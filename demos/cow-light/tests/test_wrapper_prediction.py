import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wrapper_prediction import constructor_args, predict, validate_creation, WrapperPredictor


class PredictionTests(unittest.TestCase):
    def setUp(self):
        self.bridge = '0x'+'11'*20
        self.token = '0x'+'22'*20
        self.meta = ('Wrapped Ether','WETH',18)
        self.prefix = bytes.fromhex('608060405260006000')
        self.creation = self.prefix + constructor_args(self.meta, self.bridge)
        self.wrapper = predict(self.bridge,self.token,self.creation)
        self.runtime = bytes.fromhex('6080604052')
        self.bridge_code = b'bridge' + self.prefix + b'suffix'
        self.payload = {'creation_bytecode':Web3.to_hex(self.creation),
                        'deployed_bytecode':Web3.to_hex(self.runtime)}

    def validate(self, **overrides):
        args = dict(payload=self.payload,bridge=self.bridge,token=self.token,wrapper=self.wrapper,
                    meta=self.meta,runtime=self.runtime,bridge_code=self.bridge_code)
        return validate_creation(**{**args, **overrides})

    def test_recovers_prefix_without_length_or_historical_trace(self):
        self.assertEqual(self.validate(), self.prefix)

    def test_wrong_network_or_wrapper_rejected(self):
        with self.assertRaisesRegex(ValueError,'canonical wrapper address'):
            self.validate(wrapper='0x'+'33'*20)

    def test_tampered_creation_rejected(self):
        with self.assertRaisesRegex(ValueError,'canonical wrapper address'):
            self.validate(payload={**self.payload,'creation_bytecode':Web3.to_hex(b'bad'+self.creation)})

    def test_runtime_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError,'runtime'):
            self.validate(runtime=b'different')

    def test_metadata_or_constructor_bridge_mismatch_rejected(self):
        for overrides in ({'meta':('Wrong','WETH',18)}, {'bridge':'0x'+'44'*20}):
            with self.assertRaisesRegex(ValueError,'constructor arguments'):
                self.validate(**overrides)

    def test_old_creation_code_after_bridge_upgrade_rejected(self):
        with self.assertRaisesRegex(ValueError,'current bridge implementation'):
            self.validate(bridge_code=b'new implementation')

    def test_missing_explorer_code_rejected(self):
        with self.assertRaises(ValueError):
            self.validate(payload={})

    def test_cache_revalidates_onchain_bindings_and_fails_on_upgrade(self):
        cfg = {'BRIDGE_L2':self.bridge,'WETH_L1':self.token,'WETH_L2':self.wrapper,
               'COW_WRAPPER_EXPLORER_API':'https://explorer.example/api/v2'}
        l2 = MagicMock()
        l2.eth.get_block.return_value = {'number':123,'hash':b'block'}
        l2.eth.get_storage_at.return_value = bytes(32)
        code = {'bridge':self.bridge_code}
        l2.eth.get_code.side_effect = lambda a, **kw: self.runtime if a == self.wrapper else code['bridge']
        contract = l2.eth.contract.return_value
        contract.functions.getWrappedToken.return_value.call.return_value = self.wrapper
        for name,value in zip(('name','symbol','decimals'),self.meta):
            getattr(contract.functions,name).return_value.call.return_value = value
        predictor = WrapperPredictor()
        with patch('wrapper_prediction.requests.get') as get:
            get.return_value.json.return_value = self.payload
            self.assertEqual(predictor.prefix(cfg,l2),self.prefix)
            self.assertEqual(predictor.prefix(cfg,l2),self.prefix)
            self.assertEqual(get.call_count,1)
            code['bridge'] = b'upgraded'
            with self.assertRaisesRegex(ValueError,'current bridge implementation'):
                predictor.prefix(cfg,l2)
            self.assertEqual(get.call_count,2)
        l2.provider.make_request.assert_not_called()

    def test_reorg_during_validation_not_cached(self):
        # Pure validation never caches; the provider path checks its pinned block
        # before publishing a fetched prefix (covered by a changed block hash).
        cfg = {'BRIDGE_L2':self.bridge,'WETH_L1':self.token,'WETH_L2':self.wrapper,
               'COW_WRAPPER_EXPLORER_API':'https://explorer.example/api/v2'}
        l2=MagicMock()
        l2.eth.get_block.side_effect=[{'number':123,'hash':b'old'},{'number':123,'hash':b'new'}]
        l2.eth.get_storage_at.return_value=bytes(32)
        l2.eth.get_code.side_effect=[self.runtime,self.bridge_code]
        c=l2.eth.contract.return_value
        c.functions.getWrappedToken.return_value.call.return_value=self.wrapper
        for name,value in zip(('name','symbol','decimals'),self.meta):
            getattr(c.functions,name).return_value.call.return_value=value
        predictor=WrapperPredictor()
        with patch('wrapper_prediction.requests.get') as get:
            get.return_value.json.return_value=self.payload
            with self.assertRaisesRegex(ValueError,'block changed'):
                predictor.prefix(cfg,l2)
        self.assertIsNone(predictor.cached_prefix)
