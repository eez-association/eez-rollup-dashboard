// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicy} from "../../src/chiado/TreasuryPolicy.sol";
import {TreasuryBridge} from "../../src/chiado/TreasuryBridge.sol";
import {IEEZProxyRegistry} from "../../src/interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "../../src/interfaces/IAllowanceModule.sol";
import {InvoiceMerchant} from "./InvoiceMerchant.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Controlled post-payment failure hook for isolated tests only.
contract InvoiceTreasuryPolicy is TreasuryPolicy {
    address public immutable invoiceMerchant;
    InvoiceMerchant public immutable invoiceL1Proxy;
    event InvoicePaid(bytes32 indexed invoiceId);

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address aliasReaderL1_,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        TreasuryBridge bridge_,
        address merchant
    )
        TreasuryPolicy(safeL1_, safeL2_, manager, aliasReaderL1_, moduleL1, moduleL2, token, bridge_)
    {
        require(merchant != address(0), "fixture merchant");
        invoiceMerchant = merchant;
        invoiceL1Proxy = InvoiceMerchant(manager.getOrCreateCrossChainProxy(merchant, 0));
    }

    /// @notice Route an L1 invoice payment, then require acceptance of the signed terms.
    /// @dev The immutable merchant is a terminal L1 call, after all transfers.
    ///      A rejection must propagate through the zero-refund Safe transaction.
    function payInvoice(
        address token,
        address recipient,
        uint256 amount,
        bytes32 invoiceId,
        uint256 expectedEpoch
    )
        external
        paymentExecution
    {
        require(token == canonicalToken, "fixture asset");
        // Automatic allocation belongs to this isolated scenario. Production
        // payments carry the exact contributions signed by the owners.
        (, address delegate) = _paymentContext();
        uint256 capacity = _capacity(true, delegate, expectedEpoch);
        _pay(recipient, amount, true, expectedEpoch, amount < capacity ? amount : capacity);
        invoiceL1Proxy.accept(invoiceId, token, recipient, amount);
        emit InvoicePaid(invoiceId);
    }
}
