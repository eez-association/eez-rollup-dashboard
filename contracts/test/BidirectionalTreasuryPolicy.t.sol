// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryPolicyFixture} from "./TreasuryPolicy.t.sol";
import {TreasuryPolicy} from "../src/chiado/TreasuryPolicy.sol";
import {TreasuryAliasReader} from "../src/chiado/TreasuryAliasReader.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";

contract BidirectionalTreasuryPolicyTest is TreasuryPolicyFixture {
    function _l1Data(bool onL1, uint256 amount) internal view returns (bytes memory) {
        return _paymentData(true, onL1, amount);
    }

    function _fromL1(bytes memory data) internal {
        assertTrue(_execute(safeL1, alias_, data, 0, _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B)));
    }

    function testL1OwnerTransactionSplitsToL2() public {
        uint256 n1 = safeL1.nonce();
        uint256 n2 = safeL2.nonce();
        _fromL1(_l1Data(false, 110 * U));
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 50 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 290 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(_spent(true), 10 * U);
        assertEq(_spent(false), 100 * U);
        assertEq(policy.spent(block.timestamp / 600), 110 * U);
        assertEq(safeL1.nonce(), n1 + 1);
        assertEq(safeL2.nonce(), n2);
    }

    function testL1OwnerTransactionSplitsToL1() public {
        _fromL1(_l1Data(true, 110 * U));
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 10 * U);
        assertEq(policy.spent(block.timestamp / 600), 110 * U);
    }

    function testSharedBudgetAcrossBothInitiators() public {
        _pay(false, false, 40 * U);
        _fromL1(_l1Data(true, 110 * U));
        assertEq(policy.spent(block.timestamp / 600), 150 * U);
        assertEq(_spent(false), 50 * U);
        uint256 nonce = safeL1.nonce();
        bytes memory data = _l1Data(false, U);
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        vm.expectRevert(bytes("GS013"));
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(safeL1.nonce(), nonce);
        assertEq(_spent(false), 50 * U);
    }

    function testL1OwnerSignatureCannotReplay() public {
        bytes memory data = _l1Data(false, U);
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        assertTrue(_execute(safeL1, alias_, data, 0, signatures));
        vm.expectRevert();
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(wrapped.balanceOf(recipient), U);
    }

    function testL1EntryRejectsEOAAndOtherProxy() public {
        bytes memory data = _l1Data(false, U);
        vm.prank(vm.addr(A));
        (bool direct,) = address(policy).call(data);
        assertFalse(direct);
        vm.prank(vm.addr(A));
        (bool viaProxy,) = alias_.call(data);
        assertFalse(viaProxy);
        assertEq(policy.spent(block.timestamp / 600), 0);
    }

    function testL1FailureRollsBackEarlierL2LegAndNonce() public {
        bytes memory data = _l1Data(true, 110 * U);
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), abi.encode(false));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        uint256 nonce = safeL1.nonce();
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        vm.expectRevert(bytes("GS013"));
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(safeL1.nonce(), nonce);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(_spent(true), 0);
        assertEq(_spent(false), 0);
        assertEq(policy.spent(block.timestamp / 600), 0);
    }
}
