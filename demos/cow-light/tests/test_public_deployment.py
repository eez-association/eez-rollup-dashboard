"""Public deployment evidence must not contain runtime endpoints or signing data."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class PublicDeploymentTests(unittest.TestCase):
    def test_export_omits_private_transport_and_journal_payloads(self):
        config = {'NETWORK':'chiado', 'L1_CHAIN_ID':10200, 'L2_CHAIN_ID':699169,
                  'L2_RPC':'https://user:fixture-password@example.invalid/rpc?key=fixture-api-key',
                  'COW_MANIFEST':Path('unused-manifest.json'), 'COWSWAP_ARTIFACTS':Path('unused-artifacts')}
        spec = importlib.util.spec_from_file_location('cow_public_export', ROOT / 'deployment/deploy_cow.py')
        module = importlib.util.module_from_spec(spec)
        with patch('network_config.load_config', return_value=config):
            spec.loader.exec_module(module)
        address = '0x' + '12' * 20
        tx_hash = '0x' + '34' * 32
        identity = {'L2_CHAIN_ID':699169, 'L2_GENESIS_HASH':'0x' + '56' * 32}
        output = module.deployment_record(config, address, address, identity, address, address, address,
            {'settlement': {'hash':tx_hash, 'rawTransaction':'private-journal-payload',
                            'receipt':{'diagnosticRpc':config['L2_RPC']}}})
        self.assertEqual(output['deploymentTxs'], {'settlement':tx_hash})
        self.assertEqual(output['deploymentIdentity'], identity)
        self.assertEqual(output['chainId'], 699169)
        encoded = json.dumps(output)
        for private_value in (config['L2_RPC'], 'fixture-password', 'fixture-api-key', 'private-journal-payload'):
            self.assertNotIn(private_value, encoded)
        self.assertNotIn('rpc', output)

    def test_eez_dev_public_files_contain_no_endpoint_or_signing_fields(self):
        files = ['config/deployments/eez-dev-699169-r2.json',
                 'config/token-catalog.eez-dev-699169-r2.json',
                 'deployment/records/eez-dev-699169-r2.json']

        def inspect(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertIsNone(re.search(r'rpc|private.?key|mnemonic|password|secret|signature|raw.?transaction', key, re.I), key)
                    inspect(child)
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
            elif isinstance(value, str):
                self.assertNotRegex(value, r'https?://|/(?:home|Users)/|-----BEGIN .*PRIVATE KEY')

        for filename in files:
            with self.subTest(filename=filename):
                inspect(json.loads((ROOT / filename).read_text()))


if __name__ == '__main__':
    unittest.main()
