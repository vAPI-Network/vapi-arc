// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IDisputePanel } from "./interfaces/IDisputePanel.sol";
import { IERC3009 } from "./interfaces/IERC3009.sol";
import { IEscrowV1 } from "./interfaces/IEscrowV1.sol";
import { IFeeRouter } from "./interfaces/IFeeRouter.sol";

contract EscrowV1 is ReentrancyGuard, IEscrowV1 {
    using SafeERC20 for IERC20;

    enum State {
        NONE,
        CREATED,
        LOCKED,
        SUBMITTED,
        DISPUTED,
        RESOLVED,
        EXPIRED
    }

    enum Resolution {
        NONE,
        RELEASE,
        REFUND,
        SPLIT
    }

    enum Outcome {
        RELEASE,
        REFUND,
        SPLIT
    }

    uint8 internal constant FUNDING_APPROVE = 0;
    uint8 internal constant FUNDING_AUTHORIZATION = 1;

    address internal immutable FACTORY;
    address internal immutable FEE_ROUTER;
    address internal immutable DISPUTE_PANEL;
    address internal immutable COUNCIL;
    uint16 internal immutable FEE_BP;
    uint64 internal immutable DEADLOCK_TIMEOUT;

    uint8 private _state;
    uint8 private _resolution;
    address public override buyer;
    address public override seller;
    address public override token;
    uint256 public override amount;
    bytes32 public override termsHash;
    bytes32 public override deliveryHash;
    uint64 public override offerDeadline;
    uint64 public override workDeadline;
    uint64 public override reviewDeadline;
    uint64 public override disputedAt;
    uint64 public override counterEvidenceDeadline;
    uint64 private _workDuration;
    uint64 private _reviewWindow;
    address private _disputeRaisedBy;
    bool private _counterEvidenceSubmitted;

    error NotFactory();
    error AlreadyInitialized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidFeeConfiguration();
    error InvalidState(uint8 expected, uint8 actual);
    error InvalidLiveState(uint8 actual);
    error OfferStillOpen();
    error OfferExpired();
    error NotBuyer();
    error NotSeller();
    error NotParty();
    error NotCounterparty();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error CounterEvidenceAlreadySubmitted();
    error FundingAmountMismatch();
    error UnauthorizedResolver();
    error InvalidOutcome();
    error TimestampOverflow();

    constructor(
        address factory_,
        address feeRouter_,
        address disputePanel_,
        address council_,
        uint16 feeBp_,
        uint64 deadlockTimeout_
    ) {
        if (
            factory_ == address(0) || feeRouter_ == address(0) || disputePanel_ == address(0)
                || council_ == address(0)
        ) revert InvalidAddress();
        if (deadlockTimeout_ == 0) revert InvalidDuration();
        if (IFeeRouter(feeRouter_).feeBp() != feeBp_) revert InvalidFeeConfiguration();

        FACTORY = factory_;
        FEE_ROUTER = feeRouter_;
        DISPUTE_PANEL = disputePanel_;
        COUNCIL = council_;
        FEE_BP = feeBp_;
        DEADLOCK_TIMEOUT = deadlockTimeout_;
    }

    function state() external view override returns (uint8) {
        return _state;
    }

    function resolution() external view override returns (uint8) {
        return _resolution;
    }

    function initialize(
        address seller_,
        address buyer_,
        address token_,
        uint256 amount_,
        uint64 offerDeadline_,
        uint64 workDuration_,
        uint64 reviewWindow_,
        bytes32 termsHash_
    ) external override {
        if (msg.sender != FACTORY) revert NotFactory();
        if (_state != uint8(State.NONE)) revert AlreadyInitialized();
        if (seller_ == address(0) || buyer_ == address(0) || token_ == address(0)) {
            revert InvalidAddress();
        }
        if (buyer_ == seller_) revert InvalidAddress();
        if (amount_ == 0) revert InvalidAmount();
        if (workDuration_ == 0 || reviewWindow_ == 0) revert InvalidDuration();

        seller = seller_;
        buyer = buyer_;
        token = token_;
        amount = amount_;
        offerDeadline = offerDeadline_;
        _workDuration = workDuration_;
        _reviewWindow = reviewWindow_;
        termsHash = termsHash_;
        _state = uint8(State.CREATED);
    }

    function depositFunds() external override nonReentrant {
        _requireState(State.CREATED);
        if (block.timestamp > offerDeadline) revert OfferExpired();

        IERC20 paymentToken = IERC20(token);
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(buyer, address(this), amount);
        _finishFunding(paymentToken, beforeBalance, FUNDING_APPROVE);
    }

    function fundWithAuthorization(
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external override nonReentrant {
        _requireState(State.CREATED);
        if (block.timestamp > offerDeadline) revert OfferExpired();

        IERC20 paymentToken = IERC20(token);
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        IERC3009(token)
            .receiveWithAuthorization(
                buyer, address(this), amount, validAfter, validBefore, nonce, signature
            );
        _finishFunding(paymentToken, beforeBalance, FUNDING_AUTHORIZATION);
    }

    function cancelOffer() external override nonReentrant {
        _requireState(State.CREATED);
        if (block.timestamp <= offerDeadline) revert OfferStillOpen();
        _state = uint8(State.EXPIRED);
        emit OfferCancelled(msg.sender);
    }

    function submitDelivery(bytes32 deliveryHash_) external override nonReentrant {
        _requireState(State.LOCKED);
        if (msg.sender != seller) revert NotSeller();
        if (block.timestamp > workDeadline) revert DeadlinePassed();

        deliveryHash = deliveryHash_;
        reviewDeadline = _deadline(_reviewWindow);
        _state = uint8(State.SUBMITTED);
        emit DeliverySubmitted(deliveryHash_, reviewDeadline);
    }

    function releaseFunds() external override nonReentrant {
        _requireState(State.SUBMITTED);
        if (msg.sender != buyer) revert NotBuyer();
        _settle(Resolution.RELEASE, msg.sender);
    }

    function refundBuyer() external override nonReentrant {
        if (_state != uint8(State.LOCKED) && _state != uint8(State.SUBMITTED)) {
            revert InvalidLiveState(_state);
        }
        if (msg.sender != seller) revert NotSeller();
        _settle(Resolution.REFUND, msg.sender);
    }

    function timeoutRefund() external override nonReentrant {
        _requireState(State.LOCKED);
        if (block.timestamp <= workDeadline) revert DeadlineNotPassed();
        _settle(Resolution.REFUND, msg.sender);
    }

    function finalize() external override nonReentrant {
        _requireState(State.SUBMITTED);
        if (block.timestamp <= reviewDeadline) revert DeadlineNotPassed();
        _settle(Resolution.RELEASE, msg.sender);
    }

    function raiseDispute(bytes32 evidenceHash) external override nonReentrant {
        if (_state != uint8(State.LOCKED) && _state != uint8(State.SUBMITTED)) {
            revert InvalidLiveState(_state);
        }
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();

        _state = uint8(State.DISPUTED);
        disputedAt = _timestamp();
        counterEvidenceDeadline = _add(disputedAt, IDisputePanel(DISPUTE_PANEL).evidenceWindow());
        _disputeRaisedBy = msg.sender;
        IDisputePanel(DISPUTE_PANEL).open(msg.sender, evidenceHash);
        emit DisputeRaised(msg.sender, evidenceHash, counterEvidenceDeadline);
    }

    function submitCounterEvidence(bytes32 evidenceHash) external override nonReentrant {
        _requireState(State.DISPUTED);
        address expected = _disputeRaisedBy == buyer ? seller : buyer;
        if (msg.sender != expected) revert NotCounterparty();
        if (block.timestamp > counterEvidenceDeadline) revert DeadlinePassed();
        if (_counterEvidenceSubmitted) revert CounterEvidenceAlreadySubmitted();

        _counterEvidenceSubmitted = true;
        emit CounterEvidenceSubmitted(msg.sender, evidenceHash);
    }

    function resolveDispute(uint8 outcome) external override nonReentrant {
        _requireState(State.DISPUTED);
        if (outcome > uint8(Outcome.SPLIT)) revert InvalidOutcome();

        if (msg.sender != DISPUTE_PANEL) {
            if (
                msg.sender != COUNCIL
                    || block.timestamp < uint256(disputedAt) + uint256(DEADLOCK_TIMEOUT)
            ) revert UnauthorizedResolver();
        }

        _settle(Resolution(outcome + 1), msg.sender);
    }

    function _finishFunding(IERC20 paymentToken, uint256 beforeBalance, uint8 method) private {
        if (paymentToken.balanceOf(address(this)) - beforeBalance != amount) {
            revert FundingAmountMismatch();
        }
        workDeadline = _deadline(_workDuration);
        _state = uint8(State.LOCKED);
        emit Funded(buyer, method, workDeadline);
    }

    function _settle(Resolution result, address executor) private {
        _state = uint8(State.RESOLVED);
        _resolution = uint8(result);

        IERC20 paymentToken = IERC20(token);
        uint256 buyerAmount;
        uint256 sellerNet;
        uint256 fee;

        if (result == Resolution.REFUND) {
            buyerAmount = amount;
            paymentToken.safeTransfer(buyer, buyerAmount);
        } else {
            uint256 sellerGross = amount;
            if (result == Resolution.SPLIT) {
                buyerAmount = amount / 2;
                sellerGross = amount - buyerAmount;
                if (buyerAmount != 0) paymentToken.safeTransfer(buyer, buyerAmount);
            }

            paymentToken.forceApprove(FEE_ROUTER, sellerGross);
            (sellerNet, fee) = IFeeRouter(FEE_ROUTER).distribute(token, seller, sellerGross);
            paymentToken.forceApprove(FEE_ROUTER, 0);
            if (sellerNet + fee != sellerGross || fee != Math.mulDiv(sellerGross, FEE_BP, 10_000)) {
                revert InvalidFeeConfiguration();
            }
        }

        emit Resolved(uint8(result), executor, buyerAmount, sellerNet, fee);
    }

    function _requireState(State expected) private view {
        if (_state != uint8(expected)) revert InvalidState(uint8(expected), _state);
    }

    function _deadline(uint64 duration) private view returns (uint64) {
        return _add(_timestamp(), duration);
    }

    function _timestamp() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();
        return uint64(block.timestamp);
    }

    function _add(uint64 left, uint64 right) private pure returns (uint64) {
        return left + right;
    }
}
