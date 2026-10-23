// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TreasuryBridge} from "./TreasuryBridge.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Permissionless six-decimal demo faucet shared by treasury setups.
/// @dev Not Circle USDC. The fixed claim is per caller, not a Sybil-resistant limit.
contract SharedTestUSDC is ERC20 {
    uint256 public constant SETUP_FUNDS = 450_000_000;
    address public immutable creator;
    address public bridgeL1;
    address public bridgeL2;
    mapping(address caller => bool received) public claimed;

    error AlreadyClaimed();
    error InvalidRegistration();
    event TreasuryInfrastructureRegistered(address indexed token, address indexed l1Bridge, address indexed l2Bridge);

    constructor() ERC20("Test USD Coin", "Test USDC") {
        creator = msg.sender;
        _claim();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function claim() external {
        _claim();
    }

    /// @notice Publish a once-only bridge binding after freezing the L1 peer.
    /// @dev Clients additionally verify the remote runtime, manager and peer on
    ///      EEZ-X. A registration event alone does not establish remote validity.
    function registerBridges(address l1Bridge, address l2Bridge) external {
        if (msg.sender != creator || bridgeL1 != address(0) || l2Bridge == address(0)) revert InvalidRegistration();
        TreasuryBridge local = TreasuryBridge(l1Bridge);
        if (
            local.canonicalToken() != address(this) || local.rollupId() != 0 || local.admin() != address(0)
                || local.canonicalBridgeAddress() != l2Bridge
        ) revert InvalidRegistration();
        bridgeL1 = l1Bridge;
        bridgeL2 = l2Bridge;
        emit TreasuryInfrastructureRegistered(address(this), l1Bridge, l2Bridge);
    }

    function _claim() private {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true;
        _mint(msg.sender, SETUP_FUNDS);
    }
}
