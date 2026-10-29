"""Registry status must not depend on deployment traces for another network."""
import ast
from pathlib import Path
import unittest
from unittest.mock import MagicMock
from web3 import Web3


class WrapperStatusTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'backend/server.py'
        tree = ast.parse(source.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'wrapper')
        self.l2 = MagicMock()
        self.scope = dict(Web3=Web3, l2=self.l2, BRIDGE_L2='0x'+'11'*20, BRIDGE_ABI=[],
                          catalog=MagicMock(side_effect=AssertionError('status must not predict')))
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), self.scope)

    def test_unregistered_token_reports_not_bridged_without_prediction(self):
        self.l2.eth.contract.return_value.functions.getWrappedToken.return_value.call.return_value = '0x'+'00'*20
        result = self.scope['wrapper']('0x'+'22'*20, status_only=True)
        self.assertFalse(result['deployed'])
        self.assertFalse(result['deterministic'])
        self.scope['catalog'].assert_not_called()

    def test_registered_token_reports_bridged(self):
        address = '0x'+'33'*20
        self.l2.eth.contract.return_value.functions.getWrappedToken.return_value.call.return_value = address
        result = self.scope['wrapper']('0x'+'22'*20, status_only=True)
        self.assertTrue(result['deployed'])
        self.assertEqual(result['address'], address)

    def test_rpc_failure_is_not_reported_as_unbridged(self):
        self.l2.eth.contract.return_value.functions.getWrappedToken.return_value.call.side_effect = ConnectionError()
        with self.assertRaises(ConnectionError):
            self.scope['wrapper']('0x'+'22'*20, status_only=True)
