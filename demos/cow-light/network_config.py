"""Shared, dependency-free configuration for every CoW Light process.

Paths are relative to the demo directory, never the process working directory.
Precedence: profile < deployment manifests < explicit environment overrides.
"""
import json
import os
import re
import shlex
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
INTEGER_KEYS = ('L1_CHAIN_ID', 'L2_CHAIN_ID', 'L2_ROLLUP_ID', 'WRAPPER_PREFIX_LEN')
PATH_KEYS = ('TOKEN_CATALOG', 'ORDER_QUEUE', 'SOLVER_LOG', 'ROUTE_MANIFEST',
             'COW_MANIFEST', 'COWSWAP_ARTIFACTS', 'GPV2_ARTIFACT')
ADDRESS_KEYS = ('WETH_L1', 'WETH_L2', 'BRIDGE_L1', 'BRIDGE_L2',
                'EEZ_MANAGER_L2', 'SETTLEMENT_L2', 'NATIVE_WETH_L2',
                'DETERMINISTIC_FACTORY_L1', 'COW_FAUCET_L1', 'REGISTRY_L1')
SHARED_SETTINGS = {
    'L1_RPC': 'EEZ_UI_L1_RPC_UPSTREAM',
    'L2_RPC': 'EEZ_UI_L2_RPC_UPSTREAM',
    'L2_FRONT': 'EEZ_UI_L2_FRONT_UPSTREAM',
    'L1_FRONT': 'EEZ_UI_L1_FRONT_UPSTREAM',
    'REGISTRY_L1': 'EEZ_REGISTRY_ADDRESS',
    'L1_EXPLORER': 'EEZ_UI_L1_EXPLORER_URL',
    'L2_EXPLORER': 'EEZ_UI_L2_EXPLORER_URL',
    'BRIDGE_L1': 'EEZ_L1_BRIDGE_SENDER',
    'BRIDGE_L2': 'EEZ_L2_BRIDGE_RECEIVER',
    'EEZ_MANAGER_L2': 'EEZL2_ADDRESS',
    'L2_ROLLUP_ID': 'EEZ_ROLLUP_ID',
}
IDENTITY_KEYS = ('L1_CHAIN_ID', 'L2_CHAIN_ID', 'L2_ROLLUP_ID', 'BRIDGE_L1',
                 'BRIDGE_L2', 'EEZ_MANAGER_L2', 'WETH_L1', 'WETH_L2')
PUBLIC_ENDPOINT_KEYS = ('COW_PUBLIC_L1_RPC', 'COW_PUBLIC_L2_FRONT', 'COW_WRAPPER_EXPLORER_API')


def environment(environ):
    """Read only explicitly selected public settings; never execute a .env file."""
    explicit = {k: v for k, v in environ.items() if v != ''}
    path = explicit.get('COW_ENV_FILE')
    allowed = {'COW_NETWORK', 'COW_DEPLOYMENT_ENV', 'L2_GENESIS_HASH', 'EEZ_UI_RUNTIME_CONFIG',
               *INTEGER_KEYS, *PATH_KEYS, *ADDRESS_KEYS, *PUBLIC_ENDPOINT_KEYS, *SHARED_SETTINGS,
               *SHARED_SETTINGS.values()}
    values = {}
    for line in Path(path).expanduser().read_text().splitlines() if path else []:
        name, sep, value = line.removeprefix('export ').partition('=')
        name = name.strip()
        if not sep or name not in allowed:
            continue
        parts = shlex.split(value, comments=True)
        if not parts:
            continue
        if len(parts) != 1 or '$' in parts[0] or '`' in parts[0]:
            raise ValueError(f'{name}: use a literal .env value; shell expansion is not supported')
        values[name] = parts[0]
    selected = {**values, **explicit}
    runtime_path = selected.get('EEZ_UI_RUNTIME_CONFIG')
    shared = dashboard_environment(runtime_path) if runtime_path else {}
    return {**shared, **selected}


