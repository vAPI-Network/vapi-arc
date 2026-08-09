// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IEscrowFactory {
    event EscrowCreated(
        address indexed escrow,
        address indexed seller,
        address indexed buyer,
        address token,
        uint256 amount,
        uint64 offerDeadline,
        uint64 workDuration,
        uint64 reviewWindow,
        bytes32 termsHash,
        bytes32 salt
    );

    function createEscrow(
        address buyer,
        address token,
        uint256 amount,
        uint64 workDuration,
        uint64 reviewWindow,
        bytes32 termsHash,
        bytes32 salt
    ) external returns (address);

    function predictEscrow(address seller, bytes32 salt) external view returns (address);
    function implementation() external view returns (address);
    function paymentToken() external view returns (address);
    function platformTreasury() external view returns (address);
    function platformFeeBP() external view returns (uint16);
    function isEscrow(address escrow) external view returns (bool);
    function offerTtl() external view returns (uint64);
}

