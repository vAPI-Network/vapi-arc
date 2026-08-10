// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { EscrowV1 } from "../src/EscrowV1.sol";
import { TestBase } from "./TestBase.sol";

contract TimeoutsTest is TestBase {
    function test_offerDeadlineBoundaryAllowsFundingAndRequiresStrictlyLaterCancellation() public {
        EscrowV1 escrow = _create(keccak256("offer-fund-boundary"));
        token.mint(buyer, AMOUNT);
        vm.prank(buyer);
        token.approve(address(escrow), AMOUNT);
        vm.warp(escrow.offerDeadline());
        escrow.depositFunds();
        assertEq(escrow.state(), uint8(EscrowV1.State.LOCKED));

        EscrowV1 cancellable = _create(keccak256("offer-cancel-boundary"));
        vm.warp(cancellable.offerDeadline());
        vm.expectRevert(EscrowV1.OfferStillOpen.selector);
        cancellable.cancelOffer();
        vm.warp(cancellable.offerDeadline() + 1);
        cancellable.cancelOffer();
        assertEq(cancellable.state(), uint8(EscrowV1.State.EXPIRED));
    }

    function test_workDeadlineBoundaryAllowsDeliveryAndRequiresStrictlyLaterRefund() public {
        EscrowV1 deliverable = _createAndFund(keccak256("work-delivery-boundary"));
        vm.warp(deliverable.workDeadline());
        vm.prank(seller);
        deliverable.submitDelivery(bytes32("delivery"));
        assertEq(deliverable.state(), uint8(EscrowV1.State.SUBMITTED));

        EscrowV1 refundable = _createAndFund(keccak256("work-refund-boundary"));
        vm.warp(refundable.workDeadline());
        vm.expectRevert(EscrowV1.DeadlineNotPassed.selector);
        refundable.timeoutRefund();
        vm.warp(refundable.workDeadline() + 1);
        refundable.timeoutRefund();
        assertEq(refundable.resolution(), uint8(EscrowV1.Resolution.REFUND));
    }

    function test_reviewDeadlineBoundaryRequiresStrictlyLaterFinalization() public {
        EscrowV1 escrow = _createFundAndSubmit(keccak256("review-boundary"));
        vm.warp(escrow.reviewDeadline());
        vm.expectRevert(EscrowV1.DeadlineNotPassed.selector);
        escrow.finalize();
        vm.warp(escrow.reviewDeadline() + 1);
        escrow.finalize();
        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.RELEASE));
    }

    function testFuzz_timeoutRefundRevertsAtEveryTimestampThroughDeadline(uint64 elapsed) public {
        EscrowV1 escrow = _createAndFund(keccak256(abi.encode("work-fuzz", elapsed)));
        elapsed = uint64(bound(elapsed, 0, WORK_DURATION));
        vm.warp(block.timestamp + elapsed);
        vm.expectRevert(EscrowV1.DeadlineNotPassed.selector);
        escrow.timeoutRefund();
    }

    function testFuzz_finalizeRevertsAtEveryTimestampThroughDeadline(uint64 elapsed) public {
        EscrowV1 escrow = _createFundAndSubmit(keccak256(abi.encode("review-fuzz", elapsed)));
        elapsed = uint64(bound(elapsed, 0, REVIEW_WINDOW));
        vm.warp(block.timestamp + elapsed);
        vm.expectRevert(EscrowV1.DeadlineNotPassed.selector);
        escrow.finalize();
    }

    function testFuzz_counterEvidenceAcceptedThroughExactBoundary(uint64 elapsed) public {
        EscrowV1 escrow = _createDisputed(keccak256(abi.encode("counter-fuzz", elapsed)));
        elapsed = uint64(bound(elapsed, 0, EVIDENCE_WINDOW));
        vm.warp(block.timestamp + elapsed);
        vm.prank(seller);
        escrow.submitCounterEvidence(bytes32(uint256(elapsed)));
        assertEq(escrow.state(), uint8(EscrowV1.State.DISPUTED));
    }
}

