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

def send(w,a,tx,chain,endpoint=None,timeout=1200):
    tx=dict(tx); tx['from']=a.address
    quoted_tip=tx.pop('_quotedTip',None); quoted_max=tx.pop('_quotedMaxFee',None)
    # The composer maintains a reservation-aware source nonce.  The execution
    # RPC can lag that view, so ask the submission endpoint whenever possible.
    nonce_rpc = Web3(Web3.HTTPProvider(endpoint,request_kwargs={'timeout':30})) if endpoint else w
    tx['nonce']=nonce_rpc.eth.get_transaction_count(a.address,'pending'); tx['chainId']=chain
    tx.pop('gasPrice',None); base=w.eth.get_block('latest').get('baseFeePerGas') or 0; gp=w.eth.gas_price
    # EEZ settlement admission charges an L1 tariff. A 1 gwei cap can be
    # underfunded even when ordinary L2 gas is cheap; start above that floor
    # and raise it from the structured admission error when necessary.
    tip=int(quoted_tip,16) if isinstance(quoted_tip,str) else (int(quoted_tip) if quoted_tip else max(gp//2,2_000_000_000))
    tx['maxPriorityFeePerGas']=tip
    tx['maxFeePerGas']=int(quoted_max,16) if isinstance(quoted_max,str) else (int(quoted_max) if quoted_max else max(gp,base+tip))
    if 'gas' not in tx: tx['gas']=int(w.eth.estimate_gas(tx)*13//10)
    b=nonce_rpc
    for attempt in range(3):
        raw=a.sign_transaction(tx).raw_transaction
        # Public, replayable envelope only; never log signing material.
        tx_view={
            'from': a.address,
            'to': tx.get('to'),
            'value': hex(int(tx.get('value',0))),
            'data': tx.get('data','0x'),
            'nonce': hex(int(tx['nonce'])),
            'gas': hex(int(tx['gas'])) if tx.get('gas') is not None else None,
            'maxFeePerGas': hex(int(tx['maxFeePerGas'])) if tx.get('maxFeePerGas') is not None else None,
            'maxPriorityFeePerGas': hex(int(tx['maxPriorityFeePerGas'])) if tx.get('maxPriorityFeePerGas') is not None else None,
            'chainId': chain,
        }
        debug('tx_submit_attempt', attempt=attempt, nonce=tx['nonce'], endpoint=endpoint, to=tx.get('to'), gas=tx.get('gas'), transaction=tx_view)
        try:
            h=b.eth.send_raw_transaction(raw); hx=h.hex(); debug('tx_submitted', hash=hx, nonce=tx['nonce'], transaction=tx_view); break
        except Exception as exc:
            msg=str(exc)
            debug('tx_submit_error', attempt=attempt, nonce=tx['nonce'], error=msg)
            import re
            m=re.search(r'expected(?: next)?(?: unreserved)? nonce (\d+)',msg)
            fee=re.search(r"requiredPayment['\"]?: ['\"](0x[0-9a-fA-F]+)['\"].*?sourceGasUsed['\"]?: ['\"](0x[0-9a-fA-F]+)",msg)
            if fee and attempt<2:
                required=int(fee.group(1),16); gas_used=int(fee.group(2),16)
                tx['maxPriorityFeePerGas']=max(tx['maxPriorityFeePerGas'],(required//gas_used)+100_000_000)
                tx['maxFeePerGas']=max(tx['maxFeePerGas'],base+tx['maxPriorityFeePerGas'])
                debug('fee_retry', requiredPayment=required, sourceGasUsed=gas_used, priorityFee=tx['maxPriorityFeePerGas'])
                continue
            if m and attempt<2:
                tx['nonce']=int(m.group(1)); continue
            raise
    # Poll the execution RPC and Composer index until the transaction is
    # canonical or a durable rejection is reported.
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            r=w.eth.get_transaction_receipt(h)
            if r is not None:
                if r.status!=1: raise RuntimeError('reverted '+hx)
                return r
        except Exception:
            pass
        if endpoint:
            try:
                q=requests.post(endpoint,json={'jsonrpc':'2.0','id':1,'method':'eez_getCrossChainTransaction','params':[hx]},timeout=20).json().get('result')
                if q:
                    own=q.get('ownership') or {}; rej=own.get('rejection') or {}
                    if q.get('lifecycle')=='terminal' and own.get('canonical') is None:
                        err=rej.get('error') or own.get('reason') or 'terminal composer rejection'
                        raise RuntimeError(f'composer rejected {hx}: {err}')
            except RuntimeError: raise
            except Exception: pass
        time.sleep(3)
    raise RuntimeError(f'timed out waiting for canonical receipt {hx}')

def queued():
    rows=[json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()]
    retry=os.getenv('RETRY_ORDER_ID')
    if retry:
        return next((r for r in reversed(rows) if r.get('id')==retry and r.get('status') in ('queued','failed')),None)
    return next((r for r in reversed(rows) if r.get('status')=='queued'),None)

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
    with QUEUE_LOCK.open('w') as lf:
      fcntl.flock(lf, fcntl.LOCK_EX)
      rows=[json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()]
      for r in rows:
        if r.get('id')==item.get('id') and r.get('status')=='queued':
          r['status']='failed'; r['solver']={'orderId':item.get('id'),'error':reason}
      tmp=QUEUE.with_suffix('.jsonl.tmp'); tmp.write_text(''.join(json.dumps(r)+'\n' for r in rows)); os.replace(tmp,QUEUE)
      fcntl.flock(lf, fcntl.LOCK_UN)

def main():
    CFG.check_chains(l1=L1,l2=L2)
    CFG.catalog()
    item=queued()
    if not item: print('no queued catalog-token order'); return
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
            fill=send(L2,ACCT,fill_tx,L2_CHAIN,L2_FRONT)
        except RuntimeError as exc:
            record_failure(item,str(exc)); print(f'failed: {exc}',flush=True); return
        result={'orderId':item['id'],'settlement':'0x'+fill.transactionHash.hex(),'settlementBlock':fill.blockNumber,'wrapper':predicted,'route':route.address,'l1Helper':us['l1Helper'],'inventoryBacked':False}
        with QUEUE_LOCK.open('w') as lf:
            fcntl.flock(lf,fcntl.LOCK_EX)
            rows=[json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()]
            for r in rows:
                if r.get('id')==item.get('id') and r.get('status') in ('queued','failed'): r['status']='settled'; r['solver']=result
            tmp=QUEUE.with_suffix('.jsonl.tmp'); tmp.write_text(''.join(json.dumps(r)+'\n' for r in rows)); os.replace(tmp,QUEUE); fcntl.flock(lf,fcntl.LOCK_UN)
        print(json.dumps(result,indent=2)); return

    record_failure(item, 'universal route manifest is missing; deploy the final universal route before settling')
    return

if __name__=='__main__': main()
