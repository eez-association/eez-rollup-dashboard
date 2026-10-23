// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Test} from "forge-std/Test.sol";
import {SharedTestUSDC} from "../src/chiado/SharedTestUSDC.sol";
import {TestUSDCClaim} from "../src/chiado/TestUSDCClaim.sol";

contract FailedTransferFaucet is SharedTestUSDC {
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract TestUSDCClaimTest is Test {
    function testSameWalletCanRequestMoreAfterItsDirectClaim() public {
        SharedTestUSDC token = new SharedTestUSDC();
        address wallet = address(0xABC);
        vm.prank(wallet);
        token.claim();
        vm.prank(wallet);
        vm.expectRevert(SharedTestUSDC.AlreadyClaimed.selector);
        token.claim();
        vm.startPrank(wallet);
        TestUSDCClaim first = new TestUSDCClaim(address(token));
        TestUSDCClaim second = new TestUSDCClaim(address(token));
        vm.stopPrank();
        assertEq(token.balanceOf(wallet), 3 * token.SETUP_FUNDS());
        assertEq(token.totalSupply(), 4 * token.SETUP_FUNDS());
        assertEq(token.balanceOf(address(first)), 0);
        assertEq(token.balanceOf(address(second)), 0);
        assertEq(token.creator(), address(this));
        assertEq(token.bridgeL1(), address(0));
        assertEq(token.bridgeL2(), address(0));
    }

    function testFuzzCreatorCanRequestRepeatedAllocations(uint8 requests) public {
        uint256 count = bound(uint256(requests), 1, 8);
        SharedTestUSDC token = new SharedTestUSDC();
        for (uint256 i; i < count; ++i) {
            TestUSDCClaim claim = new TestUSDCClaim(address(token));
            assertEq(token.balanceOf(address(claim)), 0);
        }
        assertEq(token.balanceOf(address(this)), (count + 1) * token.SETUP_FUNDS());
        assertEq(token.totalSupply(), token.balanceOf(address(this)));
    }

    function testRevertingDeliveryRollsBackTheMint() public {
        FailedTransferFaucet token = new FailedTransferFaucet();
        uint256 supply = token.totalSupply();
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        new TestUSDCClaim(address(token));
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(this)), supply);
    }
}
