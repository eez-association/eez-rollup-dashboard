import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryClient } from '../src/lib/treasury/client.ts';
import { buildSafeTransaction } from '../src/lib/treasury/safeTransactions.ts';

const owner=privateKeyToAccount(toHex(42n,{size:32}));
const other=privateKeyToAccount(toHex(43n,{size:32}));
const c={environment:'dashboard-testnet',l1:{chainId:10200},l2:{chainId:699069},safeL1:toHex(1n,{size:20}),safeL2:toHex(2n,{size:20})};
function fixture(source='l2',change) {
  const client=new TreasuryClient(c),calls=[];
  client.rpc=async()=>assert.fail('Signing must not fetch balances, Safe state or Composer data');
  client.validate=async()=>assert.fail('Signing must not repeat the testnet network audit');
  const tx=buildSafeTransaction({chainId:BigInt(c[source].chainId),safe:source==='l1'?c.safeL1:c.safeL2,to:toHex(3n,{size:20}),nonce:7n,data:'0x1234'});
  const snapshot={source,owners:[owner.address],threshold:1,nonce:7n};
  let signed=false;
  const provider={request:async({method,params})=>{
    calls.push(method);
    if(method==='eth_accounts')return [signed&&change==='account'?other.address:owner.address];
    if(method==='eth_chainId')return toHex(signed&&change==='chain'?1:c[source].chainId);
    assert.equal(method,'eth_signTypedData_v4');signed=true;
    if(change==='cancel')throw Object.assign(Error('User rejected signature'),{code:4001});
    return (change==='signature'?other:owner).signTypedData(JSON.parse(params[1]));
  }};
  return {client,tx,snapshot,provider,calls};
}

test('both Safe domains collect a real signature with only wallet identity reads',async()=>{
  for(const source of ['l1','l2']) {
    const f=fixture(source),approval=await f.client.approve(f.provider,f.tx,f.snapshot,owner.address);
    assert.equal(approval.owner,owner.address);
    assert.deepEqual(f.calls,['eth_accounts','eth_chainId','eth_signTypedData_v4','eth_accounts','eth_chainId']);
  }
});

test('lightweight signing still rejects changed wallets, wrong signatures and cancellation',async()=>{
  for(const change of ['account','chain','signature','cancel']) {
    const f=fixture('l2',change);
    await assert.rejects(f.client.approve(f.provider,f.tx,f.snapshot,owner.address));
    assert.equal(f.calls.filter(method=>method==='eth_signTypedData_v4').length,1);
  }
  for(const change of [{nonce:8n},{source:'l1'}]) {
    const f=fixture();
    await assert.rejects(f.client.approve(f.provider,f.tx,{...f.snapshot,...change},owner.address),/snapshot does not match/);
    assert.deepEqual(f.calls,[]);
  }
});

test('submission still rejects a changed Safe nonce before opening the wallet',async()=>{
  const f=fixture();f.client.validate=async()=>{};
  f.client.snapshot=async()=>({...f.snapshot,nonce:8n});
  await assert.rejects(f.client.prepare(f.provider,f.tx,f.snapshot,[]),/Owners or Safe nonce changed/);
  assert.deepEqual(f.calls,[]);
});
