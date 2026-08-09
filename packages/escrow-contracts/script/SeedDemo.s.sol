// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Script } from "forge-std/Script.sol";
import { ArbiterRegistry } from "../src/ArbiterRegistry.sol";
import { EscrowFactory } from "../src/EscrowFactory.sol";

contract SeedDemo is Script {
    function run() external returns (address demoEscrow) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        ArbiterRegistry registry = ArbiterRegistry(vm.envAddress("ARBITER_REGISTRY"));
        EscrowFactory factory = EscrowFactory(vm.envAddress("ESCROW_FACTORY"));

        vm.startBroadcast(deployerPk);
        registry.setArbiter(vm.envAddress("ARBITER_1"), true);
        registry.setArbiter(vm.envAddress("ARBITER_2"), true);
        registry.setArbiter(vm.envAddress("ARBITER_3"), true);

        if (vm.envOr("CREATE_DEMO_ESCROW", false)) {
            demoEscrow = factory.createEscrow(
                vm.envAddress("DEMO_BUYER"),
                factory.paymentToken(),
                vm.envOr("DEMO_AMOUNT", uint256(100e6)),
                uint64(vm.envOr("DEMO_WORK_DURATION", uint256(1 days))),
                uint64(vm.envOr("DEMO_REVIEW_WINDOW", uint256(1 days))),
                vm.envOr("DEMO_TERMS_HASH", bytes32(0)),
                vm.envOr("DEMO_SALT", bytes32(0))
            );
        }
        vm.stopBroadcast();
    }
}

