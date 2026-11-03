import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, keccak256, pad, toHex, zeroHash, type Address, type Hex } from 'viem';
import { inspectSafeSelection, prepareOwnerAddition, ownerTransaction, readAttachment, saveAttachment, selectFactorySafe, SafeSelectionConflict, attachmentKey, verifyOwnerAddition } from '../../src/lib/falcon/existingSafe.ts';
import { safeAbi, loadRemoteSafe, prepareSafeTransfer, hasSafeExecution, inspectExistingSafe } from '../../src/lib/falcon/safe.ts';
import { safeTransactionHash, encodeSafeExecution } from '../../src/lib/treasury/safeTransactions.ts';
import { loadTreasuryArtifacts } from '../../src/lib/treasury/release.ts';
import { crossChainDeployment as d } from '../../src/lib/falcon/crossChainDeployment.ts';
import { readRecovery, type RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
const a = (n: number) => toHex(n, {size:20});
const account=a(90), controller=a(91), owner=a(92), target=a(93), singleton=a(94), module=a(95), other=a(96);
const signal = new AbortController().signal;
const artifacts = await loadTreasuryArtifacts();
const snapshots = JSON.parse(readFileSync(new URL('./fixtures/existing-safes.json', import.meta.url), 'utf8'));
const safe150 = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/safe-150.json', import.meta.url), 'utf8'));
const deployed = JSON.parse(readFileSync(new URL('./fixtures/deployed-code.json', import.meta.url), 'utf8'));
function fixture(safeAddress = target, singletonAddress = singleton) {
 const state = { owners: [account] as Address[], threshold: 1n, nonce: 7n, chainId: d.l1.chainId, proxy: artifacts.contracts.SafeProxy!.runtime,
   implementation: artifacts.contracts.Safe!.runtime, version: '1.4.1', guard: zeroHash, moduleGuard: zeroHash, registered: false, hashMismatch: false,
   factoryTarget: a(0), factoryCode: deployed.safeFactory.code as Hex,
   walletCode: '0x' as Hex, ownerCode: {} as Record<string, Hex>, modules: [module] as Address[] };
 const code = (address: string) => address.toLowerCase()===d.l1.safe!.factory.address.toLowerCase()?state.factoryCode:address.toLowerCase()===safeAddress.toLowerCase()?state.proxy:address.toLowerCase()===singletonAddress.toLowerCase()?state.implementation:state.ownerCode[address.toLowerCase()]??(address.toLowerCase()===account.toLowerCase()?state.walletCode:'0x');
 const block = { number:100n, hash:zeroHash, timestamp:100n };
 const reads = async ({functionName,args=[]}: {functionName:string;args?:unknown[]}) => {
  if(functionName==='getTransactionHash') return state.hashMismatch?zeroHash:safeTransactionHash(ownerTransaction({...d,l1:{...d.l1,chainId:state.chainId}},safeAddress,owner,BigInt(args[9] as bigint)));
  return ({safes:state.factoryTarget,VERSION:state.version,getOwners:state.owners,getThreshold:state.threshold,nonce:state.nonce,getModulesPaginated:[state.modules,a(1)],computeCrossChainProxyAddress:owner,authorizedProxies:[state.registered,controller,d.l2.rollupId]} as Record<string,unknown>)[functionName];
 };
 const client = { getChainId:async()=>state.chainId, getBlock:async({blockNumber}: {blockNumber?:bigint}={})=>blockNumber===d.l1.anchor.blockNumber?{...block,hash:d.l1.anchor.blockHash}:block,
  getBlockNumber:async()=>100n, getBalance:async()=>100n, getCode:async({address}:{address:string})=>code(address), readContract:reads,
  request:async({method,params}: {method:string;params:unknown[]})=>{
   if(method==='eth_getBlockByNumber')return {number:'0x64',hash:zeroHash};
   if(method==='eth_getCode')return code(params[0] as string);
   if(method==='eth_getStorageAt')return params[1]==='0x0'?pad(singletonAddress):params[1]==='0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947'?state.moduleGuard:state.guard;
   throw Error(method);
  }
 } as unknown as EezClient;
 return {state,client};
}
test('owner addition is a signed L1 Safe self-call, adding the controller proxy with threshold 1',async()=>{
 const {client}=fixture(); const review=await prepareOwnerAddition(client,d,controller,target,account,signal);
 const {transaction}=review;
 assert.equal(transaction.domain.chainId,BigInt(d.l1.chainId));assert.equal(transaction.domain.verifyingContract,target);
 assert.equal(transaction.message.to,target);assert.equal(transaction.message.nonce,7n);assert.equal(transaction.message.operation,0);
 const {args}=decodeFunctionData({abi:[{type:'function',name:'addOwnerWithThreshold',inputs:[{type:'address',name:'owner'},{type:'uint256',name:'threshold'}],outputs:[],stateMutability:'nonpayable'}],data:transaction.message.data});
 assert.deepEqual(args,[owner,1n]);
});
test('reject wrong owner, multi-signature quorum, unknown implementation and mismatched signing hash',async()=>{
 for(const mutation of [{owners:[other]},{owners:[account,other],threshold:2n},{threshold:2n},{proxy:'0x6000'},{implementation:'0x6000'},{guard:pad('0x01')},{hashMismatch:true},{chainId:1},{walletCode:'0x6000'}]) {
  const {state,client}=fixture();Object.assign(state,mutation);
  await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,signal));
 }
});

