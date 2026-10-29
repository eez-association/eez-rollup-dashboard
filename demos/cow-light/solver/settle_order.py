#!/usr/bin/env python3
"""Settle queued catalog-token orders through the canonical WETH/L1 route.

This is a one-shot adapter used by the long-running worker. It reads the signed
order from ui-orders.jsonl, checks the live quote and balances, and submits one
standard GPv2 settlement through the L2 composer. Settlement pre-interactions
perform the complete canonical L2->L1->L2 route before GPv2 pays the wrapper
token.
"""
import json, os, sys, time, fcntl, requests
from pathlib import Path
from web3 import Web3
from eth_account import Account
from eth_abi import encode
from eth_utils import to_checksum_address, keccak

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
from settlement_state import is_active, reconcile, update_order
from deployment.bootstrap_chiado import quote_transaction, validate_fee_quote
CFG=load_config()
L1=Web3(Web3.HTTPProvider(CFG['L1_RPC'],request_kwargs={'timeout':60}))
L2=Web3(Web3.HTTPProvider(CFG['L2_RPC'],request_kwargs={'timeout':60}))
L2_FRONT=CFG['L2_FRONT']
L1_CHAIN,L2_CHAIN=CFG['L1_CHAIN_ID'],CFG['L2_CHAIN_ID']
KEY=os.getenv('SOLVER_PRIVATE_KEY')
if not KEY and os.getenv('SOLVER_KEY_FILE'):
    for line in Path(os.environ['SOLVER_KEY_FILE']).read_text().splitlines():
        if line.startswith('FUZZER_PRIVATE_KEY=') or line.startswith('SOLVER_PRIVATE_KEY='):
            KEY=line.split('=',1)[1].strip()
if not KEY: raise RuntimeError('protected solver key missing')
ACCT=Account.from_key(KEY)
BRIDGE_L2=to_checksum_address(CFG['BRIDGE_L2'])
WETH_L1=to_checksum_address(CFG['WETH_L1'])
WETH_L2=to_checksum_address(CFG['WETH_L2'])
SETTLEMENT=to_checksum_address(CFG['SETTLEMENT_L2'])
SETTLEMENT_VIEW_ABI=[{'type':'function','name':'vaultRelayer','stateMutability':'view','inputs':[],'outputs':[{'type':'address'}]}]
QUEUE=CFG['ORDER_QUEUE']
QUEUE_LOCK=QUEUE.with_suffix(QUEUE.suffix+'.lock')
WORKER_LOG=CFG['SOLVER_LOG']

def debug(event, **fields):
    rec={'ts':int(time.time()),'event':event,**fields}
    line=json.dumps(rec, sort_keys=True)
    print(line, flush=True)
    try:
        with WORKER_LOG.open('a') as f: f.write(line+'\n')
    except Exception: pass
ERC20=[{'type':'function','name':'balanceOf','stateMutability':'view','inputs':[{'type':'address'}],'outputs':[{'type':'uint256'}]}, {'type':'function','name':'approve','stateMutability':'nonpayable','inputs':[{'type':'address'},{'type':'uint256'}],'outputs':[{'type':'bool'}]}, {'type':'function','name':'allowance','stateMutability':'view','inputs':[{'type':'address'},{'type':'address'}],'outputs':[{'type':'uint256'}]}, {'type':'function','name':'transfer','stateMutability':'nonpayable','inputs':[{'type':'address'},{'type':'uint256'}],'outputs':[{'type':'bool'}]}]
BRIDGE_ABI=[{'type':'function','name':'bridgeTokens','stateMutability':'nonpayable','inputs':[{'type':'address'},{'type':'uint256'},{'type':'uint64'},{'type':'address'}],'outputs':[]}, {'type':'function','name':'getWrappedToken','stateMutability':'view','inputs':[{'type':'address'},{'type':'uint64'}],'outputs':[{'type':'address'}]}]
PAIR_ABI=[{'type':'function','name':'token0','stateMutability':'view','inputs':[],'outputs':[{'type':'address'}]}, {'type':'function','name':'getReserves','stateMutability':'view','inputs':[],'outputs':[{'type':'uint112'},{'type':'uint112'},{'type':'uint32'}]}, {'type':'function','name':'swap','stateMutability':'nonpayable','inputs':[{'type':'uint256'},{'type':'uint256'},{'type':'address'},{'type':'bytes'}],'outputs':[]}]
CATALOG=CFG['TOKEN_CATALOG']

