import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { checkedPayment, fundingPreview, paymentTransaction, parseUSDC } from '../src/lib/treasury/payments.ts';
import { TreasuryClient, readIntent, safeAbi } from '../src/lib/treasury/client.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { transferAbi, transferHelper, parseTransferAmount, verifyTransferHelper, transferFunds, transferFunding } from '../src/lib/treasury/transfers.ts';
const address = n => getAddress(toHex(n, {size:20})), hash = s => keccak256(toHex(s));
const c = { version:1, environment:'isolated-devnet', instance:hash('treasury'), l1:{chainId:1337,rpc:'http://127.0.0.1/l1',front:'http://127.0.0.1/front/l1'}, l2:{chainId:1338,rpc:'http://127.0.0.1/l2',front:'http://127.0.0.1/front/l2'},
  safeL1:address(1),safeL2:address(2),registry:address(3),manager:address(4),adapter:address(5),code:[],ownerLabels:{},
  payments:{policy:address(6),alias:address(7),tokenL1:address(8),tokenL2:address(9),bridgeL1:address(10),bridgeL2:address(11),l1Initiation:true,exactSplits:true,combinedL2:true} };
const p = {kind:'transfer',source:'l1',destination:'l2',recipient:c.safeL2,amount:'427740000',epoch:'5',rollupId:'1'};
const transaction = paymentTransaction(c,p,5n);
const intent = {version:1,instance:c.instance,nonce:'5',value:'0',safeHash:safeTransactionHash(transaction),data:'0x1234',sender:address(20),sourceNonce:'0x4',startBlock:'0x20',l2StartBlock:'0x30',hash:hash('source'),payment:p};
test('transfer funding reads only the pinned source balance and rejects reorgs and insufficient funds', async () => {
  const client = new TreasuryClient(c), calls = [];
  let reorg = false;
  client.rpc = async (url, method, params) => {
    assert.equal(url, c.l1.rpc, 'a deposit balance check does not need L2 or payment-budget reads');
    calls.push({ method, params });
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: hash(reorg && params[0] !== 'latest' ? 'reorg' : 'block'), timestamp: '0x3a98' };
    assert.equal(method, 'eth_call');
    assert.equal(params[0].to, c.payments.tokenL1);
    assert.equal(params[1], '0x10');
    return encodeAbiParameters([{ type: 'uint256' }], [427740000n]);
  };
  const funds = await transferFunds(client);
  assert.deepEqual(funds, { balance: 427740000n, epoch: 25n });
  assert.equal(calls.length, 3);
  assert.deepEqual(transferFunding(funds.balance, 427740000n), { fromL1: 427740000n, fromL2: 0n });
  assert.throws(() => transferFunding(funds.balance, 427740001n), /Insufficient balance/);
  reorg = true;
  await assert.rejects(transferFunds(client), /Chain state changed/);
});
test('internal transfer signs an exact approve/bridge/reset batch from the existing L1 Safe', () => {
  assert.equal(parseTransferAmount('427.74'),427740000n); assert.throws(()=>parseUSDC('427.74'),/at most 150/);
  assert.equal(transaction.domain.verifyingContract,c.safeL1); assert.equal(transaction.message.operation,1);
  assert.equal(transaction.message.to,transferHelper.address); assert.equal(transaction.message.safeTxGas,0n); assert.equal(transaction.message.gasPrice,0n);
  let bytes=decodeFunctionData({abi:transferAbi,data:transaction.message.data}).args[0].slice(2),calls=[];
  while(bytes.length){const operation=Number.parseInt(bytes.slice(0,2),16),to=getAddress('0x'+bytes.slice(2,42)),value=BigInt('0x'+bytes.slice(42,106)),length=Number(BigInt('0x'+bytes.slice(106,170)));
    calls.push({operation,to,value,call:decodeFunctionData({abi:transferAbi,data:'0x'+bytes.slice(170,170+length*2)})});bytes=bytes.slice(170+length*2);}
  assert.equal(calls.length,4); assert(calls.every(x=>x.operation===0&&x.value===0n));
  assert.deepEqual(calls.map(x=>x.to),[c.payments.tokenL1,c.payments.tokenL1,c.payments.bridgeL1,c.payments.tokenL1]);
  assert.deepEqual(calls.map(x=>[x.call.functionName,...x.call.args]),[
    ['approve',c.payments.bridgeL1,0n],['approve',c.payments.bridgeL1,427740000n],['bridgeTokens',c.payments.tokenL1,427740000n,1n,c.safeL2],['approve',c.payments.bridgeL1,0n]]);
  assert.deepEqual(fundingPreview({balanceL1:427740000n,balanceL2:0n,spent:150000000n,globalLimit:150000000n,allowanceL1:[100000000n,100000000n],allowanceL2:[0n,0n]},p),{fromL1:427740000n,fromL2:0n});
  assert.throws(()=>fundingPreview({balanceL1:1n},p),/Insufficient balance/);
  assert.equal(readIntent(c,JSON.stringify(intent)).safeHash,intent.safeHash);
  for(const change of [{amount:'427740001'},{rollupId:'2'},{recipient:address(30)}]) assert.throws(()=>readIntent(c,JSON.stringify({...intent,payment:{...p,...change}})));
});
test('transfer batching preserves stored calldata casing and its Safe signing hash', () => {
  const config = { ...c, l1: { ...c.l1, chainId: 1 }, safeL1: address(0xabc123), safeL2: address(0xdef456),
    payments: { ...c.payments, tokenL1: address(0xbadc0ffe), bridgeL1: address(0xcafeaaaa) } };
  const tx = paymentTransaction(config, { ...p, recipient: config.safeL2, amount: '1' }, 0n);
  assert.equal(tx.message.data, tx.message.data.toLowerCase());
  assert.equal(safeTransactionHash(tx), '0xd58ef4ca16e0ebaef0f3e0e895c7c7b3658ecea03ce5faae7828d12ddb6c375c');
});
test('transfer validation cannot become an arbitrary owner call or silently bypass payment limits', () => {
  for(const change of [{amount:'0'},{amount:String(1n<<256n)},{source:'l2'},{destination:'l1'},{funding:'split'},{rollupId:'0'},{rollupId:String(1n<<64n)},{fromL1:'1'},{bps:'1000'}])assert.throws(()=>checkedPayment({...p,...change}));
  for(const amount of ['-1','1e6','0','0.0000001'])assert.throws(()=>parseTransferAmount(amount));
  assert.throws(()=>paymentTransaction(c,{...p,recipient:address(30)},5n),/this treasury/);
  assert.throws(()=>paymentTransaction(c,{source:'l1',destination:'l2',recipient:c.safeL2,fromL1:'40000000',amount:'40000000',epoch:'5'},5n),/Move to EEZ-X Safe/);
});
test('an unverified helper cannot reach owner signing', async () => {
  const client=new TreasuryClient(c);client.validate=async()=>{};client.rpc=async()=> '0x00';
  let walletCalls=0;client.wallet=async()=>{walletCalls++;return address(20)};
  await assert.rejects(verifyTransferHelper(client),/verified batch helper/);
  await assert.rejects(client.approve({request:()=>{walletCalls++;throw Error('must not sign')}},transaction,{owners:[address(20)]},address(20)),/verified batch helper/);
  assert.equal(walletCalls,0);
});
function event(address,name,args,blockHash,blockNumber,transactionHash){
  const abi=transferAbi.find(e=>e.type==='event'&&e.name===name);
  return {address,topics:encodeEventTopics({abi:transferAbi,eventName:name,args}),data:encodeAbiParameters(abi.inputs.filter(x=>!x.indexed),abi.inputs.filter(x=>!x.indexed).map(x=>args[x.name])),blockHash,blockNumber,transactionHash};
}
function fixture(change={}){
 const client=new TreasuryClient(c),b1=hash('source block'),b2=hash('destination block'),h2=hash('delivery'),callHash=hash('bridge call');
 const data=encodeFunctionData({abi:transferAbi,functionName:'receiveTokens',args:[c.payments.tokenL1,0n,c.safeL2,427740000n,'Test USD Coin','Test USDC',6,0n]});
 const out=event(c.registry,'CrossChainCallExecuted',{crossChainCallHash:callHash,proxy:address(40),sourceAddress:c.payments.bridgeL1,callData:data,value:0n},b1,'0x21',intent.hash);
 const incoming=event(c.manager,'IncomingCrossChainCallExecuted',{crossChainCallHash:callHash,isStatic:false,sourceAddress:c.payments.bridgeL1,sourceRollup:0n,destination:c.payments.bridgeL2,value:0n,callGas:1000000n,data,...change.incoming},b2,'0x31',h2);
 const source={status:'0x1',blockHash:b1,blockNumber:'0x21',logs:[
  {address:c.safeL1,topics:[encodeEventTopics({abi:safeAbi,eventName:'ExecutionSuccess'})[0],intent.safeHash],data:encodeAbiParameters([{type:'uint256'}],[0n])},out,
  event(c.payments.tokenL1,'Transfer',{from:c.safeL1,to:c.payments.bridgeL1,value:427740000n},b1,'0x21',intent.hash),
  event(c.payments.bridgeL1,'TokensBridged',{token:c.payments.tokenL1,sender:c.safeL1,rollupId:1n,amount:427740000n},b1,'0x21',intent.hash)]};
 const destination={status:'0x1',blockHash:b2,blockNumber:'0x31',logs:[incoming,
  event(c.payments.tokenL2,'Transfer',{from:zeroAddress,to:change.recipient??c.safeL2,value:427740000n},b2,'0x31',h2),
  event(c.payments.bridgeL2,'WrappedTokensMinted',{wrappedToken:c.payments.tokenL2,to:c.safeL2,amount:427740000n},b2,'0x31',h2)]};
 if(change.noLock)source.logs.splice(2,1);if(change.noIncomingReceipt)destination.logs.shift();
 let rereads=0;
 client.rpc=async(url,method,params)=>{
  if(method==='eth_getTransactionReceipt')return url===c.l1.rpc?source:destination;
  if(method==='eez_getCrossChainTransaction')return null;
  if(method==='eth_getTransactionByHash')return{from:intent.sender,to:c.safeL1,input:intent.data,nonce:intent.sourceNonce,value:'0x0'};
  if(method==='eth_getBlockByNumber'){if(params[0]==='safe')return{number:change.unsafe?'0x30':'0x31',hash:b2};if(url===c.l1.rpc)return{number:'0x21',hash:change.reorg&&++rereads>1?hash('reorg'):b1};return{number:'0x31',hash:b2};}
  if(method==='eth_getLogs')return url===c.l1.rpc?change.ambiguous?[out,{...out,transactionHash:hash('other source')}]:[out]:[incoming];
  if(method==='eez_getSettlementByL2Block')return change.noIndex?null:{canonicalL2:!change.noncanonical,l1BlockHash:change.otherSettlement?hash('other block'):b1,l1BlockNumber:'0x21',l2Blocks:[{number:'0x31',hash:b2}]};
  assert.fail(method);
 };
 return client;
}
test('transfer completion requires the exact lock, protocol call identity, destination mint and canonical settlement',async()=>{
 const result=await fixture().outcome(intent);assert.equal(result.kind,'settled');assert.deepEqual(result.execution,{l1:intent.hash,l2:hash('delivery')});assert.deepEqual(result.contributions,{fromL1:p.amount,fromL2:'0'});
 for(const options of [{noIndex:true},{noncanonical:true},{otherSettlement:true},{unsafe:true},{reorg:true},{incoming:{sourceAddress:address(50)}},{incoming:{data:'0x'}},{incoming:{isStatic:true}}])assert.equal((await fixture(options).outcome(intent)).kind,'pending');
 for(const options of [{noLock:true},{recipient:address(50)},{noIncomingReceipt:true},{ambiguous:true}])await assert.rejects(fixture(options).outcome(intent));
});

