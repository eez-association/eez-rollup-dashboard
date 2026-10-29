#!/usr/bin/env python3
"""Deploy or reuse the selected network's L2 route and deterministic L1 helper."""
import json, os, sys
from pathlib import Path
from web3 import Web3

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
from deployment.bootstrap_chiado import atomic_json
from deployment.l2_transactions import L2Transactions
from deployment.route_identity import authorized_l1_caller
from deployment.signers import deployment_signer, check_infrastructure
CFG=load_config()
L1=Web3(Web3.HTTPProvider(CFG['L1_RPC']))
L2=Web3(Web3.HTTPProvider(CFG['L2_RPC']))
FRONT=CFG['L2_FRONT']; CHAIN=CFG['L2_CHAIN_ID']
MANAGER=Web3.to_checksum_address(CFG['EEZ_MANAGER_L2']); BRIDGE=Web3.to_checksum_address(CFG['BRIDGE_L2'])
WETH=Web3.to_checksum_address(CFG['WETH_L2']); SETTLEMENT=Web3.to_checksum_address(CFG['SETTLEMENT_L2'])
FACTORY=Web3.to_checksum_address(CFG['DETERMINISTIC_FACTORY_L1'])
BRIDGE_L1=Web3.to_checksum_address(CFG['BRIDGE_L1']); WETH_L1=Web3.to_checksum_address(CFG['WETH_L1'])
MABI=[{'type':'function','name':'computeCrossChainProxyAddress','stateMutability':'view','inputs':[{'type':'address'},{'type':'uint64'}],'outputs':[{'type':'address'}]},{'type':'function','name':'createCrossChainProxy','stateMutability':'nonpayable','inputs':[{'type':'address'},{'type':'uint64'}],'outputs':[{'type':'address'}]}]


def artifact(name):
    d=json.loads((BASE/'contracts'/'out'/f'{name}.sol'/f'{name}.json').read_text()); b=d['bytecode']
    return d['abi'], b['object'] if isinstance(b,dict) else b

