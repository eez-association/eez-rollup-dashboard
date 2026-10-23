// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Bounded Ethereum spending delegate controlled by one rollup policy.
/// @dev The Safe binds its policy alias once and grants the official module's
/// allowance separately. Transfer, approval and bridging share one L1 call so
/// execution does not depend on several mutable L1 callback snapshots. No module
/// authority, owner keys or arbitrary external calls are granted to this delegate.
contract StandardBridgeDelegate {
    using SafeERC20 for IERC20;
    address public immutable safe;
    IAllowanceModule public immutable allowance;
    IERC20 public immutable token;
    IStandardBridge public immutable bridge;
    uint64 public immutable rollupId;
    address public policyAlias;
    bool private entered;

    error OnlySafe();
    error OnlyPolicy();
    error InvalidConfiguration();
    error ResidualFunds();
    error Reentered();
    event PolicyBound(address indexed policyAlias);

    constructor(address safe_, IAllowanceModule allowance_, IERC20 token_, IStandardBridge bridge_, uint64 rollup) {
        if (
            safe_.code.length == 0 || address(allowance_).code.length == 0 || address(token_).code.length == 0
                || bridge_.rollupId() != 0 || rollup == 0
        ) revert InvalidConfiguration();
        safe = safe_;
        allowance = allowance_;
        token = token_;
        bridge = bridge_;
        rollupId = rollup;
    }

    function bindPolicy(address alias_) external {
        if (msg.sender != safe) revert OnlySafe();
        if (policyAlias != address(0) || alias_.code.length == 0) revert InvalidConfiguration();
        policyAlias = alias_;
        emit PolicyBound(alias_);
    }

    function pay(address recipient, uint256 amount, bool onL1) external {
        if (msg.sender != policyAlias) revert OnlyPolicy();
        if (entered) revert Reentered();
        if (amount == 0 || amount > type(uint96).max || recipient == address(0) || recipient == address(this)) {
            revert InvalidConfiguration();
        }
        entered = true;
        uint256 beforeBalance = token.balanceOf(address(this));
        allowance.executeAllowanceTransfer(
            safe,
            address(token),
            payable(onL1 ? recipient : address(this)),
            uint96(amount),
            address(0),
            0,
            address(this),
            ""
        );
        if (!onL1) {
            if (token.balanceOf(address(this)) != beforeBalance + amount) revert ResidualFunds();
            token.forceApprove(address(bridge), amount);
            bridge.bridgeTokens(address(token), amount, rollupId, recipient);
            if (token.allowance(address(this), address(bridge)) != 0) revert ResidualFunds();
        }
        if (token.balanceOf(address(this)) != beforeBalance) revert ResidualFunds();
        entered = false;
    }
}
