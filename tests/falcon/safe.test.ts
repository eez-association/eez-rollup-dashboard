import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, pad, zeroAddress, zeroHash, type Hex, type TransactionReceipt } from 'viem';
import { hasSafeExecution, parseSafeTransfer, safeAbi, safeCallData, safeCallResult, safeOwnerApproval, type SafeOperation } from '../../src/lib/falcon/safe.ts';
const owner = '0x0000000000000000000000000000000000000011';
const target = '0x0000000000000000000000000000000000000022';
const recipient = '0x0000000000000000000000000000000000000033';
const op: Extract<SafeOperation, {kind:'transfer'}> = {kind:'transfer',owner,target,recipient,value:7n,safeNonce:3n,safeTxHash:keccak256('0x1234')};
const log = (eventName: 'ExecutionSuccess' | 'ExecutionFailure') => ({ address: target, topics: encodeEventTopics({abi:safeAbi,eventName,args:{txHash:op.safeTxHash}}), data:encodeAbiParameters([{type:'uint256'}],[0n]) });
const txLog = (value=7n, sender=owner) => ({ address:target,topics:encodeEventTopics({abi:safeAbi,eventName:'SafeMultiSigTransaction'}),data:encodeAbiParameters(
  [{type:'address'},{type:'uint256'},{type:'bytes'},{type:'uint8'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'address'},{type:'address'},{type:'bytes'},{type:'bytes'}],
  [recipient,value,'0x',0,0n,0n,0n,zeroAddress,zeroAddress,safeOwnerApproval(owner),encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'uint256'}],[3n,sender,1n])],
)});
const receipt = (...logs: unknown[]) => ({logs} as TransactionReceipt);

test('Safe owner approval uses the public sender-authenticated v=1 encoding',()=>{
 const approval=safeOwnerApproval(owner);
 assert.equal(approval.length,132); assert.equal(approval,pad(owner,{size:32})+zeroHash.slice(2)+'01');
 assert.throws(()=>safeOwnerApproval(zeroAddress));
 const {args}=decodeFunctionData({abi:safeAbi,data:safeCallData(owner,recipient,7n)});
 assert.deepEqual(args,[recipient,7n,'0x',0,0n,0n,0n,zeroAddress,zeroAddress,approval]);
});
test('Native amounts are precise and reject rounding, empty, scientific and nonpositive input',()=>{
 assert.equal(parseSafeTransfer(recipient,'0.000000000000000001').value,1n);
 assert.equal(parseSafeTransfer(recipient,'9007199254740993.1').value,9007199254740993100000000000000000n);
 for(const bad of ['0','-1','1e3','01','1.0000000000000000001','',' 1','.1','1.']) assert.throws(()=>parseSafeTransfer(recipient,bad));
 assert.throws(()=>parseSafeTransfer(zeroAddress,'1')); assert.throws(()=>parseSafeTransfer('bad','1'));
});
test('Safe source result requires canonical true, not merely a successful outer receipt',()=>{
 assert.equal(safeCallResult(op,pad('0x01',{size:32})),true);
 for(const bytes of [zeroHash,pad('0x02',{size:32}),'0x01'])assert.throws(()=>safeCallResult(op,bytes as Hex));
 assert.equal(safeCallResult({kind:'create'},pad(target,{size:32})),target);
 assert.throws(()=>safeCallResult({kind:'create'},zeroHash));
});
test('Safe L1 evidence binds success hash, operation, sender, nonce and contract',()=>{
 assert(hasSafeExecution(receipt(log('ExecutionSuccess'),txLog()),op));
 for(const logs of [[log('ExecutionSuccess')],[txLog()],[log('ExecutionSuccess'),txLog(8n)],[log('ExecutionSuccess'),txLog(7n,recipient)],[log('ExecutionSuccess'),txLog(),log('ExecutionFailure')]])assert(!hasSafeExecution(receipt(...logs),op));
 assert(!hasSafeExecution(receipt(log('ExecutionSuccess'),txLog()),{...op,safeNonce:4n}));
 assert(!hasSafeExecution(receipt(log('ExecutionSuccess'),txLog()),{...op,safeTxHash:zeroHash}));
 assert(!hasSafeExecution(receipt(log('ExecutionSuccess'),{...txLog(),address:recipient}),op));
});
