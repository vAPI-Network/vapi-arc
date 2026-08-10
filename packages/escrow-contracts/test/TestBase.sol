// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Test } from "forge-std/Test.sol";
import { ArbiterRegistry } from "../src/ArbiterRegistry.sol";
import { DisputePanel } from "../src/DisputePanel.sol";
import { EscrowFactory } from "../src/EscrowFactory.sol";
import { EscrowV1 } from "../src/EscrowV1.sol";
import { FeeRouter } from "../src/FeeRouter.sol";
import { ReputationRegistryV0 } from "../src/ReputationRegistryV0.sol";
import { MockUSDC3009 } from "./mocks/MockUSDC3009.sol";

abstract contract TestBase is Test {
    uint16 internal constant FEE_BP = 500;
    uint64 internal constant OFFER_TTL = 1 days;
    uint64 internal constant WORK_DURATION = 2 days;
    uint64 internal constant REVIEW_WINDOW = 1 days;
    uint64 internal constant EVIDENCE_WINDOW = 1 hours;
    uint64 internal constant COMMIT_WINDOW = 1 hours;
    uint64 internal constant REVEAL_WINDOW = 1 hours;
    uint64 internal constant DEADLOCK_TIMEOUT = 7 days;
    uint256 internal constant AMOUNT = 1_000e6;

    uint256 internal buyerKey = 0xB0B;
    address internal buyer;
    address internal seller = makeAddr("seller");
    address internal treasury = makeAddr("treasury");
    address internal council = makeAddr("council");
    address internal arbiter1 = makeAddr("arbiter1");
    address internal arbiter2 = makeAddr("arbiter2");
    address internal arbiter3 = makeAddr("arbiter3");
    address internal outsider = makeAddr("outsider");

    MockUSDC3009 internal token;
    FeeRouter internal feeRouter;
    ArbiterRegistry internal registry;
    DisputePanel internal panel;
    EscrowFactory internal factory;
    ReputationRegistryV0 internal reputation;

    function setUp() public virtual {
        buyer = vm.addr(buyerKey);
        token = new MockUSDC3009();
        feeRouter = new FeeRouter(treasury, FEE_BP);
        registry = new ArbiterRegistry(address(this), address(0));
        registry.setArbiter(arbiter1, true);
        registry.setArbiter(arbiter2, true);
        registry.setArbiter(arbiter3, true);
        panel = new DisputePanel(
            address(this), address(registry), EVIDENCE_WINDOW, COMMIT_WINDOW, REVEAL_WINDOW
        );
        factory = new EscrowFactory(
            address(token), address(feeRouter), address(panel), council, OFFER_TTL, DEADLOCK_TIMEOUT
        );
        panel.setFactory(address(factory));
        reputation = new ReputationRegistryV0(address(factory));
    }

    function _create(bytes32 salt) internal returns (EscrowV1 escrow) {
        vm.prank(seller);
        address created = factory.createEscrow(
            buyer, address(token), AMOUNT, WORK_DURATION, REVIEW_WINDOW, keccak256("terms"), salt
        );
        escrow = EscrowV1(created);
    }

    function _createAndFund(bytes32 salt) internal returns (EscrowV1 escrow) {
        escrow = _create(salt);
        token.mint(buyer, AMOUNT);
        vm.prank(buyer);
        token.approve(address(escrow), AMOUNT);
        vm.prank(outsider);
        escrow.depositFunds();
    }

    function _createFundAndSubmit(bytes32 salt) internal returns (EscrowV1 escrow) {
        escrow = _createAndFund(salt);
        vm.prank(seller);
        escrow.submitDelivery(keccak256("delivery"));
    }

    function _createDisputed(bytes32 salt) internal returns (EscrowV1 escrow) {
        escrow = _createFundAndSubmit(salt);
        vm.prank(buyer);
        escrow.raiseDispute(keccak256("evidence"));
    }

    function _commitment(address escrow, address arbiter, uint8 vote, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(escrow, arbiter, vote, salt));
    }

    function _commit(address escrow, address arbiter, uint8 vote, bytes32 salt) internal {
        vm.prank(arbiter);
        panel.commit(escrow, _commitment(escrow, arbiter, vote, salt));
    }

    function _reveal(address escrow, address arbiter, uint8 vote, bytes32 salt) internal {
        vm.prank(arbiter);
        panel.reveal(escrow, vote, salt);
    }
}

