"""Validate Blockscout creation bytecode against the live canonical bridge."""
import threading

import requests
from eth_abi import encode
from hexbytes import HexBytes
from web3 import Web3

IMPLEMENTATION_SLOT = int.from_bytes(Web3.keccak(text='eip1967.proxy.implementation'), 'big') - 1
BRIDGE_ABI = [{'type':'function','name':'getWrappedToken','stateMutability':'view',
              'inputs':[{'type':'address'},{'type':'uint64'}], 'outputs':[{'type':'address'}]}]
META_ABI = [{'type':'function','name':name,'stateMutability':'view','inputs':[],
             'outputs':[{'type':kind}]} for name,kind in
            [('name','string'),('symbol','string'),('decimals','uint8')]]


def metadata(client, token):
    contract = client.eth.contract(Web3.to_checksum_address(token), abi=META_ABI)
    return (contract.functions.name().call(), contract.functions.symbol().call(),
            contract.functions.decimals().call())


def constructor_args(meta, bridge):
    return encode(['string','string','uint8','address'], [*meta, Web3.to_checksum_address(bridge)])


def predict(bridge, token, init_code):
    salt = Web3.keccak(bytes.fromhex(token.removeprefix('0x')) + bytes(8))
    return Web3.to_checksum_address(Web3.keccak(
        b'\xff' + bytes.fromhex(bridge.removeprefix('0x')) + salt + Web3.keccak(init_code))[-20:])


def validate_creation(payload, bridge, token, wrapper, meta, runtime, bridge_code):
    """Explorer data is an untrusted candidate, never the authority for prediction."""
    creation = bytes(HexBytes(payload.get('creation_bytecode') or '0x'))
    reported_runtime = bytes(HexBytes(payload.get('deployed_bytecode') or '0x'))
    if not runtime or reported_runtime != bytes(runtime):
        raise ValueError('Explorer wrapper runtime does not match live code')
    args = constructor_args(meta, bridge)
    if len(creation) <= len(args) or not creation.endswith(args):
        raise ValueError('Explorer wrapper constructor arguments do not match the canonical wrapper')
    if predict(bridge, token, creation).lower() != wrapper.lower():
        raise ValueError('Explorer creation bytecode does not reproduce the canonical wrapper address')
    prefix = creation[:-len(args)]
    if prefix not in bytes(bridge_code):
        raise ValueError('Wrapper creation code is not embedded in the current bridge implementation')
    return prefix


class WrapperPredictor:
    def __init__(self):
        self.lock = threading.Lock()
        self.cached_key = None
        self.cached_prefix = None

    def prefix(self, cfg, l2):
        bridge = Web3.to_checksum_address(cfg['BRIDGE_L2'])
        token = Web3.to_checksum_address(cfg['WETH_L1'])
        registry = l2.eth.contract(bridge, abi=BRIDGE_ABI)
        # Pin all validation reads to one L2 block, including proxy storage.
        block = l2.eth.get_block('latest')
        height = block['number']
        wrapper = registry.functions.getWrappedToken(token, 0).call(block_identifier=height)
        if int(wrapper,16) == 0 or wrapper.lower() != cfg['WETH_L2'].lower():
            raise ValueError('A canonical WETH wrapper is required for wrapper prediction')
        runtime = l2.eth.get_code(wrapper, block_identifier=height)
        bridge_runtime = l2.eth.get_code(bridge, block_identifier=height)
        implementation = l2.eth.get_storage_at(bridge, IMPLEMENTATION_SLOT, block_identifier=height)
        if int.from_bytes(implementation, 'big'):
            implementation_address = Web3.to_checksum_address(implementation[-20:])
            bridge_code = l2.eth.get_code(implementation_address, block_identifier=height)
        else:
            bridge_code = bridge_runtime
        contract = l2.eth.contract(wrapper, abi=META_ABI)
        meta = tuple(getattr(contract.functions, name)().call(block_identifier=height)
                     for name in ('name','symbol','decimals'))
        endpoint = cfg.get('COW_WRAPPER_EXPLORER_API')
        if not endpoint:
            raise ValueError('Configure COW_WRAPPER_EXPLORER_API for validated wrapper prediction')
        key = (bridge, token, wrapper, meta, bytes(runtime), bytes(bridge_runtime), bytes(bridge_code), endpoint)
        with self.lock:
            if key == self.cached_key:
                return self.cached_prefix
            response = requests.get(endpoint.rstrip('/') + '/smart-contracts/' + wrapper, timeout=20)
            response.raise_for_status()
            prefix = validate_creation(response.json(), bridge, token, wrapper, meta, runtime, bridge_code)
            if l2.eth.get_block(height)['hash'] != block['hash']:
                raise ValueError('Wrapper validation block changed; retry prediction')
            self.cached_key, self.cached_prefix = key, prefix
            return prefix
