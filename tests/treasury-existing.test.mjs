import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toHex } from 'viem';
import { existingTreasury, TreasurySetupRequired } from '../src/lib/treasury/existingTreasury.ts';
import { DeploymentIO } from '../src/lib/treasury/deploymentIO.ts';
import { MainnetSetup, mainnetSetupStepsFor, readMainnetSetup, setupIdentity } from '../src/lib/treasury/mainnetSetup.ts';
const json = path => JSON.parse(readFileSync(path));
const network = json('src/lib/treasury/mainnet-network.json');
const release = json(`src/lib/treasury/builds/${json('src/lib/treasury/current-build.json').build}.json`);
const address = n => getAddress(toHex(n, {size:20})), hash = n => toHex(n, {size:32});
const target = {l1:{rpc:'l1',front:'l1-front',explorer:'https://etherscan.io'},l2:{rpc:'l2',front:'l2-front',explorer:'https://example.com'},fees:{l1:'1',l2:'1'}};
function fixture() {
  const a = Object.fromEntries(['safeL1','safeL2','singletonL1','singletonL2','adapter','moduleL1','moduleL2','policyL1','policy','alias','safeL2Alias','peerProxyL2'].map((key,i)=>[key,address(i+10)]));
  const l1={address:a.safeL1,singleton:a.singletonL1,proxyHash:hash(1),singletonHash:hash(2),block:'0xa',modules:[a.moduleL1],moreModules:false};
  const l2={address:a.safeL2,singleton:a.singletonL2,proxyHash:hash(1),singletonHash:hash(2),block:'0xb',modules:[a.moduleL2],moreModules:false,
    adapter:{address:a.adapter,safeL1:a.safeL1,manager:network.manager}};
  const state={delegates:[a.policy],next:0,peerSafe:a.safeL1,token:network.contracts.wrappedUSDC.address,reorg:false,fail:false};
  const calls=[], blocks={l1:0,l2:0};
  const codes = new Map([[a.moduleL1,release.contracts.AllowanceModule.runtime],[a.moduleL2,release.contracts.AllowanceModule.runtime],
    [a.policyL1,release.contracts.PairedTreasuryPolicy.runtime],[a.policy,release.contracts.PairedTreasuryPolicy.runtime],
    ...[a.alias,a.safeL2Alias,a.peerProxyL2,a.adapter].map(value=>[value,'0x6000'])]);
  const io = new DeploymentIO(target,release);
  io.rpc=async(chain,method,params)=>{
    calls.push({chain,method,params});
    if(method==='eth_getBlockByNumber') return {hash:state.reorg && ++blocks[chain]>1 ? hash(99) : hash(3)};
    assert.equal(method,'eth_getCode','connection must not send or estimate transactions');
    if(state.fail) throw Error('RPC unavailable');
    assert.equal(params[1],chain==='l1'?l1.block:l2.block);
    return codes.get(params[0])??'0x';
  };
  io.read=async(chain,to,artifact,method,args,tag)=>{
    calls.push({chain,method,args});assert.equal(tag,chain==='l1'?l1.block:l2.block);
    const values={getDelegates:[state.delegates,state.next],configuration:{safe:a.safeL2,peerPolicy:a.policyL1,peerProxy:a.peerProxyL2},
      token:state.token,allowanceModule:chain==='l1'?a.moduleL1:a.moduleL2,peerSafe:state.peerSafe,localAliasOnPeer:a.alias,computeCrossChainProxyAddress:a.safeL2Alias};
    assert(method in values); return values[method];
  };
  return {a,l1,l2,state,codes,calls,io,connect:()=>existingTreasury(io,network,l1,l2)};
}
test('existing treasury discovers installed policies using bounded read-only module queries',async()=>{
  const f=fixture(), found=await f.connect();
  for(const key of Object.keys(found.addresses)) assert.equal(found.addresses[key],f.a[key]);
  assert(found.code.some(b=>b.chain==='l1'&&b.address===f.a.policyL1&&b.hash===keccak256(release.contracts.PairedTreasuryPolicy.runtime)));
  assert(found.code.some(b=>b.chain==='l2'&&b.address===f.a.peerProxyL2));
  assert.equal(f.calls.filter(c=>c.method==='getDelegates').length,1);
  assert(!f.calls.some(c=>/send|estimate|Logs/.test(c.method)));
});
test('unconfigured pairs need explicit setup; unrelated or unreviewed delegates are not imported',async()=>{
  for(const change of [f=>{f.l2.modules=[];},f=>{f.state.delegates=[];},f=>{f.codes.set(f.a.policy,'0x6001');},
    f=>{f.state.peerSafe=address(999);},f=>{f.state.token=address(998);}]) {
    const f=fixture();change(f);await assert.rejects(f.connect,TreasurySetupRequired);
  }
});
test('RPC failures, reorgs, scan bounds and ambiguous pairs never offer automatic setup',async()=>{
  for(const [change,message] of [
    [f=>{f.state.fail=true;},/RPC unavailable/],
    [f=>{f.state.reorg=true;f.state.delegates=[];},/state changed/],
    [f=>{f.l2.moreModules=true;},/too many modules/],
    [f=>{f.state.next=5;},/too many delegates/],
    [f=>{const other=address(900);f.codes.set(other,release.contracts.PairedTreasuryPolicy.runtime);f.state.delegates.push(other);},/Multiple treasury policies/],
    [f=>{f.l2.adapter.safeL1=address(998);},/already connected/],
    [f=>{f.codes.set(f.a.policyL1,'0x6001');},/Unsupported treasury/],
  ]) {
    const f=fixture();change(f);await assert.rejects(f.connect,error=>!(error instanceof TreasurySetupRequired)&&message.test(error.message));
  }
});
test('connection journals have no deployment steps and cannot produce deployment transactions',async()=>{
  const f=fixture(), found=await f.connect();
  const saved={version:4,build:release.build,identity:setupIdentity(network),salt:hash(8),deployer:address(400),...found,completed:[]};
  assert.deepEqual(readMainnetSetup(JSON.stringify(saved)),saved); assert.deepEqual(mainnetSetupStepsFor(saved),[]);
  for(const change of [{completed:[{hash:hash(1),chain:'l1',number:'0x1',blockHash:hash(2)}]}, {creation:'create-both'}, {pending:{}}, {review:{}},
    {addresses:{...saved.addresses,policy:undefined}}]) assert.throws(()=>readMainnetSetup(JSON.stringify({...saved,...change})),/Invalid existing treasury/);
  const engine=new MainnetSetup(target,release);
  await assert.rejects(engine.batch(saved,'0x0'),/original contract release/);
  await assert.rejects(engine.prepare(saved,{request:()=>assert.fail('Unexpected wallet prompt')}),/original contract release/);
});
