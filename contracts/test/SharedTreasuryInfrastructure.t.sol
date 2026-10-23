// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OwnerFixture} from "./helpers/OwnerFixture.sol";
import {SharedTestUSDC} from "../src/chiado/SharedTestUSDC.sol";
import {SharedTreasuryBridge} from "../src/chiado/SharedTreasuryBridge.sol";
import {TreasuryBridge} from "../src/chiado/TreasuryBridge.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SharedTreasuryInfrastructureTest is OwnerFixture {
    function testFaucetFundsSeparateSetupsAndRejectsARepeatedClaim() public {
        SharedTestUSDC token = new SharedTestUSDC();
        assertEq(token.decimals(), 6);
        assertEq(token.balanceOf(address(this)), 450_000_000);
        address second = address(0xABC);
        vm.prank(second);
        token.claim();
        assertEq(token.balanceOf(second), 450_000_000);
        assertEq(token.totalSupply(), 900_000_000);
        vm.prank(second);
        vm.expectRevert(SharedTestUSDC.AlreadyClaimed.selector);
        token.claim();
        vm.expectRevert(SharedTestUSDC.AlreadyClaimed.selector);
        token.claim();
    }

    function testSharedPeersAreFrozenAndBothDirectionsKeepSupplyBacked() public {
        SharedTestUSDC token = new SharedTestUSDC();
        SharedTreasuryBridge first = new SharedTreasuryBridge(address(token), ROLLUP_ID, address(l1), 0, address(this));
        SharedTreasuryBridge second =
            new SharedTreasuryBridge(address(token), ROLLUP_ID, address(l2), ROLLUP_ID, address(this));
        vm.expectRevert(TreasuryBridge.InvalidRoute.selector);
        first.seal();
        first.setCanonicalBridgeAddress(address(second));
        second.setCanonicalBridgeAddress(address(first));
        vm.expectRevert(SharedTestUSDC.InvalidRegistration.selector);
        token.registerBridges(address(first), address(second));
        first.seal();
        second.seal();
        token.registerBridges(address(first), address(second));
        vm.expectRevert(SharedTestUSDC.InvalidRegistration.selector);
        token.registerBridges(address(first), address(second));
        vm.prank(address(0xBAD));
        vm.expectRevert(SharedTestUSDC.InvalidRegistration.selector);
        token.registerBridges(address(first), address(second));
        vm.expectRevert(Bridge.OnlyAdmin.selector);
        first.setCanonicalBridgeAddress(address(0xBAD));
        vm.expectRevert(Bridge.OnlyAdmin.selector);
        second.setCanonicalBridgeAddress(address(0xBAD));
        assertTrue(token.approve(address(first), 150_000_000));
        first.bridgeTokens(address(token), 150_000_000, ROLLUP_ID, address(this));
        IERC20 wrapped = IERC20(second.getWrappedToken(address(token), 0));
        assertEq(wrapped.balanceOf(address(this)), 150_000_000);
        second.bridgeTokens(address(wrapped), 10_000_000, 0, address(0xAAA));
        assertEq(token.balanceOf(address(0xAAA)), 10_000_000);
        // A different treasury caller uses the same bridge and its own L1 alias.
        address payer = address(0xBBB);
        address payerAlias = l1.getOrCreateCrossChainProxy(payer, ROLLUP_ID);
        assertTrue(token.transfer(payerAlias, 20_000_000));
        vm.prank(payerAlias);
        assertTrue(token.approve(address(first), 20_000_000));
        vm.prank(payer);
        second.bridgeFromL1(20_000_000, address(0xCCC));
        assertEq(wrapped.balanceOf(address(0xCCC)), 20_000_000);
        assertEq(token.balanceOf(payerAlias), 0);
        assertEq(token.allowance(payerAlias, address(first)), 0);
        assertEq(wrapped.totalSupply(), token.balanceOf(address(first)));
        assertEq(token.bridgeL1(), address(first));
        assertEq(token.bridgeL2(), address(second));
    }
}
