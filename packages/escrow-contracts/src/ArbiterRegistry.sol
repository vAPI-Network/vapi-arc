// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IArbiterRegistry } from "./interfaces/IArbiterRegistry.sol";
import { IStakeGate } from "./interfaces/IStakeGate.sol";

contract ArbiterRegistry is Ownable, IArbiterRegistry {
    IStakeGate public immutable stakeGate;

    mapping(address arbiter => bool allowed) private _arbiters;
    uint256 public override arbiterCount;

    error InvalidArbiter();
    error StakeRequired();

    constructor(address initialOwner, address stakeGate_) Ownable(initialOwner) {
        stakeGate = IStakeGate(stakeGate_);
    }

    function isArbiter(address account) external view override returns (bool) {
        return _arbiters[account];
    }

    function setArbiter(address arbiter, bool allowed) external onlyOwner {
        if (arbiter == address(0)) revert InvalidArbiter();
        if (allowed && address(stakeGate) != address(0) && !stakeGate.isEligible(arbiter)) {
            revert StakeRequired();
        }

        bool current = _arbiters[arbiter];
        if (current == allowed) return;

        _arbiters[arbiter] = allowed;
        if (allowed) {
            ++arbiterCount;
        } else {
            --arbiterCount;
        }
        emit ArbiterSet(arbiter, allowed);
    }
}

