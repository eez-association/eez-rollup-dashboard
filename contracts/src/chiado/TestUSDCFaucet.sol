// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TestUSDCClaim} from "./TestUSDCClaim.sol";

interface ITestUSDCBridge {
    function canonicalToken() external view returns (address);
    function treasuryRollupId() external view returns (uint64);
    function rollupId() external view returns (uint64);
    function bridgeTokens(address token, uint256 amount, uint64 destination, address recipient) external;
}

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Exact, repeatable test-token deliveries through the existing bridge.
/// @dev The immutable token issues fixed allocations. Fresh callers refill this
///      permissionless dispenser; excess stays here for later requests. No user
///      deposit, ownership privilege or treasury spending allowance is involved.
contract TestUSDCFaucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    ITestUSDCBridge public immutable bridge;
    uint64 public immutable destinationRollup;
    bool private delivering;

    error InvalidRequest();
    error InvalidBridge();
    error EmptyClaim();
    error Reentered();
    event TokensRequested(address indexed requester, address indexed recipient, bool onL2, uint256 amount);

    constructor(address token_, address bridge_) {
        token = IERC20(token_);
        bridge = ITestUSDCBridge(bridge_);
        uint64 rollup = bridge.treasuryRollupId();
        if (bridge.canonicalToken() != token_ || bridge.rollupId() != 0 || rollup == 0) revert InvalidBridge();
        destinationRollup = rollup;
    }

    function request(address recipient, uint256 amount, bool onL2) external {
        _request(recipient, amount, onL2);
    }

    function _request(address recipient, uint256 amount, bool onL2) private {
        if (recipient == address(0) || recipient == address(this) || amount == 0) revert InvalidRequest();
        if (delivering) revert Reentered();
        delivering = true;
        uint256 available = token.balanceOf(address(this));
        while (available < amount) {
            new TestUSDCClaim(address(token));
            uint256 next = token.balanceOf(address(this));
            if (next <= available) revert EmptyClaim();
            available = next;
        }
        if (onL2) {
            token.forceApprove(address(bridge), amount);
            bridge.bridgeTokens(address(token), amount, destinationRollup, recipient);
            token.forceApprove(address(bridge), 0);
        } else {
            token.safeTransfer(recipient, amount);
        }
        emit TokensRequested(msg.sender, recipient, onL2, amount);
        delivering = false;
    }
}
