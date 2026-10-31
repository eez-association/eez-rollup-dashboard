import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, pad, toHex, zeroHash, type Address, type Hex } from 'viem';
import { prepareOwnerAddition, ownerTransaction, readAttachment, saveAttachment, attachmentKey, verifyOwnerAddition } from '../../src/lib/falcon/existingSafe.ts';
import { safeAbi, loadRemoteSafe, prepareSafeTransfer, hasSafeExecution } from '../../src/lib/falcon/safe.ts';
import { safeTransactionHash, encodeSafeExecution } from '../../src/lib/treasury/safeTransactions.ts';
import { loadTreasuryArtifacts } from '../../src/lib/treasury/release.ts';
import { crossChainDeployment as d } from '../../src/lib/falcon/crossChainDeployment.ts';
import { readRecovery, type RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
const a = (n: number) => toHex(n, {size:20});
const account=a(90), controller=a(91), owner=a(92), target=a(93), singleton=a(94), module=a(95), other=a(96);
const signal = new AbortController().signal;
const artifacts = await loadTreasuryArtifacts();
function fixture() {
 const state = { owners: [account] as Address[], threshold: 1n, nonce: 7n, chainId: d.l1.chainId, proxy: artifacts.contracts.SafeProxy!.runtime,
   implementation: artifacts.contracts.Safe!.runtime, guard: zeroHash, registered: false, hashMismatch: false, walletCode: '0x' as Hex };
 const code = (address: string) => address.toLowerCase()===target.toLowerCase()?state.proxy:address.toLowerCase()===singleton.toLowerCase()?state.implementation:address.toLowerCase()===account.toLowerCase()?state.walletCode:'0x';
 const block = { number:100n, hash:zeroHash, timestamp:100n };
 const reads = async ({functionName,args=[]}: {functionName:string;args?:unknown[]}) => {
  if(functionName==='getTransactionHash') return state.hashMismatch?zeroHash:safeTransactionHash(ownerTransaction(d,target,owner,BigInt(args[9] as bigint)));
  return ({VERSION:'1.4.1',getOwners:state.owners,getThreshold:state.threshold,nonce:state.nonce,getModulesPaginated:[[module],a(1)],computeCrossChainProxyAddress:owner,authorizedProxies:[state.registered,controller,d.l2.rollupId]} as Record<string,unknown>)[functionName];
 };
 const client = { getChainId:async()=>state.chainId, getBlock:async({blockNumber}: {blockNumber?:bigint}={})=>blockNumber===d.l1.anchor.blockNumber?{...block,hash:d.l1.anchor.blockHash}:block,
  getBlockNumber:async()=>100n, getBalance:async()=>100n, getCode:async({address}:{address:string})=>code(address), readContract:reads,
  request:async({method,params}: {method:string;params:unknown[]})=>{
   if(method==='eth_getBlockByNumber')return {number:'0x64',hash:zeroHash};
   if(method==='eth_getCode')return code(params[0] as string);
   if(method==='eth_getStorageAt')return params[1]==='0x0'?pad(singleton):state.guard;
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
test('reject wrong owner, multisig, changed threshold, unknown implementation and mismatched signing hash',async()=>{
 for(const mutation of [{owners:[other]},{owners:[account,other]},{threshold:2n},{proxy:'0x6000'},{implementation:'0x6000'},{guard:pad('0x01')},{hashMismatch:true},{chainId:1},{walletCode:'0x6000'}]) {
  const {state,client}=fixture();Object.assign(state,mutation);
  await assert.rejects(prepareOwnerAddition(client,d,controller,target,account,signal));
 }
});
test('attached Treasury Safe retains its modules and supports controller calls with both owners',async()=>{
 const {state,client}=fixture();state.owners=[owner,account];
 const attachment={target,walletOwner:account};
 const remote=await loadRemoteSafe(client,d,controller,signal,undefined,attachment);
 assert.equal(remote.target,target);assert.equal(remote.owner,owner);assert.equal(remote.attachment,attachment);
 const operation=await prepareSafeTransfer(client,d,controller,other,1n,signal,'0x',attachment);
 assert.equal(operation.kind,'transfer');if(operation.kind!=='transfer')throw Error();
 assert.equal(operation.target,target);assert.equal(operation.attachment,attachment);
 // Standard Safe (not SafeL2) reports success without SafeMultiSigTransaction.
 const log={address:target,topics:encodeEventTopics({abi:safeAbi,eventName:'ExecutionSuccess',args:{txHash:operation.safeTxHash}}),data:encodeAbiParameters([{type:'uint256'}],[0n])};
 assert(hasSafeExecution({logs:[log]} as never,operation));
 assert(!hasSafeExecution({logs:[{...log,address:other}]} as never,operation));
 assert(!hasSafeExecution({logs:[log]} as never,{...operation,safeTxHash:zeroHash}));
 state.owners=[owner];await assert.rejects(loadRemoteSafe(client,d,controller,signal,undefined,attachment),/two owners/);
 state.owners=[owner,other];await assert.rejects(loadRemoteSafe(client,d,controller,signal,undefined,attachment),/two owners/);
});
test('confirmed owner changes bind exact request, Safe success hash, nonce and resulting owners',async()=>{
 const {state,client}=fixture();const publicKey=('0x'+'11'.repeat(897)) as Hex,hash=toHex(123,{size:32});
 const transaction=ownerTransaction(d,target,owner,7n);
 const attempt:RecoveryAttempt={version:1,id:'owner-change',kind:'owner',chainId:d.l1.chainId,account,to:target,nonce:'2',value:'0',data:encodeSafeExecution(transaction,('0x'+'11'.repeat(65)) as Hex),publicKey,controller,safeNonce:'7',hash};
 assert.deepEqual(readRecovery(JSON.stringify(attempt)),attempt);
 state.owners=[owner,account];state.nonce=8n;
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
