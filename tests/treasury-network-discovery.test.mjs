import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, toHex, zeroAddress } from 'viem';
import { discoverInfrastructure, discoverToken, validateDiscoveredNetwork, dashboardNetworkKey, matchingDeployerChecks, assertSameInfrastructure, validateDiscoveredToken } from '../src/lib/treasury/networkDiscovery.ts';
import { MainnetSetup, setupIdentity, readMainnetSetup } from '../src/lib/treasury/mainnetSetup.ts';
import { TreasuryClient } from '../src/lib/treasury/client.ts';
import { treasuryExplorerUrl } from '../src/lib/treasury/mainnet.ts';
import { TestnetAsset } from '../src/lib/treasury/testnetAsset.ts';
import { fixture, dashboard, token, target, owner, address, release } from './fixtures/treasury-discovery.mjs';
import { keccak256 } from 'viem';

test('new selections use a canonical finalized checkpoint when genesis has been pruned', async () => {
  const { io } = fixture(), rpc = io.rpc;
  const calls = [];
  io.rpc = async (chain, method, params = [], ...rest) => {
    calls.push([chain, method, params]);
    if (method === 'eth_getBlockByNumber' && params[0] === '0x0') throw new Error('pruned history unavailable: requested 0');
    return rpc(chain, method, method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? ['0x5', false] : params, ...rest);
  };
  const { network, checks } = await discoverInfrastructure(io, dashboard);
  assert(network, JSON.stringify(checks));
  assert.equal(network.chains.l1.number, '0x5'); assert.equal(network.chains.l2.number, '0x5');
  assert.equal(setupIdentity((await discoverInfrastructure(io, dashboard, network)).network), setupIdentity(network));
  const saved = { ...network, chains: { ...network.chains, l1: { ...network.chains.l1, number: '0x0' } } };
  const before = calls.filter(c => c[2][0] === 'finalized').length;
  const result = await discoverInfrastructure(io, dashboard, saved);
  assert.equal(result.network, undefined); assert.match(result.checks[0].error, /saved treasury was preserved/);
  assert.equal(calls.filter(c => c[2][0] === 'finalized').length, before, 'never silently replace a saved anchor');
});

