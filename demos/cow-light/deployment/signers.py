"""Deployment signers. Ledger signs locally through cast; it never broadcasts."""
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from hexbytes import HexBytes
from web3 import Web3


class LedgerSigner:
    def __init__(self, address, rpc, derivation_path):
        self.address = Web3.to_checksum_address(address)
        self.rpc, self.derivation_path = rpc, derivation_path

    def sign_transaction(self, tx):
        if tx.get('type') != 2 or tx.get('accessList'):
            raise ValueError('Ledger deployment supports type-2 transactions with empty access lists only')
        if tx.get('from', self.address).lower() != self.address.lower():
            raise ValueError('Unexpected deployment sender')
        args = ['cast', 'mktx', '--ledger', '--from', self.address,
                '--mnemonic-derivation-path', self.derivation_path,
                '--rpc-url', self.rpc, '--chain', str(tx['chainId']),
                '--nonce', str(tx['nonce']), '--gas-limit', str(tx['gas']),
                '--gas-price', str(tx['maxFeePerGas']),
                '--priority-gas-price', str(tx['maxPriorityFeePerGas']),
                '--value', str(tx.get('value', 0))]
        data = Web3.to_hex(HexBytes(tx.get('data', '0x')))
        args += [tx['to'], data] if tx.get('to') else ['--create', data]
        print(f"Ledger: chain {tx['chainId']}, nonce {tx['nonce']}, "
              f"to {tx.get('to') or 'CREATE'}, value {tx.get('value', 0)} wei, "
              f"maximum gas cost {tx['gas'] * tx['maxFeePerGas']} wei, "
              f"calldata hash {Web3.to_hex(Web3.keccak(hexstr=data))}", flush=True)
        # Prevent ambient Foundry wallet/transaction settings from selecting a
        # software signer or adding access lists, delegation, or other fields.
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('ETH_', 'FOUNDRY_', 'TEMPO_', 'AWS_', 'GCP_', 'TURNKEY_'))}
        result = subprocess.run(args, stdout=subprocess.PIPE, text=True,
                                check=True, env=env, timeout=300)
        raw = HexBytes(result.stdout.strip())
        decoded = TypedTransaction.from_bytes(raw).as_dict()
        for key in ('type', 'chainId', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value'):
            if decoded.get(key) != tx.get(key, 0):
                raise ValueError(f'Ledger signed unexpected {key}; not broadcasting')
        for key in ('to', 'data'):
            if HexBytes(decoded.get(key, b'')) != HexBytes(tx.get(key) or b''):
                raise ValueError(f'Ledger signed unexpected {key}; not broadcasting')
        if decoded.get('accessList') or Account.recover_transaction(raw).lower() != self.address.lower():
            raise ValueError('Ledger signature/address mismatch; not broadcasting')
        return SimpleNamespace(raw_transaction=raw, hash=Web3.keccak(raw))


def deployment_signer(config):
    mode = os.getenv('DEPLOYER_SIGNER', 'key')
    if mode == 'ledger':
        if os.getenv('DEPLOYER_PRIVATE_KEY') or os.getenv('DEPLOYER_KEY_FILE'):
            raise ValueError('Remove private-key settings when using Ledger')
        return LedgerSigner(os.environ['DEPLOYER_ADDRESS'], config['L2_RPC'],
                            os.environ['LEDGER_DERIVATION_PATH'])
    if mode != 'key':
        raise ValueError('DEPLOYER_SIGNER must be key or ledger')
    key = os.getenv('DEPLOYER_PRIVATE_KEY')
    if not key and os.getenv('DEPLOYER_KEY_FILE'):
        for line in Path(os.environ['DEPLOYER_KEY_FILE']).read_text().splitlines():
            if line.startswith(('DEPLOYER_PRIVATE_KEY=', 'FUZZER_PRIVATE_KEY=')):
                key = line.split('=', 1)[1].strip()
    if not key:
        raise ValueError('Configure a deployment signer')
    return Account.from_key(key)


def check_infrastructure(config):
    """Validate existing bridges and the sell wrapper before spending on deployment."""
    clients = {s: Web3(Web3.HTTPProvider(config[s + '_RPC'], request_kwargs={'timeout': 30}))
               for s in ('L1', 'L2')}
    config.check_chains(l1=clients['L1'], l2=clients['L2'])
    def read(side, address, name, output='address', inputs=(), args=()):
        abi = [{'type':'function', 'name':name, 'stateMutability':'view',
                'inputs':[{'type':t} for t in inputs], 'outputs':[{'type':output}]}]
        return getattr(clients[side].eth.contract(Web3.to_checksum_address(address), abi=abi).functions, name)(*args).call()
    for side, other, rollup in (('L1','L2',0), ('L2','L1',config['L2_ROLLUP_ID'])):
        bridge = config['BRIDGE_' + side]
        if not clients[side].eth.get_code(Web3.to_checksum_address(bridge)):
            raise ValueError('Configured bridge has no code')
        peer = read(side, bridge, 'canonicalBridgeAddress')
        if int(peer,16) == 0:
            peer = bridge
        if peer.lower() != config['BRIDGE_' + other].lower() or read(side,bridge,'rollupId','uint64') != rollup:
            raise ValueError('Bridge peer or rollup mismatch')
    try:
        manager = read('L2',config['BRIDGE_L2'],'EEZContract')
    except Exception:
        manager = read('L2',config['BRIDGE_L2'],'manager')
    if manager.lower() != config['EEZ_MANAGER_L2'].lower():
        raise ValueError('Bridge manager mismatch')
    wrapper = read('L2',config['BRIDGE_L2'],'getWrappedToken', inputs=('address','uint64'),
                   args=(Web3.to_checksum_address(config['WETH_L1']),0))
    if int(wrapper,16) == 0 or wrapper.lower() != config['WETH_L2'].lower() or not clients['L2'].eth.get_code(wrapper):
        raise ValueError('Bridge Ethereum WETH first and configure its actual L2 wrapper before deploying')


def solver_address(manager):
    address = os.getenv('COW_SOLVER_ADDRESS')
    if not address and os.getenv('DEPLOYER_SIGNER') == 'ledger':
        raise ValueError('Ledger deployment requires a separate COW_SOLVER_ADDRESS')
    address = Web3.to_checksum_address(address or manager)
    if int(address, 16) == 0 or (os.getenv('DEPLOYER_SIGNER') == 'ledger' and address == manager):
        raise ValueError('Choose a nonzero solver address separate from the Ledger manager')
    return address
