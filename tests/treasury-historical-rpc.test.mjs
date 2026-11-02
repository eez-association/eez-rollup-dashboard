import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeploymentIO } from '../src/lib/treasury/deploymentIO.ts';
const release=JSON.parse(readFileSync(`src/lib/treasury/builds/${JSON.parse(readFileSync('src/lib/treasury/current-build.json')).build}.json`));
const primary='https://read.invalid',alternate='https://composer.invalid',address='0x'+'12'.repeat(20),tag='0x169f827',blockHash='0x'+'ab'.repeat(32);
function fixture(t,options={}){
 const original=globalThis.fetch,calls=[];let headers=0;
 t.after(()=>{globalThis.fetch=original;});
 const respond=(url,{id,method,params})=>{
  calls.push({url,method,params});
  if(method==='eth_chainId')return {id,result:url===alternate&&options.foreign?'0x1':'0x27d8'};
  if(method==='eth_getBlockByNumber')return {id,result:{number:tag,hash:options.reorg&&++headers>2||options.mismatch&&url===alternate?'0x'+'cd'.repeat(32):blockHash}};
  if(url===primary)return options.success?{id,result:'0x1234'}:{id,error:{code:-32000,message:options.error??'No state available for block 23721767'}};
  return {id,result:'0x1234'};
 };
 globalThis.fetch=async(url,request)=>{
  const body=JSON.parse(request.body);
  return Response.json(Array.isArray(body)?body.map(item=>respond(url,item)):respond(url,body));
 };
 return {calls,io:new DeploymentIO({l1:{rpc:primary,front:alternate},l2:{rpc:primary,front:alternate}},release)};
}
test('pruned historical state retries the exact read on a chain/block-checked Composer',async t=>{
 const {io,calls}=fixture(t);
 for(const [method,params] of [['eth_getCode',[address,tag]],['eth_getStorageAt',[address,'0x0',tag]],['eth_call',[{to:address,data:'0x'},tag]],['eth_getTransactionCount',[address,tag]]]){
  assert.equal(await io.rpc('l1',method,params),'0x1234');
  assert.deepEqual(calls.findLast(c=>c.url===alternate&&c.method===method).params,params);
 }
 assert(!JSON.stringify(calls).includes('latest'));
});
test('healthy RPC reads do not add any verification requests',async t=>{
 const {io,calls}=fixture(t,{success:true});assert.equal(await io.rpc('l1','eth_getCode',[address,tag]),'0x1234');assert.equal(calls.length,1);
});
test('fallback rejects foreign chains',async t=>{
 const {io,calls}=fixture(t,{foreign:true});await assert.rejects(io.rpc('l1','eth_getCode',[address,tag]),/different chain ID/);
 assert(!calls.some(c=>c.url===alternate&&c.method==='eth_getCode'));
});
test('fallback rejects different block hashes and reorgs',async t=>{
 for(const options of [{mismatch:true},{reorg:true}]){
  const {io}=fixture(t,options);await assert.rejects(io.rpc('l1','eth_getCode',[address,tag]),/canonical block|block changed/);
 }
});
test('fallback never retries writes, gas estimation, latest state or unrelated errors',async t=>{
 const {io,calls}=fixture(t);
 for(const [method,params,front] of [['eth_sendTransaction',[{}],false],['eth_estimateGas',[{},tag],false],['eth_getCode',[address,'latest'],false],['eth_getTransactionCount',[address,'pending'],false]])
  await assert.rejects(io.rpc('l1',method,params,front),/No state available/);
 assert(calls.every(c=>c.url===primary));
 const other=fixture(t,{error:'execution reverted'});await assert.rejects(other.io.rpc('l1','eth_call',[{to:address},tag]),/execution reverted/);
 assert.equal(other.calls.length,1);
});
