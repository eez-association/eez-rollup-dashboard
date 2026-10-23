// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";

/// @notice Permissionless six-decimal test token. Not Circle USDC or production money.
/// @dev Anyone may mint repeatedly. L2 claims use the normal L1 bridge's lock/mint path.
contract TestUSDC is ERC20 {
    uint256 public constant MAX_REQUEST_AMOUNT = 1_000_000_000; // 1,000 tokens, six decimals
    address public immutable creator;
    IStandardBridge public bridgeL1;

    error InvalidRegistration();
    error InvalidRequest();
    error IncompleteBridge();
    event BridgeRegistered(address indexed bridgeL1);
    event ClaimedOnL2(address indexed requester, address indexed recipient, uint64 indexed rollupId, uint256 amount);

    constructor() ERC20("Test USD Coin", "Test USDC") {
        creator = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint up to 1,000 tokens to a nonzero recipient, repeatedly.
    function mint(address recipient, uint256 amount) external {
        if (amount == 0 || amount > MAX_REQUEST_AMOUNT) revert InvalidRequest();
        _mint(recipient, amount);
    }

    /// @notice Bind the existing L1 bridge once. No L2 address or custom bridge is needed here.
    function registerBridge(IStandardBridge bridge) external {
        if (
            msg.sender != creator || address(bridgeL1) != address(0) || address(bridge).code.length == 0
                || bridge.rollupId() != 0
        ) revert InvalidRegistration();
        bridgeL1 = bridge;
        emit BridgeRegistered(address(bridge));
    }

    /// @notice Mint and bridge an exact amount to a recipient on the selected rollup.
    /// @dev The bridge pulls from this contract, not the caller. All minting and
    ///      approvals revert if bridging fails. The normal bridge creates the
    ///      wrapped token on first use; this contract needs only its L1 address.
    function claimOnL2(address recipient, uint256 amount, uint64 destinationRollup) external {
        IStandardBridge bridge = bridgeL1;
        if (
            address(bridge) == address(0) || recipient == address(0) || amount == 0
                || amount > MAX_REQUEST_AMOUNT || destinationRollup == 0
        ) {
            revert InvalidRequest();
        }
        uint256 beforeBalance = balanceOf(address(this));
        _mint(address(this), amount);
        _approve(address(this), address(bridge), amount);
        bridge.bridgeTokens(address(this), amount, destinationRollup, recipient);
        _approve(address(this), address(bridge), 0);
        if (balanceOf(address(this)) != beforeBalance) revert IncompleteBridge();
        emit ClaimedOnL2(msg.sender, recipient, destinationRollup, amount);
    }
}
