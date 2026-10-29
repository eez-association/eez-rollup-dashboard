import importlib.util
import ast
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from network_config import load_config, environment

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

    def test_saved_rog_asset_configuration_is_explicit_and_portable(self):
        cfg = self.config(COW_DEPLOYMENT_ENV='config/deployments/rog-916969.json')
        self.assertEqual(cfg['L2_CHAIN_ID'], 916969)
        self.assertEqual(cfg['L1_CHAIN_ID'], 10200)
        self.assertEqual(cfg.catalog()[0]['symbol'], 'ctUSD')
        self.assertEqual(cfg['ORDER_QUEUE'], self.root / 'runtime/chiado/deployments/rog-916969/ui-orders.jsonl')
        with self.assertRaisesRegex(ValueError, 'SETTLEMENT_L2'):
            cfg['SETTLEMENT_L2']

    def test_chiado_has_no_mainnet_fallback(self):
        cfg = self.config(COW_NETWORK='chiado')
        self.assertEqual(cfg['L1_CHAIN_ID'], 10200)
        self.assertIsNone(cfg.get('L2_CHAIN_ID'))
        self.assertIsNone(cfg.get('L2_ROLLUP_ID'))
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

    def test_shared_dashboard_endpoints_discover_l2(self):
        with patch('network_config.rpc_chain_id', return_value=916969) as rpc:
            cfg = self.config(COW_NETWORK='chiado',
                              EEZ_UI_L1_RPC_UPSTREAM='http://l1',
                              EEZ_UI_L2_RPC_UPSTREAM='http://l2',
                              EEZ_UI_L2_FRONT_UPSTREAM='http://composer')
            self.assertEqual(cfg['L2_CHAIN_ID'], 916969)
            self.assertEqual(cfg['L1_RPC'], 'http://l1')
            self.assertEqual(cfg['L2_FRONT'], 'http://composer')
            rpc.assert_called_once_with('http://l2')
            cfg.check_chains(l1=SimpleNamespace(eth=SimpleNamespace(chain_id=10200)),
                             l2=SimpleNamespace(eth=SimpleNamespace(chain_id=916969)))
            rpc.assert_called_with('http://composer')

    def test_discovery_does_not_accept_old_manifest(self):
        self.manifest('chiado', 'cow-deployment.json', {'chainId': 906969})
        with patch('network_config.rpc_chain_id', return_value=916969):
            with self.assertRaisesRegex(ValueError, 'manifest chainId'):
                self.config(COW_NETWORK='chiado', L2_RPC='http://l2')

    def test_shared_infrastructure_and_explicit_overrides(self):
        env = dict(COW_NETWORK='chiado', EEZ_L1_BRIDGE_SENDER=ADDRESS,
                   EEZ_L2_BRIDGE_RECEIVER=OTHER_ADDRESS, EEZL2_ADDRESS=ADDRESS,
                   EEZ_ROLLUP_ID='2', BRIDGE_L1='', EEZ_MANAGER_L2='')
        cfg = self.config(**env)
        self.assertEqual(cfg['BRIDGE_L1'], ADDRESS)
        self.assertEqual(cfg['BRIDGE_L2'], OTHER_ADDRESS)
        self.assertEqual(cfg['EEZ_MANAGER_L2'], ADDRESS)
        self.assertEqual(cfg['L2_ROLLUP_ID'], 2)
        cfg = self.config(**dict(env, BRIDGE_L1=OTHER_ADDRESS, L2_ROLLUP_ID='3'))
        self.assertEqual(cfg['BRIDGE_L1'], OTHER_ADDRESS)
        self.assertEqual(cfg['L2_ROLLUP_ID'], 3)
        with self.assertRaisesRegex(ValueError, 'BRIDGE_L2'):
            self.config(**dict(env, EEZ_L2_BRIDGE_RECEIVER='0x123'))
        with self.assertRaisesRegex(ValueError, 'positive'):
            self.config(**dict(env, EEZ_ROLLUP_ID='0'))

    def test_shared_environment_overrides_historical_snapshot(self):
        cfg = self.config(COW_DEPLOYMENT_ENV='config/deployments/rog-916969.json',
                          EEZ_L1_BRIDGE_SENDER=ADDRESS, EEZ_ROLLUP_ID='4')
        self.assertEqual(cfg['BRIDGE_L1'], ADDRESS)
        self.assertEqual(cfg['L2_ROLLUP_ID'], 4)
        cfg = self.config(COW_DEPLOYMENT_ENV='config/deployments/rog-916969.json',
                          EEZ_L1_BRIDGE_SENDER=ADDRESS, BRIDGE_L1=OTHER_ADDRESS)
        self.assertEqual(cfg['BRIDGE_L1'], OTHER_ADDRESS)

    def test_explicit_env_file_is_allowlisted_and_not_executed(self):
        path = self.root / '.env'
        path.write_text('export EEZ_ROLLUP_ID="4" # current rollup\n'
                        'EEZ_UI_L2_RPC_UPSTREAM=http://shared\n'
                        'DEPLOYER_PRIVATE_KEY=secret\nUNRELATED=$(touch should-not-exist)\n')
        env = environment({'COW_ENV_FILE':str(path), 'EEZ_ROLLUP_ID':'5'})
        self.assertEqual(env['EEZ_ROLLUP_ID'], '5')
        self.assertEqual(env['EEZ_UI_L2_RPC_UPSTREAM'], 'http://shared')
        self.assertNotIn('DEPLOYER_PRIVATE_KEY', env)
        self.assertNotIn('UNRELATED', env)
        with patch('network_config.rpc_chain_id', return_value=916969):
            cfg = self.config(COW_ENV_FILE=str(path), COW_NETWORK='chiado')
        self.assertEqual(cfg['L2_RPC'], 'http://shared')
        self.assertEqual(cfg['L2_ROLLUP_ID'], 4)

    def test_env_file_shell_substitution_is_rejected(self):
        path = self.root / '.env'
        for value in ('$(echo secret)', '${OTHER_RPC}', '`echo secret`'):
            path.write_text('EEZ_UI_L2_RPC_UPSTREAM=' + value)
            with self.assertRaises(ValueError):
                environment({'COW_ENV_FILE':str(path)})

    def test_genesis_pin_detects_reset_with_same_chain_id(self):
        cfg = self.config(COW_NETWORK='chiado', L2_CHAIN_ID='916969',
                          L2_GENESIS_HASH='0x'+'11'*32)
        l2 = SimpleNamespace(eth=SimpleNamespace(chain_id=916969,
             get_block=lambda _: {'hash':bytes.fromhex('22'*32)}))
        with self.assertRaisesRegex(ValueError, 'genesis changed'):
            cfg.check_chains(l2=l2)

    def test_api_blocks_stale_deployment_before_config_or_quotes(self):
        from urllib.parse import urlparse
        tree = ast.parse((ROOT / 'backend/server.py').read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
        cfg = MagicMock()
        cfg.check_deployment.side_effect = ValueError('stale deployment')
        namespace = {'BaseHTTPRequestHandler':object,'urlparse':urlparse,'CFG':cfg,'l1':None,'l2':None}
        exec(compile(ast.Module(body=[handler],type_ignores=[]), '<api fixture>', 'exec'), namespace)
        instance = namespace['Handler']()
        instance.send_json = MagicMock()
        for path in ('/api/config','/api/quote?amount=1','/api/wrapper?token=x','/api/allowance','/api/balances'):
            instance.path = path
            instance.do_GET()
            payload, status = instance.send_json.call_args.args
            self.assertEqual(status,503)
            self.assertEqual(payload['status'],'deployment_required')

    def test_runtime_requires_complete_matching_identity_and_live_bindings(self):
        cfg = self.config(COW_NETWORK='chiado', L2_CHAIN_ID='916969', L2_ROLLUP_ID='4',
            BRIDGE_L1=ADDRESS, BRIDGE_L2=OTHER_ADDRESS, EEZ_MANAGER_L2=ADDRESS,
            WETH_L1=ADDRESS, WETH_L2=OTHER_ADDRESS, SETTLEMENT_L2=ADDRESS)
        l1, l2 = MagicMock(), MagicMock()
        for client, chain in ((l1,10200),(l2,916969)):
            client.eth.chain_id = chain
            client.eth.get_block.return_value = {'hash': bytes.fromhex('11'*32)}
            client.eth.get_code.return_value = b'code'
            client.to_checksum_address.side_effect = lambda a:a
        identity = cfg.deployment_identity(l2)
        with self.assertRaisesRegex(ValueError, 'missing or stale'):
            cfg.check_deployment(l1,l2)
        cow = {'chainId':916969,'settlement':ADDRESS,'authenticator':ADDRESS,
               'vaultRelayer':ADDRESS,'deploymentIdentity':identity}
        route = {'chainId':916969,'settlement':ADDRESS,'routeL2':ADDRESS,
                 'l1Helper':ADDRESS,'l2HelperProxy':OTHER_ADDRESS,'deploymentIdentity':identity}
        self.manifest('chiado','cow-deployment.json',cow)
        self.manifest('chiado','route-deployment.json',route)
        l1.eth.contract.return_value.functions.canonicalBridgeAddress.return_value.call.return_value = OTHER_ADDRESS
        l1.eth.contract.return_value.functions.rollupId.return_value.call.return_value = 0
        funcs = l2.eth.contract.return_value.functions
        funcs.canonicalBridgeAddress.return_value.call.return_value = ADDRESS
        funcs.rollupId.return_value.call.return_value = 4
        funcs.EEZContract.return_value.call.return_value = ADDRESS
        funcs.getWrappedToken.return_value.call.return_value = OTHER_ADDRESS
        cfg.check_deployment(l1,l2)
        funcs.getWrappedToken.return_value.call.return_value = ADDRESS
        with self.assertRaisesRegex(ValueError, 'current bridge wrapper'):
            cfg.check_deployment(l1,l2)
        funcs.getWrappedToken.return_value.call.return_value = OTHER_ADDRESS
        l2.eth.get_code.return_value = b''
        with self.assertRaisesRegex(ValueError, 'no code'):
            cfg.check_deployment(l1,l2)
        l2.eth.get_code.return_value = b'code'
        for changed in ({'L2_GENESIS_HASH':'0x'+'22'*32}, {'L2_ROLLUP_ID':1}, {'BRIDGE_L2':ADDRESS}):
            self.manifest('chiado','cow-deployment.json',dict(cow,deploymentIdentity={**identity,**changed}))
            with self.assertRaisesRegex(ValueError, 'missing or stale'):
                cfg.check_deployment(l1,l2)

    def test_discovery_failure_is_not_a_fallback(self):
        with patch('network_config.rpc_chain_id', side_effect=ValueError('RPC unavailable')):
            with self.assertRaisesRegex(ValueError, 'RPC unavailable'):
                self.config(COW_NETWORK='chiado', L2_RPC='http://l2')

    def test_explicit_settings_and_pins_take_precedence(self):
        with patch('network_config.rpc_chain_id') as rpc:
            cfg = self.config(COW_NETWORK='chiado', L2_CHAIN_ID='916969',
                              L2_RPC='http://override', EEZ_UI_L2_RPC_UPSTREAM='http://shared')
            self.assertEqual(cfg['L2_RPC'], 'http://override')
            rpc.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'L2 RPC'):
                cfg.check_chains(l2=SimpleNamespace(eth=SimpleNamespace(chain_id=906969)))

    def test_composer_must_match_read_rpc(self):
        cfg = self.config(COW_NETWORK='chiado', L2_CHAIN_ID='916969', L2_FRONT='http://composer')
        with patch('network_config.rpc_chain_id', return_value=906969):
            with self.assertRaisesRegex(ValueError, 'Composer'):
                cfg.check_chains(l2=SimpleNamespace(eth=SimpleNamespace(chain_id=916969)))

    def test_rpc_identity_rejects_invalid_response_and_hides_endpoint(self):
        from network_config import rpc_chain_id
        from io import BytesIO
        for payload in ({'result': '0x0'}, {'result': 916969}, {'error': {'message': 'secret'}}, {}):
            with patch('network_config.urlopen', return_value=BytesIO(json.dumps(payload).encode())):
                with self.assertRaisesRegex(ValueError, '^Could not discover chain ID from configured RPC$'):
                    rpc_chain_id('http://user:secret@localhost')
        with patch('network_config.urlopen', return_value=BytesIO(b'{"result":"0xdfde9"}')):
            self.assertEqual(rpc_chain_id('http://localhost'), 916969)

    def test_profile_manifest_environment_precedence(self):
        self.manifest('mainnet', 'cow-deployment.json', {'chainId': 696990, 'settlement': ADDRESS})
        self.assertEqual(self.config()['SETTLEMENT_L2'], ADDRESS)
        self.assertEqual(self.config(SETTLEMENT_L2=OTHER_ADDRESS)['SETTLEMENT_L2'], OTHER_ADDRESS)

    def test_chiado_manifest_and_environment_configuration(self):
        self.manifest('chiado', 'cow-deployment.json', {'network': 'chiado', 'l1ChainId': 10200,
                                                       'chainId': 906969, 'settlement': ADDRESS})
        cfg = self.config(COW_NETWORK='chiado', L1_RPC='http://localhost:8545',
                          L2_CHAIN_ID='906969',
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
        with patch('network_config.rpc_chain_id', return_value=696990):
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
