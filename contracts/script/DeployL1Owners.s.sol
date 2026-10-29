// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {L1Owners} from "../src/l2/L1Owners.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";

/// @notice Deploys only the adapter and its required local proxy; no funding or Safe administration.
/// @dev Read inputs from the invocation environment, never the dashboard's operator .env.
///      Run without --broadcast first. L1 Safe and local manager identities must be verified
///      independently; the expected manager runtime hash pins the inspected local bytecode.
contract DeployL1Owners is Script {
    function run() external returns (L1Owners adapter) {
        uint256 expectedChain = vm.envUint("TREASURY_L2_CHAIN_ID");
        uint256 expectedRollup = vm.envUint("TREASURY_ROLLUP_ID");
        address managerAddress = vm.envAddress("TREASURY_L2_MANAGER");
        bytes32 expectedCodeHash = vm.envBytes32("TREASURY_L2_MANAGER_CODEHASH");
        address safeL1 = vm.envAddress("TREASURY_SAFE_L1");
        require(block.chainid == expectedChain && expectedChain != 0, "wrong L2 chain");
        require(managerAddress.code.length > 0 && managerAddress.codehash == expectedCodeHash, "manager code mismatch");
        IEEZProxyRegistry manager = IEEZProxyRegistry(managerAddress);
        require(expectedRollup > 0 && manager.ROLLUP_ID() == expectedRollup, "wrong rollup");
        require(safeL1 != address(0), "zero L1 Safe");
        vm.startBroadcast();
        manager.getOrCreateCrossChainProxy(safeL1, 0);
        adapter = new L1Owners(manager, safeL1);
        vm.stopBroadcast();
    }
}
