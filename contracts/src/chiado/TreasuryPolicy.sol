// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicyBase} from "../l2/TreasuryPolicyBase.sol";
import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {TreasuryAliasReader} from "./TreasuryAliasReader.sol";
import {TreasuryBridge} from "./TreasuryBridge.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Treasury payments through the existing Chiado lock-then-mint bridge.
/// @dev Retains direct EEZ-X submission as well as L1 Safe initiation. The bridge
///      extension avoids the return callback required by the standard L1 bridge.
contract TreasuryPolicy is TreasuryPolicyBase {
    address public immutable aliasReaderL1;
    TreasuryAliasReader public immutable aliasReaderL1Proxy;

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address aliasReaderL1_,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        TreasuryBridge bridge_
    )
        TreasuryPolicyBase(safeL1_, safeL2_, manager, moduleL1, moduleL2, token, IStandardBridge(address(bridge_)))
    {
        if (aliasReaderL1_ == address(0) || bridge_.treasuryRollupId() != rollupId || bridge_.canonicalToken() != token)
        {
            revert InvalidConfiguration();
        }
        aliasReaderL1 = aliasReaderL1_;
        aliasReaderL1Proxy = TreasuryAliasReader(manager.getOrCreateCrossChainProxy(aliasReaderL1_, 0));
    }

    function _paymentContext() internal view override returns (address alias_, address delegate) {
        alias_ = aliasReaderL1Proxy.aliasOf(address(this), rollupId);
        delegate = alias_;
    }

    function _payL1(address alias_, address recipient, uint256 amount, bool onL1) internal override {
        uint256 beforeBalance = onL1 ? 0 : tokenL1Proxy.balanceOf(alias_);
        allowanceL1Proxy.executeAllowanceTransfer(
            safeL1, canonicalToken, payable(onL1 ? recipient : alias_), uint96(amount), address(0), 0, alias_, ""
        );
        if (!onL1) {
            // The policy's funded alias approves and pays the bridge. Both the
            // temporary custody and approval must be consumed by this entry.
            if (!tokenL1Proxy.approve(bridgeL1, amount)) revert ApprovalFailed();
            TreasuryBridge(address(bridge)).bridgeFromL1(amount, recipient);
            if (tokenL1Proxy.balanceOf(alias_) != beforeBalance || tokenL1Proxy.allowance(alias_, bridgeL1) != 0) {
                revert ResidualBalance();
            }
        }
    }
}