for (const chainId of [d.l1.chainId, 1]) test(`owner inspection overlaps chain validation without bypassing it (chain ${chainId})`, async () => {
 const {client}=fixture();
 let release!: () => void, inspected!: () => void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const reached=new Promise<void>(resolve=>{inspected=resolve;});
 const read=client.readContract;
 Object.assign(client,{
  getChainId:async()=>{await gate;return chainId;},
  readContract:async(args:Parameters<typeof read>[0])=>{inspected();return read(args);},
 });
 let completed=false;
 const pending=prepareOwnerAddition(client,d,controller,target,account,signal).finally(()=>{completed=true;});
 const checked=chainId===d.l1.chainId?pending:assert.rejects(pending,/Select/);
 let timer:ReturnType<typeof setTimeout>;
 try {
  const overlapped=await Promise.race([reached.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);
  assert(overlapped,'Safe inspection must start while chain validation is pending');
  assert.equal(completed,false,'a completed inspection must still wait for chain validation');
 } finally { clearTimeout(timer!);release();await checked; }
});

test('a cancelled owner inspection starts no RPC reads', async () => {
 const {client}=fixture(),abort=new AbortController();
 let reads=0;
 Object.assign(client,{getChainId:async()=>{reads++;return d.l1.chainId;}});
 abort.abort(new Error('owner review cancelled'));
 await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,abort.signal),/owner review cancelled/);
 assert.equal(reads,0);
});
test('attached Treasury Safe supports controller calls while retaining additional owners and modules',async()=>{
 const {state,client}=fixture();state.owners=[owner,account,other];
 const attachment={target,walletOwner:account};
 const remote=await loadRemoteSafe(client,d,controller,signal,undefined,attachment);
 assert.equal(remote.target,target);assert.equal(remote.owner,owner);assert.equal(remote.attachment,attachment);
 const operation=await prepareSafeTransfer(client,d,remote,other,1n,signal,'0x');
 assert.equal(operation.kind,'transfer');if(operation.kind!=='transfer')throw Error();
 assert.equal(operation.target,target);assert.equal(operation.attachment,attachment);
 // Standard Safe (not SafeL2) reports success without SafeMultiSigTransaction.
 const log={address:target,topics:encodeEventTopics({abi:safeAbi,eventName:'ExecutionSuccess',args:{txHash:operation.safeTxHash}}),data:encodeAbiParameters([{type:'uint256'}],[0n])};
 assert(hasSafeExecution({logs:[log]} as never,operation));
 assert(!hasSafeExecution({logs:[{...log,address:other}]} as never,operation));
 assert(!hasSafeExecution({logs:[log]} as never,{...operation,safeTxHash:zeroHash}));
 for(const owners of [[owner],[owner,other],[account,other]]) {
  state.owners=owners;await assert.rejects(loadRemoteSafe(client,d,controller,signal,undefined,attachment),/retain.*wallet.*Falcon/);
 }
 state.owners=[owner,account,other];state.threshold=2n;
 await assert.rejects(loadRemoteSafe(client,d,controller,signal,undefined,attachment),/threshold 1/);
});
test('confirmed owner changes bind exact request, Safe success hash, nonce and resulting owners',async()=>{
 const {state,client}=fixture();const publicKey=('0x'+'11'.repeat(897)) as Hex,hash=toHex(123,{size:32});
 const transaction=ownerTransaction(d,target,owner,7n);
 const attempt:RecoveryAttempt={version:1,id:'owner-change',kind:'owner',chainId:d.l1.chainId,account,to:target,nonce:'2',value:'0',data:encodeSafeExecution(transaction,('0x'+'11'.repeat(65)) as Hex),publicKey,controller,safeNonce:'7',hash};
 assert.deepEqual(readRecovery(JSON.stringify(attempt)),attempt);
 state.owners=[owner,account,other];state.nonce=8n;
 const receipt={transactionHash:hash,from:account,to:target,status:'success',blockNumber:100n,blockHash:zeroHash,logs:[{address:target,topics:encodeEventTopics({abi:safeAbi,eventName:'ExecutionSuccess',args:{txHash:safeTransactionHash(transaction)}}),data:encodeAbiParameters([{type:'uint256'}],[0n])}]} as const;
 Object.assign(client,{getTransactionReceipt:async()=>receipt,getTransaction:async()=>({hash,from:account,to:target,nonce:2,value:0n,input:attempt.data,chainId:d.l1.chainId,blockHash:zeroHash,blockNumber:100n})});
 assert.deepEqual(await verifyOwnerAddition(client,d,attempt,signal),{target,walletOwner:account});
 await assert.rejects(verifyOwnerAddition(client,d,{...attempt,safeNonce:'6'},signal),/receipt/);
 await assert.rejects(verifyOwnerAddition(client,d,{...attempt,to:other},signal),/request/);
 state.nonce=9n;
 assert.deepEqual(await verifyOwnerAddition(client,d,attempt,signal),{target,walletOwner:account},'Later same-block activity must not hide the confirmed owner addition');
 const originalGet=client.getTransaction;
 Object.assign(client,{getTransaction:async()=>({...await originalGet({hash}),to:other}),getTransactionReceipt:async()=>({...receipt,status:'reverted'})});
 await assert.rejects(verifyOwnerAddition(client,d,attempt,signal),/does not match the saved request/,'An unrelated reverted hash must preserve the original request');
 Object.assign(client,{getTransaction:originalGet});
 await assert.rejects(verifyOwnerAddition(client,d,attempt,signal),/Transaction reverted/);
 assert.throws(()=>readRecovery(JSON.stringify({...attempt,safeNonce:undefined})));
 const key=attachmentKey(d,publicKey);assert.notEqual(key,attachmentKey({...d,l2:{...d.l2,rollupId:5n,manager:other}},publicKey));
 assert.deepEqual(readAttachment({getItem:()=>JSON.stringify({target,walletOwner:account})},key),{target,walletOwner:account});
 assert.throws(()=>readAttachment({getItem:()=> 'null'},key),/Saved Falcon Safe address is invalid/);
});

