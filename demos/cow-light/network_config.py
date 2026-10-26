"""Shared, dependency-free configuration for every CoW Light process.

Paths are relative to the demo directory, never the process working directory.
Precedence: profile < deployment manifests < explicit environment overrides.
"""
import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
INTEGER_KEYS = ('L1_CHAIN_ID', 'L2_CHAIN_ID', 'L2_ROLLUP_ID', 'WRAPPER_PREFIX_LEN')
PATH_KEYS = ('TOKEN_CATALOG', 'ORDER_QUEUE', 'SOLVER_LOG', 'ROUTE_MANIFEST',
             'COW_MANIFEST', 'COWSWAP_ARTIFACTS', 'GPV2_ARTIFACT')
ADDRESS_KEYS = ('WETH_L1', 'WETH_L2', 'BRIDGE_L1', 'BRIDGE_L2',
                'EEZ_MANAGER_L2', 'SETTLEMENT_L2', 'NATIVE_WETH_L2',
                'DETERMINISTIC_FACTORY_L1')
SHARED_SETTINGS = {
    'L1_RPC': 'EEZ_UI_L1_RPC_UPSTREAM',
    'L2_RPC': 'EEZ_UI_L2_RPC_UPSTREAM',
    'L2_FRONT': 'EEZ_UI_L2_FRONT_UPSTREAM',
    'L1_EXPLORER': 'EEZ_UI_L1_EXPLORER_URL',
    'L2_EXPLORER': 'EEZ_UI_L2_EXPLORER_URL',
    'BRIDGE_L1': 'EEZ_L1_BRIDGE_SENDER',
    'BRIDGE_L2': 'EEZ_L2_BRIDGE_RECEIVER',
    'EEZ_MANAGER_L2': 'EEZL2_ADDRESS',
    'L2_ROLLUP_ID': 'EEZ_ROLLUP_ID',
}


def rpc_chain_id(endpoint):
    """Read identity without Web3, signing, or exposing credential-bearing URLs."""
    try:
        request = Request(endpoint, data=json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []
        }).encode(), headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=10) as response:
            result = json.load(response)
        value = result.get('result')
        if result.get('error') or not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]+', value):
            raise ValueError('Invalid chain ID')
        chain = int(value, 16)
        if chain <= 0:
            raise ValueError('Invalid chain ID')
        return chain
    except Exception:
        raise ValueError('Could not discover chain ID from configured RPC') from None


class NetworkConfig:
    def __init__(self, values, root):
        self.values = values
        self.root = root

    def __getitem__(self, key):
        value = self.values.get(key)
        if value is None or value == '':
            raise ValueError(f'{self.values["NETWORK"]}: configure {key}')
        return value

    def get(self, key, default=None):
        return self.values.get(key, default)

    def require(self, *keys):
        for key in keys:
            self[key]
        return self

    def check_chains(self, l1=None, l2=None):
        for name, client in (('L1', l1), ('L2', l2)):
            if client is not None and client.eth.chain_id != self[name + '_CHAIN_ID']:
                raise ValueError(f'{name} RPC chain does not match {self["NETWORK"]} profile')
        if l2 is not None and self.get('L2_FRONT'):
            if rpc_chain_id(self['L2_FRONT']) != self['L2_CHAIN_ID']:
                raise ValueError('L2 Composer chain does not match selected L2')

    def read_manifest(self, key):
        path = self[key]
        if not path.exists():
            return {}
        data = json.loads(path.read_text())
        if data.get('chainId') != self['L2_CHAIN_ID']:
            raise ValueError(f'{path}: manifest chainId does not match selected L2')
        if data.get('network', self['NETWORK']) != self['NETWORK']:
            raise ValueError(f'{path}: manifest network does not match selected profile')
        if data.get('l1ChainId', self['L1_CHAIN_ID']) != self['L1_CHAIN_ID']:
            raise ValueError(f'{path}: manifest l1ChainId does not match selected L1')
        return data

    def catalog(self):
        data = json.loads(self['TOKEN_CATALOG'].read_text())
        if data.get('chainId') != self['L1_CHAIN_ID']:
            raise ValueError('Token catalog chainId does not match selected L1')
        if (data.get('weth') or '').lower() != self['WETH_L1'].lower():
            raise ValueError('Token catalog weth does not match WETH_L1')
        return data.get('tokens', [])


