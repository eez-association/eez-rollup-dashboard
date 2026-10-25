import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeDeployData, decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, getAddress, getContractAddress, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { MainnetSetup, mainnetSetupKey, mainnetManifestKey, mainnetSetupSteps, readMainnetSetup, isMainnetSetupTarget, loadMainnetManifest } from '../src/lib/treasury/mainnetSetup.ts';
import { sharedDeploymentKey, sharedManifestKey } from '../src/lib/treasury/deployment.ts';
const json=path=>JSON.parse(readFileSync(path));
const base=json('src/lib/treasury/deployment-artifacts.json'),current=json('src/lib/treasury/mainnet-artifacts.json'),network=json('src/lib/treasury/mainnet-network.json');
const shared=json('src/lib/treasury/mainnet-shared-contracts.json'),release=json(`src/lib/treasury/builds/${json('src/lib/treasury/current-build.json').build}.json`);
const artifacts={...release,contracts:{...base.contracts,...current.contracts,...release.contracts}},addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const target={l1:{rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1',explorer:'https://etherscan.io'},l2:{rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2',explorer:'https://explorer.eez.dev'},fees:{l1:'1',l2:'1'}};
function fixture(selectedArtifacts=artifacts){
 const sharedCode={ [shared.contracts.moduleL1.address.toLowerCase()]:release.contracts.AllowanceModule.runtime };
 for(const b of Object.values(shared.contracts))assert.equal(keccak256(sharedCode[b.address.toLowerCase()]),b.hash);
 const engine=new MainnetSetup(target,selectedArtifacts),safe=addr(100),singleton=addr(101),deployer=addr(200),block={number:'0xa',hash:zeroHash};
 engine.validate=async()=>{};
 engine.io.rpc=async(chain,method,params)=>{
  if(method==='eth_getBlockByNumber')return block;
  if(method==='eth_chainId')return toHex(network.chains[chain].chainId);
  if(method==='eth_getLogs')return [];
  if(method==='eth_getStorageAt')return params[1]==='0x0'?toHex(BigInt(singleton),{size:32}):zeroHash;
  if(method==='eth_getCode')return params[0]===safe?artifacts.contracts.SafeProxy.runtime:params[0]===singleton?artifacts.contracts.Safe.runtime:sharedCode[params[0].toLowerCase()]??'0x';
  if(method==='eth_getTransactionCount')return '0x4';
  throw Error(method);
 };
 engine.io.read=async(chain,address,name,method)=>({VERSION:'1.4.1',getOwners:[deployer],getThreshold:1n,nonce:0n,getModulesPaginated:[[],addr(1)],sequence:1n,owner:deployer,closed:false,registry:network.registry,isModuleEnabled:false,proxyCreationCode:artifacts.contracts.SafeProxyFactory.proxyCreationCode}[method]);
 return {engine,safe,singleton,deployer};
}
test('mainnet eligibility uses the selected network, not a treasury Safe or wallet',()=>{
 assert.equal(isMainnetSetupTarget('0x1','0xaa29e',network.registry,network.manager,network.contracts.bridgeL1.address,network.contracts.bridgeL2.address),true);
 assert.equal(isMainnetSetupTarget('0x27d8','0xdd6d9',network.registry,network.manager,network.contracts.bridgeL1.address,network.contracts.bridgeL2.address),false);
 assert.equal(isMainnetSetupTarget('0x1','0xaa29e',network.registry,network.manager,addr(9),network.contracts.bridgeL2.address),false);
 assert.notEqual(mainnetSetupKey,sharedDeploymentKey);assert.notEqual(mainnetManifestKey,sharedManifestKey);
});
test('selection preserves the entered Safe, its owner threshold and a different deployer',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(addr(201),safe);
 assert.equal(s.addresses.safeL1,safe);assert.equal(s.deployer,addr(201));assert.notEqual(s.deployer,deployer);
 assert.equal(s.completed.length,0);assert.equal(s.addresses.safeL2,undefined);assert.equal(s.code.length,3);
 assert.equal(s.version,3);
 assert.deepEqual(readMainnetSetup(JSON.stringify(s)),s);
 assert.throws(()=>readMainnetSetup(JSON.stringify({...s,identity:zeroHash})),/Invalid Ethereum setup/);
});
test('Ethereum preparation deploys bounded authority without creating, funding or minting a Safe',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe),batch=await engine.batch(s,'0x4');
 const artifact=artifacts.contracts.TreasuryBootstrap;
 const [actions]=decodeAbiParameters(artifact.abi.find(x=>x.type==='constructor').inputs,`0x${batch.data.slice(artifact.bytecode.length)}`);
 assert.equal(actions.length,2);assert(actions.every(x=>x.create));
 assert.deepEqual(batch.outputs.map(x=>x.key),['bootstrapL1','multiSendL1','policyL1']);
 const funding=actions.at(-1),a=artifacts.contracts.PairedTreasuryPolicy;
 const args=decodeAbiParameters(a.abi.find(x=>x.type==='constructor').inputs,`0x${funding.data.slice(a.bytecode.length)}`);
 assert.equal(args[0].toLowerCase(),safe.toLowerCase());assert.equal(args[1].toLowerCase(),shared.contracts.moduleL1.address.toLowerCase());assert.equal(args[2].toLowerCase(),network.contracts.usdcProxy.address.toLowerCase());
 assert.equal(args[3].toLowerCase(),network.contracts.bridgeL1.address.toLowerCase());assert.equal(args[4],1n);
 assert.equal(batch.executor,getContractAddress({from:deployer,nonce:4n}));assert((batch.data.length-2)/2<49152);
});
test('new mirror creation and policy deployment fit separate EVM batches without replacing the bridge',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 const prep=await engine.batch(s,'0x4');for(const o of prep.outputs)s.addresses[o.key]=o.address;s.completed=[{hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}];
 const mirror=await engine.batch(s,'0x4');assert((mirror.data.length-2)/2<49152);
 assert(mirror.outputs.some(x=>x.key==='safeL2'));assert(!mirror.outputs.some(x=>/bridge|token/i.test(x.key)));
 for(const o of mirror.outputs)s.addresses[o.key]=o.address;s.completed.push({hash:zeroHash,chain:'l2',number:'0xa',blockHash:zeroHash});
 const budget=await engine.batch(s,'0x5');assert.equal(budget.to,s.addresses.bootstrapL2);assert.equal(budget.closed,true);
 const decoded=decodeFunctionData({abi:artifacts.contracts.TreasuryBootstrap.abi,data:budget.data});
 assert.equal(decoded.functionName,'execute');assert.equal(decoded.args[1].length,2);
 assert.deepEqual(budget.outputs.map(x=>x.key),['moduleL2','policy']);
 const policy=decoded.args[1][1],a=artifacts.contracts.PairedTreasuryPolicy;
 const args=decodeAbiParameters(a.abi.find(x=>x.type==='constructor').inputs,`0x${policy.data.slice(a.bytecode.length)}`);
 assert.equal(args[0].toLowerCase(),s.addresses.safeL2.toLowerCase());assert.equal(args.length,5);assert.equal(args[3].toLowerCase(),network.contracts.bridgeL2.address.toLowerCase());assert.equal(args[4],BigInt(network.rollupId));
});
test('pending and incomplete mainnet setup cannot select the Chiado manifest',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 const entries=new Map([[sharedManifestKey,'must never be parsed'],[mainnetSetupKey,JSON.stringify(s)]]);
 assert.equal(loadMainnetManifest({getItem:k=>entries.get(k)??null}),null);
 assert.equal(mainnetSetupSteps.length,6);assert.equal(mainnetSetupSteps[5].chain,'l1');
});
test('setup confirmation rejects a different replacement transaction',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 s.pending={id:'0',chain:'l1',sender:deployer,nonce:'0x1',data:'0x1234',hash:zeroHash,outputs:[]};
 engine.io.trackPending=async s=>s;
 engine.io.rpc=async(chain,method)=>method==='eth_getTransactionReceipt'?{status:'0x1',blockNumber:'0xa',blockHash:zeroHash,logs:[]}:
   method==='eth_getTransactionByHash'?{from:deployer,to:null,input:'0x5678',nonce:'0x1',value:'0x0'}:{hash:zeroHash};
 await assert.rejects(engine.reconcile(s),/replaced with different work/);
 assert.equal(s.completed.length,0);
});


