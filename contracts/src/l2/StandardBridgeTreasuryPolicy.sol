// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicyBase} from "./TreasuryPolicyBase.sol";
import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {StandardBridgeDelegate} from "../l1/StandardBridgeDelegate.sol";

/// @notice A single canonical USDC budget over two Safe allowance delegates.
/// @dev Submit either Safe through its L1 entry point so standard bridge callbacks
///      remain within the pinned signer profile. Accounting is inherited unchanged.
contract StandardBridgeTreasuryPolicy is TreasuryPolicyBase {
    IStandardBridge public immutable bridgeL1Proxy;
    address public immutable bridgeExecutorL1;
    StandardBridgeDelegate public immutable bridgeExecutorL1Proxy;

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        IStandardBridge bridge_,
        address executor
    )
        TreasuryPolicyBase(safeL1_, safeL2_, manager, moduleL1, moduleL2, token, bridge_)
    {
        if (executor == address(0)) revert InvalidConfiguration();
        bridgeL1Proxy = IStandardBridge(manager.getOrCreateCrossChainProxy(bridgeL1, 0));
        bridgeExecutorL1 = executor;
        bridgeExecutorL1Proxy = StandardBridgeDelegate(manager.getOrCreateCrossChainProxy(executor, 0));
    }

    function _paymentContext() internal view override returns (address alias_, address delegate) {
        if (bridgeL1Proxy.canonicalBridgeAddress() != address(bridge) || bridgeL1Proxy.rollupId() != 0) {
            revert InvalidConfiguration();
        }
        // The Safe binds its delegate once. The client also validates that binding
        // against the registry before accepting the selected treasury.
        alias_ = bridgeExecutorL1Proxy.policyAlias();
        if (alias_ == address(0)) revert InvalidConfiguration();
        delegate = bridgeExecutorL1;
    }

    function _payL1(address, address recipient, uint256 amount, bool onL1) internal override {
        bridgeExecutorL1Proxy.pay(recipient, amount, onL1);
    }
}
