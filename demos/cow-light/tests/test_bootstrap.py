import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from deployment.bootstrap_chiado import Journal, require_chiado, validate_identity, l1_checkpoint, chiado_fees, require_verified
from network_config import load_config
from deployment.verify_chiado import compiler_input
from deployment.bootstrap_chiado import quote_transaction, validate_fee_quote


class BootstrapTests(unittest.TestCase):
    def test_cross_chain_quote_is_bound_capped_and_unexpired(self):
        tx = quote_transaction({'type': 2, 'chainId': 10200, 'nonce': 3, 'gas': 6000000,
            'from': '0x'+'12'*20, 'to': '0x'+'34'*20, 'data': '0x1234'})
        canonical = json.dumps(tx, sort_keys=True, separators=(',', ':'))
        quote = {'version': 1, 'chainId': tx['chainId'], 'nonce': tx['nonce'], 'expiresAt': hex(120),
            'options': [{'type': '0x2', 'gas': tx['gas'], 'requestHash': 'bound', 'estimatedFee': hex(1000),
                         'maxFeePerGas': hex(3000000000), 'maxPriorityFeePerGas': hex(2000000000)}]}
        def digest(text):
            self.assertEqual(text, canonical)
            return 'bound'
        self.assertEqual(validate_fee_quote(tx, quote, digest, 100)['maxPriorityFeePerGas'], 2000000000)
        for key,value in [('nonce','0x4'),('chainId','0x1'),('expiresAt','0x1')]:
            with self.assertRaises(ValueError):
                validate_fee_quote(tx, dict(quote, **{key:value}), digest, 100)
        for key,value in [('gas','0x5208'),('requestHash','different'),('maxFeePerGas',hex(6000000000))]:
            modified = dict(quote, options=[dict(quote['options'][0], **{key:value})])
            with self.assertRaises(ValueError):
                validate_fee_quote(tx, modified, digest, 100)

    def test_verification_gate_requires_full_address_specific_code_match(self):
        valid = {'is_verified': True, 'is_partially_verified': False, 'deployed_bytecode': '0x1234'}
        require_verified(valid, '0x1234')
        for info in [{}, dict(valid, is_partially_verified=True), dict(valid, is_verified=False),
                     dict(valid, deployed_bytecode='0x5678')]:
            with self.assertRaisesRegex(ValueError, 'verification required'):
                require_verified(info, '0x1234')

    def test_verification_requires_exact_source_and_retains_settings(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            root = Path(folder)
            (root / 'Token.sol').write_text('contract Token {}')
            artifact = {'metadata': {'compiler': {'version': '0.8.30'},
                'sources': {'Token.sol': {'keccak256': 'exact'}},
                'settings': {'compilationTarget': {'Token.sol': 'Token'}, 'optimizer': {'enabled': True, 'runs': 200}}}}
            version, target, data = compiler_input(artifact, root, lambda text: 'exact')
            self.assertEqual(target, 'Token.sol:Token')
            self.assertEqual(data['settings']['optimizer']['runs'], 200)
            self.assertNotIn('compilationTarget', data['settings'])
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                compiler_input(artifact, root, lambda text: 'different')
            artifact['metadata']['sources'] = {'../outside.sol': {'keccak256': 'exact'}}
            with self.assertRaisesRegex(ValueError, 'escapes'):
                compiler_input(artifact, root, lambda text: 'exact')

    def test_chiado_zero_tip_has_floor_and_fee_cap(self):
        self.assertEqual(chiado_fees(7, 0), {'type': 2, 'maxFeePerGas': 1000000014,
                                            'maxPriorityFeePerGas': 1000000000})
        self.assertEqual(chiado_fees(10, 2000000000)['maxFeePerGas'], 2000000020)
        with self.assertRaisesRegex(ValueError, 'safety cap'):
            chiado_fees(3000000000, 0)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'bootstrap.json'

    def test_mainnet_is_never_bootstrapped(self):
        for args in [('mainnet', 1, 696990), ('chiado', 1, 916969),
                     ('chiado', 10200, 1), ('chiado', 10200, 100), ('chiado', 10200, 10200)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                require_chiado(*args)
        require_chiado('chiado', 10200, 916969)
        require_chiado('chiado', 10200, 906969)

    def test_binding_changes_are_rejected(self):
        for key in ('l2ChainId', 'l2Genesis', 'l1Checkpoint', 'bridgeL1', 'bridgeL2', 'manager'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_identity({key: 'old'}, {key: 'new'})

    def test_pruned_l1_uses_finalized_checkpoint_and_rechecks_saved_block(self):
        calls = []
        def get_block(number):
            calls.append(number)
            if number == 0:
                raise ValueError('genesis pruned')
            return {'number': 23700000, 'hash': 'checkpoint'}
        self.assertEqual(l1_checkpoint(get_block)['number'], 23700000)
        l1_checkpoint(get_block, {'l1Checkpoint': {'number': 23700000}})
        self.assertEqual(calls, ['finalized', 23700000])

    def test_durable_before_broadcast_and_no_duplicate_on_rerun(self):
        calls = []
        def broadcast(raw):
            self.assertEqual(json.loads(self.path.read_text())['transactions']['factory']['hash'], '0x123')
            calls.append(raw)
            raise TimeoutError('ambiguous send')
        with self.assertRaises(TimeoutError):
            Journal(self.path, {'chain': 1}).transaction('factory', lambda: ('0x123', b'raw'), broadcast, lambda h: None)
        j = Journal(self.path, {'chain': 1})
        def never(*args):
            self.fail('Must reconcile, never sign/broadcast a second transaction')
        self.assertEqual(j.transaction('factory', never, never, lambda h: {'hash': h}), {'hash': '0x123'})
        self.assertEqual(calls, [b'raw'])

    def test_completed_stage_revalidates_receipt(self):
        j = Journal(self.path, {})
        j.transaction('seed', lambda: ('hash', b'raw'), lambda raw: None, lambda h: {'hash': h})
        def reorg(h):
            raise ValueError('not canonical')
        with self.assertRaisesRegex(ValueError, 'canonical'):
            j.transaction('seed', lambda: self.fail(), lambda raw: self.fail(), reorg)

    def test_generated_environment_is_reusable_without_sourcing_shell(self):
        env = self.path.with_name('environment.json')
        env.write_text(json.dumps({'COW_NETWORK': 'chiado', 'L2_CHAIN_ID': '916969',
                                   'WETH_L1': '0x' + '12' * 20}))
        cfg = load_config({'COW_DEPLOYMENT_ENV': str(env)})
        self.assertEqual(cfg['L2_CHAIN_ID'], 916969)
        self.assertEqual(cfg['WETH_L1'], '0x' + '12' * 20)
        env.write_text(json.dumps({'DEPLOYER_PRIVATE_KEY': 'must-not-load'}))
        with self.assertRaisesRegex(ValueError, 'environment'):
            load_config({'COW_DEPLOYMENT_ENV': str(env)})


if __name__ == '__main__':
    unittest.main()
