import test from'node:test';import assert from'node:assert/strict';
import{savedNetwork,savedNetworkKey}from'../src/lib/treasury/savedNetwork.ts';import{reloadFixture}from'./fixtures/treasury-reload.mjs';
function fixture(){const f=reloadFixture(),map=new Map(f.entries),storage={getItem:key=>map.get(key)??null};return{...f,map,storage,load:()=>savedNetwork(storage,f.cacheKey,f.config.payments.bridgeL1,f.config.payments.bridgeL2,f.config.payments.tokenL1,f.target)};}
test('completed matching setup restores network selection without caching balances, owners or nonce',()=>{const f=fixture();assert.deepEqual(f.load(),f.network);assert(!f.map.get(f.cacheKey).includes('balance'));});
test('stale, malformed, incomplete and restarted setups cannot use the reload hint',()=>{
 for(const edit of [f=>f.map.set(f.cacheKey,'bad JSON'),f=>f.map.set(f.key,''),f=>f.map.set(f.key,JSON.stringify({...f.state,completed:[]})),f=>f.map.set(f.key+':manifest',JSON.stringify({...f.config,instance:'0x'+'11'.repeat(32)}))]){const f=fixture();edit(f);assert.equal(f.load(),null);}
});
test('network, endpoint and token changes isolate saved selection hints',()=>{
 const f=fixture(),p=f.config.payments;
 assert.notEqual(savedNetworkKey({...f.target,l1:{...f.target.l1,rpc:'https://different.example'}},p.bridgeL1,p.bridgeL2,p.tokenL1),f.cacheKey);
 assert.equal(savedNetwork(f.storage,f.cacheKey,p.bridgeL1,p.bridgeL2,p.tokenL2,f.target),null);
 f.map.set(f.cacheKey,JSON.stringify({...f.network,manager:f.config.safeL1}));assert.equal(f.load(),null);
});

test('a copied cache record cannot redirect RPC or Composer reads',()=>{
 const f=fixture();f.map.set(f.key+':manifest',JSON.stringify({...f.config,l2:{...f.config.l2,front:'https://unexpected.example'}}));assert.equal(f.load(),null);
});