test('new Ethereum treasuries reuse the same verified helpers across wallets and Safes',async()=>{
 const {engine,safe}=fixture(),first=await engine.configure(addr(201),safe),otherSafe=addr(103),rpc=engine.io.rpc;
 engine.io.rpc=(chain,method,params)=>rpc(chain,method,method==='eth_getCode'&&params[0]===otherSafe?[safe,...params.slice(1)]:params);
 const second=await engine.configure(addr(202),otherSafe);
 assert.equal(first.addresses.safeL1,safe);assert.equal(second.addresses.safeL1,otherSafe);
 for(const s of [first,second])for(const [key,binding] of Object.entries(shared.contracts)){
  assert.equal(s.addresses[key],binding.address);
  assert(s.code.some(b=>b.chain==='l1'&&b.address===binding.address&&b.hash===binding.hash));
 }
 assert.notEqual(first.salt,second.salt);
 assert.equal(mainnetSetupKey,`eez:treasury:paired-setup:${keccak256(toHex(JSON.stringify(network)))}`);
});

test('shared helper inspection rejects missing or changed code, RPC uncertainty and reorgs',async()=>{
 for(const key of Object.keys(shared.contracts))for(const changed of ['0x','0x6000']){
  const {engine,safe,deployer}=fixture(),rpc=engine.io.rpc;
  engine.io.rpc=(chain,method,params)=>method==='eth_getCode'&&params[0].toLowerCase()===shared.contracts[key].address.toLowerCase()?changed:rpc(chain,method,params);
  await assert.rejects(engine.configure(deployer,safe),/Shared Ethereum .* code/);
 }

 {
  const {engine,safe,deployer}=fixture(),rpc=engine.io.rpc;
  engine.io.rpc=(chain,method,params)=>{if(method==='eth_getCode'&&params[0]===shared.contracts.moduleL1.address)throw Error('RPC unavailable');return rpc(chain,method,params);};
  await assert.rejects(engine.configure(deployer,safe),/RPC unavailable/);
 }
 {
  const {engine,safe,deployer}=fixture(),rpc=engine.io.rpc;let helpersRead=false;
  engine.io.rpc=(chain,method,params)=>{
   if(method==='eth_getCode'&&params[0]===shared.contracts.moduleL1.address)helpersRead=true;
   if(helpersRead&&method==='eth_getBlockByNumber'&&params[0]!=='latest')return {number:'0xa',hash:`0x${'ff'.repeat(32)}`};
   return rpc(chain,method,params);
  };
  await assert.rejects(engine.configure(deployer,safe),/Shared Ethereum contracts changed/);
 }
});

