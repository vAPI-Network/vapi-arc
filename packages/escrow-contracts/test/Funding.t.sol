// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { EscrowFactory } from "../src/EscrowFactory.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { MockUSDC3009 } from "./mocks/MockUSDC3009.sol";
import { MockUSDCPlain } from "./mocks/MockUSDCPlain.sol";
import { TestBase } from "./TestBase.sol";

contract FundingTest is TestBase {
    function test_approveAndDepositPullsFromBuyerEvenWhenRelayed() public {
        EscrowV1 escrow = _create(keccak256("approve"));
        token.mint(buyer, AMOUNT);
        vm.prank(buyer);
        token.approve(address(escrow), AMOUNT);

        vm.prank(outsider);
        escrow.depositFunds();

        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.state(), uint8(EscrowV1.State.LOCKED));
    }

    function test_receiveWithAuthorizationCanBeRelayedByAnyone() public {
        EscrowV1 escrow = _create(keccak256("authorization"));
        token.mint(buyer, AMOUNT);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("authorization-nonce");
        bytes memory signature =
            _signAuthorization(address(escrow), AMOUNT, validAfter, validBefore, nonce);

        vm.prank(outsider);
        escrow.fundWithAuthorization(validAfter, validBefore, nonce, signature);

        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.state(), uint8(EscrowV1.State.LOCKED));
    }

    function test_authorizationSignedForWrongToCannotFundEscrow() public {
        EscrowV1 escrow = _create(keccak256("wrong-to"));
        token.mint(buyer, AMOUNT);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("wrong-to-nonce");
        bytes memory signature =
            _signAuthorization(outsider, AMOUNT, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC3009.InvalidSignature.selector);
        escrow.fundWithAuthorization(validAfter, validBefore, nonce, signature);
        assertEq(escrow.state(), uint8(EscrowV1.State.CREATED));
    }

    function test_expiredAuthorizationCannotFundEscrow() public {
        EscrowV1 escrow = _create(keccak256("expired-auth"));
        token.mint(buyer, AMOUNT);
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp;
        bytes32 nonce = keccak256("expired-nonce");
        bytes memory signature =
            _signAuthorization(address(escrow), AMOUNT, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC3009.AuthorizationExpired.selector);
        escrow.fundWithAuthorization(validAfter, validBefore, nonce, signature);
        assertEq(escrow.state(), uint8(EscrowV1.State.CREATED));
    }

    function test_authorizationNonceCannotReplayAcrossFundingAttempts() public {
        EscrowV1 escrow = _create(keccak256("auth-replay"));
        token.mint(buyer, AMOUNT * 2);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("replay-nonce");
        bytes memory signature =
            _signAuthorization(address(escrow), AMOUNT, validAfter, validBefore, nonce);
        escrow.fundWithAuthorization(validAfter, validBefore, nonce, signature);

        vm.expectRevert(
            abi.encodeWithSelector(
                EscrowV1.InvalidState.selector,
                uint8(EscrowV1.State.CREATED),
                uint8(EscrowV1.State.LOCKED)
            )
        );
        escrow.fundWithAuthorization(validAfter, validBefore, nonce, signature);
    }

    function test_plainTokenSupportsApprovePathAndRejectsAuthorizationPath() public {
        MockUSDCPlain plain = new MockUSDCPlain();
        EscrowFactory plainFactory = new EscrowFactory(
            address(plain), address(feeRouter), address(panel), council, OFFER_TTL, DEADLOCK_TIMEOUT
        );

        vm.prank(seller);
        EscrowV1 approvedEscrow = EscrowV1(
            plainFactory.createEscrow(
                buyer,
                address(plain),
                AMOUNT,
                WORK_DURATION,
                REVIEW_WINDOW,
                bytes32("plain"),
                bytes32("plain-approved")
            )
        );
        plain.mint(buyer, AMOUNT);
        vm.prank(buyer);
        plain.approve(address(approvedEscrow), AMOUNT);
        approvedEscrow.depositFunds();
        assertEq(plain.balanceOf(address(approvedEscrow)), AMOUNT);

        vm.prank(seller);
        EscrowV1 unsupportedEscrow = EscrowV1(
            plainFactory.createEscrow(
                buyer,
                address(plain),
                AMOUNT,
                WORK_DURATION,
                REVIEW_WINDOW,
                bytes32("plain"),
                bytes32("plain-auth")
            )
        );
        vm.expectRevert();
        unsupportedEscrow.fundWithAuthorization(0, block.timestamp + 1 hours, bytes32(0), "");
        assertEq(unsupportedEscrow.state(), uint8(EscrowV1.State.CREATED));
    }

    function _signAuthorization(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view returns (bytes memory) {
        bytes32 digest = token.authorizationDigest(buyer, to, value, validAfter, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

