import ast
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from settlement_state import inspect_settlement, is_active, reconcile, update_order
from deployment.bootstrap_chiado import quote_transaction, validate_fee_quote

TX = '0x' + '11' * 32
L2_BLOCK = '0x' + '22' * 32
POST = '0x' + '33' * 32
L1_BLOCK = '0x' + '44' * 32


class Fixture:
    def __init__(self):
        self.receipt = {'transactionHash': TX, 'blockHash': L2_BLOCK, 'blockNumber': '0x7', 'status': '0x1'}
        self.post = {'transactionHash': POST, 'blockHash': L1_BLOCK, 'blockNumber': '0x64', 'status': '0x1'}
        self.record = {'canonicalL2': True, 'l1TransactionHash': POST, 'l1BlockHash': L1_BLOCK,
                       'l1BlockNumber': '0x64', 'l2Blocks': [{'hash': L2_BLOCK, 'number': '0x7'}]}
        self.l1_hash, self.l2_hash = L1_BLOCK, L2_BLOCK
        self.cross = {}
        self.calls = []
        self.unavailable = False

    def rpc(self, endpoint, method, params):
        self.calls.append((endpoint, method, params))
        if self.unavailable:
            raise TimeoutError('RPC timeout')
        if method == 'eez_getCrossChainTransaction':
            assert endpoint == 'composer'
            return self.cross
        if method == 'eez_getSettlementByL2Block':
            assert endpoint == 'composer' and params == [L2_BLOCK]
            return self.record
        if method == 'eth_getTransactionReceipt':
            assert params == [TX if endpoint == 'l2' else POST]
            return self.receipt if endpoint == 'l2' else self.post
        if method == 'eth_getBlockByNumber':
            return {'hash': self.l2_hash if endpoint == 'l2' else self.l1_hash}
        raise AssertionError(method)

    def inspect(self):
        result = inspect_settlement(TX, self.rpc, 'l1', 'l2', 'composer')
        assert all('send' not in method and 'sign' not in method for _, method, _ in self.calls)
        return result


