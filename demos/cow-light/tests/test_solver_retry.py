import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from settlement_state import update_order
from solver.retry_policy import due, price_failure, retry_fields, MAX_RETRIES


class RetryTests(unittest.TestCase):
    def item(self):
        return {'id': 'retry', 'status': 'queued', 'order': {'validTo': 1000}}

    def test_bounded_backoff_expiry_and_price_wait(self):
        row = self.item()
        for count in range(1, MAX_RETRIES + 1):
            status, fields = retry_fields(row, 'price moved', now=100)
            self.assertEqual(status, 'queued')
            self.assertEqual(fields['retryCount'], count)
            self.assertEqual(fields['nextAttemptAt'], 100 + min(60, 5 * 2 ** (count-1)))
            row['solver'] = fields
            self.assertFalse(due(row, 101))
            self.assertTrue(due(row, fields['nextAttemptAt']))
        self.assertEqual(retry_fields(row, 'price moved', now=100)[0], 'failed')
        self.assertEqual(retry_fields(row, 'below minimum', now=100, waiting_price=True)[0], 'queued')
        self.assertEqual(retry_fields(row, 'below minimum', now=1000, waiting_price=True)[0], 'expired')
        self.assertTrue(due(row, 1000))

    def test_uncertain_submission_never_retried(self):
        for field in ('txHash', 'settlement'):
            row = self.item(); row['solver'] = {field: '0x123', 'nextAttemptAt': 999}
            self.assertTrue(due(row, 100))
            with self.assertRaises(ValueError): retry_fields(row, 'timeout', now=100)

    def test_price_error_requires_movement_and_known_revert(self):
        for error in ({'details': {'revertData': '0xe450d38c' + '0'*192}}, {'reason':'Slippage()'}):
            self.assertTrue(price_failure(error, 100, 99))
            self.assertFalse(price_failure(error, 100, 100))
        for error in ('execution reverted', 'invalid signature', 'unsupported_transaction', 'OnlyBridge()'):
            self.assertFalse(price_failure(error, 100, 99))

    def test_real_main_rebuilds_after_rejected_quote_without_changing_order(self):
        from eth_utils import keccak
        from eth_abi import encode
        source = ast.parse((ROOT / 'solver/settle_order.py').read_text())
        functions = [n for n in source.body if isinstance(n, ast.FunctionDef)
                     and n.name in ('main', 'retry_later', 'record_failure')]
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)/'queue.jsonl'
            artifact = Path(directory)/'abi.json'; artifact.write_text('{"abi":[]}')
            row = self.item(); row.update(signer='owner', signature='0x1234', quote={})
            row['order'].update(sellAmount='10', buyAmount='97', receiver='owner', buyToken='buy',
                                appData='0x'+'00'*32, feeAmount='0')
            queue.write_text(json.dumps(row)+'\n')
            class Config(dict):
                def check_deployment(self, **kwargs): pass
                def catalog(self): return []
                def read_manifest(self, key): return {'routeL2':'route','l1Helper':'helper'}
            contracts = {key: MagicMock() for key in ('sell','settlement','bridge','route')}
            contracts['sell'].functions.balanceOf.return_value.call.return_value = 10
            contracts['sell'].functions.allowance.return_value.call.return_value = 10
            st = contracts['settlement']
            st.functions.vaultRelayer.return_value.call.return_value = 'relayer'
            st.functions.filledAmount.return_value.call.return_value = 0
            contracts['bridge'].functions.getWrappedToken.return_value.call.return_value = '0x0'
            route = contracts['route']; route.address = '0x'+'12'*20
            for field, value in [('bridge','bridge'),('wrappedWeth','sell'),('settlement','settlement'),('l1Helper','helper')]:
                getattr(route.functions,field).return_value.call.return_value = value
            route.functions.startHeld.return_value._encode_transaction_data.return_value = '0x1234'
            st.functions.settle.return_value._encode_transaction_data.return_value = '0x1234'
            st.functions.settle.return_value.build_transaction.return_value = {'gas':500000}
            l2 = SimpleNamespace(eth=SimpleNamespace(contract=lambda address, **kwargs: contracts[address]))
            responses = iter([{'result':{'options':[{'type':'0x2','error':{'code':'unsupported_transaction'}}],
                              'diagnostics':{'options':[{'type':'0x2','error':{'details':{'revertData':'0xe450d38c'}}}]}}},
                              {'result':{'options':[{'gas':'0x7a120'}]}}])
            quotes = iter([100,99,99])
            sent = []
            env = dict(CFG=Config(ROUTE_MANIFEST=artifact, GPV2_ARTIFACT=artifact), BASE=ROOT,
                L1=None,L2=l2, QUEUE=queue, SETTLEMENT='settlement', WETH_L2='sell', BRIDGE_L2='bridge',
                ERC20=[],BRIDGE_ABI=[],SETTLEMENT_VIEW_ABI=[],L2_CHAIN=1,L2_FRONT='composer',
                ACCT=SimpleNamespace(address='solver'),time=SimpleNamespace(time=lambda:100),
                json=json, encode=encode, keccak=keccak, to_checksum_address=lambda address:address,
                queued=lambda:json.loads(queue.read_text()),order_route=lambda item:('token','pair','symbol'),
                signed_identity=lambda *args:('owner',b'uid'),live_route_quote=lambda *args:next(quotes),
                requests=SimpleNamespace(post=lambda *args,**kwargs:SimpleNamespace(json=lambda:next(responses))),
                update_order=update_order,retry_fields=lambda item,reason,**kwargs:retry_fields(item,reason,now=100,**kwargs),
                price_failure=price_failure,debug=lambda *args,**kwargs:None,
                send=lambda *args:sent.append(args))
            exec(compile(ast.Module(body=functions,type_ignores=[]),'<solver>','exec'),env)
            env['main']()
            saved=json.loads(queue.read_text())
            self.assertEqual(saved['status'],'queued'); self.assertEqual(saved['solver']['retryCount'],1)
            self.assertEqual(sent,[]); self.assertEqual(saved['order'],row['order'])
            env['main']()
            self.assertEqual(len(sent),1)
            prices=[call.args[1][0]//10**18 for call in st.functions.settle.call_args_list]
            self.assertEqual(prices,[100,99,99])
            self.assertEqual(json.loads(queue.read_text())['order'],row['order'])
            for case in ('below minimum', 'permanent revert', 'already filled', 'invalid signature'):
                with self.subTest(case=case):
                    queue.write_text(json.dumps(row)+'\n'); sent.clear()
                    env['live_route_quote']=lambda *args: 96 if case=='below minimum' else 100
                    env['requests']=SimpleNamespace(post=lambda *args,**kwargs:SimpleNamespace(json=lambda:
                        {'result':{'options':[{'error':{'message':'Unauthorized()'}}]}}))
                    st.functions.filledAmount.return_value.call.return_value = 10 if case=='already filled' else 0
                    if case=='invalid signature':
                        def invalid(*args): raise ValueError('invalid signature')
                        env['signed_identity']=invalid
                    env['main']()
                    result=json.loads(queue.read_text())
                    self.assertEqual(result['status'],'queued' if case=='below minimum' else 'failed')
                    self.assertEqual(sent,[])
                    self.assertEqual(result['order'],row['order'])


if __name__ == '__main__': unittest.main()
