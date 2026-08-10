// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IArbiterRegistry } from "./interfaces/IArbiterRegistry.sol";
import { IDisputePanel } from "./interfaces/IDisputePanel.sol";
import { IEscrowFactory } from "./interfaces/IEscrowFactory.sol";
import { IEscrowV1 } from "./interfaces/IEscrowV1.sol";

contract DisputePanel is Ownable, IDisputePanel {
    enum Vote {
        NONE,
        RELEASE,
        REFUND,
        SPLIT
    }

    uint8 internal constant RELEASE_VOTE = uint8(Vote.RELEASE);
    uint8 internal constant REFUND_VOTE = uint8(Vote.REFUND);
    uint8 internal constant SPLIT_VOTE = uint8(Vote.SPLIT);
    uint8 internal constant PANEL_SIZE = 3;

    struct CaseData {
        uint64 commitStart;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 revealCount;
        uint8 releaseVotes;
        uint8 refundVotes;
        uint8 splitVotes;
        bool executed;
    }

    address public override factory;
    uint64 public immutable override evidenceWindow;
    uint64 public immutable commitWindow;
    uint64 public immutable revealWindow;
    IArbiterRegistry private immutable _registry;

    mapping(address escrow => CaseData data) private _cases;
    mapping(address escrow => mapping(address arbiter => bytes32 commitment)) private _commitments;
    mapping(address escrow => mapping(address arbiter => bool revealed)) private _revealed;

    error FactoryAlreadySet();
    error FactoryNotSet();
    error InvalidAddress();
    error InvalidWindow();
    error NotRegisteredEscrow();
    error DisputeAlreadyOpened();
    error DisputeNotOpened();
    error DisputeAlreadyExecuted();
    error NotArbiter();
    error CommitWindowClosed();
    error CommitmentAlreadySubmitted();
    error InvalidCommitment();
    error RevealWindowClosed();
    error InvalidVote();
    error VoteAlreadyRevealed();
    error CommitmentMismatch();
    error DisputeNotExecutable();

    constructor(
        address initialOwner,
        address registry_,
        uint64 evidenceWindow_,
        uint64 commitWindow_,
        uint64 revealWindow_
    ) Ownable(initialOwner) {
        if (registry_ == address(0)) revert InvalidAddress();
        if (evidenceWindow_ < 60 || commitWindow_ < 60 || revealWindow_ < 60) {
            revert InvalidWindow();
        }
        _registry = IArbiterRegistry(registry_);
        evidenceWindow = evidenceWindow_;
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
    }

    function registry() external view override returns (address) {
        return address(_registry);
    }

    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert InvalidAddress();
        factory = factory_;
    }

    function disputeBond() external pure override returns (uint256) {
        return 0;
    }

    function open(address raisedBy, bytes32) external override {
        address factory_ = factory;
        if (factory_ == address(0)) revert FactoryNotSet();
        if (!IEscrowFactory(factory_).isEscrow(msg.sender)) revert NotRegisteredEscrow();

        CaseData storage dispute = _cases[msg.sender];
        if (dispute.commitDeadline != 0) revert DisputeAlreadyOpened();

        uint64 now64 = _timestamp();
        uint64 commitStart = _add(now64, evidenceWindow);
        uint64 commitDeadline = _add(commitStart, commitWindow);
        uint64 revealDeadline = _add(commitDeadline, revealWindow);
        dispute.commitStart = commitStart;
        dispute.commitDeadline = commitDeadline;
        dispute.revealDeadline = revealDeadline;

        emit DisputeOpened(msg.sender, raisedBy, commitDeadline, revealDeadline);
    }

    function commit(address escrow, bytes32 commitment) external override {
        if (!_registry.isArbiter(msg.sender)) revert NotArbiter();
        CaseData storage dispute = _case(escrow);
        if (dispute.executed) revert DisputeAlreadyExecuted();
        if (block.timestamp < dispute.commitStart || block.timestamp >= dispute.commitDeadline) {
            revert CommitWindowClosed();
        }
        if (_commitments[escrow][msg.sender] != bytes32(0)) {
            revert CommitmentAlreadySubmitted();
        }
        if (commitment == bytes32(0)) revert InvalidCommitment();

        _commitments[escrow][msg.sender] = commitment;
        emit VoteCommitted(escrow, msg.sender, commitment);
    }

    function reveal(address escrow, uint8 vote, bytes32 salt) external override {
        if (!_registry.isArbiter(msg.sender)) revert NotArbiter();
        CaseData storage dispute = _case(escrow);
        if (dispute.executed) revert DisputeAlreadyExecuted();
        if (block.timestamp < dispute.commitDeadline || block.timestamp >= dispute.revealDeadline) {
            revert RevealWindowClosed();
        }
        if (vote < RELEASE_VOTE || vote > SPLIT_VOTE) revert InvalidVote();
        if (_revealed[escrow][msg.sender]) revert VoteAlreadyRevealed();

        bytes32 expected = keccak256(abi.encodePacked(escrow, msg.sender, vote, salt));
        if (
            _commitments[escrow][msg.sender] == bytes32(0)
                || expected != _commitments[escrow][msg.sender]
        ) {
            revert CommitmentMismatch();
        }

        _revealed[escrow][msg.sender] = true;
        ++dispute.revealCount;
        if (vote == RELEASE_VOTE) ++dispute.releaseVotes;
        else if (vote == REFUND_VOTE) ++dispute.refundVotes;
        else ++dispute.splitVotes;

        emit VoteRevealed(escrow, msg.sender, vote);
    }

    function execute(address escrow) external override {
        CaseData storage dispute = _case(escrow);
        if (dispute.executed) revert DisputeAlreadyExecuted();
        if (dispute.revealCount < PANEL_SIZE && block.timestamp < dispute.revealDeadline) {
            revert DisputeNotExecutable();
        }

        uint8 outcome;
        if (dispute.releaseVotes >= 2) outcome = 0;
        else if (dispute.refundVotes >= 2) outcome = 1;
        else outcome = 2;

        dispute.executed = true;
        IEscrowV1(escrow).resolveDispute(outcome);
        emit DisputeExecuted(
            escrow, outcome, dispute.releaseVotes, dispute.refundVotes, dispute.splitVotes
        );
    }

    function _case(address escrow) private view returns (CaseData storage dispute) {
        dispute = _cases[escrow];
        if (dispute.commitDeadline == 0) revert DisputeNotOpened();
    }

    function _timestamp() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidWindow();
        return uint64(block.timestamp);
    }

    function _add(uint64 left, uint64 right) private pure returns (uint64) {
        return left + right;
    }
}