class SettlementTests(unittest.TestCase):
    def test_api_reports_persisted_progress_and_does_not_trust_old_success(self):
        source = ast.parse((ROOT / 'backend/server.py').read_text())
        function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'order_debug')
        env = {'json': json}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<API status>', 'exec'), env)
        debug = env['order_debug']
        for state in ('submitted', 'submitting', 'awaiting_settlement'):
            row = {'id': 'one', 'status': state, 'solver': {'txHash': TX, 'message': 'Waiting'}}
            result = debug(row, {'one': {'event': 'order_worker_exit', 'error': 'timeout'}})
            self.assertEqual(result['state'], state)
            self.assertEqual(result['txHash'], TX)
            self.assertIsNone(result['error'])
        legacy = {'id': 'one', 'status': 'settled', 'solver': {'settlement': TX}}
        self.assertEqual(debug(legacy, {})['state'], 'awaiting_settlement')
        legacy['solver']['canonicalVerified'] = True
        self.assertEqual(debug(legacy, {})['state'], 'settled')

    def test_execution_without_index_remains_pending(self):
        f = Fixture(); f.record = None
        result = f.inspect()
        self.assertEqual(result['status'], 'awaiting_settlement')
        self.assertIsNone(result['settlement'])

    def test_only_verified_l1_and_l2_inclusion_settles(self):
        result = Fixture().inspect()
        self.assertEqual(result['status'], 'settled')
        self.assertEqual(result['l1Tx'], POST)
        self.assertEqual(result['settlementBlock'], 7)
        self.assertNotIn('finalized', result)

    def test_absent_receipt_and_terminal_without_rejection_stay_pending(self):
        f = Fixture(); f.receipt = None
        f.cross = {'lifecycle': 'terminal', 'ownership': {}}
        self.assertEqual(f.inspect()['status'], 'submitted')

    def test_explicit_composer_rejection_fails(self):
        for executed in (False, True):
            with self.subTest(executed=executed):
                f = Fixture(); f.record = None
                if not executed: f.receipt = None
                f.cross = {'lifecycle': 'terminal', 'ownership': {'rejection': {'error': 'rejected'}}}
                self.assertEqual(f.inspect()['status'], 'failed')

    def test_stale_rejection_does_not_override_verified_chain_evidence(self):
        f = Fixture(); f.cross = {'lifecycle': 'terminal', 'ownership': {'rejection': {'error': 'old'}}}
        self.assertEqual(f.inspect()['status'], 'settled')

    def test_reverted_receipt_is_not_swallowed_or_called_success(self):
        f = Fixture(); f.receipt['status'] = '0x0'
        self.assertEqual(f.inspect()['status'], 'failed')
        f.record = None
        self.assertEqual(f.inspect()['status'], 'awaiting_settlement')

    def test_missing_or_mismatched_evidence_never_settles(self):
        mutations = [
            lambda f: setattr(f, 'post', None),
            lambda f: f.post.update(status='0x0'),
            lambda f: f.post.update(blockNumber='0x65'),
            lambda f: f.post.update(transactionHash=TX),
            lambda f: setattr(f, 'l1_hash', TX),
            lambda f: setattr(f, 'l2_hash', TX),
            lambda f: f.receipt.update(transactionHash=POST),
            lambda f: f.record.update(canonicalL2=False),
            lambda f: f.record.pop('canonicalL2'),
            lambda f: f.record.update(l2Blocks=[]),
            lambda f: f.record.update(l2Blocks=[{'number': '0x8', 'hash': L2_BLOCK}]),
            lambda f: f.record.update(l2Blocks=[{'number': '0x7', 'hash': TX}]),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                f = Fixture(); mutate(f)
                self.assertNotEqual(f.inspect()['status'], 'settled')

    def test_rpc_outage_is_retryable(self):
        f = Fixture(); f.unavailable = True
        result = f.inspect()
        self.assertEqual(result['status'], 'submitted')
        self.assertIsNone(result['error'])

    def test_restart_reconciles_saved_hash_without_resubmission(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            queue = Path(directory) / 'orders.jsonl'
            queue.write_text(json.dumps({'id': 'one', 'status': 'queued', 'order': {'validTo': 0}}) + '\n')
            update_order(queue, 'one', 'submitting', txHash=TX)
            # A fresh process reads the durable hash even if submission timed out.
            item = json.loads(queue.read_text())
            f = Fixture(); f.record = None
            first = reconcile(queue, item, f.rpc, 'l1', 'l2', 'composer')
            self.assertEqual(first['status'], 'awaiting_settlement')
            self.assertEqual(first['solver']['txHash'], TX)
            f = Fixture()
            result = reconcile(queue, json.loads(queue.read_text()), f.rpc, 'l1', 'l2', 'composer')
            self.assertEqual(result['status'], 'settled')
            self.assertEqual(result['solver']['l1Tx'], POST)

    def test_legacy_execution_only_success_is_rechecked(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            queue = Path(directory) / 'orders.jsonl'
            item = {'id': 'old', 'status': 'settled', 'solver': {'settlement': TX}}
            queue.write_text(json.dumps(item) + '\n')
            self.assertTrue(is_active(item))
            f = Fixture(); f.record = None
            item = reconcile(queue, item, f.rpc, 'l1', 'l2', 'composer')
            self.assertEqual(item['status'], 'awaiting_settlement')
            self.assertIsNone(item['solver']['settlement'])
            f = Fixture()
            item = reconcile(queue, item, f.rpc, 'l1', 'l2', 'composer')
            self.assertFalse(is_active(item))
            self.assertTrue(item['solver']['canonicalVerified'])

    def test_submission_hash_is_durable_before_broadcast_and_survives_timeout(self):
        # Execute the real send/main functions with fake providers; never load
        # keys, sign using a real account, or contact an external network.
        source = ast.parse((ROOT / 'solver/settle_order.py').read_text())
        functions = ast.Module(body=[node for node in source.body if isinstance(node, ast.FunctionDef)
                                    and node.name in ('send', 'main')], type_ignores=[])
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            queue = Path(directory) / 'orders.jsonl'
            original = {'id': 'one', 'status': 'queued', 'order': {'validTo': 0}}
            queue.write_text(json.dumps(original) + '\n')
            sent = []
            def broadcast(raw):
                persisted = json.loads(queue.read_text())
                self.assertEqual(persisted['status'], 'submitting')
                self.assertEqual(persisted['solver']['txHash'], TX)
                sent.append(raw)
                raise TimeoutError('response lost')
            eth = SimpleNamespace(get_transaction_count=lambda *_: 3, gas_price=100,
                                  get_block=lambda _: {}, send_raw_transaction=broadcast)
            w = SimpleNamespace(eth=eth)
            web3 = SimpleNamespace(HTTPProvider=lambda *a, **k: None,
                                   keccak=lambda *a, **k: bytes.fromhex(TX[2:]),
                                   to_hex=lambda raw: '0x' + raw.hex())
            class FakeWeb3:
                HTTPProvider = web3.HTTPProvider
                keccak = web3.keccak
                to_hex = web3.to_hex
                def __new__(cls, *_): return w
            class Config(dict):
                def check_chains(self, **_): pass
                def check_deployment(self, **_): pass
            f = Fixture(); f.receipt = None
            def quoted_rpc(endpoint, method, params):
                if method != 'eez_quoteFee':
                    return f.rpc(endpoint, method, params)
                request = params[0]
                self.assertEqual(request['nonce'], '0x3')
                self.assertEqual(request['gas'], hex(100000))
                return {'version': 1, 'chainId': request['chainId'], 'nonce': request['nonce'],
                    'expiresAt': hex(120), 'options': [{'type': '0x2', 'gas': request['gas'],
                    'requestHash': TX, 'estimatedFee': hex(100000 * 300),
                    'maxFeePerGas': hex(300), 'maxPriorityFeePerGas': hex(200)}]}
            env = {'Web3': FakeWeb3, 'QUEUE': queue, 'update_order': update_order, 'reconcile': reconcile,
                   'debug': lambda *a, **k: None, 'rpc': quoted_rpc, 'L2_FRONT': 'composer', 'L1': None, 'L2': w,
                   'quote_transaction': quote_transaction, 'validate_fee_quote': validate_fee_quote,
                   'time': SimpleNamespace(time=lambda: 100),
                   'os': SimpleNamespace(getenv=lambda name, default: default),
                   'CFG': Config(L1_RPC='l1', L2_RPC='l2'),
                   'queued': lambda: json.loads(queue.read_text())}
            exec(compile(functions, '<solver functions>', 'exec'), env)
            def sign(tx):
                self.assertEqual(tx['maxFeePerGas'], 300)
                self.assertEqual(tx['maxPriorityFeePerGas'], 200)
                return SimpleNamespace(raw_transaction=b'signed')
            account = SimpleNamespace(address='0x'+'55'*20, sign_transaction=sign)
            transaction = {'gas': 100000, 'to': '0x'+'66'*20, 'data': '0x',
                           '_quotedTip': '0x9999', '_quotedMaxFee': '0x9999'}
            def unavailable(*args): raise TimeoutError('quote unavailable')
            env['rpc'] = unavailable
            with self.assertRaises(TimeoutError):
                env['send'](w, account, transaction, 1, original, 'composer')
            self.assertEqual(sent, [])
            self.assertEqual(json.loads(queue.read_text()), original)
            env['rpc'] = quoted_rpc
            env['send'](w, account, transaction, 1, original, 'composer')
            self.assertEqual(len(sent), 1)
            self.assertEqual(json.loads(queue.read_text())['status'], 'submitted')
            # Even an expired order must reconcile its existing submission first.
            env['main']()
            self.assertEqual(len(sent), 1)
