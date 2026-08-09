// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Script } from "forge-std/Script.sol";
import { ArbiterRegistry } from "../src/ArbiterRegistry.sol";
import { DisputePanel } from "../src/DisputePanel.sol";
import { EscrowFactory } from "../src/EscrowFactory.sol";
import { FeeRouter } from "../src/FeeRouter.sol";
import { ReputationRegistryV0 } from "../src/ReputationRegistryV0.sol";

contract Deploy is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint16 internal constant FEE_BP = 500;

    error CanonicalDeployerUnavailable();
    error DeterministicDeploymentFailed(bytes32 salt);
    error MissingChainAddress(string key);
    error InvalidWindow();

    function run()
        external
        returns (
            FeeRouter feeRouter,
            ArbiterRegistry registry,
            DisputePanel panel,
            EscrowFactory factory,
            ReputationRegistryV0 reputation
        )
    {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        address paymentToken = _chainAddress("PAYMENT_TOKEN");
        address treasury = _chainAddress("TREASURY");
        address council = vm.envAddress("COUNCIL");
        bytes32 baseSalt = vm.envBytes32("CREATE2_SALT");

        uint64 offerTtl = uint64(vm.envOr("OFFER_TTL", uint256(1 days)));
        uint64 deadlockTimeout = uint64(vm.envOr("DEADLOCK_TIMEOUT", uint256(7 days)));
        uint64 evidenceWindow = _window("EVIDENCE_WINDOW", 1 days);
        uint64 commitWindow = _window("COMMIT_WINDOW", 1 days);
        uint64 revealWindow = _window("REVEAL_WINDOW", 1 days);

        vm.startBroadcast(deployerPk);
        feeRouter = FeeRouter(
            _deploy(
                _salt(baseSalt, "FeeRouter"),
                abi.encodePacked(type(FeeRouter).creationCode, abi.encode(treasury, FEE_BP))
            )
        );
        registry = ArbiterRegistry(
            _deploy(
                _salt(baseSalt, "ArbiterRegistry"),
                abi.encodePacked(
                    type(ArbiterRegistry).creationCode, abi.encode(deployer, address(0))
                )
            )
        );
        panel = DisputePanel(
            _deploy(
                _salt(baseSalt, "DisputePanel"),
                abi.encodePacked(
                    type(DisputePanel).creationCode,
                    abi.encode(
                        deployer, address(registry), evidenceWindow, commitWindow, revealWindow
                    )
                )
            )
        );
        factory = EscrowFactory(
            _deploy(
                _salt(baseSalt, "EscrowFactory"),
                abi.encodePacked(
                    type(EscrowFactory).creationCode,
                    abi.encode(
                        paymentToken,
                        address(feeRouter),
                        address(panel),
                        council,
                        offerTtl,
                        deadlockTimeout
                    )
                )
            )
        );

        if (panel.factory() == address(0)) panel.setFactory(address(factory));

        address arbiter1 = vm.envAddress("ARBITER_1");
        address arbiter2 = vm.envAddress("ARBITER_2");
        address arbiter3 = vm.envAddress("ARBITER_3");
        registry.setArbiter(arbiter1, true);
        registry.setArbiter(arbiter2, true);
        registry.setArbiter(arbiter3, true);

        reputation = ReputationRegistryV0(
            _deploy(
                _salt(baseSalt, "ReputationRegistryV0"),
                abi.encodePacked(
                    type(ReputationRegistryV0).creationCode, abi.encode(address(factory))
                )
            )
        );
        vm.stopBroadcast();

        _writeDeployment(feeRouter, registry, panel, factory, reputation);
    }

    function _deploy(bytes32 salt, bytes memory initCode) private returns (address deployed) {
        deployed = _computeAddress(salt, keccak256(initCode));
        if (deployed.code.length != 0) return deployed;
        if (CREATE2_DEPLOYER.code.length == 0) revert CanonicalDeployerUnavailable();

        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        if (!success || deployed.code.length == 0) revert DeterministicDeploymentFailed(salt);
    }

    function _computeAddress(bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash))
                )
            )
        );
    }

    function _salt(bytes32 baseSalt, string memory label) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseSalt, label));
    }

    function _window(string memory key, uint64 fallbackValue) private view returns (uint64 value) {
        value = uint64(vm.envOr(key, uint256(fallbackValue)));
        if (value < 60) revert InvalidWindow();
    }

    function _chainAddress(string memory key) private view returns (address value) {
        value = vm.envOr(key, address(0));
        if (value != address(0)) return value;

        string memory chainKey;
        if (block.chainid == 84532) chainKey = string.concat(key, "_BASE_SEPOLIA");
        else if (block.chainid == 5_042_002) chainKey = string.concat(key, "_ARC_TESTNET");
        else revert MissingChainAddress(key);
        value = vm.envAddress(chainKey);
    }

    function _writeDeployment(
        FeeRouter feeRouter,
        ArbiterRegistry registry,
        DisputePanel panel,
        EscrowFactory factory,
        ReputationRegistryV0 reputation
    ) private {
        string memory objectKey = "deployment";
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeAddress(objectKey, "feeRouter", address(feeRouter));
        vm.serializeAddress(objectKey, "arbiterRegistry", address(registry));
        vm.serializeAddress(objectKey, "disputePanel", address(panel));
        vm.serializeAddress(objectKey, "escrowFactory", address(factory));
        vm.serializeAddress(objectKey, "escrowImplementation", factory.implementation());
        string memory json =
            vm.serializeAddress(objectKey, "reputationRegistry", address(reputation));
        vm.writeJson(json, _deploymentPath());
    }

    function _deploymentPath() private view returns (string memory) {
        string memory chainName;
        if (block.chainid == 84532) chainName = "base-sepolia";
        else if (block.chainid == 5_042_002) chainName = "arc-testnet";
        else chainName = vm.toString(block.chainid);
        return string.concat(vm.projectRoot(), "/deployments/", chainName, ".json");
    }
}
