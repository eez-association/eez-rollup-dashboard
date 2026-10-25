import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getAddress, getContractAddress, keccak256, toHex, encodeFunctionData, encodeDeployData } from 'viem';
import { TreasuryDeployment, deploymentIdentity, readDeployment, saveDeployment, sharedDeploymentKey } from '../src/lib/treasury/deployment.ts';
import { materializeGroup, encodeGroup } from '../src/lib/treasury/deploymentGroups.ts';
import saved from './fixtures/treasury-saved-setups.json' with { type: 'json' };
const legacy = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const { build } = ({build:'026c1f779c5c3bed2cc56f91707bb7b9eca67c240ef7cfd47ca83017cb868df1'});
const artifacts = {...legacy,...JSON.parse(readFileSync(`src/lib/treasury/builds/${build}.json`)), contracts:{...legacy.contracts,...JSON.parse(readFileSync(`src/lib/treasury/builds/${build}.json`)).contracts}};
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const target = { l1:{rpc:'http://localhost/l1',front:'http://localhost/l1'}, l2:{rpc:'http://localhost/l2',front:'http://localhost/l2'},fees:{l1:'1',l2:'1'}};
function fixture() {
 const d = new TreasuryDeployment(target,artifacts);
 const assetBinding = {tokenL1:address(100),tokenL2:address(101),bridgeL1:address(102),bridgeL2:address(103),tokenCodeHash:hash('token')};
 const addresses={safeL1:address(120),singletonL1:address(121),...Object.fromEntries(['tokenL1','tokenL2','bridgeL1','bridgeL2'].map(k=>[k,assetBinding[k]]))};
 const state={version:11,build,identity:deploymentIdentity,deployer:address(99),salt:hash('direct'),reuse:{l1:{address:addresses.safeL1,singleton:addresses.singletonL1,owners:[address(99)],threshold:1,proxyHash:hash('proxy'),singletonHash:hash('singleton')}},addresses,assetBinding,plan:{addresses:{...addresses},official:{}},completed:[],transactions:[]};
 return {d,state};
}
test('current setup is one stable plan without token deployment, funding or migration records',()=>{
 const {d,state}=fixture(),plan=d.steps(state),actions=plan.flatMap(s=>[...(s.group?.actions??[]),...(s.batch??[])]);
 assert.deepEqual(plan.map(s=>s.id),['contractsBatchL1','contractsBatchL2','fundingBatchL1','budgetBatchL2','configureL1']);
 assert(!actions.some(s=>['tokenL1','bridgeL1','bridgeL2','safeL1'].includes(s.output)));
 assert(!actions.some(s=>['transfer','transferFrom','approve','claim','registerBridges'].includes(s.method)));
 assert(!state.grouping&&!state.asset&&!state.fundingSkipped);
 assert.deepEqual(readDeployment(JSON.stringify(state)),state);
 const progressed=structuredClone(state);progressed.addresses.moduleL1=address(555);progressed.completed=[plan[0].id];progressed.transactions=[hash('confirmed')];
 assert.deepEqual(d.steps(readDeployment(JSON.stringify(progressed))).map(s=>s.id),plan.map(s=>s.id));
 assert.deepEqual(d.steps(progressed)[0].group.actions.map(s=>s.id),plan[0].group.actions.map(s=>s.id));
});
test('reused EEZ-X infrastructure is omitted and an existing Safe still requires its current quorum to adopt owners',()=>{
 const {d,state}=fixture();
 for(const key of ['singletonL2','factoryL2','multiSendL2','moduleL2','adapter','safeL2'])state.addresses[key]=state.plan.addresses[key]=address(200+Object.keys(state.plan.addresses).length);
 state.reuse.l2={address:state.addresses.safeL2,singleton:state.addresses.singletonL2};
 const steps=d.steps(state),actions=steps.flatMap(s=>s.group?.actions??[]);
 assert.equal(steps.filter(s=>s.migration).length,1);
 assert(!actions.some(s=>['singletonL2','factoryL2','multiSendL2','moduleL2','adapter','safeL2'].includes(s.output)));
 state.reuse.l2.adapter={address:state.addresses.adapter};assert(!d.steps(state).some(s=>s.migration));
});
test('occupied CREATE addresses are planned before signing and pending work cannot change that plan',async()=>{
 const {d,state}=fixture(),occupied=[0n,1n].map(nonce=>getContractAddress({from:state.deployer,nonce}).toLowerCase());
 d.rpc=async(_c,m,p)=>m==='eth_getCode'&&occupied.includes(p[0].toLowerCase())?'0x6000':m==='eth_getCode'?'0x':'0x0';
 const prepared=await d.prepareWallet(state);assert.equal(prepared.plan.walletPreparation.calls,2);
 assert.deepEqual(d.steps(prepared).slice(1,3).map(s=>s.id),['prepareWalletL2_0','prepareWalletL2_1']);
 assert.deepEqual(readDeployment(JSON.stringify(prepared)),prepared);
 assert.equal(await d.prepareWallet(prepared),prepared);
 const pending={...state,pending:{id:'contractsBatchL2'}};assert.equal(await d.prepareWallet(pending),pending);
 d.rpc=async(_c,m)=>m==='eth_getCode'?'0x6000':'0x0';await assert.rejects(d.prepareWallet(state),/More than two/);
});
test('saving a current plan preserves imports and fails closed on quota errors or another tab changing it',()=>{
 const {state}=fixture(),raw=JSON.stringify(state),map=new Map([[sharedDeploymentKey,raw]]);
 const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 for(const alter of [s=>s.addresses.safeL1=address(999),s=>s.plan.addresses.safeL1=address(999),s=>s.assetBinding.tokenL1=address(999),s=>s.plan.walletPreparation={nonce:'0',calls:1}]){
  const bad=structuredClone(state);alter(bad);assert.throws(()=>saveDeployment(storage,bad));assert.equal(map.get(sharedDeploymentKey),raw);
 }
 assert.throws(()=>saveDeployment({...storage,setItem:()=>{throw Error('quota');}},state),/quota/);assert.equal(map.get(sharedDeploymentKey),raw);
});
test('only an explicit wallet rejection can clear the exact unhashed pending request',()=>{
 const {state}=fixture(),pending={id:'contractsBatchL1',chain:'l1',sender:state.deployer,nonce:'0x5',data:'0x1234'};
 const map=new Map([[sharedDeploymentKey,JSON.stringify({...state,pending})]]);
 const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 const original=map.get(sharedDeploymentKey);
 assert.throws(()=>saveDeployment(storage,state),/pending wallet request/);
 assert.throws(()=>saveDeployment(storage,state,{...pending,data:'0x5678'}));
 assert.equal(map.get(sharedDeploymentKey),original);
 saveDeployment(storage,state,pending);
 assert.equal(map.get(sharedDeploymentKey),JSON.stringify(state));
 const submitted={...pending,hash:hash('submitted')};map.set(sharedDeploymentKey,JSON.stringify({...state,pending:submitted}));
 assert.throws(()=>saveDeployment(storage,state,submitted));
 assert.throws(()=>saveDeployment(storage,{...state,pending}));
 assert.equal(JSON.parse(map.get(sharedDeploymentKey)).pending.hash,submitted.hash);
 saveDeployment(storage,{...state,pending:{...submitted,hash:hash('replacement')}});
 assert.equal(JSON.parse(map.get(sharedDeploymentKey)).pending.hash,hash('replacement'));
});
test('saved setups retain the pre-refactor plan and calldata after reload',async()=>{
 for(const key of ['v3','v4','v6','v8','v9','v10']){
  const state=structuredClone(saved[key]);
  const bundle=state.build?JSON.parse(readFileSync(`src/lib/treasury/builds/${state.build}.json`)):legacy;
  const d=new TreasuryDeployment(target,{...bundle,contracts:{...legacy.contracts,...bundle.contracts}});
  let plan=d.steps(state);
  assert.deepEqual(plan.map(step=>step.id),saved.expected[key].order);
  const groupIndex=plan.findIndex(step=>step.group);
  if(groupIndex>0){
   for(const step of plan.slice(0,groupIndex)) {state.completed.push(step.id);state.transactions.push(hash(step.id));if(step.output)state.addresses[step.output]=address(500+state.completed.length);}
   plan=plan.slice(groupIndex);
  }
  if(plan[0].group){
   const built=await materializeGroup(d,state,plan[0].id,'0x5'),batch=encodeGroup(d,state,built);
   state.pending={id:plan[0].id,chain:plan[0].chain,sender:state.deployer,nonce:'0x5',data:batch.data,group:batch.receipt};
  }else {
   const step=plan[0];
   const data=step.method?encodeFunctionData({abi:d.abi(step.artifact),functionName:step.method,args:step.args()}):encodeDeployData({abi:d.abi(step.artifact),bytecode:d.artifacts.contracts[step.artifact].bytecode,args:step.args()});
   state.pending={id:step.id,chain:step.chain,sender:state.deployer,nonce:'0x5',data};
  }
  // These expected bytes were captured from the pre-refactor planner, not this implementation.
  assert.equal(state.pending.id,saved.expected[key].id);
  assert.equal(keccak256(state.pending.data),saved.expected[key].dataHash);
  assert.deepEqual(state.pending.group,saved.expected[key].group);
  const raw=JSON.stringify(state),loaded=readDeployment(raw);
  assert.equal(JSON.stringify(loaded),raw);assert.deepEqual(d.steps(loaded).slice(loaded.completed.length).map(s=>s.id),plan.map(s=>s.id));
  await assert.rejects(d.prepare(loaded,{}),/pending deployment/);
  assert.equal(JSON.stringify(loaded),raw);
 }
});
