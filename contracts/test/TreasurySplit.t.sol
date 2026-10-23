// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {TreasuryPolicyBase} from "../src/l2/TreasuryPolicyBase.sol";
import {BidirectionalTreasuryPolicyTest} from "./BidirectionalTreasuryPolicy.t.sol";
import {TreasuryPolicy} from "../src/chiado/TreasuryPolicy.sol";
import {TreasuryAliasReader} from "../src/chiado/TreasuryAliasReader.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TreasurySplitTest is BidirectionalTreasuryPolicyTest {
    function _splitData(bool onL1, uint256 amount, uint256 fromL1) internal view returns (bytes memory) {
        return abi.encodeCall(policy.paySplit, (recipient, amount, onL1, block.timestamp / 600, fromL1));
    }

    function testFuzzExactSplitBothSourcesAndDestinations(
        bool sourceL1,
        bool onL1,
        uint256 total,
        uint256 first
    )
        public
    {
        total = bound(total, 1, 150 * U);
        first = bound(first, total > 100 * U ? total - 100 * U : 0, total < 100 * U ? total : 100 * U);
        bytes memory data = _splitData(onL1, total, first);
        if (sourceL1) _fromL1(data);
        else _callL2(address(policy), data);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U - first);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U - (total - first));
        assertEq(onL1 ? usdc.balanceOf(recipient) : wrapped.balanceOf(recipient), total);
        assertEq(_spent(true), first);
        assertEq(_spent(false), total - first);
        assertEq(policy.spent(block.timestamp / 600), total);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
    }

    function testExactSplitDoesNotRebalanceOrExceedGlobal() public {
        _callL2(address(policy), _splitData(false, 100 * U, 0));
        vm.startPrank(address(safeL2));
        vm.expectRevert(TreasuryPolicyBase.Capacity.selector);
        policy.paySplit(recipient, U, true, block.timestamp / 600, 0);
        vm.expectRevert(TreasuryPolicyBase.InvalidAmount.selector);
        policy.paySplit(recipient, U, true, block.timestamp / 600, U + 1);
        vm.stopPrank();
        _fromL1(_splitData(false, 50 * U, 50 * U));
        vm.prank(address(safeL2));
        vm.expectRevert(TreasuryPolicyBase.GlobalLimit.selector);
        policy.paySplit(recipient, U, true, block.timestamp / 600, U);
        assertEq(_spent(true), 50 * U);
        assertEq(_spent(false), 100 * U);
    }

    function testChangedAllocationInvalidatesOwnerSignatures() public {
        bytes memory approved = _splitData(true, 40 * U, 10 * U);
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, approved, 0)), A, B);
        vm.expectRevert();
        _execute(safeL1, alias_, _splitData(true, 40 * U, 20 * U), 0, signatures);
        assertEq(policy.spent(block.timestamp / 600), 0);
        assertTrue(_execute(safeL1, alias_, approved, 0, signatures));
        assertEq(_spent(true), 10 * U);
        assertEq(_spent(false), 30 * U);
    }

    function testExactSplitRollbackAfterEarlierTransfer() public {
        bytes memory data = _splitData(true, 40 * U, 30 * U);
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        uint256 nonce = safeL2.nonce();
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 30 * U)), abi.encode(false));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 30 * U)), 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(safeL2.nonce(), nonce);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(_spent(true) + _spent(false), 0);
        assertEq(policy.spent(block.timestamp / 600), 0);
    }
}
