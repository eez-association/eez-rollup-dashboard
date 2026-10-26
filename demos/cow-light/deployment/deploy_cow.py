#!/usr/bin/env python3
"""Deploy the GPv2 stack on the selected EEZ L2 network."""
import json, os, sys
from pathlib import Path
from eth_account import Account
from web3 import Web3

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
CFG = load_config()
RPC = CFG['L2_RPC']; CHAIN_ID = CFG['L2_CHAIN_ID']
OUT = CFG['COW_MANIFEST']; ART = CFG['COWSWAP_ARTIFACTS']

def artifact(name):
    d = json.loads((ART / name).read_text())
    b = d["bytecode"]; b = b["object"] if isinstance(b, dict) else b
    return d["abi"], b

def key():
    if os.environ.get("DEPLOYER_PRIVATE_KEY"): return os.environ["DEPLOYER_PRIVATE_KEY"]
    path=os.environ.get("DEPLOYER_KEY_FILE")
    if path:
        for line in Path(path).read_text().splitlines():
            if line.startswith(("DEPLOYER_PRIVATE_KEY=", "FUZZER_PRIVATE_KEY=")): return line.split("=",1)[1].strip()
    raise RuntimeError("set DEPLOYER_PRIVATE_KEY or DEPLOYER_KEY_FILE")

def send(w3, acct, tx):
    tx.setdefault("from", acct.address)
    tx["nonce"] = w3.eth.get_transaction_count(acct.address, "pending")
    tx["chainId"] = CHAIN_ID
    # EEZ uses a very low gas price; retain a valid EIP-1559 fee ordering.
    gp = max(w3.eth.gas_price, 100)
    tx.setdefault("maxFeePerGas", gp)
    tx.setdefault("maxPriorityFeePerGas", min(gp, 100))
    tx.setdefault("gas", int(w3.eth.estimate_gas(tx) * 13 // 10))
    tx.pop("gasPrice", None)
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=300)
    if r.status != 1: raise RuntimeError(f"reverted {h.hex()}")
    print(f"{h.hex()} block={r.blockNumber} gas={r.gasUsed}", flush=True)
    return r

def deploy(w3, acct, abi, bytecode, *args):
    c = w3.eth.contract(abi=abi, bytecode=bytecode)
    r = send(w3, acct, c.constructor(*args).build_transaction({"from": acct.address}))
    return r.contractAddress, r

def main():
    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 60}))
    CFG.check_chains(l2=w3)
    if OUT.exists():
        raise RuntimeError(f'GPv2 manifest already exists: {OUT}; use that deployment or a new manifest path')
    acct = Account.from_key(key())
    if not w3.is_connected() or w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError(f"unexpected chain: {w3.eth.chain_id}")
    auth_abi, auth_bin = artifact("GPv2AllowListAuthentication.json")
    set_abi, set_bin = artifact("GPv2Settlement.json")
    auth, ar = deploy(w3, acct, auth_abi, auth_bin)
    authc = w3.eth.contract(auth, abi=auth_abi)
    send(w3, acct, authc.functions.initializeManager(acct.address).build_transaction({"from": acct.address}))
    send(w3, acct, authc.functions.addSolver(acct.address).build_transaction({"from": acct.address}))
    settlement, sr = deploy(w3, acct, set_abi, set_bin, auth, "0x0000000000000000000000000000000000000000")
    out = {"network": CFG['NETWORK'], "l1ChainId": CFG['L1_CHAIN_ID'], "chainId": CHAIN_ID, "rpc": RPC, "deployer": acct.address,
           "authenticator": auth, "settlement": settlement,
           "vaultRelayer": w3.eth.contract(settlement, abi=set_abi).functions.vaultRelayer().call(),
           "deploymentTxs": {"authenticator": ar.transactionHash.hex(), "settlement": sr.transactionHash.hex()}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))

if __name__ == "__main__": main()
