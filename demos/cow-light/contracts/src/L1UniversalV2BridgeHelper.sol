// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Universal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IBridgeUniversal {
    function bridgeTokens(address token, uint256 amount, uint64 destinationRollup, address destination) external;
}

interface IUniswapV2PairUniversal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice One reusable L1 leg for every WETH/Uniswap-V2 catalog token.
/// The caller supplies the pair and output token; no per-token L1 deployment
/// or solver token inventory is needed. The helper receives WETH through its
/// deterministic L1 proxy, swaps it, and bridges the resulting token directly
/// to the configured L2 settlement contract.
contract L1UniversalV2BridgeHelper {
    address public immutable bridge;
    address public immutable weth;
    address public immutable l2Settlement;
    uint64 public immutable destinationRollup;
    address public immutable authorizedProxy;

    error Unauthorized();
    error InvalidPair();
    error Slippage();
    error TransferFailed();

    constructor(address bridge_, address weth_, address settlement_, uint64 rollup_, address proxy_) {
        bridge = bridge_;
        weth = weth_;
        l2Settlement = settlement_;
        destinationRollup = rollup_;
        authorizedProxy = proxy_;
    }

    function execute(address token, address pair, uint256 minOut) external returns (uint256 out) {
        if (msg.sender != authorizedProxy) revert Unauthorized();
        address t0 = IUniswapV2PairUniversal(pair).token0();
        address t1 = IUniswapV2PairUniversal(pair).token1();
        if ((t0 != weth && t1 != weth) || (token != t0 && token != t1) || token == weth) revert InvalidPair();
        uint256 amount = IERC20Universal(weth).balanceOf(address(this));
        if (amount == 0 || !IERC20Universal(weth).transfer(pair, amount)) revert TransferFailed();
        (uint112 r0, uint112 r1,) = IUniswapV2PairUniversal(pair).getReserves();
        if (t0 == weth) {
            out = amount * 997 * uint256(r1) / (uint256(r0) * 1000 + amount * 997);
            IUniswapV2PairUniversal(pair).swap(0, out, address(this), "");
        } else {
            out = amount * 997 * uint256(r0) / (uint256(r1) * 1000 + amount * 997);
            IUniswapV2PairUniversal(pair).swap(out, 0, address(this), "");
        }
        if (out < minOut) revert Slippage();
        if (!IERC20Universal(token).approve(bridge, out)) revert TransferFailed();
        IBridgeUniversal(bridge).bridgeTokens(token, out, destinationRollup, l2Settlement);
    }
}
