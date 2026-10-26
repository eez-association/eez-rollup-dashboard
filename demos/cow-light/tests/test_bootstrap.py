import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from deployment.bootstrap_chiado import Journal, require_chiado, validate_identity, l1_checkpoint
from network_config import load_config


class BootstrapTests(unittest.TestCase):
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
