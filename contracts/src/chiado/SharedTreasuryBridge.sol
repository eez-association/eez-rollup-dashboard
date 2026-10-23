// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryBridge} from "./TreasuryBridge.sol";
import {IEEZ} from "eez-core-protocol/src/interfaces/IEEZ.sol";
import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Treasury bridge whose peer is fixed before other treasuries reuse it.
contract SharedTreasuryBridge is TreasuryBridge {
    constructor(
        address token,
        uint64 destinationRollup,
        address manager_,
        uint64 localRollup,
        address admin_
    )
        TreasuryBridge(token, destinationRollup)
    {
        // Bind initialization during creation; nobody can claim an uninitialized bridge.
        if (
            manager_.code.length == 0 || admin_ == address(0)
                || (localRollup != 0
                    && (localRollup != destinationRollup || IEEZProxyRegistry(manager_).ROLLUP_ID() != localRollup))
        ) revert InvalidRoute();
        manager = IEEZ(manager_);
        rollupId = localRollup;
        admin = admin_;
    }

    function seal() external onlyAdmin {
        if (canonicalBridgeAddress == address(0)) revert InvalidRoute();
        // No reachable caller is address(0); inherited administration is disabled.
        admin = address(0);
    }
}