function safeBatchCalls(tx){
 const packed=decodeFunctionData({abi:artifacts.contracts.MultiSendCallOnly.abi,data:tx.message.data}).args[0].slice(2),calls=[];
 for(let start=0;start<packed.length;){
  const length=Number(BigInt('0x'+packed.slice(start+106,start+170)))*2;
  calls.push({to:getAddress('0x'+packed.slice(start+2,start+42)),data:'0x'+packed.slice(start+170,start+170+length)});start+=170+length;
 }
 return calls;
}
test('paired Safe approvals skip module enablement only when already enabled',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 Object.assign(s.addresses,{moduleL1:shared.contracts.moduleL1.address,policyL1:addr(301),policy:addr(302),multiSendL1:addr(303)});
 s.completed=Array.from({length:4},()=>({hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}));
 engine.unchanged=async()=>{};
 const read=engine.io.read;let enabled=false;
 engine.io.read=(chain,address,name,method)=>method==='isModuleEnabled'?enabled:read(chain,address,name,method);
 const initial=await engine.review(s),before=safeBatchCalls(engine.tx(s,initial));
 assert.equal(before.length,4);
 assert.equal(decodeFunctionData({abi:artifacts.contracts.Safe.abi,data:before[1].data}).functionName,'enableModule');
 const legacy={...initial};delete legacy.moduleEnabled;assert.deepEqual(engine.tx(s,initial),engine.tx(s,legacy));
 s.review=initial;enabled=true;
 await assert.rejects(engine.currentReview(s),/Owners, threshold, Safe nonce or module configuration changed/);
 const current=await engine.review(s),after=safeBatchCalls(engine.tx(s,current));
 assert.equal(current.moduleEnabled,true);assert.deepEqual(after,before.filter((_,i)=>i!==1));
 assert.notEqual(current.hash,initial.hash);s.review=current;
 assert.deepEqual(await engine.currentReview(s),current);
 assert.throws(()=>readMainnetSetup(JSON.stringify({...s,review:{...current,moduleEnabled:'true'}})),/Invalid setup approvals/);
});

