// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { EscrowV1 } from "../src/EscrowV1.sol";
import { TestBase } from "./TestBase.sol";

contract FeeMathTest is TestBase {
    function testFuzz_netPlusFeeAlwaysEqualsGross(uint128 gross) public {
        token.mint(address(this), gross);
        token.approve(address(feeRouter), gross);
        (uint256 net, uint256 fee) = feeRouter.distribute(address(token), seller, gross);

        assertEq(net + fee, gross);
        assertEq(fee, uint256(gross) * FEE_BP / 10_000);
        assertEq(token.balanceOf(seller), net);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(feeRouter)), 0);
    }

    function test_feeUsesFloorDivisionAndHandlesOneWeiDust() public {
        token.mint(address(this), 20);
        token.approve(address(feeRouter), 20);

        (uint256 oneWeiNet, uint256 oneWeiFee) = feeRouter.distribute(address(token), seller, 1);
        assertEq(oneWeiNet, 1);
        assertEq(oneWeiFee, 0);

        (uint256 nineteenNet, uint256 nineteenFee) =
            feeRouter.distribute(address(token), seller, 19);
        assertEq(nineteenNet, 19);
        assertEq(nineteenFee, 0);
    }

    function test_splitUsesFloorHalfForBuyerAndChargesOnlySellerRemainder() public {
        uint256 oddAmount = 101;
        EscrowV1 escrow = _createAmount(keccak256("odd-split"), oddAmount);
        token.mint(buyer, oddAmount);
        vm.prank(buyer);
        token.approve(address(escrow), oddAmount);
        escrow.depositFunds();
        vm.prank(buyer);
        escrow.raiseDispute(bytes32("evidence"));

        vm.warp(uint256(escrow.disputedAt()) + DEADLOCK_TIMEOUT);
        vm.prank(council);
        escrow.resolveDispute(2);

        uint256 buyerLeg = oddAmount / 2;
        uint256 sellerGross = oddAmount - buyerLeg;
        uint256 expectedFee = sellerGross * FEE_BP / 10_000;
        assertEq(token.balanceOf(buyer), buyerLeg);
        assertEq(token.balanceOf(seller), sellerGross - expectedFee);
        assertEq(token.balanceOf(treasury), expectedFee);
        assertEq(
            token.balanceOf(buyer) + token.balanceOf(seller) + token.balanceOf(treasury), oddAmount
        );
    }

    function test_oneWeiSplitLeavesNoDustInEscrow() public {
        EscrowV1 escrow = _createAmount(keccak256("one-wei"), 1);
        token.mint(buyer, 1);
        vm.prank(buyer);
        token.approve(address(escrow), 1);
        escrow.depositFunds();
        vm.prank(buyer);
        escrow.raiseDispute(bytes32("evidence"));
        vm.warp(uint256(escrow.disputedAt()) + DEADLOCK_TIMEOUT);
        vm.prank(council);
        escrow.resolveDispute(2);

        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.balanceOf(seller), 1);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function _createAmount(bytes32 salt, uint256 escrowAmount) private returns (EscrowV1 escrow) {
        vm.prank(seller);
        escrow = EscrowV1(
            factory.createEscrow(
                buyer,
                address(token),
                escrowAmount,
                WORK_DURATION,
                REVIEW_WINDOW,
                bytes32("terms"),
                salt
            )
        );
    }
}

