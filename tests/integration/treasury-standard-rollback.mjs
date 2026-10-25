// Inject a separately signed fixture blacklist transaction before an unchanged
// proved bundle. Only owned native relay controls and public fixture keys are used.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { postedTransaction } from '../../scripts/treasury-invoices.mjs';
import { paymentAbi, allowanceAbi, tokenAbi } from '../../src/lib/treasury/payments.ts';
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2);
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
export async function standardRollback(f,c,client,build,payment,token,directory) {
  const p=c.payments, controls=JSON.parse(readFileSync(resolve(directory,'relay-control.json'))).directory;
  const file=name=>resolve(controls,`${name}.json`);
  const atomic=(name,value)=>{writeFileSync(`${file(name)}.new`,json(value));renameSync(`${file(name)}.new`,file(name));};
  await f.send(f.network.l1,f.C.address,'0x',10n**18n);
  const {intent,request}=await build(payment);
  const raw=await f.submitter.signTransaction({chainId:c.l1.chainId,to:request.to,data:request.data,nonce:Number(BigInt(request.nonce)),gas:BigInt(request.gas),value:0n,type:'eip1559',maxPriorityFeePerGas:BigInt(request.maxPriorityFeePerGas),maxFeePerGas:BigInt(request.maxFeePerGas)});
  const hash=keccak256(raw);intent.hash=hash;
  async function snapshot(l1,l2) {
    const read=(chain,address,abi,name,args=[])=>f.read(c[chain].rpc,address,abi,name,args,chain==='l1'?l1.number:l2.number);
    return {
      safeL1:await read('l1',p.tokenL1,tokenAbi,'balanceOf',[c.safeL1]),safeL2:await read('l2',p.tokenL2,tokenAbi,'balanceOf',[c.safeL2]),
      recipientL1:await read('l1',p.tokenL1,tokenAbi,'balanceOf',[payment.recipient]),recipientL2:await read('l2',p.tokenL2,tokenAbi,'balanceOf',[payment.recipient]),
      escrow:await read('l1',p.tokenL1,tokenAbi,'balanceOf',[p.bridgeL1]),supply:await read('l2',p.tokenL2,tokenAbi,'totalSupply'),
      allowanceL1:await read('l1',p.moduleL1,allowanceAbi,'getTokenAllowance',[c.safeL1,p.pair.policyL1,p.tokenL1]),
      allowanceL2:await read('l2',p.moduleL2,allowanceAbi,'getTokenAllowance',[c.safeL2,p.policy,p.tokenL2]),
      spent:await read('l2',p.policy,paymentAbi,'spent',[BigInt(payment.epoch)]),
      nonceL1:await read('l1',c.safeL1,f.safeArtifact.abi,'nonce'),nonceL2:await read('l2',c.safeL2,f.safeArtifact.abi,'nonce'),
      aliasBalance:await read('l1',p.tokenL1,token,'balanceOf',[p.alias]),policyBalance:await read('l2',p.tokenL2,token,'balanceOf',[p.policy]),
      policyL1Balance:await read('l1',p.tokenL1,token,'balanceOf',[p.pair.policyL1]),
      peerProxyL2Balance:await read('l2',p.tokenL2,token,'balanceOf',[p.pair.peerProxyL2]),
      bridgeApproval:await read('l1',p.tokenL1,token,'allowance',[p.pair.policyL1,p.bridgeL1]),
    };
  }
  let held,released=false;
  for(const name of ['held-bundle','released-bundle','hold-next'])rmSync(file(name),{force:true});
  try {
    atomic('hold-next',{transaction:raw});
    assert.equal(await f.rpc(c.l1.front,'eth_sendRawTransaction',[raw]),hash);
    await f.until('proved payment held by owned relay',async()=>existsSync(file('held-bundle')),55);
    held=JSON.parse(readFileSync(file('held-bundle')));
    assert.equal(held.params[0].txs.filter(x=>x===raw).length,1);
    const posts=held.params[0].txs.filter(x=>x.startsWith('0x03'));assert.equal(posts.length,1);
    const post=postedTransaction(posts[0]);
    const parent=await f.rpc(c.l1.rpc,'eth_getBlockByNumber',['latest',false]);
    const l2Before=await f.rpc(c.l2.rpc,'eth_getBlockByNumber',['safe',false]);
    assert.equal(BigInt(held.params[0].blockNumber),BigInt(parent.number)+1n);
    const before=await snapshot(parent,l2Before);
    const blacklist=await f.C.signTransaction({chainId:c.l1.chainId,to:p.tokenL1,data:encodeFunctionData({abi:token,functionName:'blacklist',args:[c.safeL1]}),
      nonce:Number(BigInt(await f.rpc(c.l1.rpc,'eth_getTransactionCount',[f.C.address,'pending']))),gas:150000n,type:'eip1559',maxPriorityFeePerGas:post.transaction.maxPriorityFeePerGas+1n,maxFeePerGas:100000000000n});
    writeFileSync(resolve(directory,'standard-original-bundle.json'),json(held));
    atomic('released-bundle',{...held,params:[{...held.params[0],txs:[blacklist,...held.params[0].txs]}]});released=true;
    const receipt=await f.until('canonical failure posting',()=>f.rpc(c.l1.rpc,'eth_getTransactionReceipt',[post.hash]));
    const changed=await f.rpc(c.l1.rpc,'eth_getTransactionReceipt',[keccak256(blacklist)]);
    assert(changed && changed.status==='0x1' && changed.blockHash===receipt.blockHash);
    assert(BigInt(changed.transactionIndex)<BigInt(receipt.transactionIndex));
    const submitted=await f.rpc(c.l1.rpc,'eth_getTransactionByHash',[post.hash]);
    assert.equal(submitted.input,post.transaction.data);assert.deepEqual(submitted.blobVersionedHashes,post.transaction.blobVersionedHashes);
    // L1-origin entries execute when the original source consumes the queued
    // entry, after postBatch. Trace that transaction, not the queue posting.
    const sourceReceipt=await f.until('canonical failed source',()=>f.rpc(c.l1.rpc,'eth_getTransactionReceipt',[hash]));
    assert.equal(sourceReceipt.blockHash,receipt.blockHash);assert.equal(sourceReceipt.status,'0x0');
    assert(BigInt(sourceReceipt.transactionIndex)>BigInt(receipt.transactionIndex));
    const trace=await f.rpc(c.l1.rpc,'debug_traceTransaction',[hash,{tracer:'callTracer'}]);
    writeFileSync(resolve(directory,'standard-rollback-trace.json'),json(trace));
    const frames=[];const visit=node=>{frames.push(node);for(const child of node.calls??[])visit(child);};visit(trace);
    const transfer=encodeFunctionData({abi:token,functionName:'transfer',args:[payment.recipient,10000000n]});
    const earlier=frames.findIndex(x=>same(x.to,p.tokenL1)&&same(x.from,p.bridgeL1)&&x.input===transfer&&!x.error&&BigInt(x.output??'0x0')===1n);
    const later=frames.findIndex(x=>same(x.to,p.tokenL1)&&same(x.from,c.safeL1)&&x.input===transfer&&x.error&&x.output?.includes('626c61636b6c6973746564'));
    assert(earlier>=0 && later>earlier,'successful bridge release must precede the blacklisted Safe transfer');
    const block=await f.rpc(c.l1.rpc,'eth_getBlockByNumber',[receipt.blockNumber,false]);assert.equal(block.hash,receipt.blockHash);
    const after=await f.until('both treasuries roll back canonically',async()=>{
      const l2=await f.rpc(c.l2.rpc,'eth_getBlockByNumber',['safe',false]),values=await snapshot(block,l2);
      return json(values)===json(before)?{values,l2}:false;
    });
    const state=await f.until('failed source request retired',async()=>{const s=await f.rpc(c.l2.front,'eez_getCrossChainTransaction',[hash]);return s?.lifecycle==='terminal'?s:false;});
    assert.equal((await f.rpc(c.l1.rpc,'eth_getBlockByNumber',[block.number,false])).hash,block.hash);
    f.evidence.standardRollback={stage:'L1 inclusion',hash,postHash:post.hash,postStatus:receipt.status,sourceStatusCode:sourceReceipt.status,blacklistHash:keccak256(blacklist),block:receipt.blockNumber,
      earlierSuccessfulRelease:true,laterBlacklistedTransfer:true,originalProofAndBlobCommitmentsUnchanged:true,before:JSON.parse(json(before)),after:JSON.parse(json(after.values)),sourceStatus:state};
    f.evidence.lastSuccessfulL2Block=Math.max(f.evidence.lastSuccessfulL2Block,Number(BigInt(after.l2.number)));f.checkpoint();
    console.log('Canonical rollback: bridge release executed before the blacklisted Safe transfer; balances, allowances, budgets and Safe nonces unchanged');
  }finally{
    if(held&&!released)atomic('released-bundle',held);
    rmSync(file('hold-next'),{force:true});
  }
}
