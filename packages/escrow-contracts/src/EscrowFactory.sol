// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EscrowV1 } from "./EscrowV1.sol";
import { IDisputePanel } from "./interfaces/IDisputePanel.sol";
import { IEscrowFactory } from "./interfaces/IEscrowFactory.sol";
import { IEscrowV1 } from "./interfaces/IEscrowV1.sol";
import { IFeeRouter } from "./interfaces/IFeeRouter.sol";

contract EscrowFactory is IEscrowFactory {
    uint16 internal constant PLATFORM_FEE_BP = 500;

    address public immutable override implementation;
    address public immutable override paymentToken;
    address public immutable override platformTreasury;
    uint16 public constant override platformFeeBP = PLATFORM_FEE_BP;
    uint64 public immutable override offerTtl;

    mapping(address escrow => bool registered) public override isEscrow;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDuration();
    error UnsupportedToken();
    error InvalidFeeConfiguration();
    error TimestampOverflow();

    constructor(
        address paymentToken_,
        address feeRouter_,
        address disputePanel_,
        address council_,
        uint64 offerTtl_,
        uint64 deadlockTimeout_
    ) {
        if (
            paymentToken_ == address(0) || feeRouter_ == address(0) || disputePanel_ == address(0)
                || council_ == address(0)
        ) revert InvalidAddress();
        if (offerTtl_ == 0 || deadlockTimeout_ == 0) revert InvalidDuration();

        IFeeRouter feeRouter = IFeeRouter(feeRouter_);
        if (feeRouter.feeBp() != PLATFORM_FEE_BP) revert InvalidFeeConfiguration();

        paymentToken = paymentToken_;
        platformTreasury = feeRouter.treasury();
        offerTtl = offerTtl_;
        implementation = address(
            new EscrowV1(
                address(this),
                feeRouter_,
                disputePanel_,
                council_,
                PLATFORM_FEE_BP,
                deadlockTimeout_
            )
        );
    }

    function createEscrow(
        address buyer,
        address token,
        uint256 amount,
        uint64 workDuration,
        uint64 reviewWindow,
        bytes32 termsHash,
        bytes32 salt
    ) external override returns (address escrow) {
        address seller = msg.sender;
        if (buyer == address(0) || buyer == seller) revert InvalidAddress();
        if (token != paymentToken) revert UnsupportedToken();
        if (amount == 0) revert InvalidAmount();
        if (workDuration == 0 || reviewWindow == 0) revert InvalidDuration();

        bytes32 cloneSalt = keccak256(abi.encodePacked(seller, salt));
        escrow = Clones.cloneDeterministic(implementation, cloneSalt);
        uint64 offerDeadline = _deadline(offerTtl);

        isEscrow[escrow] = true;
        IEscrowV1(escrow)
            .initialize(
                seller, buyer, token, amount, offerDeadline, workDuration, reviewWindow, termsHash
            );

        emit EscrowCreated(
            escrow,
            seller,
            buyer,
            token,
            amount,
            offerDeadline,
            workDuration,
            reviewWindow,
            termsHash,
            salt
        );
    }

    function predictEscrow(address seller, bytes32 salt) external view override returns (address) {
        bytes32 cloneSalt = keccak256(abi.encodePacked(seller, salt));
        return Clones.predictDeterministicAddress(implementation, cloneSalt, address(this));
    }

    function _deadline(uint64 duration) private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();
        return uint64(block.timestamp) + duration;
    }
}

