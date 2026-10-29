// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20L2Universal { function approve(address, uint256) external returns (bool); }
interface IBridgeL2Universal { function bridgeTokens(address, uint256, uint64, address) external; }
interface IL1ProxyUniversal { function execute(address token, address pair, uint256 minOut) external; }

/// @notice Reusable L2 half of the universal catalog-token route.
/// GPv2 calls this once; the L1 proxy invokes the one generic L1 helper with
/// the selected token/pair, so no token-specific L1 contract is deployed.
contract L2UniversalV2Route {
    address public immutable bridge;
    address public immutable wrappedWeth;
    address public immutable settlement;
    address public immutable admin;
    address public l1Proxy;
    address public l1Helper;

    error Unauthorized();
    error Configured();

    constructor(address bridge_, address wrappedWeth_, address settlement_) {
        bridge = bridge_; wrappedWeth = wrappedWeth_; settlement = settlement_; admin = msg.sender;
    }

    function configure(address proxy, address helper) external {
        if (msg.sender != admin) revert Unauthorized();
        if (l1Proxy != address(0)) revert Configured();
        l1Proxy = proxy; l1Helper = helper;
    }

    function startHeld(uint256 amount, address token, address pair, uint256 minOut) external {
        if (msg.sender != settlement) revert Unauthorized();
        if (!IERC20L2Universal(wrappedWeth).approve(bridge, amount)) revert Unauthorized();
        IBridgeL2Universal(bridge).bridgeTokens(wrappedWeth, amount, 0, l1Helper);
        IL1ProxyUniversal(l1Proxy).execute(token, pair, minOut);
    }
}