def dashboard_environment(filename):
    """Use the same runtime JSON as Vite, without copying network bindings."""
    path = Path(filename).expanduser()
    if not path.is_absolute():
        path = ROOT.parents[1] / path
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or not isinstance(data.get('browser'), dict) or not isinstance(data.get('proxy'), dict):
        raise ValueError('Dashboard runtime configuration requires browser and proxy objects')
    bindings = {
        'proxy': {'l1Rpc': 'EEZ_UI_L1_RPC_UPSTREAM', 'l2Rpc': 'EEZ_UI_L2_RPC_UPSTREAM',
                  'l1Front': 'EEZ_UI_L1_FRONT_UPSTREAM', 'l2Front': 'EEZ_UI_L2_FRONT_UPSTREAM'},
        'browser': {'bridgeL1Address': 'EEZ_L1_BRIDGE_SENDER', 'bridgeL2Address': 'EEZ_L2_BRIDGE_RECEIVER',
                    'l2ContractAddress': 'EEZL2_ADDRESS', 'l1ContractAddress': 'EEZ_REGISTRY_ADDRESS',
                    'rollupId': 'EEZ_ROLLUP_ID', 'l1ExplorerUrl': 'EEZ_UI_L1_EXPLORER_URL',
                    'l2ExplorerUrl': 'EEZ_UI_L2_EXPLORER_URL',
                    'l1RpcUrl': 'COW_PUBLIC_L1_RPC', 'l2FrontUrl': 'COW_PUBLIC_L2_FRONT'},
    }
    values = {}
    for section, fields in bindings.items():
        for source, target in fields.items():
            value = data[section].get(source)
            if value is None or value == '':
                continue
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise ValueError(f'Invalid dashboard setting: {section}.{source}')
            values[target] = str(value)
    return values


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
        if l2 is not None and self.get('L2_GENESIS_HASH'):
            if self.genesis(l2) != self['L2_GENESIS_HASH'].lower():
                raise ValueError('L2 genesis changed: deployment required; use fresh manifests and queue')

    @staticmethod
    def genesis(l2):
        value = l2.eth.get_block(0)['hash']
        return ('0x' + bytes(value).hex()).lower() if not isinstance(value, str) else value.lower()

    def deployment_identity(self, l2):
        return {**{key: self[key] for key in IDENTITY_KEYS}, 'L2_GENESIS_HASH': self.genesis(l2)}

    def check_deployment(self, l1, l2):
        """Fail closed for resets, stale configuration and missing demo code."""
        self.check_chains(l1=l1, l2=l2)
        identity = self.deployment_identity(l2)
        for key in ('COW_MANIFEST', 'ROUTE_MANIFEST'):
            saved = self.read_manifest(key)
            bound = saved.get('deploymentIdentity')
            if not bound or {k: str(v).lower() for k, v in bound.items()} != {
                    k: str(v).lower() for k, v in identity.items()}:
                raise ValueError('Deployment required: missing or stale network identity; do not reuse old manifests/queue')
        cow, route = self.read_manifest('COW_MANIFEST'), self.read_manifest('ROUTE_MANIFEST')
        if cow.get('settlement', '').lower() != self['SETTLEMENT_L2'].lower():
            raise ValueError('Deployment settlement does not match configuration')
        for client, addresses in ((l1, [self['BRIDGE_L1'], self['WETH_L1'], route.get('l1Helper')]),
                                  (l2, [self['BRIDGE_L2'], self['EEZ_MANAGER_L2'], self['WETH_L2'],
                                        cow.get('settlement'), cow.get('authenticator'), cow.get('vaultRelayer'),
                                        route.get('routeL2'), route.get('l2HelperProxy')])):
            for address in addresses:
                if not address or not client.eth.get_code(client.to_checksum_address(address)):
                    raise ValueError('Deployment required: configured contract has no code')
        def read(client, address, name, output='address', inputs=(), args=()):
            abi = [{'type':'function','name':name,'stateMutability':'view',
                    'inputs':[{'type':t} for t in inputs], 'outputs':[{'type':output}]}]
            contract = client.eth.contract(client.to_checksum_address(address), abi=abi)
            return getattr(contract.functions, name)(*args).call()
        for client, local, peer, rollup in ((l1, self['BRIDGE_L1'], self['BRIDGE_L2'], 0),
                                           (l2, self['BRIDGE_L2'], self['BRIDGE_L1'], self['L2_ROLLUP_ID'])):
            remote = read(client, local, 'canonicalBridgeAddress')
            if int(remote, 16) == 0:
                remote = local
            if remote.lower() != peer.lower() or read(client, local, 'rollupId', 'uint64') != rollup:
                raise ValueError('Deployment required: bridge peer or rollup binding changed')
        try:
            manager = read(l2, self['BRIDGE_L2'], 'EEZContract')
        except Exception:
            manager = read(l2, self['BRIDGE_L2'], 'manager')
        if manager.lower() != self['EEZ_MANAGER_L2'].lower():
            raise ValueError('Deployment required: bridge manager changed')
        wrapper = read(l2, self['BRIDGE_L2'], 'getWrappedToken', inputs=('address','uint64'),
                       args=(l2.to_checksum_address(self['WETH_L1']), 0))
        if wrapper.lower() != self['WETH_L2'].lower():
            raise ValueError('Deployment required: configured token is not the current bridge wrapper')

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
    env = environment(os.environ if environ is None else environ)
    # Live shared .env settings override historical deployment snapshots.
    # A non-empty demo-specific setting remains the explicit override.
    for key, shared in SHARED_SETTINGS.items():
        if not env.get(key) and env.get(shared):
            env[key] = env[shared]
    root = Path(root)
    if env.get('COW_DEPLOYMENT_ENV'):
        deployment_env = Path(env['COW_DEPLOYMENT_ENV'])
        if not deployment_env.is_absolute():
            deployment_env = root / deployment_env
        saved = json.loads(deployment_env.read_text())
        allowed = {'COW_NETWORK', 'L2_GENESIS_HASH', *INTEGER_KEYS, *PATH_KEYS, *ADDRESS_KEYS}
        if not isinstance(saved, dict) or set(saved) - allowed or any(not isinstance(v, str) for v in saved.values()):
            raise ValueError('Invalid deployment environment file')
        # Snapshots supply application bindings, never override live settings.
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
    values['COW_FAUCET_L1'] = env.get('COW_FAUCET_L1')
    for key in PUBLIC_ENDPOINT_KEYS:
        if env.get(key):
            value = env[key]
            endpoint = urlsplit(value)
            # Public browser routes can be relative to the dashboard origin.
            # The explorer API is called by Python and still requires an absolute URL.
            relative = (key != 'COW_WRAPPER_EXPLORER_API' and value.startswith('/')
                        and not value.startswith('//') and not endpoint.scheme and not endpoint.netloc)
            absolute = endpoint.scheme in ('http', 'https') and endpoint.hostname and not endpoint.username and not endpoint.password
            if '\\' in value or any(ord(c) <= 32 for c in value) or not (relative or absolute):
                raise ValueError(f'{key}: expected a public HTTP(S) URL without credentials or a dashboard-origin path')
            values[key] = value
    if env.get('L2_GENESIS_HASH'):
        if not re.fullmatch(r'0x[0-9a-fA-F]{64}', env['L2_GENESIS_HASH']):
            raise ValueError('Invalid L2_GENESIS_HASH')
        values['L2_GENESIS_HASH'] = env['L2_GENESIS_HASH']
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
