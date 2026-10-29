"""Deploy/fund a finite Chiado faucet, using the configured official L1 bridge."""
import fcntl
import json
import os
import sys
from pathlib import Path
from eth_account import Account
from web3 import Web3

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from network_config import load_config
from deployment.bootstrap_chiado import Journal, atomic_json, chiado_fees

def main():
    cfg=load_config()
    if cfg['NETWORK']!='chiado' or cfg['L1_CHAIN_ID']!=10200:
        raise ValueError('Faucet deployment is restricted to Chiado')
    l1=Web3(Web3.HTTPProvider(cfg['L1_RPC'],request_kwargs={'timeout':60}))
    l2=Web3(Web3.HTTPProvider(cfg['L2_RPC'],request_kwargs={'timeout':60}))
    cfg.check_deployment(l1=l1,l2=l2)
    account=Account.from_key(os.environ['DEPLOYER_PRIVATE_KEY'])
    artifact=json.loads((ROOT/'contracts/out/ChiadoCowFaucet.sol/ChiadoCowFaucet.json').read_text())
    directory=cfg['COW_MANIFEST'].parent
    handle=(directory/'faucet.lock').open('a'); fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    identity=cfg.deployment_identity(l2)
    journal=Journal(directory/'faucet.journal.json',{'deploymentIdentity':identity,'deployer':account.address,
        'bytecodeHash':Web3.to_hex(Web3.keccak(hexstr=artifact['bytecode']['object']))})
    def send(name,build):
        def prepare():
            nonce=l1.eth.get_transaction_count(account.address,'pending')
            if nonce!=l1.eth.get_transaction_count(account.address): raise ValueError('Pending deployer transaction')
            tx=build(); tx.update(chainId=10200,nonce=nonce,**{'from':account.address},
                **chiado_fees(l1.eth.get_block('latest')['baseFeePerGas'],l1.eth.max_priority_fee))
            tx.pop('gas',None); tx['gas']=l1.eth.estimate_gas(tx)*13//10
            if tx['gas']*tx['maxFeePerGas']>5*10**15: raise ValueError('Deployment fee budget exceeded')
            signed=account.sign_transaction(tx)
            return Web3.to_hex(signed.hash),signed.raw_transaction
        def receipt(tx):
            result=l1.eth.wait_for_transaction_receipt(tx,timeout=60)
            if result.status!=1 or l1.eth.get_block(result.blockNumber).hash!=result.blockHash: raise ValueError('Unsuccessful/noncanonical transaction')
            return json.loads(Web3.to_json(result))
        return journal.transaction(name,prepare,l1.eth.send_raw_transaction,receipt)
    constructor=l1.eth.contract(abi=artifact['abi'],bytecode=artifact['bytecode']['object']).constructor(
        Web3.to_checksum_address(cfg['WETH_L1']),Web3.to_checksum_address(cfg['BRIDGE_L1']),cfg['L2_ROLLUP_ID'])
    deployed=send('deploy',lambda:constructor.build_transaction({'from':account.address,'gas':1}))
    address=deployed['contractAddress']
    token=l1.eth.contract(Web3.to_checksum_address(cfg['WETH_L1']),abi=[{'type':'function','name':'transfer','stateMutability':'nonpayable',
        'inputs':[{'type':'address'},{'type':'uint256'}],'outputs':[{'type':'bool'}]}])
    send('fundTokens',lambda:token.functions.transfer(address,5*10**17).build_transaction({'from':account.address,'gas':1}))
    send('fundGas',lambda:{'to':address,'value':10**16,'data':'0x'})
    record={'address':address,'deploymentIdentity':identity,'deployer':account.address,'funding':{'ctWETH':'0.5','native':'0.01'},
        'transactions':{name:tx['hash'] for name,tx in journal.data['transactions'].items()}}
    atomic_json(directory/'faucet.json',record)
    print(json.dumps(record,indent=2))

if __name__=='__main__': main()
