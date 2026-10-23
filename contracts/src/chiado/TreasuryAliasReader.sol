// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// L1 alias lookup for treasury calls originating on EEZ-X.
/// @dev Newer EEZ deployments reject cross-chain calls targeting the manager itself.
///      This helper is the remote target; its read of the L1 registry is a local call.
contract TreasuryAliasReader {
    IEEZProxyRegistry public immutable registry;

    error InvalidRegistry();

    constructor(IEEZProxyRegistry registry_) {
        if (address(registry_).code.length == 0) revert InvalidRegistry();
        registry = registry_;
    }

    function aliasOf(address original, uint64 rollupId) external view returns (address) {
        return registry.computeCrossChainProxyAddress(original, rollupId);
    }
}
