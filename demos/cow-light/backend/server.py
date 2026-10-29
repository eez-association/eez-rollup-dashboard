#!/usr/bin/env python3
"""Dependency-light API/UI for the EEZ cross-chain CoW Light demo.

Quotes are read-only L1 Uniswap V2 calls. Orders are EIP-712 verified and
persisted to a queue. A live solver adapter must be explicitly configured;
this process never signs or posts a settlement by itself.
"""
import json, os, sys, threading, time, uuid, requests, fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_abi import encode as abi_encode
from eth_utils import keccak, to_checksum_address

ROOT=Path(__file__).resolve().parents[1]; UI=ROOT/"ui"
sys.path.insert(0, str(ROOT))
from wrapper_prediction import WrapperPredictor, metadata
from network_config import load_config
CFG=load_config()
CATALOG=CFG['TOKEN_CATALOG']; QUEUE=CFG['ORDER_QUEUE']; QUEUE_LOCK=QUEUE.with_suffix(QUEUE.suffix+'.lock')
SOLVER_LOG=CFG['SOLVER_LOG']
L1_RPC=CFG['L1_RPC']; L2_RPC=CFG['L2_RPC']; L2_FRONT=CFG['L2_FRONT']
L1_CHAIN=CFG['L1_CHAIN_ID']; L2_CHAIN=CFG['L2_CHAIN_ID']
WETH=CFG['WETH_L1']; WETH_L2=CFG['WETH_L2']
SETTLEMENT=CFG['SETTLEMENT_L2']; BRIDGE_L2=CFG['BRIDGE_L2']
NATIVE_WETH_L2=CFG.get('NATIVE_WETH_L2')
PAIR_ABI=[{"type":"function","name":"getReserves","stateMutability":"view","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]},{"type":"function","name":"token0","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}]
BRIDGE_ABI=[{"type":"function","name":"getWrappedToken","stateMutability":"view","inputs":[{"type":"address"},{"type":"uint64"}],"outputs":[{"type":"address"}]}]
TOKEN_META_ABI=[
    {"type":"function","name":"name","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
    {"type":"function","name":"symbol","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
    {"type":"function","name":"decimals","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
]
MANAGER_ABI=[{"type":"function","name":"computeCrossChainProxyAddress","stateMutability":"view","inputs":[{"type":"address"},{"type":"uint64"}],"outputs":[{"type":"address"}]}]
SETTLEMENT_VIEW_ABI=[{"type":"function","name":"vaultRelayer","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}]
l1=Web3(Web3.HTTPProvider(L1_RPC,request_kwargs={"timeout":30})); l2=Web3(Web3.HTTPProvider(L2_RPC,request_kwargs={"timeout":30})); lock=threading.Lock()
_wrapper_predictor=WrapperPredictor()
def vault_relayer():
    return l2.eth.contract(Web3.to_checksum_address(SETTLEMENT),abi=SETTLEMENT_VIEW_ABI).functions.vaultRelayer().call()

def catalog(): return CFG.catalog()
def faucet_status(owner):
    address=CFG.get('COW_FAUCET_L1')
    if CFG['NETWORK']!='chiado' or L1_CHAIN!=10200 or not address:
        raise ValueError('Test-token faucet is not configured for this network')
    owner=Web3.to_checksum_address(owner)
    address=Web3.to_checksum_address(address)
    abi=[{'type':'function','name':name,'stateMutability':'view','inputs':[],
          'outputs':[{'type':kind}]} for name,kind in [('token','address'),('bridge','address'),('rollupId','uint64'),
                                                    ('tokenAmount','uint256'),('gasAmount','uint256'),('cooldown','uint256')]]
    abi.append({'type':'function','name':'nextClaimAt','stateMutability':'view','inputs':[{'type':'address'}],'outputs':[{'type':'uint256'}]})
    faucet=l1.eth.contract(address,abi=abi)
    if (faucet.functions.token().call().lower()!=WETH.lower()
        or faucet.functions.bridge().call().lower()!=CFG['BRIDGE_L1'].lower()
        or faucet.functions.rollupId().call()!=CFG['L2_ROLLUP_ID']):
        raise ValueError('Faucet does not match the current token, bridge and rollup')
    token_abi=[{'type':'function','name':'balanceOf','stateMutability':'view','inputs':[{'type':'address'}],'outputs':[{'type':'uint256'}]}]
    amount=faucet.functions.tokenAmount().call(); gas=faucet.functions.gasAmount().call()
    stock=l1.eth.contract(Web3.to_checksum_address(WETH),abi=token_abi).functions.balanceOf(address).call()
    next_claim=faucet.functions.nextClaimAt(owner).call()
    return {'address':address,'owner':owner,'tokenAmount':str(amount),'gasAmount':str(gas),
            'cooldown':faucet.functions.cooldown().call(),'nextClaimAt':next_claim,
            'funded':stock>=amount and l1.eth.get_balance(address)>=gas,
            'eligible':l1.eth.get_block('latest')['timestamp']>=next_claim,
            'l2TokenBalance':str(l2.eth.contract(Web3.to_checksum_address(WETH_L2),abi=token_abi).functions.balanceOf(owner).call()),
            'l2GasBalance':str(l2.eth.get_balance(owner))}
def quote(t,amount):
    p=l1.eth.contract(Web3.to_checksum_address(t["pair"]),abi=PAIR_ABI); r0,r1,_=p.functions.getReserves().call(); t0=p.functions.token0().call()
    rin,rout=(r0,r1) if t0.lower()==WETH.lower() else (r1,r0)
    if amount<=0 or not rin or not rout: raise ValueError("empty pair")
    out=amount*997*rout//(rin*1000+amount*997); spot=amount*rout//rin
    return {"amountIn":str(amount),"amountOut":str(out),"spotOut":str(spot),
            "priceImpactBps":round((spot-out)*10000/spot,2) if spot else None,
            "feeBps":30,"pair":t["pair"],"block":l1.eth.block_number,
            "tokenSymbol":t.get("symbol",""),"tokenDecimals":t.get("decimals",18),
            "tokenReserve":t.get("tokenReserve"),"wethReserve":t.get("wethReserve")}
def _live_wrapper_prefix():
    return _wrapper_predictor.prefix(CFG, l2)

def wrapper(token, status_only=False):
    token=Web3.to_checksum_address(token)
    c=l2.eth.contract(Web3.to_checksum_address(BRIDGE_L2),abi=BRIDGE_ABI); x=c.functions.getWrappedToken(token,0).call()
    if int(x,16): return {"address":x,"deployed":True,"deterministic":True}
    if status_only:
        # Listing status needs only the canonical registry, not a historical
        # creation trace or a predicted address for a future swap.
        return {"address":x,"deployed":False,"deterministic":False}
    t=next((z for z in catalog() if z["address"].lower()==token.lower()),None)
    if not t: raise ValueError("token is not in the L1 catalog")
    # The bridge derives CREATE2 init code from the token's *on-chain* ERC20
    # metadata. Catalog labels are display-only.
    name, symbol, decimals = metadata(l1, token)
    init=_live_wrapper_prefix()+abi_encode(["string","string","uint8","address"],[name,symbol,decimals,Web3.to_checksum_address(BRIDGE_L2)])
    # The deployed BridgeLive ABI uses uint64 for originalRollupId, so
    # _wrappedSalt is abi.encodePacked(address,uint64): 20 + 8 bytes.  The
    # current network's rollup id is 0 for Ethereum-origin tokens.
    salt=keccak(bytes.fromhex(token[2:])+int(0).to_bytes(8,"big"))
    # Bridge._getOrDeployWrapped executes `new WrappedToken{salt: salt}` in
    # the Bridge contract itself.  Therefore the CREATE2 deployer is the L2
    # bridge address, not the cross-chain proxy representing that bridge.
    raw=keccak(b"\xff"+bytes.fromhex(Web3.to_checksum_address(BRIDGE_L2)[2:])+salt+keccak(init))[-20:]
    predicted=to_checksum_address(raw)
    return {"address":predicted,"deployed":bool(l2.eth.get_code(predicted)),"deterministic":True}

def recover(order,sig):
    required=["sellToken","buyToken","receiver","sellAmount","buyAmount","validTo","appData","feeAmount","kind","partiallyFillable","sellTokenBalance","buyTokenBalance"]
    if any(k not in order for k in required): raise ValueError("order missing typed-data field")
    if int(order["validTo"])<=int(time.time()): raise ValueError("order expired")
    if order["kind"]!="sell" or order["partiallyFillable"] is not False: raise ValueError("only fixed sell orders supported")
    types={"Order":[{"name":"sellToken","type":"address"},{"name":"buyToken","type":"address"},{"name":"receiver","type":"address"},{"name":"sellAmount","type":"uint256"},{"name":"buyAmount","type":"uint256"},{"name":"validTo","type":"uint32"},{"name":"appData","type":"bytes32"},{"name":"feeAmount","type":"uint256"},{"name":"kind","type":"string"},{"name":"partiallyFillable","type":"bool"},{"name":"sellTokenBalance","type":"string"},{"name":"buyTokenBalance","type":"string"}]}
    msg=encode_typed_data(domain_data={"name":"Gnosis Protocol","version":"v2","chainId":L2_CHAIN,"verifyingContract":SETTLEMENT},message_types=types,message_data=order)
    return Account.recover_message(msg,signature=sig)
def queue(order,sig,signer,q):
    rec={"id":uuid.uuid4().hex,"receivedAt":int(time.time()),"status":"queued","order":order,"signature":sig,"signer":signer,"quote":q,"l2Front":L2_FRONT}
    with lock:
        QUEUE.parent.mkdir(parents=True,exist_ok=True)
        with QUEUE_LOCK.open("w") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            with QUEUE.open("a") as f:
                f.write(json.dumps(rec)+"\n"); f.flush(); os.fsync(f.fileno())
            fcntl.flock(lf, fcntl.LOCK_UN)
    return rec

def solver_events():
    """Return the latest durable worker event for each order.

    The solver is a separate process, so the queue status alone cannot tell a
    user whether an order is waiting, being simulated, submitted, or awaiting
    canonical settlement.  Parse only the bounded tail to keep this read-only
    endpoint cheap even after a long-running demo.
    """
    latest={}
    if not SOLVER_LOG.exists(): return latest
    try:
        lines=SOLVER_LOG.read_text().splitlines()[-2000:]
        for line in lines:
            try: e=json.loads(line)
            except Exception: continue
            oid=e.get("orderId")
            if oid:
                if oid in latest: e["previous"] = latest[oid]
                latest[oid]=e
    except Exception: return latest
    return latest


def order_debug(row, events):
    oid=row.get("id"); e=events.get(oid,{})
    # A worker-exit record is a lifecycle marker, not the cause. Keep the
    # preceding solver event visible so the user sees the actual failure.
    display=e.get("previous",e) if e.get("event")=="order_worker_exit" and e.get("previous") else e
    status=str(row.get("status","queued")).lower()
    event=display.get("event","")
    states={
        "order_pickup":"picked_up", "tx_submit_attempt":"submitting",
        "tx_submitted":"submitted", "tx_submit_error":"submission_failed",
        "composer_debug_quote":"quote_rejected",
        "order_worker_exception":"worker_error", "order_worker_exit":"worker_stopped",
    }
    if status=="settled":
        state="settled" if (row.get('solver') or {}).get('canonicalVerified') is True else "awaiting_settlement"
    elif status in ("submitting","submitted","awaiting_settlement"): state=status
    elif status in ("failed","expired"): state="failed"
    else: state=states.get(event,"queued")
    msg=(row.get('solver') or {}).get('message') or display.get("error") or display.get("message")
    if event=="composer_debug_quote":
        try:
            diag=display.get("response",{}).get("result",{}).get("diagnostics",{})
            opt=(diag.get("options") or [{}])[0]
            err=opt.get("error",{})
            detail=err.get("details",{})
            msg=detail.get("message") or err.get("message") or msg
            if err:
                msg=json.dumps({
                    "code": err.get("code"),
                    "message": detail.get("message") or err.get("message"),
                    "stage": detail.get("stage"),
                    "reason": detail.get("reason"),
                    "revertData": detail.get("revertData"),
                }, separators=(",", ":"))
        except Exception: pass
    solver=row.get("solver") or {}
    settlement=solver.get("settlement")
    # The solver records the exact public composer intent so a failed quote
    # can be reproduced with curl/cast.  Do not include signatures or keys.
    intent=display.get("intent") or display.get("transaction")
    return {"state":state,"event":event,"message":msg,"lastEventAt":display.get("ts"),
            "nonce":display.get("nonce"),"gas":display.get("gas"),
            "intent":intent,
            "createdContracts":display.get("createdContracts"),
            "txHash":solver.get('txHash') or display.get("hash") or settlement,
            "settlement":settlement,"settlementBlock":solver.get("settlementBlock"),
            "l1Tx":solver.get("l1Tx"),
            "l1Block":solver.get("l1Block"),
            "error":solver.get("error") or (msg if state in ('failed','quote_rejected','worker_error') else None)}

class Handler(BaseHTTPRequestHandler):
    def send_json(self,obj,code=200):
        b=json.dumps(obj).encode();self.send_response(code);self.send_header("content-type","application/json");self.send_header("content-length",str(len(b)));self.send_header("access-control-allow-origin","*");self.end_headers();self.wfile.write(b)
    def do_OPTIONS(self):self.send_response(204);self.send_header("access-control-allow-origin","*");self.send_header("access-control-allow-headers","content-type");self.end_headers()
    def do_GET(self):
        p=urlparse(self.path)
        try:
            if p.path in ('/api/config', '/api/quote', '/api/wrapper', '/api/allowance', '/api/balances', '/api/faucet'):
                try:
                    CFG.check_deployment(l1=l1,l2=l2)
                except Exception:
                    return self.send_json({'status':'deployment_required',
                        'error':'Deployment required or network verification unavailable. Check the configured RPCs and deployment identity.'},503)
            if p.path in ("/","/index.html"):
                b=(UI/"index.html").read_bytes();self.send_response(200);self.send_header("content-type","text/html; charset=utf-8");self.send_header("content-length",str(len(b)));self.end_headers();self.wfile.write(b);return
            if p.path=="/api/config":return self.send_json({"network":CFG['NETWORK'],"l1NativeSymbol":CFG['L1_NATIVE_SYMBOL'],"l2NativeSymbol":CFG['L2_NATIVE_SYMBOL'],"l1Explorer":CFG.get('L1_EXPLORER'),"l2Explorer":CFG.get('L2_EXPLORER'),"l1ChainId":L1_CHAIN,"l2ChainId":L2_CHAIN,"l1Rpc":CFG.get('COW_PUBLIC_L1_RPC',L1_RPC),"l2Front":CFG.get('COW_PUBLIC_L2_FRONT',L2_FRONT),"settlement":SETTLEMENT,"vaultRelayer":vault_relayer(),"wethL1":WETH,"wethL2":WETH_L2,"nativeWethL2":NATIVE_WETH_L2,"bridgeL2":BRIDGE_L2})
            if p.path=="/api/health":
                # Keep this endpoint read-only and bounded: it is used by the UI
                # as an operator signal, not as a transaction submission path.
                return self.send_json({"l1Head":l1.eth.block_number,"l2Head":l2.eth.block_number,"checkedAt":int(time.time())})
            if p.path=="/api/faucet":
                return self.send_json(faucet_status(parse_qs(p.query).get('owner',[''])[0]))
            if p.path=="/api/tokens":return self.send_json({"tokens":catalog()})
            if p.path=="/api/orders":
                rows=[]
                if QUEUE.exists(): rows=[json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()]
                events=solver_events()
                for row in rows: row["solverDebug"]=order_debug(row,events)
                return self.send_json({"orders":rows})
            if p.path=="/api/wrapper":
                a=parse_qs(p.query).get("token",[""])[0]
                if not a: raise ValueError("token is required")
                w=wrapper(a, status_only=parse_qs(p.query).get("statusOnly")==["1"]); return self.send_json({"token":Web3.to_checksum_address(a),"wrapper":w["address"],"deployed":w["deployed"],"deterministic":w["deterministic"]})
            if p.path=="/api/allowance":
                owner=parse_qs(p.query).get("owner",[""])[0]
                if not owner: raise ValueError("owner is required")
                owner=Web3.to_checksum_address(owner)
                abi=[{"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},{"type":"function","name":"allowance","stateMutability":"view","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"uint256"}]}]
                c=l2.eth.contract(Web3.to_checksum_address(WETH_L2),abi=abi)
                return self.send_json({"owner":Web3.to_checksum_address(owner),"balance":str(c.functions.balanceOf(owner).call()),"allowance":str(c.functions.allowance(owner,vault_relayer()).call()),"spender":vault_relayer()})
            if p.path=="/api/balances":
                owner=Web3.to_checksum_address(parse_qs(p.query).get("owner",[""])[0])
                erc20=[{"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]}]
                l2w=l2.eth.contract(Web3.to_checksum_address(WETH_L2),abi=erc20)
                l1w=l1.eth.contract(Web3.to_checksum_address(WETH),abi=erc20)
                out={"owner":owner,"l2Eth":str(l2.eth.get_balance(owner)),"l2Weth":str(l2w.functions.balanceOf(owner).call()),"l1Eth":str(l1.eth.get_balance(owner)),"l1Weth":str(l1w.functions.balanceOf(owner).call())}
                token=parse_qs(p.query).get("token",[""])[0]
                if token:
                    t=next((x for x in catalog() if x["address"].lower()==token.lower()),None)
                    if t:
                        winfo=wrapper(token); waddr=winfo["address"]; deployed=bool(l2.eth.get_code(Web3.to_checksum_address(waddr))); wabi=l2.eth.contract(Web3.to_checksum_address(waddr),abi=erc20)
                        out["selected"]={"symbol":t.get("symbol",""),"decimals":int(t.get("decimals",18)),"wrapper":waddr,"deployed":deployed,"balance":str(wabi.functions.balanceOf(owner).call()) if deployed else "0"}
                return self.send_json(out)
            if p.path=="/api/quote":
                a=parse_qs(p.query);addr=a.get("token",[""])[0].lower();t=next((x for x in catalog() if x["address"].lower()==addr),None)
                if not t:return self.send_json({"error":"unknown token"},404)
                return self.send_json(quote(t,int(a.get("amount",["0"])[0])))
            return self.send_json({"error":"not found"},404)
        except Exception as e:return self.send_json({"error":str(e)},500)
    def do_POST(self):
        if urlparse(self.path).path!="/api/orders":return self.send_json({"error":"not found"},404)
        try:
            CFG.check_deployment(l1=l1,l2=l2)
            n=int(self.headers.get("content-length","0"));body=json.loads(self.rfile.read(n));order=body["order"];sig=body["signature"];signer=recover(order,sig)
            l1token=body.get("l1Token","").lower();t=next((x for x in catalog() if x["address"].lower()==l1token),None)
            if not t: raise ValueError("l1Token must identify a catalogued L1 token")
            q=quote(t,int(order["sellAmount"]))
            if int(q["amountOut"]) < int(order["buyAmount"]): raise ValueError("signed minimum output is above the current L1 quote")
            balance_abi=[{"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]}]
            balance=l2.eth.contract(Web3.to_checksum_address(WETH_L2),abi=balance_abi).functions.balanceOf(signer).call()
            if balance < int(order["sellAmount"]): raise ValueError("insufficient L2 WETH balance for this order")
            expected=wrapper(l1token)["address"]
            if order["buyToken"].lower()!=expected.lower(): raise ValueError("buyToken is not the deterministic wrapper for l1Token")
            return self.send_json(queue(order,sig,signer,q),202)
        except Exception as e:return self.send_json({"error":str(e)},400)

if __name__=="__main__":
    # Keep the status API available after a reset; trading requests and the
    # solver independently validate the live deployment before proceeding.
    catalog()
    port=int(os.getenv("PORT","8787"));print(f"EEZ CoW Light UI: http://127.0.0.1:{port}",flush=True)
    ThreadingHTTPServer((os.getenv("HOST","127.0.0.1"),port),Handler).serve_forever()
