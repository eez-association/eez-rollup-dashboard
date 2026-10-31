// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {BridgeTestToken} from "../src/testnet/BridgeTestToken.sol";

contract BridgeTestTokenTest is Test {
    function testDeploymentMintsOnlyToSender() public {
        address sender = makeAddr("sender");
        vm.prank(sender);
        BridgeTestToken token = new BridgeTestToken("Bridge Test Token", "TEST", 10_000 ether);
        assertEq(token.balanceOf(sender), 10_000 ether);
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(token.totalSupply(), 10_000 ether);
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Bridge Test Token");
        assertEq(token.symbol(), "TEST");
    }

    function testBridgeCanSpendOnlyApprovedAmount() public {
        BridgeTestToken token = new BridgeTestToken("Test", "TEST", 100 ether);
        address bridge = makeAddr("bridge");
        token.approve(bridge, 2 ether);
        vm.prank(bridge);
        token.transferFrom(address(this), bridge, 2 ether);
        assertEq(token.balanceOf(bridge), 2 ether);
        assertEq(token.allowance(address(this), bridge), 0);
        vm.prank(bridge);
        vm.expectRevert();
        token.transferFrom(address(this), bridge, 1);
    }

    function testRejectsEmptyMetadataAndSupply() public {
        vm.expectRevert(BridgeTestToken.InvalidToken.selector);
        new BridgeTestToken("", "TEST", 1);
        vm.expectRevert(BridgeTestToken.InvalidToken.selector);
        new BridgeTestToken("Test", "", 1);
        vm.expectRevert(BridgeTestToken.InvalidToken.selector);
        new BridgeTestToken("Test", "TEST", 0);
    }
}
