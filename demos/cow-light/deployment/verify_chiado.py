#!/usr/bin/env python3
"""Submit exact bootstrap sources to Chiado Blockscout; no signing or transactions."""
import argparse
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from deployment.bootstrap_chiado import atomic_json


def compiler_input(artifact, source_root, hash_source):
    metadata = artifact['metadata']
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    sources = {}
    source_root = source_root.resolve()
    for name, expected in metadata['sources'].items():
        path = (source_root / name).resolve()
        if not path.is_relative_to(source_root):
            raise ValueError('Source escapes artifact source directory')
        content = path.read_text()
        if hash_source(content) != expected['keccak256']:
            raise ValueError(f'Source hash mismatch: {name}')
        sources[name] = {'content': content}
    settings = dict(metadata['settings'])
    target = settings.pop('compilationTarget')
    if len(target) != 1:
        raise ValueError('Expected one compilation target')
    name, contract = next(iter(target.items()))
    settings['outputSelection'] = {'*': {'*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode']}}
    return metadata['compiler']['version'], name + ':' + contract, {'language': 'Solidity', 'sources': sources, 'settings': settings}


def main():
    import requests
    from web3 import Web3
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', required=True)
    parser.add_argument('--submit', action='store_true', help='Publish source inputs; otherwise only query verification status')
    parser.add_argument('--via-sourcify', action='store_true', help='Use Blockscout Sourcify import instead of its compiler verifier')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', args.deployment):
        parser.error('Invalid deployment name')
    directory = ROOT / 'runtime/chiado/deployments' / args.deployment
    manifest = json.loads((directory / 'bootstrap.json').read_text())
    if manifest['identity']['l1ChainId'] != 10200:
        raise ValueError('Chiado verification only')
    rpc = os.environ.get('L1_RPC') or os.environ.get('EEZ_UI_L1_RPC_UPSTREAM')
    client = Web3(Web3.HTTPProvider(rpc, request_kwargs={'timeout': 30})) if rpc else None
    if client is not None and client.eth.chain_id != 10200:
        raise ValueError('Verification RPC must be Chiado')
    upstream = ROOT / 'contracts/node_modules/@uniswap/v2-core'
    local = ROOT / 'contracts'
    targets = []
    # During deployment, finalized creation receipts may precede the final bindings.
    for key, filename, source_root in [('factory', 'UniswapV2Factory', upstream), ('liquidity', 'ChiadoLiquidity', local)]:
        receipt = manifest['transactions'].get(key, {}).get('receipt', {})
        tx_hash = manifest['transactions'].get(key, {}).get('hash')
        if not receipt and tx_hash and client is not None:
            live = client.eth.get_transaction_receipt(tx_hash)
            if live.status != 1 or client.eth.get_block(live.blockNumber).hash != live.blockHash:
                raise ValueError('Deployment receipt is not a canonical success')
            receipt = dict(live)
        address = receipt.get('contractAddress')
        if address:
            artifact = upstream / 'build/UniswapV2Factory.json' if key == 'factory' else local / 'out/ChiadoLiquidity.sol/ChiadoLiquidity.json'
            targets.append((key, address, artifact, source_root))
            if key == 'liquidity' and client is not None:
                abi = json.loads(artifact.read_text())['abi']
                fixture = client.eth.contract(address=address, abi=abi)
                for name in ('weth', 'token', 'pair'):
                    nested = getattr(fixture.functions, name)().call()
                    manifest.setdefault('contracts', {})[name] = {'address': nested}
    for key, filename, source_root in [('weth', 'ChiadoTestToken', local), ('token', 'ChiadoTestToken', local), ('pair', 'UniswapV2Pair', upstream)]:
        binding = manifest.get('contracts', {}).get(key)
        if binding:
            artifact = upstream / 'build/UniswapV2Pair.json' if key == 'pair' else local / 'out/ChiadoLiquidity.sol/ChiadoTestToken.json'
            targets.append((key, binding['address'], artifact, source_root))
    results = {}
    for key, address, artifact_path, source_root in targets:
        url = 'https://gnosis-chiado.blockscout.com/api/v2/smart-contracts/' + address
        response = requests.get(url, timeout=30)
        info = response.json() if response.ok else {}
        verified = info.get('is_verified') is True and info.get('is_partially_verified') is False
        if verified and client is not None:
            verified = info.get('deployed_bytecode', '').lower() == Web3.to_hex(client.eth.get_code(Web3.to_checksum_address(address))).lower()
        result = {'address': address, 'verified': verified}
        if not verified and args.submit:
            artifact = json.loads(artifact_path.read_text())
            version, target, data = compiler_input(artifact, source_root,
                lambda text: Web3.to_hex(Web3.keccak(text=text)))
            # Retain the exact submitted public sources/settings for reproducibility.
            atomic_json(directory / (key + '-compiler-input.json'), data)
            if args.via_sourcify:
                metadata = artifact.get('rawMetadata', artifact['metadata'])
                if not isinstance(metadata, str):
                    metadata = json.dumps(metadata)
                files = {'files[0]': ('metadata.json', metadata, 'application/json')}
                for index, (name, source) in enumerate(data['sources'].items(), 1):
                    files[f'files[{index}]'] = (name, source['content'], 'text/plain')
                response = requests.post(url + '/verification/via/sourcify', files=files, timeout=60)
            else:
                response = requests.post(url + '/verification/via/standard-input',
                    files={'files[0]': ('input.json', json.dumps(data), 'application/json')},
                    data={'compiler_version': 'v' + version, 'contract_name': target, 'autodetect_constructor_args': 'true'}, timeout=60)
            result.update(submissionStatus=response.status_code, response=response.text[:2000])
        results[key] = result
    if args.submit:
        atomic_json(directory / 'verification.json', results)
    print(json.dumps(results, indent=2))
    if not targets or any(not entry['verified'] for entry in results.values()):
        print('Verification incomplete; rerun after explorer processing. Wrapper verification is separate.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