def load_config(environ=None, root=ROOT):
    env = os.environ if environ is None else environ
    root = Path(root)
    if env.get('COW_DEPLOYMENT_ENV'):
        deployment_env = Path(env['COW_DEPLOYMENT_ENV'])
        if not deployment_env.is_absolute():
            deployment_env = root / deployment_env
        saved = json.loads(deployment_env.read_text())
        allowed = {'COW_NETWORK', *INTEGER_KEYS, *PATH_KEYS, *ADDRESS_KEYS}
        if not isinstance(saved, dict) or set(saved) - allowed or any(not isinstance(v, str) for v in saved.values()):
            raise ValueError('Invalid deployment environment file')
        # Saved deployment bindings win over shared dashboard aliases; explicit
        # demo-specific environment values retain their usual precedence.
        env = {**saved, **env}
    network = env.get('COW_NETWORK', 'mainnet')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', network):
        raise ValueError('Invalid COW_NETWORK profile name')
    profile = root / 'config' / 'networks' / f'{network}.json'
    if not profile.is_file():
        raise ValueError(f'Unknown COW_NETWORK profile: {network}')
    values = json.loads(profile.read_text())
    # Share the dashboard environment, without implicitly reading/sourcing files.
    # Non-empty demo-specific settings override shared settings.
    env = dict(env)
    for key, shared in SHARED_SETTINGS.items():
        if not env.get(key) and env.get(shared):
            env[key] = env[shared]
    values['NETWORK'] = network
    runtime = f'runtime/{network}'
    values.update(ORDER_QUEUE=f'{runtime}/ui-orders.jsonl',
                  SOLVER_LOG=f'{runtime}/solver-worker.log',
                  ROUTE_MANIFEST=f'{runtime}/route-deployment.json',
                  COW_MANIFEST=f'{runtime}/cow-deployment.json')
    values.setdefault('COWSWAP_ARTIFACTS', 'contracts/artifacts')
    # Resolve paths and chain identity before loading any deployment addresses.
    for key in (*INTEGER_KEYS, *PATH_KEYS):
        if key in env:
            values[key] = env[key]
    for key in INTEGER_KEYS:
        if values.get(key) is not None:
            values[key] = int(values[key])
            if values[key] <= 0:
                raise ValueError(f'{key} must be positive')
    for key in SHARED_SETTINGS:
        if key in env and key not in INTEGER_KEYS:
            values[key] = env[key]
    # A null profile chain ID means discover, not trust a deployment manifest.
    for side in ('L1', 'L2'):
        if values.get(side + '_CHAIN_ID') is None and values.get(side + '_RPC'):
            values[side + '_CHAIN_ID'] = rpc_chain_id(values[side + '_RPC'])
    for key in PATH_KEYS:
        if values.get(key):
            path = Path(values[key])
            values[key] = path if path.is_absolute() else root / path
    cfg = NetworkConfig(values, root)
    cow = cfg.read_manifest('COW_MANIFEST')
    if cow.get('settlement'):
        values['SETTLEMENT_L2'] = cow['settlement']
    route = cfg.read_manifest('ROUTE_MANIFEST')
    for key in set(values) - set(INTEGER_KEYS) - set(PATH_KEYS) - {'NETWORK'}:
        if key in env:
            values[key] = env[key]
    if not values.get('GPV2_ARTIFACT'):
        values['GPV2_ARTIFACT'] = values['COWSWAP_ARTIFACTS'] / 'GPv2Settlement.json'
    if route.get('settlement') and route['settlement'].lower() != (values.get('SETTLEMENT_L2') or '').lower():
        raise ValueError('Route manifest settlement does not match selected settlement')
    for key in ADDRESS_KEYS:
        value = values.get(key)
        if value and (not re.fullmatch(r'0x[0-9a-fA-F]{40}', value) or int(value, 16) == 0):
            raise ValueError(f'Invalid {key}')
    return cfg
