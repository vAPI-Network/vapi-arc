// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ArbiterRegistry } from "../src/ArbiterRegistry.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { ReputationRegistryV0 } from "../src/ReputationRegistryV0.sol";
import { IStakeGate } from "../src/interfaces/IStakeGate.sol";
import { TestBase } from "./TestBase.sol";

contract MockStakeGate is IStakeGate {
    mapping(address account => bool eligible) public eligibility;

    function setEligible(address account, bool eligible) external {
        eligibility[account] = eligible;
    }

    function isEligible(address account) external view returns (bool) {
        return eligibility[account];
    }
}

contract RegistriesTest is TestBase {
    function test_arbiterRegistryTracksOwnerAllowlistAndCount() public {
        address fourth = makeAddr("fourth");
        registry.setArbiter(fourth, true);
        assertTrue(registry.isArbiter(fourth));
        assertEq(registry.arbiterCount(), 4);

        registry.setArbiter(fourth, false);
        assertFalse(registry.isArbiter(fourth));
        assertEq(registry.arbiterCount(), 3);
    }

    function test_arbiterRegistryEnforcesOptionalStakeGate() public {
        MockStakeGate gate = new MockStakeGate();
        ArbiterRegistry gated = new ArbiterRegistry(address(this), address(gate));
        address candidate = makeAddr("candidate");
        vm.expectRevert(ArbiterRegistry.StakeRequired.selector);
        gated.setArbiter(candidate, true);

        gate.setEligible(candidate, true);
        gated.setArbiter(candidate, true);
        assertTrue(gated.isArbiter(candidate));
    }

    function test_reputationAttestsResolvedEscrowExactlyOnce() public {
        EscrowV1 escrow = _createDisputed(keccak256("reputation"));
        vm.warp(uint256(escrow.disputedAt()) + DEADLOCK_TIMEOUT);
        vm.prank(council);
        escrow.resolveDispute(2);

        vm.prank(outsider);
        reputation.attest(address(escrow));
        (uint64 settled, uint64 released, uint64 refunded, uint64 disputed, uint64 splits) =
            reputation.scoreOf(seller);
        assertEq(settled, 1);
        assertEq(released, 0);
        assertEq(refunded, 0);
        assertEq(disputed, 1);
        assertEq(splits, 1);

        vm.expectRevert(ReputationRegistryV0.AlreadyAttested.selector);
        reputation.attest(address(escrow));
    }

    function test_reputationRejectsUnregisteredAndUnresolvedEscrows() public {
        vm.expectRevert(ReputationRegistryV0.NotRegisteredEscrow.selector);
        reputation.attest(outsider);

        EscrowV1 escrow = _create(keccak256("unresolved"));
        vm.expectRevert(ReputationRegistryV0.EscrowNotResolved.selector);
        reputation.attest(address(escrow));
    }
}

