// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITestUSDCFaucet {
    function claim() external;
}

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Receive another faucet allocation of the existing Test USDC.
/// @dev The deployed token limits claims by caller and cannot be upgraded. A
///      fresh claim contract forwards its allocation to the deploying wallet,
///      so repeated requests keep the same token and bridge bindings. This is
///      testnet tooling, never part of treasury setup or the payment path.
contract TestUSDCClaim {
    using SafeERC20 for IERC20;

    constructor(address token) {
        ITestUSDCFaucet(token).claim();
        IERC20(token).safeTransfer(msg.sender, IERC20(token).balanceOf(address(this)));
    }
}
