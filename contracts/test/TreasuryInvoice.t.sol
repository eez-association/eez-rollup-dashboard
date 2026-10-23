// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {TreasuryPolicyBase} from "../src/l2/TreasuryPolicyBase.sol";
import {TreasuryPolicyFixture} from "./TreasuryPolicy.t.sol";
import {TreasuryPolicy} from "../src/chiado/TreasuryPolicy.sol";
import {TreasuryAliasReader} from "../src/chiado/TreasuryAliasReader.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceMerchant} from "./fixtures/InvoiceMerchant.sol";
import {InvoiceTreasuryPolicy} from "./fixtures/InvoiceTreasuryPolicy.sol";

contract TreasuryInvoiceTest is TreasuryPolicyFixture {
    InvoiceMerchant merchant;

    function _newPolicy() internal override returns (TreasuryPolicy) {
        merchant = new InvoiceMerchant(address(usdc));
        InvoiceTreasuryPolicy invoicePolicy = new InvoiceTreasuryPolicy(
            address(safeL1),
            address(safeL2),
            IEEZProxyRegistry(address(l2)),
            address(new TreasuryAliasReader(IEEZProxyRegistry(address(l1)))),
            address(module1),
            module2,
            address(usdc),
            bridge2,
            address(merchant)
        );
        merchant.bindPolicy(l1.getOrCreateCrossChainProxy(address(invoicePolicy), ROLLUP_ID));
        return invoicePolicy;
    }

    function _invoiceData(bytes32 id, uint256 amount) private view returns (bytes memory) {
        return abi.encodeCall(
            InvoiceTreasuryPolicy.payInvoice, (address(usdc), recipient, amount, id, vm.getBlockTimestamp() / 600)
        );
    }

    function _treasuryState() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                usdc.balanceOf(address(safeL1)),
                wrapped.balanceOf(address(safeL2)),
                usdc.balanceOf(recipient),
                wrapped.balanceOf(recipient),
                usdc.balanceOf(address(bridge1)),
                wrapped.totalSupply(),
                usdc.balanceOf(alias_),
                wrapped.balanceOf(address(policy)),
                module1.getTokenAllowance(address(safeL1), alias_, address(usdc)),
                module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)),
                policy.spent(vm.getBlockTimestamp() / 600),
                safeL1.nonce(),
                safeL2.nonce()
            )
        );
    }

    function testInvoiceAcceptsExactTermsAfterBothContributions() public {
        bytes32 id = keccak256("invoice");
        merchant.open(id, recipient, 110 * U);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        _callL2(address(policy), _invoiceData(id, 110 * U));
        (,, InvoiceMerchant.Status status) = merchant.invoices(id);
        assertEq(uint256(status), uint256(InvoiceMerchant.Status.Paid));
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 110 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 10 * U);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMerchant.InvoiceNotOpen.selector, id));
        vm.prank(alias_);
        merchant.accept(id, address(usdc), recipient, 110 * U);
    }

    function testClosedInvoiceRollsBackTransfersAllowancesBudgetAndSafeNonce() public {
        bytes32 id = keccak256("closed invoice");
        merchant.open(id, recipient, 110 * U);
        merchant.close(id);
        bytes32 beforeState = _treasuryState();
        bytes memory data = _invoiceData(id, 110 * U);
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectCall(
            address(merchant), abi.encodeCall(InvoiceMerchant.accept, (id, address(usdc), recipient, 110 * U)), 1
        );
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(_treasuryState(), beforeState);
        (,, InvoiceMerchant.Status status) = merchant.invoices(id);
        assertEq(uint256(status), uint256(InvoiceMerchant.Status.Closed));
    }

    function testInvoiceTermsAndControllerCannotBeBypassed() public {
        bytes32 id = keccak256("terms");
        merchant.open(id, recipient, U);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        merchant.accept(id, address(usdc), recipient, U);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        vm.prank(recipient);
        merchant.close(id);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        merchant.bindPolicy(recipient);
        vm.startPrank(alias_);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(wrapped), recipient, U);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(usdc), alias_, U);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(usdc), recipient, U + 1);
        vm.stopPrank();
        vm.expectRevert(TreasuryPolicyBase.OnlySafe.selector);
        InvoiceTreasuryPolicy(address(policy)).payInvoice(address(usdc), recipient, U, id, vm.getBlockTimestamp() / 600);
        bytes32 beforeState = _treasuryState();
        bytes memory data = _invoiceData(id, 2 * U);
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(_treasuryState(), beforeState);
        merchant.close(id);
        vm.expectRevert(InvoiceMerchant.InvalidInvoice.selector);
        merchant.open(id, recipient, U);
    }
}