def main():
    check_infrastructure(CFG)
    CFG.check_chains(l1=L1,l2=L2)
    deployment_identity=CFG.deployment_identity(L2)
    cow_identity=CFG.read_manifest('COW_MANIFEST').get('deploymentIdentity') or {}
    if {k:str(v).lower() for k,v in cow_identity.items()} != {k:str(v).lower() for k,v in deployment_identity.items()}:
        raise ValueError('GPv2 deployment identity is missing or stale; validate the current deployment first')
    a=deployment_signer(CFG); mgr=L2.eth.contract(MANAGER,abi=MABI)
    saved=CFG.read_manifest('ROUTE_MANIFEST')
    rabi,rbin=artifact('L2UniversalV2Route'); existing=os.getenv('UNIVERSAL_ROUTE_L2') or saved.get('routeL2')
    habi,hbin=artifact('L1UniversalV2BridgeHelper')
    if not L1.eth.get_code(FACTORY):
        raise ValueError('Configured deterministic L1 factory has no code')
    sender=L2Transactions(CFG,a,CFG['ROUTE_MANIFEST'].with_suffix('.journal.json'), {
        'settlement':SETTLEMENT,'bridgeL1':BRIDGE_L1,'bridgeL2':BRIDGE,
        'wethL1':WETH_L1,'wethL2':WETH,'managerL2':MANAGER,
        'factory':FACTORY,'factoryCodeHash':Web3.to_hex(Web3.keccak(L1.eth.get_code(FACTORY))),
        'rollupId':CFG['L2_ROLLUP_ID'], 'salt':os.getenv('ROUTE_SALT','eez-universal-v2-helper-v1'),
        'routeCodeHash':Web3.to_hex(Web3.keccak(hexstr=rbin)),
        'helperCodeHash':Web3.to_hex(Web3.keccak(hexstr=hbin)),
    })
    def build(call):
        return call.build_transaction({'from':a.address,'gas':1})
    if existing and L2.eth.get_code(existing): route=L2.eth.contract(existing,abi=rabi); rr=None
    else:
        rr=sender.send('route',lambda:build(L2.eth.contract(abi=rabi,bytecode=rbin).constructor(BRIDGE,WETH,SETTLEMENT)))
        route=L2.eth.contract(rr['contractAddress'],abi=rabi)
    fproxy=mgr.functions.computeCrossChainProxyAddress(FACTORY,0).call()
    if not L2.eth.get_code(fproxy) or 'factoryProxy' in sender.journal.data['transactions']:
        sender.send('factoryProxy',lambda:build(mgr.functions.createCrossChainProxy(FACTORY,0)))
    helper=L1.eth.contract(abi=habi,bytecode=hbin)
    for name, expected in (('bridge',BRIDGE),('wrappedWeth',WETH),('settlement',SETTLEMENT)):
        if getattr(route.functions,name)().call().lower()!=expected.lower():
            raise RuntimeError(f'Existing route {name} does not match selected configuration')
    authorized=authorized_l1_caller(L1,BRIDGE_L1,route.address,CFG['L2_ROLLUP_ID'])
    init=bytes.fromhex(helper.constructor(BRIDGE_L1,WETH_L1,SETTLEMENT,CFG['L2_ROLLUP_ID'],authorized).data_in_transaction[2:])
    salt=Web3.keccak(text=os.getenv('ROUTE_SALT','eez-universal-v2-helper-v1'))
    predicted=Web3.to_checksum_address(Web3.keccak(b'\xff'+bytes.fromhex(FACTORY[2:])+salt+Web3.keccak(init))[-20:])
    hproxy=mgr.functions.computeCrossChainProxyAddress(predicted,0).call()
    if not L2.eth.get_code(hproxy) or 'helperProxy' in sender.journal.data['transactions']:
        sender.send('helperProxy',lambda:build(mgr.functions.createCrossChainProxy(predicted,0)))
    if len(L1.eth.get_code(predicted))<2 or 'helper' in sender.journal.data['transactions']:
        sender.send('helper',lambda:{'to':fproxy,'data':'0x'+(salt+init).hex()},cross_chain=True)
        sender.require_settled({'helper'})
    if len(L1.eth.get_code(predicted))<2: raise RuntimeError('L1 helper was not deployed')
    helper=L1.eth.contract(predicted,abi=habi)
    for name,expected in [('bridge',BRIDGE_L1),('weth',WETH_L1),('l2Settlement',SETTLEMENT),
                          ('destinationRollup',CFG['L2_ROLLUP_ID']),('authorizedProxy',authorized)]:
        if getattr(helper.functions,name)().call()!=expected:
            raise ValueError(f'Existing L1 helper {name} does not match')
    configured=route.functions.l1Proxy().call()
    if int(configured,16)==0 or 'configure' in sender.journal.data['transactions']:
        sender.send('configure',lambda:build(route.functions.configure(hproxy,predicted)))
    if route.functions.l1Proxy().call().lower()!=hproxy.lower() or route.functions.l1Helper().call().lower()!=predicted.lower():
        raise RuntimeError('Existing route helper configuration does not match')
    out={'network':CFG['NETWORK'],'l1ChainId':CFG['L1_CHAIN_ID'],'chainId':CHAIN,'settlement':SETTLEMENT,'routeL2':route.address,'l1Helper':predicted,'authorizedL1Caller':authorized,'l2HelperProxy':hproxy,'factoryProxyL2':fproxy,'deploymentTx':rr['transactionHash'] if rr else saved.get('deploymentTx'),
         'deploymentTxs':{name:row['hash'] for name,row in sender.journal.data['transactions'].items()}}
    if CFG.deployment_identity(L2)!=deployment_identity:
        raise ValueError('Network identity changed during deployment; manifest not published')
    out['deploymentIdentity']=deployment_identity
    path=CFG['ROUTE_MANIFEST']; path.parent.mkdir(parents=True,exist_ok=True); atomic_json(path,out); print(json.dumps(out,indent=2))

if __name__=='__main__': main()