test('a first wallet prepares shared EEZ-X contracts; another wallet reuses the same exact deployments',async()=>{
 const {engine,safe,deployer}=fixture(),first=await engine.configure(deployer,safe);
 const prep=await engine.batch(first,'0x4');for(const o of prep.outputs)first.addresses[o.key]=o.address;
 first.completed=[{hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}];
 const mirror=await engine.batch(first,'0x4');for(const o of mirror.outputs)first.addresses[o.key]=o.address;
 first.completed.push({hash:zeroHash,chain:'l2',number:'0xa',blockHash:zeroHash});
 const beforeBudget=engine.io.rpc;
 engine.io.rpc=(chain,method,params)=>method==='eth_getTransactionCount'?'0x5':beforeBudget(chain,method,params);
 const budget=await engine.batch(first,'0x5');
 const keys=['singletonL2','factoryL2','multiSendL2','moduleL2','adapter'],outputs=[...mirror.outputs,...budget.outputs].filter(o=>keys.includes(o.key));
 assert.equal(outputs.length,5);
 const abi=parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)']);
 const logs=outputs.map((o,i)=>({topics:encodeEventTopics({abi,eventName:'Created',args:{index:BigInt(i),target:o.address}}),
  data:encodeAbiParameters([{type:'bytes32'}],[keccak256(o.key==='adapter' ? encodeDeployData({abi:artifacts.contracts.L1Owners.abi,bytecode:artifacts.contracts.L1Owners.bytecode,args:[network.manager,safe]}) : artifacts.contracts[o.artifact].bytecode)])}));
 const rpc=engine.io.rpc;
 engine.io.rpc=(chain,method,params)=>{
  if(chain==='l2'&&method==='eth_getBlockByNumber')return {number:network.chains.l2.number,hash:zeroHash};
  if(chain==='l2'&&method==='eth_getLogs')return logs;
  if(chain==='l2'&&method==='eth_getCode'){
   if(params[0]===addr(800))return '0x6000';
   const o=outputs.find(o=>o.address.toLowerCase()===params[0].toLowerCase());if(o)return artifacts.contracts[o.artifact].runtime;
  }
  return rpc(chain,method,params);
 };
 const originalRead=engine.io.read;
 engine.io.read=(chain,address,name,method,args,tag)=>name==='L1Owners'||name==='Registry'
  ? ({safeL1:safe,manager:network.manager,safeL1Proxy:addr(800),computeCrossChainProxyAddress:addr(800),authorizedProxies:[true,safe,0n]})[method]
  : originalRead(chain,address,name,method,args,tag);
 const second=await engine.configure(addr(201),safe);
 for(const o of outputs)assert.equal(second.addresses[o.key],getAddress(o.address));
 const secondPrep=await engine.batch(second,'0x9');for(const o of secondPrep.outputs)second.addresses[o.key]=o.address;
 second.completed=[{hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}];
 const secondMirror=await engine.batch(second,'0x9');
 assert(!secondMirror.outputs.some(o=>keys.includes(o.key)));
 for(const o of secondMirror.outputs)second.addresses[o.key]=o.address;
 second.completed.push({hash:zeroHash,chain:'l2',number:'0xa',blockHash:zeroHash});
 const read=engine.io.read;
 engine.io.read=(chain,address,name,method,args)=>method==='owner'?second.deployer:read(chain,address,name,method,args);
 const secondBudget=await engine.batch(second,'0xa');assert.deepEqual(secondBudget.outputs.map(o=>o.key),['policy']);
 assert.notEqual(second.addresses.safeL2,first.addresses.safeL2);
 assert.equal(second.addresses.aliasReaderL1,undefined);
});
