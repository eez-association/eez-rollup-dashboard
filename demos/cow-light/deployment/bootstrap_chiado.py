#!/usr/bin/env python3
"""Explicit, journaled Chiado-only liquidity bootstrap. No writes without --execute."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from network_config import load_config, rpc_chain_id

ZERO = '0x' + '00' * 20
IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'


def chiado_fees(base_fee, suggested_tip, max_fee_cap=5_000_000_000):
    # Chiado's read RPC can return zero priority fee and only the base fee as
    # gasPrice. Recent included transactions use a 1 gwei tip.
    tip = max(1_000_000_000, suggested_tip)
    maximum = 2 * base_fee + tip
    if maximum > max_fee_cap:
        raise ValueError('Chiado fee exceeds 5 gwei safety cap; review before retrying')
    return {'type': 2, 'maxFeePerGas': maximum, 'maxPriorityFeePerGas': tip}


def require_verified(info, runtime):
    if (info.get('is_verified') is not True or info.get('is_partially_verified') is not False
            or info.get('deployed_bytecode', '').lower() != runtime.lower()):
        raise ValueError('Full Blockscout source verification required before wrapper initialization; run verify_chiado.py')


def quote_transaction(tx):
    quantities = {'type', 'chainId', 'nonce', 'gas', 'value'}
    return {key: hex(int(tx.get(key, 0))) if key in quantities else tx[key].lower()
            for key in ('type', 'chainId', 'from', 'to', 'nonce', 'gas', 'value', 'data')}


def validate_fee_quote(transaction, quote, hash_text, now, max_fee_cap=5_000_000_000):
    def quantity(value):
        if not isinstance(value, str) or not re.fullmatch(r'0x(?:0|[1-9a-f][0-9a-f]*)', value):
            raise ValueError('Invalid fee quote quantity')
        return int(value, 16)
    if quote.get('version') != 1 or quote.get('chainId') != transaction['chainId'] or quote.get('nonce') != transaction['nonce']:
        raise ValueError('Fee quote chain/nonce mismatch')
    expiry = quantity(quote.get('expiresAt'))
    if not now < expiry <= now + 31:
        raise ValueError('Fee quote expired or invalid clock')
    options = quote.get('options', [])
    if len(options) != 1 or options[0].get('type') != '0x2':
        raise ValueError('Expected exactly one type-2 fee quote')
    option = options[0]
    if set(option) != {'type', 'gas', 'requestHash', 'estimatedFee', 'maxFeePerGas', 'maxPriorityFeePerGas'}:
        raise ValueError('Unavailable or malformed fee quote')
    if option['gas'] != transaction['gas']:
        raise ValueError('Fee quote changed gas limit')
    digest = hash_text(json.dumps(transaction, sort_keys=True, separators=(',', ':')))
    if option['requestHash'].lower() != digest.lower():
        raise ValueError('Fee quote transaction binding mismatch')
    maximum, tip = quantity(option['maxFeePerGas']), quantity(option['maxPriorityFeePerGas'])
    if maximum > max_fee_cap or tip > maximum:
        raise ValueError('Quoted fee exceeds safety cap')
    if quantity(option['estimatedFee']) > quantity(option['gas']) * maximum:
        raise ValueError('Inconsistent quoted fee')
    return {'type': 2, 'maxFeePerGas': maximum, 'maxPriorityFeePerGas': tip}


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_identity(saved, current):
    if saved != current:
        raise ValueError('Deployment identity changed; use a new deployment name, not the old manifest')


def l1_checkpoint(get_block, saved_identity=None):
    number = saved_identity['l1Checkpoint']['number'] if saved_identity else 'finalized'
    return get_block(number)


def require_chiado(network, l1_chain, l2_chain):
    if network != 'chiado' or l1_chain != 10200 or l2_chain in (1, 100, 10200):
        raise ValueError('Bootstrap requires Chiado L1 and a separate EEZ testnet; mainnet is forbidden')


class Journal:
    def __init__(self, path, identity):
        self.path = path
        self.data = json.loads(path.read_text()) if path.exists() else {
            'version': 1, 'identity': identity, 'transactions': {}}
        validate_identity(self.data['identity'], identity)

    def transaction(self, name, prepare, broadcast, receipt):
        entry = self.data['transactions'].get(name)
        if entry is None:
            tx_hash, raw = prepare()
            entry = {'hash': tx_hash}
            self.data['transactions'][name] = entry
            atomic_json(self.path, self.data)  # durable before any broadcast
            broadcast(raw)
        # Never rebroadcast or replace an ambiguous transaction on a rerun.
        result = receipt(entry['hash'])
        entry['receipt'] = result
        atomic_json(self.path, self.data)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', required=True, help='Unique name for this EEZ deployment')
    parser.add_argument('--execute', action='store_true', help='Deploy and bridge test assets; otherwise read-only')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', args.deployment):
        parser.error('deployment must be a simple lowercase name')

    from web3 import Web3
    from eth_account import Account
    cfg = load_config()
    l1 = Web3(Web3.HTTPProvider(cfg['L1_RPC'], request_kwargs={'timeout': 30}))
    l2 = Web3(Web3.HTTPProvider(cfg['L2_RPC'], request_kwargs={'timeout': 30}))
    require_chiado(cfg['NETWORK'], l1.eth.chain_id, l2.eth.chain_id)
    cfg.check_chains(l1=l1, l2=l2)
    front = os.environ.get('L1_FRONT') or os.environ.get('EEZ_UI_L1_FRONT_UPSTREAM')
    if not front or rpc_chain_id(front) != 10200:
        raise ValueError('Configure a Chiado L1 Composer via EEZ_UI_L1_FRONT_UPSTREAM or L1_FRONT')
    composer = Web3(Web3.HTTPProvider(front, request_kwargs={'timeout': 60}))
    bridge1, bridge2, manager = [Web3.to_checksum_address(cfg[k]) for k in ('BRIDGE_L1', 'BRIDGE_L2', 'EEZ_MANAGER_L2')]

    def read(w, address, name, inputs=(), outputs=('address',), args=(), block='latest'):
        abi = [{'type': 'function', 'name': name, 'stateMutability': 'view',
                'inputs': [{'type': t} for t in inputs], 'outputs': [{'type': t} for t in outputs]}]
        return getattr(w.eth.contract(address=address, abi=abi).functions, name)(*args).call(block_identifier=block)

    def code_identity(w, address, implementation=True):
        code = w.eth.get_code(address)
        if not code:
            raise ValueError(f'No contract code at {address}')
        result = {'address': address.lower(), 'codeHash': Web3.to_hex(Web3.keccak(code))}
        slot = w.eth.get_storage_at(address, IMPLEMENTATION_SLOT) if implementation else bytes(32)
        if int.from_bytes(slot, 'big'):
            impl = Web3.to_checksum_address(slot[-20:])
            result['implementation'] = code_identity(w, impl, False)
        return result

    registry = read(l1, bridge1, 'manager')
    expected_registry = os.environ.get('EEZ_REGISTRY_ADDRESS')
    if not expected_registry or registry.lower() != expected_registry.lower():
        raise ValueError('L1 bridge manager does not match EEZ_REGISTRY_ADDRESS')
    checks = [(read(l1, bridge1, 'canonicalBridgeAddress'), bridge2),
              (read(l2, bridge2, 'canonicalBridgeAddress'), bridge1),
              (read(l2, bridge2, 'manager'), manager)]
    if any(a.lower() != b.lower() for a, b in checks):
        raise ValueError('Bridge peer/manager mismatch')
    rollup = cfg['L2_ROLLUP_ID']
    if (read(l1, bridge1, 'rollupId', outputs=('uint64',)) != 0 or
        read(l2, bridge2, 'rollupId', outputs=('uint64',)) != rollup or
        read(l2, manager, 'ROLLUP_ID', outputs=('uint64',)) != rollup):
        raise ValueError('Bridge/manager rollup mismatch')
    directory = ROOT / 'runtime' / 'chiado' / 'deployments' / args.deployment
    path = directory / 'bootstrap.json'
    saved = json.loads(path.read_text()) if path.exists() else None
    # The configured Chiado RPC may prune genesis. Pin an available finalized
    # checkpoint, then always recheck that exact block on subsequent runs.
    checkpoint = l1_checkpoint(l1.eth.get_block, saved['identity'] if saved else None)
    identity = {'l1ChainId': 10200, 'l2ChainId': cfg['L2_CHAIN_ID'], 'rollupId': rollup,
                'l1Checkpoint': {'number': checkpoint.number, 'hash': Web3.to_hex(checkpoint.hash)},
                'l2Genesis': Web3.to_hex(l2.eth.get_block(0).hash),
                'registry': code_identity(l1, registry), 'manager': code_identity(l2, manager),
                'bridgeL1': code_identity(l1, bridge1), 'bridgeL2': code_identity(l2, bridge2)}
    if path.exists():
        validate_identity(json.loads(path.read_text())['identity'], identity)
    print(json.dumps({'identity': identity, 'manifest': str(path), 'execute': args.execute}, indent=2))
    if not args.execute:
        return

    key = os.environ.get('DEPLOYER_PRIVATE_KEY')
    if not key:
        raise ValueError('Set DEPLOYER_PRIVATE_KEY in a protected environment for --execute')
    account = Account.from_key(key)
    factory_art = json.loads((ROOT / 'contracts/node_modules/@uniswap/v2-core/build/UniswapV2Factory.json').read_text())
    fixture_art = json.loads((ROOT / 'contracts/out/ChiadoLiquidity.sol/ChiadoLiquidity.json').read_text())
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'bootstrap.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = Journal(path, identity)
        build = {name: Web3.to_hex(Web3.keccak(text=json.dumps(artifact, sort_keys=True)))
                 for name, artifact in [('factory', factory_art), ('liquidity', fixture_art)]}
        if journal.data.get('build', build) != build:
            raise ValueError('Build artifacts changed; restore the original build to resume')
        journal.data['build'] = build
        if journal.data.get('deployer', account.address) != account.address:
            raise ValueError('Use the original deployer to resume this deployment')
        journal.data['deployer'] = account.address

        def receipt(tx_hash):
            # A missing/ambiguous submission stops; manual investigation is required.
            r = l1.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
            if r.status != 1:
                raise ValueError(f'Transaction reverted: {tx_hash}; inspect before continuing')
            if l1.eth.get_block(r.blockNumber).hash != r.blockHash:
                raise ValueError('Receipt is not canonical; rerun after reconciliation')
            if l1.eth.get_block('finalized').number < r.blockNumber:
                raise ValueError('Awaiting L1 finalization; rerun later (no replacement transaction)')
            return {'hash': tx_hash, 'blockHash': Web3.to_hex(r.blockHash),
                    'blockNumber': r.blockNumber, 'contractAddress': r.contractAddress}

        def send(name, build, cross_chain=False):
            def prepare():
                fees = chiado_fees(l1.eth.get_block('latest')['baseFeePerGas'], l1.eth.max_priority_fee)
                gas = 12000000 if name == 'liquidity' else 6000000
                if l1.eth.get_balance(account.address) < gas * fees['maxFeePerGas']:
                    raise ValueError('Insufficient deployment balance for maximum transaction fee')
                tx = build({'from': account.address, 'nonce': l1.eth.get_transaction_count(account.address, 'pending'),
                            'chainId': 10200, 'gas': gas, **fees})
                if (composer if cross_chain else l1).eth.estimate_gas(tx) > gas:
                    raise ValueError('Deployment simulation exceeds configured gas limit')
                if cross_chain:
                    transaction = quote_transaction(tx)
                    response = composer.provider.make_request('eez_quoteFee', [transaction, {'transactionTypes': ['0x2']}])
                    if response.get('error') or not response.get('result'):
                        raise ValueError('Composer fee quote unavailable; refusing unquoted submission')
                    tx.update(validate_fee_quote(transaction, response['result'],
                        lambda text: Web3.to_hex(Web3.keccak(text=text)), time.time()))
                    if l1.eth.get_balance(account.address) < gas * tx['maxFeePerGas']:
                        raise ValueError('Insufficient deployment balance for quoted cross-chain fee')
                signed = account.sign_transaction(tx)
                return Web3.to_hex(Web3.keccak(signed.raw_transaction)), signed.raw_transaction
            return journal.transaction(name, prepare,
                (composer if cross_chain else l1).eth.send_raw_transaction, receipt)

        def creation(artifact, *arguments):
            bytecode = artifact['bytecode']
            if isinstance(bytecode, dict):
                bytecode = bytecode['object']
            return l1.eth.contract(abi=artifact['abi'], bytecode=bytecode).constructor(*arguments).build_transaction

        factory = send('factory', creation(factory_art, account.address))['contractAddress']
        code_identity(l1, factory)
        fixture = send('liquidity', creation(fixture_art, factory, bridge1, rollup, account.address))['contractAddress']
        contract = l1.eth.contract(address=fixture, abi=fixture_art['abi'])
        if contract.functions.owner().call() != account.address or contract.functions.bridge().call() != bridge1 or contract.functions.rollupId().call() != rollup:
            raise ValueError('Liquidity deployment binding mismatch')
        weth, token, pair = [getattr(contract.functions, name)().call() for name in ('weth', 'token', 'pair')]
        if read(l1, factory, 'getPair', ('address', 'address'), args=(weth, token)) != pair:
            raise ValueError('Factory/pair mismatch')
        import requests
        for address in (factory, fixture, weth, token, pair):
            response = requests.get('https://gnosis-chiado.blockscout.com/api/v2/smart-contracts/' + address, timeout=30)
            response.raise_for_status()
            require_verified(response.json(), Web3.to_hex(l1.eth.get_code(address)))
        for name, asset in [('weth', weth), ('token', token)]:
            send('bridge-' + name, contract.functions.initializeWrapper(asset).build_transaction, cross_chain=True)
        wrapped = []
        for asset in (weth, token):
            address = read(l2, bridge2, 'getWrappedToken', ('address', 'uint64'), args=(asset, 0), block='safe')
            if address == ZERO or not l2.eth.get_code(address, 'safe'):
                raise ValueError('Wrapper not yet present in safe L2 state; rerun later')
            if read(l2, address, 'BRIDGE', block='safe') != bridge2:
                raise ValueError('Wrapper bridge authority mismatch')
            wrapped.append(address)
        reserves = read(l1, pair, 'getReserves', outputs=('uint112', 'uint112', 'uint32'))
        if not reserves[0] or not reserves[1]:
            raise ValueError('Pool has no liquidity; refusing to seed it again')
        bindings = {name: code_identity(l1, address) for name, address in
                    [('factory', factory), ('liquidity', fixture), ('weth', weth), ('token', token), ('pair', pair)]}
        if 'contracts' in journal.data and journal.data['contracts'] != bindings:
            raise ValueError('Saved contract code changed')
        journal.data.update(contracts=bindings, wrappers=wrapped, status='ready')
        atomic_json(path, journal.data)
        catalog_path = directory / 'token-catalog.json'
        atomic_json(catalog_path, {'chainId': 10200, 'factory': factory, 'weth': weth, 'tokens': [
            {'address': token, 'symbol': 'ctUSD', 'name': 'CoW Test USD', 'decimals': 18, 'pair': pair}]})
        # JSON is shell-independent, contains no secrets, and is generated only after validation.
        atomic_json(directory / 'environment.json', {
            'COW_NETWORK': 'chiado', 'L1_CHAIN_ID': '10200', 'L2_CHAIN_ID': str(cfg['L2_CHAIN_ID']),
            'L2_ROLLUP_ID': str(rollup), 'BRIDGE_L1': bridge1, 'BRIDGE_L2': bridge2,
            'EEZ_MANAGER_L2': manager, 'WETH_L1': weth, 'WETH_L2': wrapped[0],
            'TOKEN_CATALOG': str(catalog_path), 'COW_MANIFEST': str(directory / 'cow-deployment.json'),
            'ROUTE_MANIFEST': str(directory / 'route-deployment.json'),
            'ORDER_QUEUE': str(directory / 'ui-orders.jsonl'), 'SOLVER_LOG': str(directory / 'solver.log')})
        print('Ready: ' + str(directory / 'environment.json'))


if __name__ == '__main__':
    main()
