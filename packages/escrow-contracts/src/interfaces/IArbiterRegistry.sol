// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IArbiterRegistry {
    event ArbiterSet(address indexed arbiter, bool allowed);

    function isArbiter(address account) external view returns (bool);
    function arbiterCount() external view returns (uint256);
}

