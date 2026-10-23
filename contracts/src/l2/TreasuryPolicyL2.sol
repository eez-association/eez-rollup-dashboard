// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PairedTreasuryPolicy} from "../shared/PairedTreasuryPolicy.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The L2 half of a paired treasury. Its local Safe grants its allowance to this policy.
contract TreasuryPolicyL2 is PairedTreasuryPolicy {
    constructor(address safe_, IAllowanceModule module, IERC20 token_, IStandardBridge bridge_, uint64 rollup)
        PairedTreasuryPolicy(safe_, module, token_, bridge_, rollup)
    {
        if (localRollupId != rollup) revert InvalidConfiguration();
    }
}
