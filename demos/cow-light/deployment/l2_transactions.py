"""Durable L2 deployment transactions; never replace an ambiguous submission."""
import fcntl
import json
import os
import time

from web3 import Web3

from deployment.bootstrap_chiado import Journal, quote_transaction, validate_fee_quote
from settlement_state import inspect_settlement


class L2Transactions:
    def __init__(self, config, account, path, identity):
        self.config, self.account = config, account
        self.l2 = Web3(Web3.HTTPProvider(config['L2_RPC'], request_kwargs={'timeout': 60}))
        self.front = Web3(Web3.HTTPProvider(config['L2_FRONT'], request_kwargs={'timeout': 60}))
        config.check_chains(l2=self.l2)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = path.with_suffix('.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.journal = Journal(path, {
            'chainId': config['L2_CHAIN_ID'],
            'genesis': Web3.to_hex(self.l2.eth.get_block(0).hash),
            'deployer': account.address, **identity,
        })

    def send(self, name, build, cross_chain=False):
        def prepare():
            nonce = self.front.eth.get_transaction_count(self.account.address, 'pending')
            if nonce != self.l2.eth.get_transaction_count(self.account.address):
                raise ValueError('Unresolved pending deployer transaction; reconcile before proceeding')
            tx = dict(build())
            tx.pop('gasPrice', None)
            tx.pop('gas', None)
            tx.update(type=2, chainId=self.config['L2_CHAIN_ID'],
                      nonce=nonce, **{'from': self.account.address})
            tx.setdefault('value', 0)
            tx.setdefault('data', '0x')
            # Creation is outside eez_quoteFee's supported profile. Pure L2
            # deployments use bounded local fees; cross-chain calls MUST quote.
            maximum = 2 * self.l2.eth.get_block('latest')['baseFeePerGas'] + 100
            if maximum > 5_000_000_000:
                raise ValueError('Local deployment fee exceeds safety cap')
            tx.update(maxFeePerGas=maximum, maxPriorityFeePerGas=100)
            estimator = self.front if cross_chain else self.l2
            tx['gas'] = estimator.eth.estimate_gas(tx) * 13 // 10
            if cross_chain:
                request = quote_transaction(tx)
                result = self.front.provider.make_request('eez_quoteFee', [request, {'transactionTypes': ['0x2']}])
                if 'error' in result:
                    raise ValueError(f"Fee quote unavailable: {result['error']}")
                print('Cross-chain fee quote: ' + json.dumps(result['result']), flush=True)
                # L2 tariffs can require a high tip on a small source gas
                # limit. Bound the entire spend, not Chiado's per-gas price.
                budget = int(os.environ.get('COW_DEPLOY_MAX_FEE_WEI', '5000000000000000'))
                if budget <= 0:
                    raise ValueError('Deployment fee budget must be positive')
                tx.update(validate_fee_quote(request, result['result'],
                    lambda text: Web3.to_hex(Web3.keccak(text=text)), int(time.time()),
                    max_fee_cap=budget // tx['gas']))
            budget = int(os.environ.get('COW_DEPLOY_MAX_FEE_WEI', '5000000000000000'))
            if budget <= 0 or tx['gas'] * tx['maxFeePerGas'] > budget:
                raise ValueError('Deployment transaction exceeds total fee budget')
            if self.l2.eth.get_balance(self.account.address) < tx['value'] + tx['gas'] * tx['maxFeePerGas']:
                raise ValueError('Insufficient deployer balance for bounded transaction cost')
            signed = self.account.sign_transaction(tx)
            if cross_chain:
                # A human may take longer than the Composer quote lifetime.
                # Never refresh fee fields underneath an existing signature.
                validate_fee_quote(request, result['result'],
                    lambda text: Web3.to_hex(Web3.keccak(text=text)), int(time.time()),
                    max_fee_cap=budget // tx['gas'])
            if self.front.eth.get_transaction_count(self.account.address, 'pending') != nonce:
                raise ValueError('Deployer nonce changed during signing; not broadcasting')
            return Web3.to_hex(signed.hash), signed.raw_transaction

        def receipt(tx_hash):
            r = self.l2.eth.wait_for_transaction_receipt(tx_hash, timeout=50)
            if r.status != 1 or self.l2.eth.get_block(r.blockNumber).hash != r.blockHash:
                raise ValueError(f'Deployment transaction failed or changed inclusion: {tx_hash}')
            return json.loads(Web3.to_json(r))

        result = self.journal.transaction(name, prepare,
            (self.front if cross_chain else self.l2).eth.send_raw_transaction, receipt)
        print(f"{name}: {result['transactionHash']}", flush=True)
        return result

    def require_settled(self, names=None):
        def rpc(endpoint, method, params):
            result = Web3(Web3.HTTPProvider(endpoint)).provider.make_request(method, params)
            if 'error' in result:
                raise ValueError(result['error'])
            return result.get('result')
        for name, entry in self.journal.data['transactions'].items():
            if names is not None and name not in names:
                continue
            state = inspect_settlement(entry['hash'], rpc, self.config['L1_RPC'],
                self.config['L2_RPC'], self.config['L2_FRONT'])
            if not state['canonicalVerified']:
                raise ValueError(f"{name}: {state['message']} Rerun to reconcile; no replacement will be sent.")
