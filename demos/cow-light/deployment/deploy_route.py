#!/usr/bin/env python3
"""Deploy or reuse the selected network's L2 route and deterministic L1 helper."""
import json, os, sys
from pathlib import Path
from eth_account import Account
from web3 import Web3

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
CFG=load_config()
L1=Web3(Web3.HTTPProvider(CFG['L1_RPC']))
L2=Web3(Web3.HTTPProvider(CFG['L2_RPC']))
FRONT=CFG['L2_FRONT']; CHAIN=CFG['L2_CHAIN_ID']
MANAGER=Web3.to_checksum_address(CFG['EEZ_MANAGER_L2']); BRIDGE=Web3.to_checksum_address(CFG['BRIDGE_L2'])
WETH=Web3.to_checksum_address(CFG['WETH_L2']); SETTLEMENT=Web3.to_checksum_address(CFG['SETTLEMENT_L2'])
FACTORY=Web3.to_checksum_address(CFG['DETERMINISTIC_FACTORY_L1'])
BRIDGE_L1=Web3.to_checksum_address(CFG['BRIDGE_L1']); WETH_L1=Web3.to_checksum_address(CFG['WETH_L1'])
MABI=[{'type':'function','name':'computeCrossChainProxyAddress','stateMutability':'view','inputs':[{'type':'address'},{'type':'uint64'}],'outputs':[{'type':'address'}]},{'type':'function','name':'createCrossChainProxy','stateMutability':'nonpayable','inputs':[{'type':'address'},{'type':'uint64'}],'outputs':[{'type':'address'}]}]

def key():
    if os.getenv('DEPLOYER_PRIVATE_KEY'): return os.environ['DEPLOYER_PRIVATE_KEY']
    path=os.getenv('DEPLOYER_KEY_FILE')
    if path:
        for line in Path(path).read_text().splitlines():
            if line.startswith(('DEPLOYER_PRIVATE_KEY=','FUZZER_PRIVATE_KEY=')): return line.split('=',1)[1].strip()
    raise RuntimeError('set DEPLOYER_PRIVATE_KEY or DEPLOYER_KEY_FILE')

def artifact(name):
    d=json.loads((BASE/'contracts'/'out'/f'{name}.sol'/f'{name}.json').read_text()); b=d['bytecode']
    return d['abi'], b['object'] if isinstance(b,dict) else b

def send(w,a,tx,endpoint=None,gas=1_000_000):
    tx.update({'from':a.address,'nonce':w.eth.get_transaction_count(a.address,'pending'),'chainId':w.eth.chain_id,'gas':gas,'type':2})
    gp=max(w.eth.gas_price,100); tx.update(maxPriorityFeePerGas=min(gp,100),maxFeePerGas=gp)
    raw=a.sign_transaction(tx).raw_transaction; b=Web3(Web3.HTTPProvider(endpoint)) if endpoint else w
    h=b.eth.send_raw_transaction(raw); r=w.eth.wait_for_transaction_receipt(h,timeout=1800)
    if r.status!=1: raise RuntimeError(f'reverted {h.hex()}')
    print(h.hex(),r.blockNumber,r.gasUsed,flush=True); return r

def main():
    CFG.check_chains(l1=L1,l2=L2)
    a=Account.from_key(key()); mgr=L2.eth.contract(MANAGER,abi=MABI)
    saved=CFG.read_manifest('ROUTE_MANIFEST')
    rabi,rbin=artifact('L2UniversalV2Route'); existing=os.getenv('UNIVERSAL_ROUTE_L2') or saved.get('routeL2')
    if existing and L2.eth.get_code(existing): route=L2.eth.contract(existing,abi=rabi); rr=None
    else:
        rr=send(L2,a,L2.eth.contract(abi=rabi,bytecode=rbin).constructor(BRIDGE,WETH,SETTLEMENT).build_transaction({}),gas=2_000_000)
        route=L2.eth.contract(rr.contractAddress,abi=rabi)
    fproxy=mgr.functions.computeCrossChainProxyAddress(FACTORY,0).call()
    if not L2.eth.get_code(fproxy): send(L2,a,mgr.functions.createCrossChainProxy(FACTORY,0).build_transaction({}))
    habi,hbin=artifact('L1UniversalV2BridgeHelper'); helper=L1.eth.contract(abi=habi,bytecode=hbin)
    for name, expected in (('bridge',BRIDGE),('wrappedWeth',WETH),('settlement',SETTLEMENT)):
        if getattr(route.functions,name)().call().lower()!=expected.lower():
            raise RuntimeError(f'Existing route {name} does not match selected configuration')
    init=bytes.fromhex(helper.constructor(BRIDGE_L1,WETH_L1,SETTLEMENT,CFG['L2_ROLLUP_ID'],route.address).data_in_transaction[2:])
    salt=Web3.keccak(text=os.getenv('ROUTE_SALT','eez-universal-v2-helper-v1'))
    predicted=Web3.to_checksum_address(Web3.keccak(b'\xff'+bytes.fromhex(FACTORY[2:])+salt+Web3.keccak(init))[-20:])
    hproxy=mgr.functions.computeCrossChainProxyAddress(predicted,0).call()
    if not L2.eth.get_code(hproxy): send(L2,a,mgr.functions.createCrossChainProxy(predicted,0).build_transaction({}))
    if len(L1.eth.get_code(predicted))<2: send(L2,a,{'to':fproxy,'data':'0x'+(salt+init).hex()},endpoint=FRONT,gas=2_000_000)
    if len(L1.eth.get_code(predicted))<2: raise RuntimeError('L1 helper was not deployed')
    configured=route.functions.l1Proxy().call()
    if int(configured,16)==0:
        send(L2,a,route.functions.configure(hproxy,predicted).build_transaction({}),gas=300_000)
    elif configured.lower()!=hproxy.lower() or route.functions.l1Helper().call().lower()!=predicted.lower():
        raise RuntimeError('Existing route helper configuration does not match')
    out={'network':CFG['NETWORK'],'l1ChainId':CFG['L1_CHAIN_ID'],'chainId':CHAIN,'settlement':SETTLEMENT,'routeL2':route.address,'l1Helper':predicted,'l2HelperProxy':hproxy,'factoryProxyL2':fproxy,'deploymentTx':rr.transactionHash.hex() if rr else saved.get('deploymentTx')}
    path=CFG['ROUTE_MANIFEST']; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(out,indent=2)+'\n'); print(json.dumps(out,indent=2))

if __name__=='__main__': main()