test('submission packs real owner signatures and requires a bound live quote with the same reviewed bridge destination',async()=>{
 const {readFileSync}=await import('node:fs');const{privateKeyToAccount}=await import('viem/accounts');
 const owner=privateKeyToAccount(toHex(41,{size:32}));
 const client=new TreasuryClient({...c,fees:{maxTotalWei:'10000000',l1MaxTotalWei:'10000000'}});
 const snapshot={source:'l1',nonce:5n,owners:[owner.address],threshold:1,fingerprint:'1:'+owner.address,value:0n,l1Block:'33'};
 const signature=await owner.signTypedData(transaction);let quotes=0,changed=false,unavailable=false;
 client.validate=async()=>{};client.snapshot=async()=>snapshot;client.wallet=async()=>owner.address;
 client.rpc=async(_url,method,params)=>{
  if(method==='eth_getCode')return JSON.parse(readFileSync('tests/fixtures/safe-multisend-call-only-130.json')).runtime;
  if(method==='eth_call')return encodeAbiParameters([{type:'uint64'}],[changed?2n:1n]);
  if(method==='eth_getTransactionCount')return '0x4';
  if(method==='eth_getBlockByNumber')return{number:'0x30',hash:hash('block'),baseFeePerGas:'0x1'};
  if(method==='eez_quoteFee'){
    quotes++;const tx={...params[0],gas:'0x3df58'};const normalized=Object.fromEntries(Object.entries(tx).map(([k,v])=>[k,v.toLowerCase()]));
    const requestHash=keccak256(toHex(JSON.stringify(Object.fromEntries(Object.keys(normalized).sort().map(k=>[k,normalized[k]])))));
    return{version:1,chainId:'0x539',nonce:'0x4',expiresAt:toHex(Math.floor(Date.now()/1000)+20),options:[unavailable?{type:'0x2',error:{code:'unsupported_transaction'}}:{type:'0x2',gas:tx.gas,requestHash,estimatedFee:'0x10000',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1'}]};
  }
  assert.fail(method);
 };
 const prepared=await client.prepare({},transaction,snapshot,[{owner:owner.address,signature}],p);
 assert.equal(prepared.request.to,c.safeL1);assert.equal(prepared.intent.payment.kind,'transfer');assert.equal(prepared.intent.safeHash,intent.safeHash);
 const execution=decodeFunctionData({abi:parseAbi(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)']),data:prepared.request.data});
 assert.equal(execution.args[0],transferHelper.address);assert.equal(execution.args[3],1);assert.equal(execution.args[9],signature);
 assert.equal(quotes,1);changed=true;await assert.rejects(client.prepare({},transaction,snapshot,[{owner:owner.address,signature}],p),/bridge destination changed/);assert.equal(quotes,1);
 changed=false;unavailable=true;await assert.rejects(client.prepare({},transaction,snapshot,[{owner:owner.address,signature}],p),/unsupported_transaction/);
});
