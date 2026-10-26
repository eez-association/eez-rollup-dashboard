import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from network_config import load_config

ADDRESS = '0x' + '12' * 20
OTHER_ADDRESS = '0x' + '34' * 20


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        # Keep fixtures on the workspace filesystem (some hosts quota /tmp).
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / 'config', self.root / 'config')

    def config(self, **env):
        return load_config(env, root=self.root)

    def manifest(self, network, name, data):
        path = self.root / 'runtime' / network / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
        return path

    def test_original_mainnet_defaults(self):
        cfg = self.config()
        self.assertEqual(cfg['L1_CHAIN_ID'], 1)
        self.assertEqual(cfg['L2_CHAIN_ID'], 696990)
        self.assertEqual(cfg['SETTLEMENT_L2'], '0x2ee5672Aef87B35fe544C41BdfBB7C8D0F7c3478')
        self.assertEqual(len(cfg.catalog()), 100)

    def test_chiado_has_no_mainnet_fallback(self):
        cfg = self.config(COW_NETWORK='chiado')
        self.assertEqual((cfg['L1_CHAIN_ID'], cfg['L2_CHAIN_ID']), (10200, 906969))
        for key in ('L1_RPC', 'L2_RPC', 'L2_FRONT', 'WETH_L1', 'WETH_L2',
                    'SETTLEMENT_L2', 'BRIDGE_L1', 'BRIDGE_L2', 'EEZ_MANAGER_L2',
                    'WRAPPER_REFERENCE_TX', 'WRAPPER_PREFIX_LEN'):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                cfg[key]

    def test_runtime_and_catalog_are_separate(self):
        mainnet, chiado = self.config(), self.config(COW_NETWORK='chiado')
        for key in ('ORDER_QUEUE', 'SOLVER_LOG', 'COW_MANIFEST', 'ROUTE_MANIFEST', 'TOKEN_CATALOG'):
            self.assertNotEqual(mainnet[key], chiado[key])
        self.assertEqual(chiado['ORDER_QUEUE'], self.root / 'runtime/chiado/ui-orders.jsonl')

    def test_profile_manifest_environment_precedence(self):
        self.manifest('mainnet', 'cow-deployment.json', {'chainId': 696990, 'settlement': ADDRESS})
        self.assertEqual(self.config()['SETTLEMENT_L2'], ADDRESS)
        self.assertEqual(self.config(SETTLEMENT_L2=OTHER_ADDRESS)['SETTLEMENT_L2'], OTHER_ADDRESS)

    def test_chiado_manifest_and_environment_configuration(self):
        self.manifest('chiado', 'cow-deployment.json', {'network': 'chiado', 'l1ChainId': 10200,
                                                       'chainId': 906969, 'settlement': ADDRESS})
        cfg = self.config(COW_NETWORK='chiado', L1_RPC='http://localhost:8545',
                          L2_RPC='http://localhost:8546', WRAPPER_PREFIX_LEN='42',
                          WETH_L1=OTHER_ADDRESS)
        self.assertEqual(cfg['SETTLEMENT_L2'], ADDRESS)
        self.assertEqual(cfg['L1_RPC'], 'http://localhost:8545')
        self.assertEqual(cfg['WRAPPER_PREFIX_LEN'], 42)
        catalog = {'chainId': 10200, 'weth': OTHER_ADDRESS, 'tokens': [{'symbol': 'TEST'}]}
        cfg['TOKEN_CATALOG'].write_text(json.dumps(catalog))
        self.assertEqual(cfg.catalog(), [{'symbol': 'TEST'}])

    def test_rejects_foreign_manifest_chain_and_profile(self):
        for data in ({'chainId': 906969}, {'chainId': 696990, 'network': 'chiado'},
                     {'chainId': 696990, 'l1ChainId': 10200}, {}):
            with self.subTest(data=data):
                self.manifest('mainnet', 'cow-deployment.json', data)
                with self.assertRaisesRegex(ValueError, 'manifest'):
                    self.config()

    def test_explicit_manifest_path_is_also_validated(self):
        path = self.manifest('chiado', 'route-deployment.json', {'chainId': 906969})
        with self.assertRaisesRegex(ValueError, 'chainId'):
            self.config(ROUTE_MANIFEST=str(path))

    def test_route_cannot_use_different_settlement(self):
        self.manifest('mainnet', 'route-deployment.json', {'chainId': 696990, 'settlement': ADDRESS})
        with self.assertRaisesRegex(ValueError, 'settlement'):
            self.config()
        self.assertEqual(self.config(SETTLEMENT_L2=ADDRESS)['SETTLEMENT_L2'], ADDRESS)

    def test_paths_do_not_depend_on_cwd(self):
        previous = Path.cwd()
        try:
            os.chdir(self.root / 'config')
            cfg = self.config(ORDER_QUEUE='custom/orders.jsonl', COWSWAP_ARTIFACTS='vendor/cow')
        finally:
            os.chdir(previous)
        self.assertEqual(cfg['ORDER_QUEUE'], self.root / 'custom/orders.jsonl')
        self.assertEqual(cfg['GPV2_ARTIFACT'], self.root / 'vendor/cow/GPv2Settlement.json')
        explicit = self.root / 'settlement.json'
        self.assertEqual(self.config(GPV2_ARTIFACT=str(explicit))['GPV2_ARTIFACT'], explicit)

    def test_rejects_wrong_rpc_chain(self):
        cfg = self.config()
        cfg.check_chains(l1=SimpleNamespace(eth=SimpleNamespace(chain_id=1)),
                         l2=SimpleNamespace(eth=SimpleNamespace(chain_id=696990)))
        with self.assertRaisesRegex(ValueError, 'L2 RPC'):
            cfg.check_chains(l2=SimpleNamespace(eth=SimpleNamespace(chain_id=906969)))

    def test_rejects_foreign_catalog(self):
        with self.assertRaisesRegex(ValueError, 'chainId'):
            self.config(COW_NETWORK='chiado', WETH_L1=ADDRESS,
                        TOKEN_CATALOG='config/token-catalog.json').catalog()
        with self.assertRaisesRegex(ValueError, 'weth'):
            self.config(WETH_L1=ADDRESS).catalog()

    def test_invalid_profile_and_address_fail_clearly(self):
        for name in ('../mainnet', 'unknown'):
            with self.assertRaisesRegex(ValueError, 'profile'):
                self.config(COW_NETWORK=name)
        with self.assertRaisesRegex(ValueError, 'SETTLEMENT_L2'):
            self.config(SETTLEMENT_L2='0x123')

    def test_worker_uses_selected_queue_and_active_interpreter(self):
        cfg = self.config(COW_NETWORK='chiado')
        cfg['ORDER_QUEUE'].parent.mkdir(parents=True)
        cfg['ORDER_QUEUE'].write_text(json.dumps({'id': 'chiado-order', 'status': 'queued'}) + '\n')
        spec = importlib.util.spec_from_file_location('cow_test_worker', ROOT / 'solver/worker.py')
        worker = importlib.util.module_from_spec(spec)
        with patch('network_config.load_config', return_value=cfg):
            spec.loader.exec_module(worker)
        with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as run:
            worker.run_once()
        self.assertEqual(run.call_args.args[0][0], sys.executable)
        self.assertEqual(worker.QUEUE, cfg['ORDER_QUEUE'])
        self.assertTrue(cfg['SOLVER_LOG'].exists())
        self.assertFalse(self.config()['SOLVER_LOG'].exists())


if __name__ == '__main__':
    unittest.main()
