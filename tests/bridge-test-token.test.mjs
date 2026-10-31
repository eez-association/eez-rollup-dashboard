import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, getContractAddress, parseAbi, zeroAddress } from 'viem';
import { observeTestToken, parseTestToken, readTestTokenDeployment, testTokenData, testTokenErrorMessage } from '../src/lib/bridgeTestToken.ts';
const artifact=JSON.parse(fs.readFileSync('src/lib/bridge-test-token-artifact.json'));
const account='0x'+'12'.repeat(20), other='0x'+'34'.repeat(20), hash='0x'+'56'.repeat(32), blockHash='0x'+'78'.repeat(32);
const input={name:'Bridge Test Token',symbol:'TEST',amount:'10000'};
const saved={version:1,id:'test',chainId:10200,account,nonce:'0x3',input,data:testTokenData(input,artifact),hash};
const address=getContractAddress({from:account,nonce:3n});
const mintAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
test('wallet plain-object and nested errors retain the actual cause',()=>{
  assert.equal(testTokenErrorMessage({code:-32000,message:'insufficient funds for gas'}),'insufficient funds for gas');
  assert.equal(testTokenErrorMessage({code:-32603,message:'Internal JSON-RPC error.',data:{originalError:{message:'transaction underpriced'}}}),'transaction underpriced');
  assert.equal(testTokenErrorMessage('RPC disconnected'),'RPC disconnected');
  const cycle={message:'Wallet error'};cycle.cause=cycle;
  assert.equal(testTokenErrorMessage(cycle),'Wallet error');
});
function fixture(options={}) {
  let blocks=0;
  const requests=[];
  const rpc=async(method,params=[])=>{
    requests.push({method,params});
    if(method==='eth_chainId') return options.wrongChain?'0x1':'0x27d8';
    if(method==='eth_getTransactionCount') return options.nonce ?? '0x3';
    if(method==='eth_getTransactionByHash') return options.notFound?null:{hash,from:account,to:null,nonce:'0x3',input:saved.data,value:'0x0',chainId:'0x27d8',blockHash,blockNumber:'0x10',...options.transaction};
    if(method==='eth_getTransactionReceipt') return options.pending?null:{transactionHash:hash,from:account,to:null,status:'0x1',blockHash,blockNumber:'0x10',contractAddress:address,
      logs:options.noMint?[]:[{address,topics:encodeEventTopics({abi:mintAbi,eventName:'Transfer',args:{from:zeroAddress,to:options.recipient??account}}),data:encodeAbiParameters([{type:'uint256'}],[parseTestToken(input).supply])}],...options.receipt};
    if(method==='eth_getBlockByNumber') return {hash:options.reorg && blocks++ ? hash:blockHash};
    if(method==='eth_getCode') {assert.equal(params[1],'0x10');return options.wrongCode?'0x00':artifact.runtime;}
    throw new Error(`Unexpected RPC ${method}`);
  };
  return {rpc,requests};
}

test('demo deployment uses exact positive supply with 18 decimals and bounded metadata',()=>{
  assert.equal(parseTestToken({...input,amount:'1.000000000000000001'}).supply,1000000000000000001n);
  for(const amount of ['0','-1','1e3','01','1.0000000000000000001','9'.repeat(78)]) assert.throws(()=>parseTestToken({...input,amount}));
  for(const name of ['', 'a'.repeat(49), '🎉'.repeat(13)]) assert.throws(()=>parseTestToken({...input,name}));
  for(const symbol of ['', 'a'.repeat(13), 'BAD TOKEN']) assert.throws(()=>parseTestToken({...input,symbol}));
  assert.equal(readTestTokenDeployment(JSON.stringify(saved)).data,saved.data);
  assert.throws(()=>readTestTokenDeployment(JSON.stringify({...saved,outcome:'confirmed'})));
});

test('packaged deployment bytecode tracks the checked-in Solidity sources',()=>{
  for(const [path,digest] of Object.entries(artifact.sources)) assert.equal(createHash('sha256').update(fs.readFileSync('contracts/'+path)).digest('hex'),digest,path);
  assert(artifact.bytecode.startsWith('0x'));assert(artifact.runtime.startsWith('0x'));
  assert(!artifact.abi.some(item=>item.type==='function' && item.name==='mint'));
});

test('only the correct canonical deployment and mint confirm the new token',async t=>{
  const f=fixture();
  assert.deepEqual(await observeTestToken(f.rpc,saved,artifact),{...saved,outcome:'confirmed',address});
  assert(f.requests.every(r=>!['eth_sendTransaction','eth_sendRawTransaction'].includes(r.method)));
  for(const [name,options] of Object.entries({wrongChain:{wrongChain:true},wrongSender:{transaction:{from:other}},wrongNonce:{transaction:{nonce:'0x4'}},wrongAddress:{receipt:{contractAddress:other}},wrongCode:{wrongCode:true},missingMint:{noMint:true},wrongRecipient:{recipient:other},reorg:{reorg:true}})) {
    await t.test(name,()=>assert.rejects(observeTestToken(fixture(options).rpc,saved,artifact)));
  }
  for(const options of [{pending:true},{notFound:true}]) assert.deepEqual(await observeTestToken(fixture(options).rpc,saved,artifact),saved);
});

test('reverts and mined replacements close the attempt without creating a token',async()=>{
  assert.equal((await observeTestToken(fixture({receipt:{status:'0x0'}}).rpc,saved,artifact)).outcome,'reverted');
  for(const status of ['0x0','0x1']) {
    const result=await observeTestToken(fixture({transaction:{to:account,input:'0x'},receipt:{status}}).rpc,saved,artifact);
    assert.equal(result.outcome,'replaced');assert.equal(result.address,undefined);
  }
  assert.equal((await observeTestToken(fixture({transaction:{to:account,input:'0x'},pending:true}).rpc,saved,artifact)).outcome,undefined);
});
