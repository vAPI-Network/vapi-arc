// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IDisputePanel {
    event DisputeOpened(
        address indexed escrow,
        address indexed raisedBy,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event VoteCommitted(address indexed escrow, address indexed arbiter, bytes32 commitment);
    event VoteRevealed(address indexed escrow, address indexed arbiter, uint8 vote);
    event DisputeExecuted(
        address indexed escrow,
        uint8 outcome,
        uint8 releaseVotes,
        uint8 refundVotes,
        uint8 splitVotes
    );

    function open(address raisedBy, bytes32 evidenceHash) external;
    function commit(address escrow, bytes32 commitment) external;
    function reveal(address escrow, uint8 vote, bytes32 salt) external;
    function execute(address escrow) external;
    function factory() external view returns (address);
    function registry() external view returns (address);
    function evidenceWindow() external view returns (uint64);
    function disputeBond() external pure returns (uint256);
}