test('new chain pair uses dashboard addresses, Composer and live bridge rollup; snapshots survive reload', async () => {
  const {io, state} = fixture();
  const result = await discoverInfrastructure(io, dashboard);
  assert(result.network, JSON.stringify(result.checks));
  assert.equal(result.network.rollupId, 77);
  const n = await discoverToken(io, result.network, token);
  assert.equal(n.discovered.symbol, 'EXAMPLE');
  assert.equal(n.discovered.kind, 'erc20');
  assert.equal(state.symbolReads,1);
  state.block++;
  await validateDiscoveredNetwork(io, n);
  assert.equal(state.symbolReads,1,'Reuse the selected symbol during validation');
  assert.equal(setupIdentity((await discoverInfrastructure(io,dashboard,n)).network), setupIdentity(n));
  assert.equal(dashboardNetworkKey(dashboard), dashboardNetworkKey({...dashboard,l1ChainId:toHex(BigInt(dashboard.l1ChainId))}));
  assert.notEqual(dashboardNetworkKey(dashboard), dashboardNetworkKey({...dashboard,bridgeL1:address(900)}));
});
test('missing contracts are reported for both chains; peer and Composer mismatches are rejected', async () => {
  for (const kind of ['missing','wrongPeer','composerMismatch']) {
    const {io,state} = fixture();
    if (kind === 'missing') state.missing = new Set([dashboard.bridgeL1.toLowerCase(),dashboard.manager.toLowerCase()]); else state[kind]=true;
    const result = await discoverInfrastructure(io,dashboard);
    assert.equal(result.network,undefined);
    assert(result.checks.every(c=>c.error),JSON.stringify(result));
  }
});
test('token discovery distinguishes missing bridge registration, unsupported decimals and wrong origin', async () => {
  const {io,state} = fixture(); const {network}=await discoverInfrastructure(io,dashboard);
  state.wrapped=false;
  assert.equal((await discoverToken(io,network,token,false)).contracts.wrappedUSDC.address,zeroAddress);
  await assert.rejects(discoverToken(io,network,token),/not been bridged/);
  state.wrapped=true;state.decimals=18;
  await assert.rejects(discoverToken(io,network,token),/6 decimal/);
  state.decimals=6;state.wrongOrigin=true;
  await assert.rejects(discoverToken(io,network,token),/origin/);
});
test('saved token upgrades and network changes block use instead of silently accepting new hashes', async()=>{
  const {io,state}=fixture();const {network}=await discoverInfrastructure(io,dashboard);
  state.tokenImplementation=address(500);
  const n=await discoverToken(io,network,token);await validateDiscoveredNetwork(io,n);
  state.tokenImplementation=address(501);await assert.rejects(validateDiscoveredNetwork(io,n),/Token code/);
  state.reorg=true;await assert.rejects(validateDiscoveredNetwork(io,n),/reference changed/);
});
test('new Safes retain Arachnid, matching addresses and the original four deployment batches', async()=>{
  const {io}=fixture();const {network}=await discoverInfrastructure(io,dashboard);const n=await discoverToken(io,network,token);
  const engine=new MainnetSetup(target,release,n);engine.io.rpc=io.rpc;
  const s=await engine.configure(owner,undefined,undefined,undefined,{matching:true});
  assert(s.matching);assert.equal(s.addresses.singletonL1,undefined);
  assert.deepEqual(readMainnetSetup(JSON.stringify(s),n),s);
  for(let step=0;step<4;step++) {
    const batch=await engine.batch(s,toHex(step));
    if(step<2)assert((batch.data.length-2)/2<=49152);
    for(const output of batch.outputs)s.addresses[output.key]=output.address;
    if(step===0){assert(batch.outputs.some(o=>o.key==='safeL1'));assert(!batch.outputs.some(o=>o.key==='policyL1'));}
    if(step===3)assert(batch.outputs.some(o=>o.key==='policyL1'));
    s.completed.push({number:'0xa',hash:toHex(step+1,{size:32}),blockHash:toHex(1,{size:32})});
  }
});
test('demo-token deployment uses the discovered bridge and rollup, never the pinned testnet', async()=>{
  const {io}=fixture();const {network}=await discoverInfrastructure(io,dashboard);
  const d=new TestnetAsset(target,release,dashboard.bridgeL1,dashboard.bridgeL2,network);d.rpc=io.rpc;
  const artifact=release.contracts.TestUSDC;
  const data=d.data('deploy',owner);
  const args=decodeAbiParameters(artifact.abi.find(x=>x.type==='constructor').inputs,`0x${data.slice(artifact.bytecode.length)}`);
  assert.equal(args[0].toLowerCase(),dashboard.bridgeL1.toLowerCase());assert.equal(args[1],77n);
  const provider={request:async ({method})=>method==='eth_accounts'?[owner]:method==='eth_chainId'?toHex(BigInt(dashboard.l1ChainId)):assert.fail(method)};
  d.wallet=async()=>owner;
  const prepared=await d.prepare('deploy',undefined,owner,provider);
  assert.equal(prepared.request.data,data);assert.equal(prepared.pending.build,release.build);
  assert.equal(prepared.pending.sender,owner);
  assert.equal(keccak256(prepared.pending.data),keccak256(data));
});

test('configured bridges and tokens do not need a bytecode allowlist',async()=>{
 const {io,state}=fixture();state.unknown=true;
 const {network,checks}=await discoverInfrastructure(io,dashboard);assert(network,JSON.stringify(checks));
 const n=await discoverToken(io,network,token);await validateDiscoveredNetwork(io,n);
});

test('missing Arachnid is identified by chain and blocks new matching Safe setup',async()=>{
 const {io,state}=fixture();state.deployer=false;
 const checks=await matchingDeployerChecks(io);assert.equal(checks.length,2);assert(checks.every(c=>c.error.includes('Deploy Arachnid')));
 const {network}=await discoverInfrastructure(io,dashboard);const n=await discoverToken(io,network,token);
 const engine=new MainnetSetup(target,release,n);engine.io.rpc=io.rpc;
 await assert.rejects(engine.configure(owner,undefined,undefined,undefined,{matching:true}),/Deploy the Arachnid.*on L1/);
 await assert.rejects(engine.configure(owner),/New Safes require matching/);
});


test('new network anchors survive tip reorganizations without changing setup identity', async()=>{
 const {io,state}=fixture();const {network}=await discoverInfrastructure(io,dashboard);
 assert.equal(network.chains.l1.number,'0x0');assert.equal(network.chains.l2.number,'0x0');
 state.tipReorg=true;
 const result=await discoverInfrastructure(io,dashboard,network);
 assert.equal(setupIdentity(result.network),setupIdentity(network));
});

