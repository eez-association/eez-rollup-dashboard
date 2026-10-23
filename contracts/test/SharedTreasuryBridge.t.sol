// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {OwnerFixture} from "./helpers/OwnerFixture.sol";
import {SharedTreasuryBridge} from "../src/chiado/SharedTreasuryBridge.sol";
import {TreasuryBridge} from "../src/chiado/TreasuryBridge.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {DevnetUSDC} from "./fixtures/DevnetUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SharedTreasuryBridgeTest is OwnerFixture {
    function testConstructorBindingsCannotBeTakenOverAndPairBridgesBackedTokens() public {
        DevnetUSDC token = new DevnetUSDC();
        SharedTreasuryBridge first = new SharedTreasuryBridge(address(token), ROLLUP_ID, address(l1), 0, address(this));
        SharedTreasuryBridge second =
            new SharedTreasuryBridge(address(token), ROLLUP_ID, address(l2), ROLLUP_ID, address(this));
        vm.prank(address(0xBAD));
        vm.expectRevert(Bridge.AlreadyInitialized.selector);
        first.initialize(address(l2), ROLLUP_ID, address(0xBAD));
        assertEq(address(first.manager()), address(l1));
        assertEq(first.admin(), address(this));
        assertEq(first.rollupId(), 0);
        first.setCanonicalBridgeAddress(address(second));
        second.setCanonicalBridgeAddress(address(first));
        token.approve(address(first), 150_000_000);
        first.bridgeTokens(address(token), 150_000_000, ROLLUP_ID, address(safeL2));
        IERC20 wrapped = IERC20(second.getWrappedToken(address(token), 0));
        assertEq(wrapped.balanceOf(address(safeL2)), 150_000_000);
        assertEq(wrapped.totalSupply(), token.balanceOf(address(first)));
    }

    function testRejectsWrongLocalManagerAndZeroAdmin() public {
        vm.expectRevert(TreasuryBridge.InvalidRoute.selector);
        new SharedTreasuryBridge(address(0x1234), ROLLUP_ID, address(l1), ROLLUP_ID, address(this));
        vm.expectRevert(TreasuryBridge.InvalidRoute.selector);
        new SharedTreasuryBridge(address(0x1234), ROLLUP_ID, address(l1), 0, address(0));
    }
}
