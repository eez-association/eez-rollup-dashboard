#!/usr/bin/env python3
"""Deploy the GPv2 stack on the selected EEZ L2 network."""
import json, os, sys
from pathlib import Path
from eth_account import Account
from web3 import Web3

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
from deployment.bootstrap_chiado import atomic_json
from deployment.l2_transactions import L2Transactions
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

def main():
    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 60}))
    CFG.check_chains(l2=w3)
    if OUT.exists():
        raise RuntimeError(f'GPv2 manifest already exists: {OUT}; use that deployment or a new manifest path')
    acct = Account.from_key(key())
    deployment_identity = CFG.deployment_identity(w3)
    if not w3.is_connected() or w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError(f"unexpected chain: {w3.eth.chain_id}")
    auth_abi, auth_bin = artifact("GPv2AllowListAuthentication.json")
    set_abi, set_bin = artifact("GPv2Settlement.json")
    sender = L2Transactions(CFG, acct, OUT.with_suffix('.journal.json'), {
        'authCodeHash': Web3.to_hex(Web3.keccak(hexstr=auth_bin)),
        'settlementCodeHash': Web3.to_hex(Web3.keccak(hexstr=set_bin)),
    })
    def build(call):
        return call.build_transaction({'from': acct.address, 'gas': 1})
    ar = sender.send('authenticator', lambda: build(w3.eth.contract(abi=auth_abi, bytecode=auth_bin).constructor()))
    auth = ar['contractAddress']
    authc = w3.eth.contract(auth, abi=auth_abi)
    sender.send('initializeManager', lambda: build(authc.functions.initializeManager(acct.address)))
    sender.send('addSolver', lambda: build(authc.functions.addSolver(acct.address)))
    if authc.functions.manager().call() != acct.address or not authc.functions.isSolver(acct.address).call():
        raise ValueError('Authenticator manager/solver mismatch')
    sr = sender.send('settlement', lambda: build(w3.eth.contract(abi=set_abi, bytecode=set_bin).constructor(
        auth, '0x0000000000000000000000000000000000000000')))
    settlement = sr['contractAddress']
    # These pure L2 deployments only require canonical L2 receipts. The
    # eventual cross-chain swap must separately prove its canonical L1 posting.
    out = {"network": CFG['NETWORK'], "l1ChainId": CFG['L1_CHAIN_ID'], "chainId": CHAIN_ID, "rpc": RPC, "deployer": acct.address,
           "authenticator": auth, "settlement": settlement,
           "deploymentIdentity": deployment_identity,
           "vaultRelayer": w3.eth.contract(settlement, abi=set_abi).functions.vaultRelayer().call(),
           "deploymentTxs": {name: row['hash'] for name, row in sender.journal.data['transactions'].items()}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if CFG.deployment_identity(w3) != deployment_identity:
        raise ValueError('Network identity changed during deployment; manifest not published')
    atomic_json(OUT, out)
    print(json.dumps(out, indent=2))

if __name__ == "__main__": main()
