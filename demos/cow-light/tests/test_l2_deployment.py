import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from web3.exceptions import ContractLogicError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deployment.l2_transactions import L2Transactions
from deployment.route_identity import authorized_l1_caller, bridge_manager


class RouteIdentityTests(unittest.TestCase):
    def test_authorizes_l1_proxy_for_source_route_not_route_itself(self):
        l1 = MagicMock()
        bridge, manager = MagicMock(), MagicMock()
        l1.eth.contract.side_effect = [bridge, manager]
        bridge.functions.EEZContract.return_value.call.return_value = 'l1-manager'
        l1.eth.get_code.return_value = b'code'
        manager.functions.computeCrossChainProxyAddress.return_value.call.return_value = 'l1-source-proxy'
        self.assertEqual(authorized_l1_caller(l1, 'bridge', 'l2-route', 7), 'l1-source-proxy')
        manager.functions.computeCrossChainProxyAddress.assert_called_once_with('l2-route', 7)
        self.assertEqual(l1.eth.contract.call_args.args[0], 'l1-manager')
        bridge.functions.manager.assert_not_called()

    def test_legacy_bridge_manager_fallback(self):
        l1 = MagicMock()
        bridge = l1.eth.contract.return_value
        bridge.functions.EEZContract.return_value.call.side_effect = ContractLogicError('execution reverted')
        bridge.functions.manager.return_value.call.return_value = 'legacy-manager'
        l1.eth.get_code.return_value = b'code'
        self.assertEqual(bridge_manager(l1, 'bridge'), 'legacy-manager')

    def test_rpc_outage_does_not_trigger_legacy_fallback(self):
        l1 = MagicMock()
        bridge = l1.eth.contract.return_value
        bridge.functions.EEZContract.return_value.call.side_effect = ConnectionError('offline')
        with self.assertRaises(ConnectionError):
            bridge_manager(l1, 'bridge')
        bridge.functions.manager.assert_not_called()

    def test_missing_manager_code_stops_deployment(self):
        l1 = MagicMock()
        l1.eth.get_code.return_value = b''
        with self.assertRaisesRegex(ValueError, 'no deployed code'):
            authorized_l1_caller(l1, 'bridge', 'route', 1)


class TransactionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.sender = L2Transactions.__new__(L2Transactions)
        self.sender.config = {'L2_CHAIN_ID': 916969}
        self.sender.l2 = MagicMock()
        self.sender.front = MagicMock()
        self.sender.account = MagicMock()
        self.sender.account.address = '0x' + '11' * 20
        self.sender.journal = MagicMock()
        self.sender.journal.transaction.side_effect = lambda name, prepare, broadcast, receipt: prepare()
        self.sender.front.eth.get_transaction_count.return_value = 0
        self.sender.l2.eth.get_transaction_count.return_value = 0
        self.sender.l2.eth.get_block.return_value = {'baseFeePerGas': 50}
        self.sender.l2.eth.estimate_gas.return_value = 21000
        self.sender.front.eth.estimate_gas.return_value = 21000
        self.sender.l2.eth.get_balance.return_value = 10**18

    def test_pending_nonce_never_signs(self):
        self.sender.front.eth.get_transaction_count.return_value = 1
        with self.assertRaisesRegex(ValueError, 'Unresolved pending'):
            self.sender.send('stage', lambda: {})
        self.sender.account.sign_transaction.assert_not_called()

    def test_local_fee_cap_never_signs(self):
        self.sender.l2.eth.get_block.return_value = {'baseFeePerGas': 5_000_000_000}
        with self.assertRaisesRegex(ValueError, 'safety cap'):
            self.sender.send('stage', lambda: {})
        self.sender.account.sign_transaction.assert_not_called()

    def test_cross_chain_quote_failure_has_no_unquoted_fallback(self):
        self.sender.front.provider.make_request.return_value = {'error': 'unsupported'}
        with self.assertRaisesRegex(ValueError, 'Fee quote unavailable'):
            self.sender.send('stage', lambda: {'to': '0x' + '22' * 20}, cross_chain=True)
        self.sender.account.sign_transaction.assert_not_called()

    def test_insufficient_balance_never_signs(self):
        self.sender.l2.eth.get_balance.return_value = 0
        with self.assertRaisesRegex(ValueError, 'Insufficient deployer'):
            self.sender.send('stage', lambda: {})
        self.sender.account.sign_transaction.assert_not_called()

    def test_expired_quote_after_hardware_confirmation_never_returns_signed_bytes(self):
        self.sender.front.provider.make_request.return_value = {'result': {}}
        fees = {'maxFeePerGas': 200, 'maxPriorityFeePerGas': 100}
        with patch('deployment.l2_transactions.validate_fee_quote',
                   side_effect=[fees, ValueError('quote expired')]):
            with self.assertRaisesRegex(ValueError, 'quote expired'):
                self.sender.send('helper', lambda: {'to': '0x' + '22' * 20}, cross_chain=True)
        self.sender.account.sign_transaction.assert_called_once()
        self.sender.front.eth.send_raw_transaction.assert_not_called()

    def test_local_transaction_total_budget_applies_before_signing(self):
        with patch.dict('os.environ', {'COW_DEPLOY_MAX_FEE_WEI': '1'}):
            with self.assertRaisesRegex(ValueError, 'total fee budget'):
                self.sender.send('stage', lambda: {})
        self.sender.account.sign_transaction.assert_not_called()


if __name__ == '__main__':
    unittest.main()
