// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";
import {ISafe} from "../interfaces/ISafe.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Safe v1.4.1 contract owner delegating verification to an L1 Safe.
/// @dev The full Safe transaction preimage retains its L2 chain, Safe and nonce domain.
///      Verification requires an authenticated EEZ static entry. An ordinary RPC eth_call
///      without those execution tables can fail even for otherwise valid signatures.
contract L1Owners {
    bytes4 public constant MAGIC_VALUE = 0x20c13b0b;
    uint64 public constant L1_ROLLUP_ID = 0;
    IEEZProxyRegistry public immutable manager;
    address public immutable safeL1;
    address public immutable safeL1Proxy;

    error InvalidManager();
    error InvalidSafe();
    error ProxyNotDeployed(address proxy);
    error InvalidProxyIdentity(address proxy);

    /// @param manager_ The local EEZ-X manager, not the remote L1 registry.
    /// @param safeL1_ The original L1 Safe address, not an alias.
    /// @dev Provision the proxy first: signature verification cannot deploy it under STATICCALL.
    ///      The deployment procedure must independently verify the manager and remote Safe code.
    constructor(IEEZProxyRegistry manager_, address safeL1_) {
        if (address(manager_).code.length == 0 || manager_.ROLLUP_ID() == L1_ROLLUP_ID) revert InvalidManager();
        if (safeL1_ == address(0)) revert InvalidSafe();
        address proxy = manager_.computeCrossChainProxyAddress(safeL1_, L1_ROLLUP_ID);
        if (proxy.code.length == 0) revert ProxyNotDeployed(proxy);
        (bool registered, address original, uint64 origin) = manager_.authorizedProxies(proxy);
        if (!registered || original != safeL1_ || origin != L1_ROLLUP_ID) revert InvalidProxyIdentity(proxy);
        manager = manager_;
        safeL1 = safeL1_;
        safeL1Proxy = proxy;
    }

    /// @notice Returns the legacy EIP-1271 magic value or propagates verification failure.
    /// @dev Safe v1.4.1 uses bytes,bytes here, not the bytes32 overload. checkSignatures
    ///      reads the live L1 threshold and verifies against that Safe's current owners.
    ///      The caller on L1 is this adapter's alias, not the transaction submitter.
    function isValidSignature(bytes calldata data, bytes calldata signatures) external view returns (bytes4) {
        ISafe(safeL1Proxy).checkSignatures(keccak256(data), data, signatures);
        return MAGIC_VALUE;
    }
}
