// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IStakeGate {
    function isEligible(address account) external view returns (bool);
}

