// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";

/// @notice Permissionless test faucet: every claim issues 1,000 tokens. Not real USDC.
contract TestUSDC is ERC20 {
    uint256 public constant MAX_REQUEST_AMOUNT = 1_000_000_000; // 1,000 tokens, six decimals
    IStandardBridge public immutable bridgeL1;
    uint64 public immutable destinationRollup;

    error InvalidBridge();
    error InvalidRecipient();
    error IncompleteBridge();
    event ClaimedOnL2(address indexed requester, address indexed recipient, uint256 amount);

    constructor(IStandardBridge bridge_, uint64 rollup) ERC20("Test USD Coin", "Test USDC") {
        if (address(bridge_).code.length == 0 || rollup == 0 || bridge_.rollupId() != 0) revert InvalidBridge();
        bridgeL1 = bridge_;
        destinationRollup = rollup;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Send 1,000 tokens to the recipient on L1. Anyone can call repeatedly.
    function claim(address recipient) external {
        _mint(recipient, MAX_REQUEST_AMOUNT);
    }

    /// @notice Send 1,000 tokens to the recipient on L2 through the normal bridge.
    function claimOnL2(address recipient) external {
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 beforeBalance = balanceOf(address(this));
        _mint(address(this), MAX_REQUEST_AMOUNT);
        _approve(address(this), address(bridgeL1), MAX_REQUEST_AMOUNT);
        bridgeL1.bridgeTokens(address(this), MAX_REQUEST_AMOUNT, destinationRollup, recipient);
        _approve(address(this), address(bridgeL1), 0);
        if (balanceOf(address(this)) != beforeBalance) revert IncompleteBridge();
        emit ClaimedOnL2(msg.sender, recipient, MAX_REQUEST_AMOUNT);
    }
}
