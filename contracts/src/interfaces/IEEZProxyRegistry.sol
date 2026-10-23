// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Local proxy registry ABI from EEZ core 855fe060.
interface IEEZProxyRegistry {
    // EEZ L1 and EEZL2 expose different local-rollup getters.
    function MAINNET_ROLLUP_ID() external view returns (uint64);
    function ROLLUP_ID() external view returns (uint64);
    function computeCrossChainProxyAddress(address original, uint64 rollupId) external view returns (address);
    function authorizedProxies(address proxy) external view returns (bool isProxy, address original, uint64 rollupId);
    function getOrCreateCrossChainProxy(address original, uint64 rollupId) external returns (address);
}
