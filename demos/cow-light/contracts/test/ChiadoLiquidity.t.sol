// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ChiadoLiquidity, ChiadoTestToken} from "../src/ChiadoLiquidity.sol";

interface VmBootstrap {
    function chainId(uint256) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseBytes(string calldata) external pure returns (bytes memory);
    function expectRevert(bytes calldata) external;
    function prank(address) external;
}

interface IBootstrapPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function balanceOf(address) external view returns (uint256);
}

contract BootstrapBridge {
    function bridgeTokens(address token, uint256 amount, uint64, address) external {
        ChiadoTestToken(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract ChiadoLiquidityTest {
    VmBootstrap constant vm = VmBootstrap(address(uint160(uint256(keccak256("hevm cheat code")))));
    ChiadoLiquidity fixture;
    BootstrapBridge bridge;

    function setUp() public {
        vm.chainId(10200);
        string memory json = vm.readFile("node_modules/@uniswap/v2-core/build/UniswapV2Factory.json");
        string memory raw = vm.parseJsonString(json, ".bytecode");
        bytes memory creation = abi.encodePacked(vm.parseBytes(string.concat("0x", raw)), abi.encode(address(this)));
        address factory;
        assembly { factory := create(0, add(creation, 32), mload(creation)) }
        require(factory != address(0), "factory deployment");
        bridge = new BootstrapBridge();
        fixture = new ChiadoLiquidity(factory, address(bridge), 1, address(this));
    }

    function testSeedsRealV2PoolOnce() public view {
        (uint112 r0, uint112 r1,) = IBootstrapPair(fixture.pair()).getReserves();
        require(uint256(r0) * r1 == 1000 ether * 100000 ether, "reserves");
        require(IBootstrapPair(fixture.pair()).balanceOf(address(this)) > 0, "LP owner");
        require(fixture.weth().balanceOf(address(this)) == 1000 ether, "test funding");
    }

    function testWrapperInitializationOncePerAsset() public {
        address asset = address(fixture.weth());
        fixture.initializeWrapper(asset);
        require(fixture.weth().balanceOf(address(bridge)) == 1 ether, "bridge funding");
        vm.expectRevert(bytes("initialized"));
        fixture.initializeWrapper(asset);
        fixture.initializeWrapper(address(fixture.token()));
    }

    function testNonOwnerCannotInitialize() public {
        address asset = address(fixture.weth());
        vm.prank(address(123));
        vm.expectRevert(bytes("owner"));
        fixture.initializeWrapper(asset);
    }

    function testMainnetDeploymentForbidden() public {
        vm.chainId(1);
        vm.expectRevert(bytes("Chiado only"));
        new ChiadoTestToken("Test", "TEST", 1);
        vm.expectRevert(bytes("Chiado only"));
        new ChiadoLiquidity(address(bridge), address(bridge), 1, address(this));
    }
}