test('manifest completion accepts absent and HTTP explorers for discovered dashboards', async t=>{
 const {io}=fixture();const {network}=await discoverInfrastructure(io,dashboard);const n=await discoverToken(io,network,token);
 const original= TreasuryClient.prototype.validate;
 TreasuryClient.prototype.validate=async()=>{};
 t.after(()=>{TreasuryClient.prototype.validate=original;});
 for(const explorer of ['', 'http://127.0.0.1:4000', 'https://example.com']) {
  const selectedTarget={...target,l1:{...target.l1,explorer},l2:{...target.l2,explorer}};
  const engine=new MainnetSetup(selectedTarget,release,n);engine.io.rpc=io.rpc;
  await engine.validate();
  const addresses=Object.fromEntries(['safeL1','safeL2','singletonL1','singletonL2','adapter','policy','policyL1','moduleL1','moduleL2','alias','safeL2Alias'].map((key,i)=>[key,address(200+i)]));
  const code=Object.entries(addresses).map(([key,a])=>({chain:['safeL1','singletonL1','policyL1','moduleL1','alias','safeL2Alias'].includes(key)?'l1':'l2',address:a,hash:keccak256('0x6000')}));
  engine.unchanged=async()=>{};engine.io.read=async()=>address(400);engine.io.rpc=async()=> '0x6000';
  const manifest=await engine.manifest({version:3,build:release.build,salt:toHex(99,{size:32}),deployer:owner,addresses,code,completed:Array(6).fill({})});
  assert.equal(manifest.l1.explorer,explorer||undefined);assert.equal(manifest.l2.explorer,explorer||undefined);
 }
});

test('invalid explorer URLs fail before setup RPCs or transactions',async()=>{
 for(const explorer of ['javascript:alert(1)','https://user:password@example.com','https://example.com/#fragment','not-a-url']) {
  const engine=new MainnetSetup({...target,l1:{...target.l1,explorer}},release,{discovered:{symbol:'EXAMPLE',kind:'erc20'}});
  engine.io.rpc=async()=>assert.fail('Must reject the explorer before inspecting or deploying contracts');
  await assert.rejects(engine.validate());
 }
 assert.throws(()=>treasuryExplorerUrl('http://127.0.0.1:4000',false),/Invalid treasury explorer/);
});


test('startup reuses one live network check without accepting different saved bindings',async()=>{
 const {io}=fixture();const {network}=await discoverInfrastructure(io,dashboard);const selected=await discoverToken(io,network,token);
 const original=io.rpc;let calls=0,active=0,peak=0;
 io.rpc=async(...args)=>{calls++;active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,1));return await original(...args);}finally{active--;}};
 const observed=await discoverInfrastructure(io,dashboard,network);
 assertSameInfrastructure(selected,observed.network);await validateDiscoveredToken(io,selected);
 assert.equal(calls,43,'One infrastructure pass and one token pass');assert(peak>=8,'Independent reads overlap');
 for(const patch of [n=>n.registry=address(900),n=>n.chains.l1.hash=toHex(99,{size:32}),n=>n.contracts.bridgeL1.address=address(901),n=>n.protocol[0].implementation=address(902)]) {
  const changed=structuredClone(selected);patch(changed);assert.throws(()=>assertSameInfrastructure(changed,observed.network),/Network contracts changed/);
 }
});


test('network rechecks ignore hex casing and object order without rewriting saved identities', async () => {
 const {io}=fixture();const {network}=await discoverInfrastructure(io,dashboard);
 const saved=structuredClone(network);
 const counterpart=address(0xabcdef);
 saved.contracts.bridgeL1.bindings.counterpart=counterpart.toLowerCase();
 const before=JSON.stringify(saved),current=structuredClone(saved);
 current.contracts.bridgeL1.bindings={...current.contracts.bridgeL1.bindings,counterpart};
 current.contracts.bridgeL1=Object.fromEntries(Object.entries(current.contracts.bridgeL1).reverse());
 current.protocol[0].implementationHash='0x'+current.protocol[0].implementationHash.slice(2).toUpperCase();
 assertSameInfrastructure(saved,current);
 assert.equal(JSON.stringify(saved),before,'Comparisons never rekey an existing setup journal');
 for(const patch of [n=>n.contracts.bridgeL1.bindings.counterpart=address(999),n=>n.contracts.bridgeL1.hash=toHex(99,{size:32}),
   n=>n.contracts.bridgeL1.bindings.rollupId='2',n=>n.bridgeImplementations.l1.address=address(999),n=>n.protocol[0].implementationHash=toHex(88,{size:32})]){
  const changed=structuredClone(current);patch(changed);assert.throws(()=>assertSameInfrastructure(saved,changed),/Network contracts changed/);
 }
});
