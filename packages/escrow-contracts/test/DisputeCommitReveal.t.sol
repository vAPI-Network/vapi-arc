// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { DisputePanel } from "../src/DisputePanel.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { TestBase } from "./TestBase.sol";

contract DisputeCommitRevealTest is TestBase {
    bytes32 private constant SALT_1 = keccak256("vote-salt-1");
    bytes32 private constant SALT_2 = keccak256("vote-salt-2");
    bytes32 private constant SALT_3 = keccak256("vote-salt-3");

    function test_threeToZeroReleaseVotePaysSeller() public {
        EscrowV1 escrow = _createDisputed(keccak256("three-zero"));
        _commitAndRevealAll(escrow, 1, 1, 1);
        panel.execute(address(escrow));

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.RELEASE));
        assertEq(token.balanceOf(seller), 950e6);
        assertEq(token.balanceOf(treasury), 50e6);
        assertEq(token.balanceOf(address(panel)), 0);
    }

    function test_twoToOneRefundVotePaysBuyerWithoutFee() public {
        EscrowV1 escrow = _createDisputed(keccak256("two-one"));
        _commitAndRevealAll(escrow, 2, 2, 1);
        panel.execute(address(escrow));

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.REFUND));
        assertEq(token.balanceOf(buyer), AMOUNT);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_oneOneOneDefaultsToSplit() public {
        EscrowV1 escrow = _createDisputed(keccak256("one-one-one"));
        _commitAndRevealAll(escrow, 1, 2, 3);
        panel.execute(address(escrow));

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.SPLIT));
        assertEq(token.balanceOf(buyer), 500e6);
        assertEq(token.balanceOf(seller), 475e6);
        assertEq(token.balanceOf(treasury), 25e6);
    }

    function test_zeroRevealsCanUseCouncilDeadlockPath() public {
        EscrowV1 escrow = _createDisputed(keccak256("zero-reveal-council"));
        vm.warp(uint256(escrow.disputedAt()) + DEADLOCK_TIMEOUT);
        vm.prank(council);
        escrow.resolveDispute(1);

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.REFUND));
        assertEq(token.balanceOf(buyer), AMOUNT);
    }

    function test_zeroRevealsPastRevealDeadlineExecutesSplit() public {
        EscrowV1 escrow = _createDisputed(keccak256("zero-reveal-panel"));
        vm.warp(uint256(escrow.counterEvidenceDeadline()) + COMMIT_WINDOW + REVEAL_WINDOW);
        panel.execute(address(escrow));
        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.SPLIT));
    }

    function test_badSaltCannotReveal() public {
        EscrowV1 escrow = _createDisputed(keccak256("bad-salt"));
        vm.warp(escrow.counterEvidenceDeadline());
        _commit(address(escrow), arbiter1, 1, SALT_1);
        vm.warp(block.timestamp + COMMIT_WINDOW);

        vm.prank(arbiter1);
        vm.expectRevert(DisputePanel.CommitmentMismatch.selector);
        panel.reveal(address(escrow), 1, keccak256("wrong-salt"));
    }

    function test_replayedCommitCannotOverwrite() public {
        EscrowV1 escrow = _createDisputed(keccak256("replayed-commit"));
        vm.warp(escrow.counterEvidenceDeadline());
        _commit(address(escrow), arbiter1, 1, SALT_1);

        vm.prank(arbiter1);
        vm.expectRevert(DisputePanel.CommitmentAlreadySubmitted.selector);
        panel.commit(address(escrow), _commitment(address(escrow), arbiter1, 2, SALT_2));
    }

    function test_nonArbiterCannotCommitOrReveal() public {
        EscrowV1 escrow = _createDisputed(keccak256("non-arbiter"));
        vm.warp(escrow.counterEvidenceDeadline());

        vm.prank(outsider);
        vm.expectRevert(DisputePanel.NotArbiter.selector);
        panel.commit(address(escrow), bytes32(uint256(1)));

        vm.warp(block.timestamp + COMMIT_WINDOW);
        vm.prank(outsider);
        vm.expectRevert(DisputePanel.NotArbiter.selector);
        panel.reveal(address(escrow), 1, SALT_1);
    }

    function test_commitDuringEvidenceWindowReverts() public {
        EscrowV1 escrow = _createDisputed(keccak256("early-commit"));
        vm.prank(arbiter1);
        vm.expectRevert(DisputePanel.CommitWindowClosed.selector);
        panel.commit(address(escrow), _commitment(address(escrow), arbiter1, 1, SALT_1));
    }

    function test_executeAfterAllRevealsCallsEscrowExactlyOnce() public {
        EscrowV1 escrow = _createDisputed(keccak256("execute-once"));
        _commitAndRevealAll(escrow, 1, 1, 1);
        panel.execute(address(escrow));

        vm.expectRevert(DisputePanel.DisputeAlreadyExecuted.selector);
        panel.execute(address(escrow));
    }

    function test_onlyPanelOrTimedOutCouncilCanResolve() public {
        EscrowV1 escrow = _createDisputed(keccak256("resolver-access"));
        vm.prank(outsider);
        vm.expectRevert(EscrowV1.UnauthorizedResolver.selector);
        escrow.resolveDispute(0);

        vm.prank(council);
        vm.expectRevert(EscrowV1.UnauthorizedResolver.selector);
        escrow.resolveDispute(0);

        vm.warp(uint256(escrow.disputedAt()) + DEADLOCK_TIMEOUT);
        vm.prank(council);
        vm.expectRevert(EscrowV1.InvalidOutcome.selector);
        escrow.resolveDispute(3);
    }

    function test_panelOpenIsRestrictedToFactoryRegisteredEscrows() public {
        vm.prank(outsider);
        vm.expectRevert(DisputePanel.NotRegisteredEscrow.selector);
        panel.open(outsider, bytes32("evidence"));
    }

    function test_disputeBondStubIsZero() public view {
        assertEq(panel.disputeBond(), 0);
    }

    function _commitAndRevealAll(EscrowV1 escrow, uint8 vote1, uint8 vote2, uint8 vote3) private {
        vm.warp(escrow.counterEvidenceDeadline());
        _commit(address(escrow), arbiter1, vote1, SALT_1);
        _commit(address(escrow), arbiter2, vote2, SALT_2);
        _commit(address(escrow), arbiter3, vote3, SALT_3);

        vm.warp(block.timestamp + COMMIT_WINDOW);
        _reveal(address(escrow), arbiter1, vote1, SALT_1);
        _reveal(address(escrow), arbiter2, vote2, SALT_2);
        _reveal(address(escrow), arbiter3, vote3, SALT_3);
    }
}

