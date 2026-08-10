// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { EscrowFactory } from "../src/EscrowFactory.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { TestBase } from "./TestBase.sol";

contract EscrowStateMachineTest is TestBase {
    bytes32 private constant SALT = keccak256("state-machine");

    function test_createEscrowUsesPredictedCloneAndInitializesCreatedState() public {
        address predicted = factory.predictEscrow(seller, SALT);
        EscrowV1 escrow = _create(SALT);

        assertEq(address(escrow), predicted);
        assertTrue(factory.isEscrow(address(escrow)));
        assertEq(escrow.state(), uint8(EscrowV1.State.CREATED));
        assertEq(escrow.seller(), seller);
        assertEq(escrow.buyer(), buyer);
        assertEq(escrow.token(), address(token));
        assertEq(escrow.amount(), AMOUNT);
        assertEq(escrow.offerDeadline(), block.timestamp + OFFER_TTL);
    }

    function test_depositTransitionsCreatedToLockedPermissionlessly() public {
        EscrowV1 escrow = _createAndFund(SALT);
        assertEq(escrow.state(), uint8(EscrowV1.State.LOCKED));
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.workDeadline(), block.timestamp + WORK_DURATION);
    }

    function test_cancelOfferTransitionsCreatedToExpiredAfterTtl() public {
        EscrowV1 escrow = _create(SALT);
        vm.warp(escrow.offerDeadline() + 1);
        vm.prank(outsider);
        escrow.cancelOffer();

        assertEq(escrow.state(), uint8(EscrowV1.State.EXPIRED));
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_submitDeliveryTransitionsLockedToSubmitted() public {
        EscrowV1 escrow = _createAndFund(SALT);
        bytes32 delivery = keccak256("final-delivery");
        vm.prank(seller);
        escrow.submitDelivery(delivery);

        assertEq(escrow.state(), uint8(EscrowV1.State.SUBMITTED));
        assertEq(escrow.deliveryHash(), delivery);
        assertEq(escrow.reviewDeadline(), block.timestamp + REVIEW_WINDOW);
    }

    function test_releaseFundsBuyerOnlyAndChargesSellerLegFee() public {
        EscrowV1 escrow = _createFundAndSubmit(SALT);
        vm.prank(buyer);
        escrow.releaseFunds();

        assertEq(escrow.state(), uint8(EscrowV1.State.RESOLVED));
        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.RELEASE));
        assertEq(token.balanceOf(seller), 950e6);
        assertEq(token.balanceOf(treasury), 50e6);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_refundBuyerFromLockedIsFullAndFeeFree() public {
        EscrowV1 escrow = _createAndFund(SALT);
        vm.prank(seller);
        escrow.refundBuyer();

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.REFUND));
        assertEq(token.balanceOf(buyer), AMOUNT);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_refundBuyerFromSubmittedIsFullAndFeeFree() public {
        EscrowV1 escrow = _createFundAndSubmit(SALT);
        vm.prank(seller);
        escrow.refundBuyer();

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.REFUND));
        assertEq(token.balanceOf(buyer), AMOUNT);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_timeoutRefundIsPermissionless() public {
        EscrowV1 escrow = _createAndFund(SALT);
        vm.warp(escrow.workDeadline() + 1);
        vm.prank(outsider);
        escrow.timeoutRefund();

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.REFUND));
        assertEq(token.balanceOf(buyer), AMOUNT);
    }

    function test_finalizeIsPermissionless() public {
        EscrowV1 escrow = _createFundAndSubmit(SALT);
        vm.warp(escrow.reviewDeadline() + 1);
        vm.prank(outsider);
        escrow.finalize();

        assertEq(escrow.resolution(), uint8(EscrowV1.Resolution.RELEASE));
        assertEq(token.balanceOf(seller) + token.balanceOf(treasury), AMOUNT);
    }

    function test_raiseAndCounterEvidenceStayDisputed() public {
        EscrowV1 escrow = _createDisputed(SALT);
        vm.prank(seller);
        escrow.submitCounterEvidence(keccak256("counter"));
        assertEq(escrow.state(), uint8(EscrowV1.State.DISPUTED));

        vm.prank(seller);
        vm.expectRevert(EscrowV1.CounterEvidenceAlreadySubmitted.selector);
        escrow.submitCounterEvidence(keccak256("again"));
    }

    function test_roleRestrictionsUseExactErrors() public {
        EscrowV1 locked = _createAndFund(keccak256("locked-roles"));
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.NotSeller.selector);
        locked.submitDelivery(bytes32(0));

        vm.prank(buyer);
        vm.expectRevert(EscrowV1.NotSeller.selector);
        locked.refundBuyer();

        EscrowV1 submitted = _createFundAndSubmit(keccak256("submitted-roles"));
        vm.prank(seller);
        vm.expectRevert(EscrowV1.NotBuyer.selector);
        submitted.releaseFunds();

        vm.prank(outsider);
        vm.expectRevert(EscrowV1.NotParty.selector);
        submitted.raiseDispute(bytes32(0));
    }

    function test_factoryRejectsInvalidInputsAndSaltReplay() public {
        vm.startPrank(seller);
        vm.expectRevert(EscrowFactory.InvalidAddress.selector);
        factory.createEscrow(
            seller,
            address(token),
            AMOUNT,
            WORK_DURATION,
            REVIEW_WINDOW,
            bytes32(0),
            bytes32("same-party")
        );
        vm.expectRevert(EscrowFactory.UnsupportedToken.selector);
        factory.createEscrow(
            buyer, outsider, AMOUNT, WORK_DURATION, REVIEW_WINDOW, bytes32(0), bytes32("token")
        );

        factory.createEscrow(
            buyer,
            address(token),
            AMOUNT,
            WORK_DURATION,
            REVIEW_WINDOW,
            bytes32(0),
            bytes32("replay")
        );
        vm.expectRevert();
        factory.createEscrow(
            buyer,
            address(token),
            AMOUNT,
            WORK_DURATION,
            REVIEW_WINDOW,
            bytes32(0),
            bytes32("replay")
        );
        vm.stopPrank();
    }

    function test_stateMatrixEveryFunctionAcrossEveryInvalidState() public {
        EscrowV1 none = EscrowV1(factory.implementation());
        EscrowV1 created = _create(keccak256("matrix-created"));
        EscrowV1 locked = _createAndFund(keccak256("matrix-locked"));
        EscrowV1 submitted = _createFundAndSubmit(keccak256("matrix-submitted"));
        EscrowV1 disputed = _createDisputed(keccak256("matrix-disputed"));
        EscrowV1 resolved = _createFundAndSubmit(keccak256("matrix-resolved"));
        vm.prank(buyer);
        resolved.releaseFunds();
        EscrowV1 expired = _create(keccak256("matrix-expired"));
        vm.warp(expired.offerDeadline() + 1);
        expired.cancelOffer();

        _assertInvalidActions(none, uint8(EscrowV1.State.NONE), 0);
        _assertInvalidActions(created, uint8(EscrowV1.State.CREATED), 1 << 0 | 1 << 1 | 1 << 2);
        _assertInvalidActions(
            locked, uint8(EscrowV1.State.LOCKED), 1 << 3 | 1 << 5 | 1 << 6 | 1 << 8
        );
        _assertInvalidActions(
            submitted, uint8(EscrowV1.State.SUBMITTED), 1 << 4 | 1 << 5 | 1 << 7 | 1 << 8
        );
        _assertInvalidActions(disputed, uint8(EscrowV1.State.DISPUTED), 1 << 9 | 1 << 10);
        _assertInvalidActions(resolved, uint8(EscrowV1.State.RESOLVED), 0);
        _assertInvalidActions(expired, uint8(EscrowV1.State.EXPIRED), 0);
    }

    function _assertInvalidActions(EscrowV1 escrow, uint8 actual, uint256 validMask) private {
        bytes[] memory calls = new bytes[](11);
        calls[0] = abi.encodeCall(EscrowV1.depositFunds, ());
        calls[1] = abi.encodeCall(
            EscrowV1.fundWithAuthorization, (0, type(uint256).max, bytes32(0), bytes(""))
        );
        calls[2] = abi.encodeCall(EscrowV1.cancelOffer, ());
        calls[3] = abi.encodeCall(EscrowV1.submitDelivery, (bytes32(0)));
        calls[4] = abi.encodeCall(EscrowV1.releaseFunds, ());
        calls[5] = abi.encodeCall(EscrowV1.refundBuyer, ());
        calls[6] = abi.encodeCall(EscrowV1.timeoutRefund, ());
        calls[7] = abi.encodeCall(EscrowV1.finalize, ());
        calls[8] = abi.encodeCall(EscrowV1.raiseDispute, (bytes32(0)));
        calls[9] = abi.encodeCall(EscrowV1.submitCounterEvidence, (bytes32(0)));
        calls[10] = abi.encodeCall(EscrowV1.resolveDispute, (uint8(0)));

        uint8[11] memory expectedStates = [uint8(1), 1, 1, 2, 3, 0, 2, 3, 0, 4, 4];
        for (uint256 i; i < calls.length; ++i) {
            if ((validMask & (1 << i)) != 0) continue;

            bytes memory expected;
            if (i == 5 || i == 8) {
                expected = abi.encodeWithSelector(EscrowV1.InvalidLiveState.selector, actual);
            } else {
                expected = abi.encodeWithSelector(
                    EscrowV1.InvalidState.selector, expectedStates[i], actual
                );
            }
            vm.expectRevert(expected);
            vm.prank(outsider);
            _bubbleCall(address(escrow), calls[i]);
        }
    }

    function _bubbleCall(address target, bytes memory data) private {
        (bool success, bytes memory result) = target.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}
