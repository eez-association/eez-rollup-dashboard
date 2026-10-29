#!/usr/bin/env python3
"""Read-only audit of the saved mainnet profile; never imports signing keys."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from web3 import Web3

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from network_config import load_config


def validate(solver=None):
    cfg = load_config(environ={'COW_NETWORK': 'mainnet'})
    clients = {side: Web3(Web3.HTTPProvider(cfg[side+'_RPC'], request_kwargs={'timeout': 20})) for side in ('L1','L2')}
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'readOnly': True, 'checks': [], 'catalog': []}
    def check(name, action, expected=None):
        try:
            actual = action()
            ok = bool(actual) if expected is None else str(actual).lower() == str(expected).lower()
            entry = {'name': name, 'ok': ok, 'actual': actual}
            if expected is not None: entry['expected'] = expected
        except Exception as error: entry = {'name': name, 'ok': False, 'error': str(error)}
        report['checks'].append(entry)
        return entry.get('actual')
    def read(side, address, name, output='address', inputs=(), args=()):
        contract=clients[side].eth.contract(Web3.to_checksum_address(address),abi=[{
            'type':'function','name':name,'stateMutability':'view',
            'inputs':[{'type':t} for t in inputs],'outputs':[{'type':output}]}])
        return getattr(contract.functions,name)(*args).call()
    for side in clients:
        check(side+' chain ID',lambda side=side: clients[side].eth.chain_id,cfg[side+'_CHAIN_ID'])
        report[side.lower()+'Block']=check(side+' current block',lambda side=side:clients[side].eth.block_number)
    check('Composer chain ID',lambda:Web3(Web3.HTTPProvider(cfg['L2_FRONT'])).eth.chain_id,cfg['L2_CHAIN_ID'])
    report['l2Genesis']=check('L2 genesis available',lambda:cfg.genesis(clients['L2']))
    for side, keys in [('L1',['BRIDGE_L1','WETH_L1','DETERMINISTIC_FACTORY_L1']),
                       ('L2',['BRIDGE_L2','EEZ_MANAGER_L2','WETH_L2','SETTLEMENT_L2','NATIVE_WETH_L2'])]:
        for key in keys:
            check(key+' deployed code',lambda side=side,key=key:len(clients[side].eth.get_code(Web3.to_checksum_address(cfg[key]))))
    for side, local, peer, rollup in [('L1','BRIDGE_L1','BRIDGE_L2',0),('L2','BRIDGE_L2','BRIDGE_L1',cfg['L2_ROLLUP_ID'])]:
        check(local+' canonical peer',lambda side=side,local=local:read(side,cfg[local],'canonicalBridgeAddress'),cfg[peer])
        check(local+' rollup',lambda side=side,local=local:read(side,cfg[local],'rollupId','uint64'),rollup)
    def manager():
        try: return read('L2',cfg['BRIDGE_L2'],'EEZContract')
        except Exception: return read('L2',cfg['BRIDGE_L2'],'manager')
    check('L2 bridge manager',manager,cfg['EEZ_MANAGER_L2'])
    check('Canonical L2 WETH wrapper',lambda:read('L2',cfg['BRIDGE_L2'],'getWrappedToken',inputs=('address','uint64'),
        args=(Web3.to_checksum_address(cfg['WETH_L1']),0)),cfg['WETH_L2'])
    for name in ('authenticator','vaultRelayer'):
        address=check('Settlement '+name,lambda name=name:read('L2',cfg['SETTLEMENT_L2'],name))
        if address:
            check(name+' deployed code',lambda address=address:len(clients['L2'].eth.get_code(Web3.to_checksum_address(address))))
            if name=='authenticator':
                check('Authenticator manager',lambda:read('L2',address,'manager'))
                check('Intended mainnet solver specified',lambda:bool(solver),True)
                if solver:
                    check('Intended mainnet solver allowlisted',lambda:read('L2',address,'isSolver','bool',
                        inputs=('address',),args=(Web3.to_checksum_address(solver),)),True)
    for key in ('COW_MANIFEST','ROUTE_MANIFEST'):
        check(key+' present',lambda key=key:cfg[key].is_file(),True)
    def deployment_valid():
        cfg.check_deployment(l1=clients['L1'],l2=clients['L2']);return True
    check('Full deployment binding validation',deployment_valid,True)
    catalog=json.loads(cfg['TOKEN_CATALOG'].read_text())
    def token_check(token):
        result={'symbol':token['symbol'],'token':token['address'],'pair':token['pair']}
        try:
            t0=read('L1',token['pair'],'token0');t1=read('L1',token['pair'],'token1')
            factory_pair=read('L1',catalog['factory'],'getPair',inputs=('address','address'),
                args=(Web3.to_checksum_address(cfg['WETH_L1']),Web3.to_checksum_address(token['address'])))
            reserve=clients['L1'].eth.contract(Web3.to_checksum_address(token['pair']),abi=[{'type':'function','name':'getReserves',
                'stateMutability':'view','inputs':[],'outputs':[{'type':'uint112'},{'type':'uint112'},{'type':'uint32'}]}]).functions.getReserves().call()
            decimals=read('L1',token['address'],'decimals','uint8')
            result.update(ok=set([t0.lower(),t1.lower()])==set([cfg['WETH_L1'].lower(),token['address'].lower()])
                and factory_pair.lower()==token['pair'].lower() and reserve[0]>0 and reserve[1]>0 and decimals==token['decimals'],
                token0=t0,token1=t1,decimals=decimals,reserves=[str(r) for r in reserve])
        except Exception as error:result.update(ok=False,error=str(error))
        return result
    with ThreadPoolExecutor(max_workers=4) as pool:report['catalog']=list(pool.map(token_check,cfg.catalog()))
    report['ready']=all(c['ok'] for c in report['checks']) and all(t['ok'] for t in report['catalog'])
    report['limits']=['No transactions signed or sent.','Live permission to operate the intended solver requires its mainnet address.',
                      'Contract security and source verification are not established by code presence.']
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--solver',help='Intended mainnet solver address (public address only)')
    args=parser.parse_args();report=validate(args.solver);args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'ready':report['ready'],'failedChecks':[c['name'] for c in report['checks'] if not c['ok']],
        'catalogChecked':len(report['catalog']),'catalogFailures':[t['symbol'] for t in report['catalog'] if not t['ok']]}))
    sys.exit(0 if report['ready'] else 1)
