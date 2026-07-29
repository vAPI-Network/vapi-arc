// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EvaluationRouter} from "../src/EvaluationRouter.sol";

/// Deploys EvaluationRouter to Arc Testnet.
/// Env: AGENTIC_COMMERCE, ORACLE_ADDR, HUMAN_RESOLVER (Circle treasury wallet;
/// falls back to HUMAN_ADDR), AUTO_SETTLE_CAP (6dp), MIN_CONFIDENCE_BP.
/// Run: forge script script/DeployRouter.s.sol --rpc-url $ARC_RPC_URL --private-key $CLIENT_PK --broadcast
contract DeployRouter is Script {
    function run() external {
        address targetAddr = vm.envAddress("AGENTIC_COMMERCE");
        address oracle = vm.envAddress("ORACLE_ADDR");
        address human = vm.envOr("HUMAN_RESOLVER", address(0));
        if (human == address(0)) human = vm.envAddress("HUMAN_ADDR");
        uint256 cap = vm.envOr("AUTO_SETTLE_CAP", uint256(100e6));
        uint16 minConf = uint16(vm.envOr("MIN_CONFIDENCE_BP", uint256(8000)));

        vm.startBroadcast();
        EvaluationRouter router = new EvaluationRouter(targetAddr, oracle, human, cap, minConf);
        vm.stopBroadcast();

        console.log("EvaluationRouter deployed:", address(router));
        console.log("  target:", targetAddr);
        console.log("  oracle:", oracle);
        console.log("  humanResolver:", human);
        console.log("  autoSettleCap:", cap);
        console.log("  minConfidenceBP:", minConf);
    }
}