test('the observed mainnet Safe 1.5.0 accepts either owner, including EIP-7702, without replacing owners or modules', async () => {
 const snapshot=snapshots.mainnet;
 const {state,client}=fixture(snapshot.address,snapshot.singleton.address);
 assert.equal(keccak256(snapshot.proxy.runtime),snapshot.proxy.codeHash);
 assert.equal(keccak256(safe150.contracts.Safe.runtime),snapshot.singleton.codeHash);
 Object.assign(state,{chainId:1,proxy:snapshot.proxy.runtime,implementation:safe150.contracts.Safe.runtime,version:snapshot.version,
  owners:snapshot.owners.map((o: {address: Address})=>o.address),threshold:BigInt(snapshot.threshold),nonce:BigInt(snapshot.nonce),modules:snapshot.modules,
  ownerCode:Object.fromEntries(snapshot.owners.map((o: {address: string;code: Hex})=>[o.address.toLowerCase(),o.code]))});
 // Only the Safe state is from mainnet. The registry/controller are test doubles;
 // this does not configure or claim a deployed mainnet Falcon route.
 const deployment={...d,l1:{...d.l1,chainId:1,chainName:'Ethereum'}};
 const inspected=await inspectExistingSafe(client,snapshot.address,signal);
 assert.deepEqual(inspected.signableOwners,state.owners);
 assert.deepEqual(inspected.modules,snapshot.modules);
 for(const wallet of state.owners) {
  const review=await prepareOwnerAddition(client,deployment,controller,snapshot.address,wallet,signal);
  assert.equal(review.transaction.domain.chainId,1n);
  assert.equal(review.transaction.message.nonce,4n);
  assert.equal(review.transaction.message.data,ownerTransaction(deployment,snapshot.address,owner,4n).message.data);
 }
 const review=await prepareOwnerAddition(client,deployment,controller,snapshot.address,state.owners[0]!,signal);
 state.owners=[...state.owners,other]; // A module can change owners without consuming the Safe nonce.
 const fresh=await prepareOwnerAddition(client,deployment,controller,snapshot.address,state.owners[0]!,signal);
 assert.notEqual(fresh.ownerFingerprint,review.ownerFingerprint);
 state.moduleGuard=pad('0x01');
 await assert.rejects(prepareOwnerAddition(client,deployment,controller,snapshot.address,state.owners[0]!,signal),/module Guard/);
});

