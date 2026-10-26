import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { pairedSetupKey, pairedSetupSnapshot, pairedSetupTransactions, restartPairedSetup } from '../src/lib/treasury/pairedSetupState.ts';
import { setupIdentity, loadMainnetManifest } from '../src/lib/treasury/mainnetSetup.ts';
import { safeFaucetKey, readSafeFaucetClaim } from '../src/lib/treasury/safeFaucet.ts';
const a = n => toHex(n, { size: 20 }), h = n => toHex(n, { size: 32 });
const network = JSON.parse(readFileSync('src/lib/treasury/mainnet-network.json'));
function fixture() {
  const state = { version:3,build:'ab'.repeat(32),identity:setupIdentity(network),salt:h(1),deployer:a(2),addresses:{safeL1:a(3),safeL2:a(4)},code:[],
    sourceRequests:[{build:'ab'.repeat(32),chainId:1337,transactionHash:h(20)}],
    completed:Array.from({length:6},(_,i)=>({chain:['l1','l2','l2','l1','l1','l1'][i],hash:h(20+i),number:toHex(i+1),blockHash:h(40+i)})) };
  const manifest = { version:1,environment:'isolated-devnet',instance:keccak256(toHex(`${state.salt}:${a(3)}:${a(4)}`)),
    l1:{chainId:1337,rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1',genesis:h(2)},l2:{chainId:1338,rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2',genesis:h(3)},
    safeL1:a(3),safeL2:a(4),adapter:a(5),registry:a(6),manager:a(7),ownerLabels:{},
    code:['l1','l2'].flatMap(chain=>Array.from({length:20},(_,i)=>({chain,address:a(i+2),hash:h(i+2)}))),
    payments:{version:2,bridgeKind:'standard',policy:a(8),alias:a(9),tokenL1:a(10),tokenL2:a(11),pair:{version:1,policyL1:a(12),peerProxyL2:a(13)},safeL2Alias:a(14),moduleL1:a(15),moduleL2:a(16),bridgeL1:a(17),bridgeL2:a(18),recipient:a(19),decimals:6,period:600,globalLimit:'150000000',assetLabel:'Devnet USDC'} };
  const key=pairedSetupKey(network),map=new Map([[key,JSON.stringify(state)],[key+':manifest',JSON.stringify(manifest)],['unrelated','preserved']]);
  return {state,manifest,key,map,storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)}};
}
test('restart archives the complete paired setup and source requests before selecting the chooser',()=>{
 const f=fixture(),snapshot=pairedSetupSnapshot(f.storage,network);assert(snapshot.manifest);
 restartPairedSetup(f.storage,network,snapshot);
 assert.equal(f.map.get(f.key),'');assert.equal(loadMainnetManifest(f.storage,network),null);
 const archive=JSON.parse(f.map.get(`${f.key}:archive:${f.state.salt}`));assert.deepEqual(archive.state,f.state);assert.deepEqual(archive.manifest,f.manifest);assert.deepEqual(archive.sourceRequests,f.state.sourceRequests);
 assert.equal(f.map.get('unrelated'),'preserved');assert(f.map.has(f.key+':manifest'));
});
test('pending payments, owner changes and either faucet destination block restart',()=>{
 for(const keyOf of [c=>`eez:treasury:submission:${c.instance}`,c=>`eez:treasury:owners:${c.instance}`,c=>safeFaucetKey(c,'l1'),c=>safeFaucetKey(c,'l2')]){
  const f=fixture(),before=f.map.get(f.key),snapshot=pairedSetupSnapshot(f.storage,network),key=keyOf(f.manifest);
  const kind=key.endsWith(':l2')?'l2':'l1';
  const pending={id:kind,kind,chain:'l1',sender:a(2),nonce:'0x0',data:'0x1234',recipient:kind==='l1'?a(3):a(4),token:a(10),to:a(10),build:'ab'.repeat(32),l2StartBlock:'0x0'};
  f.map.set(key,key.includes('safe-faucet')?JSON.stringify({token:a(10),pending}):'pending');
  assert.throws(()=>restartPairedSetup(f.storage,network,snapshot),/pending|Finish|faucet/);assert.equal(f.map.get(f.key),before);
 }
});
test('restart refuses a changed selection or pending setup, and a failed selection write preserves the old journal',()=>{
 const f=fixture(),snapshot=pairedSetupSnapshot(f.storage,network),before=f.map.get(f.key);
 f.map.set(f.key,JSON.stringify({...f.state,salt:h(99)}));assert.throws(()=>restartPairedSetup(f.storage,network,snapshot),/changed/);
 f.map.set(f.key,JSON.stringify({...f.state,completed:[],pending:{id:'0',chain:'l1',sender:a(2),nonce:'0x0',data:'0x1234',outputs:[]}}));
 assert.throws(()=>restartPairedSetup(f.storage,network,pairedSetupSnapshot(f.storage,network)),/pending setup/);
 f.map.set(f.key,before);assert.throws(()=>restartPairedSetup({...f.storage,setItem:(k,v)=>{if(k===f.key)throw Error('Storage full');f.map.set(k,v);}},network,snapshot),/Storage full/);assert.equal(f.map.get(f.key),before);
});
test('history preserves exact chain and inclusion identities and independent faucet journals remain recoverable',()=>{
 const f=fixture(),rows=pairedSetupTransactions(f.storage,network);assert.equal(rows.length,6);assert.equal(rows[5].chain,'l1');assert.equal(rows[5].inclusion.blockHash,h(45));
 for(const chain of ['l1','l2']){
  const journal={token:a(10),pending:{id:chain,kind:chain,chain:'l1',sender:a(2),nonce:chain==='l1'?'0x0':'0x1',data:'0x1234',recipient:chain==='l1'?a(3):a(4),token:a(10),to:a(10),build:'ab'.repeat(32),l2StartBlock:'0x0'}};
  f.map.set(safeFaucetKey(f.manifest,chain),JSON.stringify(journal));assert.deepEqual(readSafeFaucetClaim(f.manifest,f.storage,chain),journal);
 }
 const legacy=fixture();legacy.map.set(safeFaucetKey(legacy.manifest),f.map.get(safeFaucetKey(f.manifest,'l2')));
 assert(readSafeFaucetClaim(legacy.manifest,legacy.storage,'l2').pending);assert(!readSafeFaucetClaim(legacy.manifest,legacy.storage,'l1').pending);
});
