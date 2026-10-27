import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeDeployData, decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, getAddress, getContractAddress, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { MainnetSetup, mainnetSetupKey, mainnetManifestKey, mainnetSetupSteps, readMainnetSetup, isMainnetSetupTarget, loadMainnetManifest } from '../src/lib/treasury/mainnetSetup.ts';
import { sharedDeploymentKey, sharedManifestKey } from '../src/lib/treasury/deployment.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { ownerFingerprint } from '../src/lib/treasury/safeSetup.ts';
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/lib/treasury/mainnet.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
const json=path=>JSON.parse(readFileSync(path));
const base=json('src/lib/treasury/deployment-artifacts.json'),current=json('src/lib/treasury/mainnet-artifacts.json'),network=json('src/lib/treasury/mainnet-network.json');
const shared=json('src/lib/treasury/mainnet-shared-contracts.json'),release=json(`src/lib/treasury/builds/${json('src/lib/treasury/current-build.json').build}.json`);
const artifacts={...release,contracts:{...base.contracts,...current.contracts,...release.contracts}},addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const target={l1:{rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1',explorer:'https://etherscan.io'},l2:{rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2',explorer:'https://explorer.eez.dev'},fees:{l1:'1',l2:'1'}};
function fixture(selectedArtifacts=artifacts,selectedTarget=target){
 const sharedCode={ [shared.contracts.moduleL1.address.toLowerCase()]:release.contracts.AllowanceModule.runtime };
 for(const b of Object.values(shared.contracts))assert.equal(keccak256(sharedCode[b.address.toLowerCase()]),b.hash);
 const engine=new MainnetSetup(selectedTarget,selectedArtifacts),safe=addr(100),singleton=addr(101),deployer=addr(200),block={number:'0xa',hash:zeroHash};
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

test('setup recovery compares calldata bytes despite RPC hex normalization',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 s.pending={id:'0',chain:'l1',sender:deployer,nonce:'0x1',data:'0xAbCd',hash:zeroHash,outputs:[]};
 engine.io.trackPending=async state=>state;
 let input='0xabcd';
 engine.io.rpc=async(_chain,method)=>method==='eth_getTransactionReceipt'?{status:'0x1',blockNumber:'0xa',blockHash:zeroHash,logs:[]}:
   method==='eth_getTransactionByHash'?{from:deployer,to:null,input,nonce:'0x1',value:'0x0'}:{hash:zeroHash};
 const next=await engine.reconcile(s);assert.equal(next.completed.length,1);assert.equal(next.pending,undefined);
 input='0xabce';await assert.rejects(engine.reconcile(s),/replaced with different work/);
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
 const read=engine.io.read;let enabled=false,ownerReads=0;
 engine.io.read=(chain,address,name,method)=>{if(method==='getOwners')ownerReads++;return method==='isModuleEnabled'?enabled:read(chain,address,name,method);};
 const initial=await engine.review(s),before=safeBatchCalls(engine.tx(s,initial));
 assert.equal(ownerReads,1,'one canonical ownership snapshot per review');
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

test('overlapping Safe inspection cannot bypass a failed network validation',async()=>{
 const {engine,safe,deployer}=fixture();
 let rejectValidation;
 engine.validate=()=>new Promise((_,reject)=>{rejectValidation=reject;});
 const pending=engine.configure(deployer,safe);
 await new Promise(resolve=>setImmediate(resolve));
 rejectValidation(Error('Network binding changed'));
 await assert.rejects(pending,/Network binding changed/);
});

test('full failure diagnostics still reject changed contracts, confirmations and owners',async()=>{
 for(const failure of ['network','code','confirmation','owners']) {
  const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
  Object.assign(s.addresses,{policyL1:addr(301),policy:addr(302),multiSendL1:addr(303)});
  s.completed=Array.from({length:4},()=>({hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}));
  const rpc=engine.io.rpc,read=engine.io.read;
  if(failure==='network')engine.validate=async()=>{throw Error('Network binding changed');};
  if(failure==='code')engine.io.rpc=(chain,method,params)=>method==='eth_getCode'&&params[0]===shared.contracts.moduleL1.address?'0x':rpc(chain,method,params);
  if(failure==='confirmation')s.completed[0].blockHash=toHex(1n,{size:32});
  if(failure==='owners')engine.io.read=(chain,address,name,method,...rest)=>method==='getThreshold'?2n:read(chain,address,name,method,...rest);
  await assert.rejects(engine.unchanged(s),/Network binding changed|contract changed|reorganized|owners or threshold/);
 }
});

test('a returned signature is rejected if the wallet account changed without repeating network audits',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 Object.assign(s.addresses,{policyL1:addr(301),policy:addr(302),multiSendL1:addr(303)});
 s.completed=Array.from({length:4},()=>({hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}));
 s.review=await engine.review(s);
 let signed=false;const progress=[];
 engine.currentReview=async()=>{throw Error('Unexpected repeated review');};
 engine.validate=async()=>{throw Error('Unexpected network audit');};
 const provider={request:async({method})=>{
  if(method==='eth_accounts')return [signed?addr(201):deployer];
  if(method==='eth_chainId')return '0x1';
  assert.equal(method,'eth_signTypedData_v4');signed=true;
  assert.equal(progress.at(-1),'Waiting for the owner signature in your wallet…');return '0x';
 }};
 await assert.rejects(engine.approve(s,provider,message=>progress.push(message)),/Connect the wallet selected/);
 assert(signed);assert.match(progress.at(-1),/^Signature received/);assert.equal(s.review.approvals.length,0);
});

test('normal preparation estimates gas first and only diagnoses a failed simulation',async()=>{
 for(const failure of [false,true]) {
  const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe),phases=[];
  engine.wallet=async()=>deployer;
  engine.batch=async()=>({data:'0x1234',outputs:[]});
  engine.io.rpc=async(_chain,method)=>{if(method==='eth_getTransactionCount')return '0x1';assert.equal(method,'eth_estimateGas');if(failure)throw Error('execution reverted');return '0x5208';};
  let diagnoses=0;engine.unchanged=async()=>{diagnoses++;throw Error('The selected contract changed');};
  const prepared=engine.prepare(s,{},message=>phases.push(message));
  if(failure){await assert.rejects(prepared,/execution reverted.*selected contract changed/);assert.equal(diagnoses,1);}
  else {assert.equal((await prepared).request.gas,'0x6270');assert.equal(diagnoses,0);}
 }
});

async function submissionFixture(step) {
 const {engine,safe,deployer}=fixture(artifacts,{...target,fees:{l1:'1000000',l2:'1000000'}}),state=await engine.configure(deployer,safe);
 const owner=privateKeyToAccount(toHex(42n,{size:32})); // Public dummy test key.
 Object.assign(state.addresses,{policyL1:addr(301),policy:addr(302),multiSendL1:addr(303),
   safeL2:addr(304),moduleL2:addr(305),multiSendL2:addr(306),adapter:addr(307),safeL2Alias:addr(308)});
 state.completed=['l1','l2','l2','l1','l1'].slice(0,step).map((chain,i)=>({chain,hash:toHex(i+1,{size:32}),number:toHex(i+10),blockHash:toHex(i+20,{size:32})}));
 const review={step,chain:step===4?'l1':'l2',nonce:'0',owners:[owner.address],threshold:1,
   fingerprint:ownerFingerprint([owner.address],1),hash:zeroHash,approvals:[],moduleEnabled:false};
 const tx=engine.tx(state,review);review.hash=safeTransactionHash(tx);
 review.approvals=[{owner:owner.address,signature:await owner.signTypedData(tx)}];state.review=review;
 engine.wallet=async()=>owner.address;
 engine.unchanged=async()=>assert.fail('The full audit must not run for a successful simulation or guard failure');
 engine.currentReview=async()=>assert.fail('Submission must not repeat ownership reads');
 const reads=[];
 engine.io.rpc=async(chain,method,params)=>{
   reads.push({chain,method,params});
   if(method==='eth_getTransactionCount')return '0x1';
   if(method==='eth_estimateGas')return '0x5208';
   if(method==='eth_blockNumber')return '0x20';
   if(method==='eez_quoteFee'){
     const [request]=params;
     const normalized={...request,type:'0x2',gas:'0x5208',from:request.from.toLowerCase(),to:request.to.toLowerCase(),data:request.data.toLowerCase()};
     return {version:1,chainId:request.chainId,nonce:request.nonce,expiresAt:toHex(Math.floor(Date.now()/1000)+30),
       options:[{type:'0x2',gas:'0x5208',estimatedFee:'0x5208',maxFeePerGas:'0x1',maxPriorityFeePerGas:'0x0',
         requestHash:keccak256(toHex(JSON.stringify(Object.fromEntries(Object.keys(normalized).sort().map(k=>[k,normalized[k]])))))}]};
   }
   if(method==='eth_getStorageAt'){
     const pin=network.protocol.find(p=>p.chain===chain);
     assert.deepEqual(params,[pin.proxy,EIP1967_IMPLEMENTATION_SLOT,'latest']);
     return toHex(BigInt(pin.implementation),{size:32});
   }
   if(method==='eth_getBlockByNumber'){
     const latest=state.completed.filter(t=>t.chain===chain).at(-1);
     assert.deepEqual(params,[latest.number,false],'Only the latest recorded block per chain needs a new read');
     return {hash:latest.blockHash};
   }
   assert.fail(`Unexpected RPC: ${method}`);
 };
 return {engine,state,reads};
}

for(const step of [4,5]) {
 test(`setup step ${step+1} collects an owner signature without deployment RPC reads`,async()=>{
   const {engine,state}=await submissionFixture(step),approval=state.review.approvals[0];
   state.review.approvals=[];
   engine.wallet=MainnetSetup.prototype.wallet;
   engine.io.rpc=async()=>assert.fail('Owner signing must not add deployment RPC reads');
   const methods=[],provider={request:async({method})=>{
     methods.push(method);
     if(method==='eth_accounts')return [approval.owner];
     if(method==='eth_chainId')return toHex(network.chains[state.review.chain].chainId);
     assert.equal(method,'eth_signTypedData_v4');return approval.signature;
   }};
   assert.deepEqual(await engine.approve(state,provider),approval);
   assert.deepEqual(methods,['eth_accounts','eth_chainId','eth_signTypedData_v4','eth_accounts','eth_chainId']);
 });
 test(`setup step ${step+1} performs exactly four fresh guard reads after successful simulation`,async()=>{
   const {engine,state,reads}=await submissionFixture(step),before=JSON.stringify(state);
   const prepared=await engine.prepare(state,{});
   assert.equal(prepared.pending.id,String(step));assert.equal(JSON.stringify(state),before);
   const guard=reads.filter(r=>['eth_getStorageAt','eth_getBlockByNumber'].includes(r.method));
   assert.equal(guard.length,4);
   assert.deepEqual(guard.map(r=>[r.chain,r.method]),[['l1','eth_getStorageAt'],['l1','eth_getBlockByNumber'],['l2','eth_getStorageAt'],['l2','eth_getBlockByNumber']]);
   assert(reads.findIndex(r=>r.method===(step===4?'eth_estimateGas':'eez_quoteFee'))<reads.indexOf(guard[0]));
 });
 for(const chain of ['l1','l2'])for(const failure of ['implementation','reorg','missing-block','unavailable','block-unavailable','malformed-slot']) {
   test(`setup step ${step+1} preserves its journal and rejects ${chain} ${failure}`,async()=>{
     const {engine,state,reads}=await submissionFixture(step),rpc=engine.io.rpc,before=JSON.stringify(state);
     engine.io.rpc=async(c,method,params)=>{
       if(c===chain && method==='eth_getStorageAt'){
         if(failure==='implementation')return toHex(999n,{size:32});
         if(failure==='malformed-slot')return '0x';
         if(failure==='unavailable')throw Error('RPC unavailable');
       }
       if(c===chain && method==='eth_getBlockByNumber'){
         if(failure==='block-unavailable')throw Error('RPC unavailable');
         if(failure==='reorg')return {hash:zeroHash};
         if(failure==='missing-block')return null;
       }
       return rpc(c,method,params);
     };
     await assert.rejects(engine.prepare(state,{}),/protocol implementation changed|confirmation changed or is unavailable|RPC unavailable/);
     assert.equal(JSON.stringify(state),before);assert.equal(state.pending,undefined);
     assert(!reads.some(r=>r.method.startsWith('eth_send')));
   });
 }
}

test('submission guard dispatches all four reads together and rechecks on retry',async()=>{
 const {engine,state}=await submissionFixture(4),rpc=engine.io.rpc,releases=[];
 engine.io.rpc=(...args)=>new Promise((resolve,reject)=>releases.push(()=>rpc(...args).then(resolve,reject)));
 const first=engine.checkSubmission(state);
 assert.equal(releases.length,4);releases.splice(0).forEach(release=>release());await first;
 const retry=engine.checkSubmission(state);
 assert.equal(releases.length,4);releases.splice(0).forEach(release=>release());await retry;
});

test('submission guard uses the real HTTP transport and configured RPC paths',async()=>{
 const {state}=await submissionFixture(4),requests=[];
 const server=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   const request=JSON.parse(body),chain=req.url==='/configured/l1'?'l1':req.url==='/configured/l2'?'l2':null;
   requests.push({chain,...request});
   res.setHeader('Content-Type','application/json');
   const pin=network.protocol.find(p=>p.chain===chain),block=state.completed.filter(tx=>tx.chain===chain).at(-1);
   const result=request.method==='eth_getStorageAt' && pin ? toHex(BigInt(pin.implementation),{size:32})
     : request.method==='eth_getBlockByNumber' && block ? {hash:block.blockHash} : null;
   res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
   const origin=`http://127.0.0.1:${server.address().port}`;
   const engine=new MainnetSetup({...target,l1:{...target.l1,rpc:origin+'/configured/l1'},
     l2:{...target.l2,rpc:origin+'/configured/l2'}},artifacts);
   await engine.checkSubmission(state);
   assert.equal(requests.length,4);
   for(const chain of ['l1','l2']) {
     const calls=requests.filter(r=>r.chain===chain),pin=network.protocol.find(p=>p.chain===chain);
     assert.equal(calls.length,2);
     assert.deepEqual(calls.find(r=>r.method==='eth_getStorageAt').params,[pin.proxy,EIP1967_IMPLEMENTATION_SLOT,'latest']);
     assert.deepEqual(calls.find(r=>r.method==='eth_getBlockByNumber').params,[state.completed.filter(tx=>tx.chain===chain).at(-1).number,false]);
   }
 } finally {await new Promise(resolve=>server.close(resolve));}
});