test('the observed Chiado Falcon proxy is recognized, but its contract owner cannot be replaced by a gas wallet', async () => {
 const snapshot=snapshots.chiado;
 const {state,client}=fixture(snapshot.address,snapshot.singleton.address);
 assert.equal(keccak256(snapshot.proxy.runtime),d.l1.safe!.proxyRuntimeCodeHash);
 assert.equal(keccak256(deployed.singleton.code),snapshot.singleton.codeHash);
 Object.assign(state,{proxy:snapshot.proxy.runtime,implementation:deployed.singleton.code,owners:snapshot.owners.map((o: {address: Address})=>o.address),
  ownerCode:Object.fromEntries(snapshot.owners.map((o: {address: string;code: Hex})=>[o.address.toLowerCase(),o.code]))});
 await assert.rejects(prepareOwnerAddition(client,d,controller,snapshot.address,account,signal),error=>
  error instanceof Error && /contract-owner signatures/.test(error.message) && error.message.includes(snapshot.owners[0].address));
 // Proxy recognition does not waive code, implementation or Guard checks.
 state.owners=[account];
 await prepareOwnerAddition(client,d,controller,snapshot.address,account,signal);
 for(const proxy of [snapshot.proxy.runtime+'00','0x00'+snapshot.proxy.runtime.slice(4)]) {
  state.proxy=proxy as Hex;await assert.rejects(prepareOwnerAddition(client,d,controller,snapshot.address,account,signal),/not a supported Safe proxy/);
 }
 state.proxy=snapshot.proxy.runtime;state.implementation='0x6000';
 await assert.rejects(prepareOwnerAddition(client,d,controller,snapshot.address,account,signal),/Unsupported Safe implementation/);
 state.implementation=deployed.singleton.code;state.guard=pad('0x01');
 await assert.rejects(prepareOwnerAddition(client,d,controller,snapshot.address,account,signal),/transaction Guard/);
});

test('duplicate controller owners and owner counts beyond the inspection bound stop before signing', async () => {
 const {state,client}=fixture();state.owners=[account,owner];
 await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,signal),/already an owner/);
 state.owners=[account,...Array.from({length:49},(_,i)=>a(1000+i))];
 await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,signal),/50 owners/);
});


test('another tab cannot silently replace a confirmed Safe attachment', () => {
 let saved: string | null = null;
 const storage={getItem:()=>saved,setItem:(_key: string,value: string)=>{saved=value;}};
 const first={target,walletOwner:account};
 saveAttachment(storage,'safe',first);
 saveAttachment(storage,'safe',first);
 assert.throws(()=>saveAttachment(storage,'safe',{target:other,walletOwner:account}),/Another Safe was selected/);
 assert.throws(()=>saveAttachment(storage,'safe',{target,walletOwner:other}),/Another Safe was selected/);
 assert.deepEqual(JSON.parse(saved!),first);
});

