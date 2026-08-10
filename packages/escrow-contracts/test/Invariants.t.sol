// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Test } from "forge-std/Test.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { MockUSDC3009 } from "./mocks/MockUSDC3009.sol";
import { TestBase } from "./TestBase.sol";

contract EscrowHandler is Test {
    EscrowV1 public immutable escrow;
    address public immutable buyer;
    address public immutable seller;
    address public immutable council;
    uint64 public immutable deadlockTimeout;

    constructor(
        EscrowV1 escrow_,
        address buyer_,
        address seller_,
        address council_,
        uint64 deadlockTimeout_
    ) {
        escrow = escrow_;
        buyer = buyer_;
        seller = seller_;
        council = council_;
        deadlockTimeout = deadlockTimeout_;
    }

    function submit(bytes32 deliveryHash) external {
        if (escrow.state() != uint8(EscrowV1.State.LOCKED)) return;
        if (block.timestamp > escrow.workDeadline()) return;
        vm.prank(seller);
        escrow.submitDelivery(deliveryHash);
    }

    function release() external {
        if (escrow.state() != uint8(EscrowV1.State.SUBMITTED)) return;
        vm.prank(buyer);
        escrow.releaseFunds();
    }

    function refund() external {
        uint8 current = escrow.state();
        if (current != uint8(EscrowV1.State.LOCKED) && current != uint8(EscrowV1.State.SUBMITTED)) {
            return;
        }
        vm.prank(seller);
        escrow.refundBuyer();
    }

    function timeoutRefund() external {
        if (escrow.state() != uint8(EscrowV1.State.LOCKED)) return;
        vm.warp(uint256(escrow.workDeadline()) + 1);
        escrow.timeoutRefund();
    }

    function finalize() external {
        if (escrow.state() != uint8(EscrowV1.State.SUBMITTED)) return;
        vm.warp(uint256(escrow.reviewDeadline()) + 1);
        escrow.finalize();
    }

    function dispute(bytes32 evidenceHash, bool raisedBySeller) external {
        uint8 current = escrow.state();
        if (current != uint8(EscrowV1.State.LOCKED) && current != uint8(EscrowV1.State.SUBMITTED)) {
            return;
        }
        vm.prank(raisedBySeller ? seller : buyer);
        escrow.raiseDispute(evidenceHash);
    }

    function counterEvidence(bytes32 evidenceHash) external {
        if (escrow.state() != uint8(EscrowV1.State.DISPUTED)) return;
        if (block.timestamp > escrow.counterEvidenceDeadline()) return;
        vm.prank(seller);
        try escrow.submitCounterEvidence(evidenceHash) { } catch { }
        vm.prank(buyer);
        try escrow.submitCounterEvidence(evidenceHash) { } catch { }
    }

    function councilResolve(uint8 outcome) external {
        if (escrow.state() != uint8(EscrowV1.State.DISPUTED)) return;
        outcome = uint8(bound(outcome, 0, 2));
        vm.warp(uint256(escrow.disputedAt()) + deadlockTimeout);
        vm.prank(council);
        escrow.resolveDispute(outcome);
    }
}

contract InvariantsTest is StdInvariant, TestBase {
    EscrowV1 private escrow;
    EscrowV1 private expiredEscrow;
    EscrowHandler private handler;

    function setUp() public override {
        super.setUp();
        escrow = _createAndFund(keccak256("invariant-funded"));
        expiredEscrow = _create(keccak256("invariant-expired"));
        vm.warp(uint256(expiredEscrow.offerDeadline()) + 1);
        expiredEscrow.cancelOffer();

        handler = new EscrowHandler(escrow, buyer, seller, council, DEADLOCK_TIMEOUT);
        targetContract(address(handler));
    }

    function invariant_liveEscrowBalanceEqualsAmount() public view {
        uint8 current = escrow.state();
        if (
            current == uint8(EscrowV1.State.LOCKED) || current == uint8(EscrowV1.State.SUBMITTED)
                || current == uint8(EscrowV1.State.DISPUTED)
        ) {
            assertEq(token.balanceOf(address(escrow)), AMOUNT);
        }
    }

    function invariant_terminalEscrowBalancesAreZero() public view {
        if (escrow.state() == uint8(EscrowV1.State.RESOLVED)) {
            assertEq(token.balanceOf(address(escrow)), 0);
        }
        assertEq(expiredEscrow.state(), uint8(EscrowV1.State.EXPIRED));
        assertEq(token.balanceOf(address(expiredEscrow)), 0);
    }

    function invariant_terminalOutboundAlwaysSumsToAmount() public view {
        if (escrow.state() == uint8(EscrowV1.State.RESOLVED)) {
            assertEq(
                token.balanceOf(buyer) + token.balanceOf(seller) + token.balanceOf(treasury), AMOUNT
            );
        }
    }

    function invariant_panelRegistryReputationAndArbitersNeverReceiveTokens() public view {
        assertEq(token.balanceOf(address(panel)), 0);
        assertEq(token.balanceOf(address(registry)), 0);
        assertEq(token.balanceOf(address(reputation)), 0);
        assertEq(token.balanceOf(arbiter1), 0);
        assertEq(token.balanceOf(arbiter2), 0);
        assertEq(token.balanceOf(arbiter3), 0);
    }
}