def send(w,a,tx,chain,item,endpoint):
    tx=dict(tx); tx['from']=a.address
    tx.pop('_quotedTip',None); tx.pop('_quotedMaxFee',None)
    # The composer maintains a reservation-aware source nonce.  The execution
    # RPC can lag that view, so ask the submission endpoint whenever possible.
    nonce_rpc = Web3(Web3.HTTPProvider(endpoint,request_kwargs={'timeout':30})) if endpoint else w
    tx['nonce']=nonce_rpc.eth.get_transaction_count(a.address,'pending'); tx['chainId']=chain
    for field in ('gasPrice','maxFeePerGas','maxPriorityFeePerGas'):
        tx.pop(field,None)
    tx['type']=2
    tx.setdefault('value',0)
    if 'gas' not in tx: tx['gas']=int(w.eth.estimate_gas(tx)*13//10)
    # Debug estimates are advisory. Bind a fresh authoritative quote to the
    # final nonce, gas and calldata, and never fall back to unquoted fees.
    request=quote_transaction(tx)
    quoted=rpc(endpoint,'eez_quoteFee',[request,{'transactionTypes':['0x2']}])
    budget=int(os.getenv('COW_SOLVER_MAX_FEE_WEI','5000000000000000'))
    if budget<=0: raise ValueError('Solver fee budget must be positive')
    tx.update(validate_fee_quote(request,quoted,lambda text:Web3.to_hex(Web3.keccak(text=text)),
        int(time.time()),max_fee_cap=budget//tx['gas']))
    raw=a.sign_transaction(tx).raw_transaction
    tx_hash=Web3.to_hex(Web3.keccak(raw))
    # Persist the deterministic signed transaction hash before contacting the
    # Composer. A lost response or process exit must never cause a fresh send.
    update_order(QUEUE,item['id'],'submitting',txHash=tx_hash,nonce=tx['nonce'],
                 message='Submission started; awaiting Composer response.')
    debug('tx_submit_attempt',orderId=item['id'],hash=tx_hash,nonce=tx['nonce'])
    try:
        accepted=nonce_rpc.eth.send_raw_transaction(raw)
        if Web3.to_hex(accepted).lower()!=tx_hash.lower():
            raise RuntimeError('Composer returned an unexpected transaction hash')
        update_order(QUEUE,item['id'],'submitted',message='Submitted; awaiting canonical settlement.')
        debug('tx_submitted',orderId=item['id'],hash=tx_hash,nonce=tx['nonce'])
    except Exception as exc:
        # Even a timeout may follow acceptance. Keep the hash and reconcile it.
        update_order(QUEUE,item['id'],'submitted',message=f'Submission outcome unknown; checking transaction: {exc}')
        debug('tx_submit_error',orderId=item['id'],hash=tx_hash,error=str(exc))
    pending={**item,'solver':{**item.get('solver',{}),'txHash':tx_hash}}
    return reconcile(QUEUE,pending,rpc,CFG['L1_RPC'],CFG['L2_RPC'],L2_FRONT)


def rpc(endpoint,method,params):
    response=requests.post(endpoint,json={'jsonrpc':'2.0','id':1,'method':method,'params':params},timeout=15)
    response.raise_for_status()
    body=response.json()
    if 'error' in body: raise RuntimeError(str(body['error']))
    return body.get('result')

def queued():
    rows=[json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()]
    retry=os.getenv('RETRY_ORDER_ID')
    if retry:
        return next((r for r in reversed(rows) if r.get('id')==retry and is_active(r)),None)
    return next((r for r in reversed(rows) if is_active(r)),None)

def token_route(token):
    t=next((x for x in CFG.catalog() if x.get('address','').lower()==token.lower()),None)
    if not t: raise RuntimeError(f'no configured L1 route for token {token}')
    return to_checksum_address(t['address']),to_checksum_address(t['pair']),t.get('symbol',token[:10])

def order_route(item):
    symbol=item.get('quote',{}).get('tokenSymbol','').lower()
    t=next((x for x in CFG.catalog() if x.get('symbol','').lower()==symbol),None)
    if not t: raise RuntimeError(f'no configured L1 route for token symbol {symbol or "<unknown>"}')
    return token_route(t['address'])

def live_route_quote(pair, amount):
    p=L1.eth.contract(pair,abi=PAIR_ABI)
    t0=p.functions.token0().call()
    r0,r1,_=p.functions.getReserves().call()
    rin,rout=(r0,r1) if t0.lower()==WETH_L1.lower() else (r1,r0)
    net=amount*997
    return net*rout//(rin*1000+net)

def record_failure(item, reason):
    """Durably terminalize an order that cannot be filled as signed."""
    update_order(QUEUE,item['id'],'failed',error=reason)

def main():
    CFG.check_deployment(l1=L1,l2=L2)
    item=queued()
    if not item: print('no queued catalog-token order'); return
    if item.get('solver',{}).get('txHash') or item.get('solver',{}).get('settlement'):
        result=reconcile(QUEUE,item,rpc,CFG['L1_RPC'],CFG['L2_RPC'],L2_FRONT)
        debug('settlement_checked',orderId=item['id'],status=result['status'])
        return
    if item.get('status')!='queued':
        raise RuntimeError('Pending submission has no transaction hash; manual inspection required')
    CFG.catalog()
    order=item['order']; amount=int(order['sellAmount']); minimum=int(order['buyAmount'])
    token,pair,symbol=order_route(item)
    if int(time.time()) >= int(order['validTo']):
        reason='order expired before solver processing'
        record_failure(item, reason)
        print('failed:', reason, flush=True)
        return
    c2=L2.eth.contract(WETH_L2,abi=ERC20); user=to_checksum_address(order['receiver']); user_bal=c2.functions.balanceOf(user).call()
    relayer=L2.eth.contract(SETTLEMENT,abi=SETTLEMENT_VIEW_ABI).functions.vaultRelayer().call()
    settlement_allowance=c2.functions.allowance(user, relayer).call()
    # A route is valid only when the user's WETH starts the canonical
    # L2->L1 leg and the resulting inbound token is observed.
    if user_bal<amount or settlement_allowance<amount:
        # Keep the worker alive while the user funds the order and grants the
        # GPv2 relayer allowance.
        print(f'waiting: user WETH/allowance insufficient ({user_bal}/{settlement_allowance} < {amount})', flush=True)
        update_order(QUEUE,item['id'],'queued',message='Waiting for user WETH balance or allowance.')
        return
    predicted=to_checksum_address(order['buyToken'])
    # The signed order is immutable. Reject a non-canonical wrapper address so
    # the EIP-712 order and the atomic fill refer to the same token.
    canonical= L2.eth.contract(BRIDGE_L2,abi=BRIDGE_ABI).functions.getWrappedToken(token,0).call()
    if int(canonical,16) and predicted.lower()!=to_checksum_address(canonical).lower():
        reason=f'order buyToken {predicted} is not the canonical wrapper {to_checksum_address(canonical)} for {token}; resubmit after refreshing the quote'
        record_failure(item,reason); print('failed:',reason,flush=True); return
    # GPv2 pulls the user's WETH into settlement before the pre-interactions
    # transfer it to the universal route. The first bridge funds the L1 swap
    # and creates the deterministic wrapper when needed. The reusable L1 helper
    # is deployed through the canonical deterministic factory.
    universal_state=CFG['ROUTE_MANIFEST']
    if universal_state.exists():
        us=CFG.read_manifest('ROUTE_MANIFEST')
        route_abi=json.loads((BASE/'contracts'/'out'/'L2UniversalV2Route.sol'/'L2UniversalV2Route.json').read_text())['abi']
        route=L2.eth.contract(us['routeL2'],abi=route_abi)
        for name, expected in (('bridge',BRIDGE_L2),('wrappedWeth',WETH_L2),('settlement',SETTLEMENT)):
            if getattr(route.functions,name)().call().lower()!=expected.lower():
                raise RuntimeError(f'Route {name} does not match selected configuration')
        if route.functions.l1Helper().call().lower()!=us['l1Helper'].lower():
            reason='universal L2 route is not configured with the factory-deployed L1 helper'
            record_failure(item,reason); print('failed:',reason,flush=True); return
        sab=json.loads(CFG['GPV2_ARTIFACT'].read_text())['abi']
        st=L2.eth.contract(SETTLEMENT,abi=sab)
        trade=(0,1,order['receiver'],amount,minimum,int(order['validTo']),bytes.fromhex(order['appData'][2:]),int(order['feeAmount']),0,amount,bytes.fromhex(item['signature'][2:]))
        transfer='0x'+(keccak(text='transfer(address,uint256)')[:4]+encode(['address','uint256'],[route.address,amount])).hex()
        held=route.functions.startHeld(amount,token,pair,minimum)._encode_transaction_data()
        interactions=[[],[(WETH_L2,0,transfer),(route.address,0,held)],[]]
        clearing_out=max(minimum,live_route_quote(pair,amount))
        clearing_prices=[clearing_out*10**18,amount*10**18]
        settle_gas=500_000; quoted_tip=None; quoted_max=None
        intent={'from':ACCT.address,'to':SETTLEMENT,
                # Encode the signed limit ratio exactly.  A floor/ceiling
                # approximation can respectively over-demand one wei or fail
                # GPv2's limit-price check.
                'data':st.functions.settle([WETH_L2,predicted],clearing_prices,[trade],interactions)._encode_transaction_data(),
                'value':'0x0'}
        try:
            dbg=requests.post(L2_FRONT,json={'jsonrpc':'2.0','id':1,'method':'eez_debugQuoteFee',
                'params':[intent,{'transactionTypes':['0x2'],'trace':'calls'}]},timeout=90).json()
            debug('composer_debug_quote',orderId=item.get('id'),intent=intent,response=dbg)
            # Preserve addresses observed in the Composer call trace so the
            # diagnostic contains the contracts created during the first bridge.
            trace=((dbg.get('result') or {}).get('diagnostics') or {}).get('trace') or {}
            created=[]
            for run in trace.get('runs',[]) or []:
                for frame in run.get('frames',[]) or []:
                    if frame.get('kind')=='CREATE2' and frame.get('to'):
                        created.append(frame.get('to'))
            if created:
                # Repeat the diagnostic event with the trace-derived CREATE2
                # addresses attached so the UI's latest event remains the
                # actionable composer_debug_quote record.
                debug('composer_debug_quote',orderId=item.get('id'),intent=intent,response=dbg,createdContracts=created,requestedBuyToken=predicted)
            opts=(dbg.get('result') or {}).get('options') or []
            if opts and opts[0].get('gas'):
                settle_gas=int(opts[0]['gas'],16)*110//100
            if opts:
                quoted_tip=opts[0].get('maxPriorityFeePerGas'); quoted_max=opts[0].get('maxFeePerGas')
            if opts and opts[0].get('error'):
                err=opts[0]['error']
                detail=err.get('details') or {}
                # Keep the actionable composer reason in the durable order
                # record; the top-level unsupported_transaction is only a
                # wrapper around the real execution failure.
                reason=json.dumps({
                    'code': err.get('code'),
                    'message': detail.get('message') or err.get('message'),
                    'stage': detail.get('stage'),
                    'reason': detail.get('reason'),
                    'revertData': detail.get('revertData'),
                },sort_keys=True)
                record_failure(item,reason); print(f'failed: composer debug quote {reason}',flush=True); return
        except Exception as exc:
            debug('composer_debug_quote_error',orderId=item.get('id'),intent=intent,error=str(exc))
        try:
            # Use the observed route gas with a safety margin. Composer
            # admission separately accounts for the L1 settlement estimate.
            fill_tx=st.functions.settle([WETH_L2,predicted],clearing_prices,[trade],interactions).build_transaction({'from':ACCT.address,'gas':settle_gas})
            fill_tx['_quotedTip']=quoted_tip; fill_tx['_quotedMaxFee']=quoted_max
            send(L2,ACCT,fill_tx,L2_CHAIN,item,L2_FRONT)
        except Exception as exc:
            # Errors before submission leave the order queued. Once persisted,
            # the submission hash is retained and the next pass only reconciles.
            debug('order_worker_exception',orderId=item['id'],error=str(exc))
        return

    record_failure(item, 'universal route manifest is missing; deploy the final universal route before settling')
    return

if __name__=='__main__':
    QUEUE.parent.mkdir(parents=True,exist_ok=True)
    # Serialize independent worker processes as well as threads.
    with QUEUE.with_suffix(QUEUE.suffix+'.solver.lock').open('a') as execution_lock:
        fcntl.flock(execution_lock,fcntl.LOCK_EX)
        main()