test('a Safe already controlled by Falcon needs no wallet-owner authorization', async () => {
 const {state,client}=fixture();
 state.owners=[owner];state.ownerCode[owner.toLowerCase()]='0x6000';state.registered=true;
 const selected=await inspectSafeSelection(client,d,controller,target,signal);
 assert.equal(selected?.target,target);assert.equal(selected?.owner,owner);
 assert.deepEqual(selected?.attachment,{target});
 assert.deepEqual(readAttachment({getItem:()=>JSON.stringify(selected!.attachment)},'safe'),{target});
 // The setup path still requires an actual signing owner when adding authority.
 await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,signal),/contract-owner signatures/);
 state.registered=false;
 await assert.rejects(inspectSafeSelection(client,d,controller,target,signal),/proxy binding/);
 state.registered=true;state.owners=[owner,account];state.threshold=2n;
 await assert.rejects(inspectSafeSelection(client,d,controller,target,signal));
 state.owners=[account];state.threshold=1n;
 assert.equal(await inspectSafeSelection(client,d,controller,target,signal),null);
});

test('explicit replacement compares the reviewed selection and preserves concurrent changes', () => {
 let saved: string | null=null;
 const storage={getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;}};
 const first={target,walletOwner:account},next={target:other};
 saveAttachment(storage,'safe',first);
 const reviewed=saved;
 saveAttachment(storage,'safe',next,reviewed);
 assert.deepEqual(readAttachment(storage,'safe'),next);
 saveAttachment(storage,'safe',next,reviewed); // Idempotent confirmation from another tab.
 assert.throws(()=>saveAttachment(storage,'safe',first,reviewed),/Another Safe was selected/);
 assert.deepEqual(readAttachment(storage,'safe'),next);
 saved=null;
 assert.throws(()=>saveAttachment(storage,'safe',next,reviewed),/Another Safe was selected/);
 saveAttachment(storage,'safe',next,null);
});

test('selection conflicts are distinct from storage failures', () => {
 const saved=JSON.stringify({target:other});
 const storage={getItem:()=>saved,setItem:()=>{},removeItem:()=>{}};
 assert.throws(()=>saveAttachment(storage,'safe',{target},null),SafeSelectionConflict);
 assert.throws(()=>selectFactorySafe(storage,'safe',null),SafeSelectionConflict);
 const unavailable=new Error('Storage access denied');
 const blocked={...storage,getItem:()=>{throw unavailable;}};
 assert.throws(()=>selectFactorySafe(blocked,'safe',saved),error=>error===unavailable);
 assert.throws(()=>saveAttachment(blocked,'safe',{target},saved),error=>error===unavailable);
 assert.throws(()=>selectFactorySafe({...storage,removeItem:()=>{throw unavailable;}},'safe',saved),error=>error===unavailable);
});

test('factory classification and validation errors never fall back to an external Safe', async () => {
 const {state,client}=fixture();state.owners=[owner,account];
 // External Safe inspection succeeds, demonstrating that fallback would mask the error.
 assert((await inspectSafeSelection(client,d,controller,target,signal))?.attachment);
 state.factoryCode='0x6000';
 await assert.rejects(inspectSafeSelection(client,d,controller,target,signal),/factory bytecode/);
 state.factoryCode=deployed.safeFactory.code;
 const read=client.readContract;
 const unavailable=new Error('Factory RPC unavailable');
 Object.assign(client,{readContract:async(args:Parameters<EezClient['readContract']>[0])=>{
   if(args.functionName==='safes')throw unavailable;
   return read(args);
 }});
 await assert.rejects(inspectSafeSelection(client,d,controller,target,signal),error=>error===unavailable);
 // Once the mapping identifies this Safe, a strict validation failure is propagated.
 const invalid=new Error('Safe authority or configuration changed');
 let strictValidation=false;
 Object.assign(client,{readContract:async(args:Parameters<EezClient['readContract']>[0])=>{
   if(args.functionName==='safes')return target;
   if(args.functionName==='singleton'){strictValidation=true;throw invalid;}
   return read(args);
 }});
 await assert.rejects(inspectSafeSelection(client,d,controller,target,signal));
 assert(strictValidation,'factory-owned targets must enter strict factory validation');
});
