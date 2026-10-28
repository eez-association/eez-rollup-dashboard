import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUSDC, formatUSDC, fundingPreview, checkedPayment, paymentTransaction, settledPayment, paymentAbi, paymentState, defaultSplit, allowanceAbi, tokenAbi } from '../src/lib/treasury/payments.ts';
import { readIntent } from '../src/lib/treasury/client.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { encodeEventTopics, encodeAbiParameters, encodeFunctionResult, decodeFunctionData, parseAbi, keccak256, stringToHex, toHex } from 'viem';
const address = byte => `0x${byte.repeat(40)}`;
const s = { epoch: 100n, balanceL1: 300_000_000n, balanceL2: 110_000_000n, allowanceL1: [100_000_000n,0n], allowanceL2: [100_000_000n,40_000_000n], spent:40_000_000n, globalLimit:150_000_000n };
const p = { recipient:address('1'), amount:'110000000', destination:'l1',fromL1:'100000000',epoch:'100' };
const c = { instance:keccak256(stringToHex('devnet')),safeL2:address('2'),l2:{chainId:420691},payments:{policy:address('3'),tokenL1:address('4'),version:2} };
test('USDC uses exact six-decimal base units and rejects silent rounding',()=>{
 assert.equal(parseUSDC('0.000001'),1n); assert.equal(parseUSDC('110.000001'),110_000_001n);
 assert.equal(formatUSDC(110_000_001n),'110.000001');
 for(const text of ['0','-1','1.0000001','1e2','1.',' 40','150.000001']) assert.throws(()=>parseUSDC(text));
});
test('split and global ceiling are independent of remaining L2 allowance',()=>{
 assert.deepEqual(fundingPreview(s,p),{fromL1:100_000_000n,fromL2:10_000_000n});
 assert.throws(()=>fundingPreview({...s,spent:150_000_000n,allowanceL2:[100_000_000n,50_000_000n]},{...p,amount:'1000000',destination:'l2',fromL1:'0'}),/Shared budget/);
 assert.throws(()=>fundingPreview(s,{...p,fromL1:p.amount}),/Insufficient/);
 assert.throws(()=>fundingPreview({...s,epoch:101n},p),/period changed/);
 assert.equal(checkedPayment({...p,destination:'l2'}).destination,'l2');
});
test('saved payment binds recipient, chain, amount, funding, budget period and Safe nonce',()=>{
 const tx=paymentTransaction(c,p,5n);
 const i={version:1,instance:c.instance,value:'0',payment:p,nonce:'5',safeHash:safeTransactionHash(tx),data:'0x1234',sender:address('5'),sourceNonce:'0x1',startBlock:'0x1'};
 assert.deepEqual(readIntent(c,JSON.stringify(i)),i);
 for(const update of [{amount:'1000000'},{recipient:address('6')},{epoch:'101'},{destination:'l2',fromL1:'0'},{fromL1:'110000000'}])
  assert.throws(()=>readIntent(c,JSON.stringify({...i,payment:{...p,...update}})));
});
test('payment settlement needs the exact emitted recipient, amount, destination and funding sum',()=>{
 const topics=encodeEventTopics({abi:paymentAbi,eventName:'Paid',args:{token:c.payments.tokenL1,recipient:p.recipient}});
 const log=(amount,from1,from2)=>({address:c.payments.policy,topics,data:encodeAbiParameters([{type:'bool'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[true,amount,from1,from2,100n])});
 assert.deepEqual(settledPayment(c,p,[log(110_000_000n,100_000_000n,10_000_000n)]),{fromL1:'100000000',fromL2:'10000000'});
 assert.equal(settledPayment(c,p,[log(110_000_000n,100_000_000n,9_000_000n)]),undefined);
 assert.equal(settledPayment(c,p,[log(109_000_000n,100_000_000n,9_000_000n)]),undefined);
});

function idleClient({ reset = 1000n, period = 10n, l2Timestamp = 60_599n, sharedEpoch = 101n } = {}) {
 const abi = [...paymentAbi, ...allowanceAbi, ...tokenAbi];
 const config = { ...c, safeL1: address('8'), l1: { rpc: 'l1' }, l2: { rpc: 'l2' },
  payments: { ...c.payments, tokenL2: address('5'), moduleL1: address('6'), moduleL2: address('7'), alias: address('9') } };
 return { config, async rpc(url, method, params) {
  if (method === 'eth_getBlockByNumber') return { number: url === 'l1' ? '0x20' : '0x10', hash: keccak256(stringToHex(url)), timestamp: toHex(url === 'l1' ? 60_600n : l2Timestamp) };
  assert.equal(method, 'eth_call');
  const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
  let result;
  if (functionName === 'balanceOf') result = url === 'l1' ? 200_000_000n : 100_000_000n;
  else if (functionName === 'getTokenAllowance') result = url === 'l1' ? [100_000_000n, 0n, 10n, 1010n, 2n] : [100_000_000n, 50_000_000n, period, reset, 3n];
  else { assert.equal(functionName, 'spent'); assert.equal(args[0], sharedEpoch); result = 0n; }
  return encodeFunctionResult({ abi, functionName, result });
 } };
}
test('an idle settled L2 block does not prevent review in the next L1 budget period', async () => {
 const state = await paymentState(idleClient());
 assert.equal(state.epoch, 101n); assert.equal(state.spent, 0n);
 assert.equal(state.balanceL1, 200_000_000n); assert.equal(state.balanceL2, 100_000_000n);
 assert.deepEqual(state.allowanceL2, [100_000_000n, 0n, 10n, 1010n, 3n]);
 assert.equal(state.observedL2, '16');
 assert.deepEqual(fundingPreview(state, { ...p, epoch: '101' }), { fromL1: 100_000_000n, fromL2: 10_000_000n });
});
test('an idle-period preview still rejects mismatched reset bases, intervals and future state', async () => {
 for (const options of [{ reset: 1001n }, { period: 11n }, { l2Timestamp: 61_200n }])
  await assert.rejects(paymentState(idleClient(options)));
});

test('EEZ-X funding fills local capacity first and preserves the L2 signing domain', () => {
 const payment = { ...p, destination: 'l2', fromL1: '10000000' };
 const state = { ...s, spent: 0n, allowanceL2: [100_000_000n, 0n] };
 assert.deepEqual(fundingPreview(state, payment), { fromL1: 10_000_000n, fromL2: 100_000_000n });
 assert.equal(defaultSplit({ ...state, balanceL2: 20_000_000n }, 110_000_000n, 'l2'),90_000_000n);
 assert.throws(()=>fundingPreview({ ...state, balanceL2: 20_000_000n }, payment),/Insufficient/);
 assert.throws(() => fundingPreview({ ...state, balanceL1: 9_000_000n }, payment), /Insufficient/);
 assert.throws(() => fundingPreview(state, { ...payment, fromL1: '0' }), /Insufficient/);
 const tx = paymentTransaction(c, payment, 5n);
 assert.equal(tx.domain.chainId, BigInt(c.l2.chainId)); assert.equal(tx.domain.verifyingContract, c.safeL2);
 const call = decodeFunctionData({ abi: paymentAbi, data: tx.message.data });
 assert.equal(call.functionName, 'paySplit'); assert.equal(call.args[2], false);

});
test('reverse-payment recovery binds destination and funding and validates the paid event', () => {
 const payment = { ...p, destination: 'l2', fromL1: '10000000' }, tx = paymentTransaction(c, payment, 5n);
 const saved = { version: 1, instance: c.instance, value: '0', payment, nonce: '5', safeHash: safeTransactionHash(tx), data: '0x1234', sender: address('5'), sourceNonce: '0x1', startBlock: '0x1' };
 assert.deepEqual(readIntent(c, JSON.stringify(saved)).payment, payment);
 for (const update of [{ destination: 'l1' }, { fromL1: '0' }]) assert.throws(() => readIntent(c, JSON.stringify({ ...saved, payment: { ...payment, ...update } })));
 const log = { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'Paid', args: { token: c.payments.tokenL1, recipient: p.recipient } }),
  data: encodeAbiParameters([{ type: 'bool' }, ...Array(4).fill({ type: 'uint256' })], [false, 110_000_000n, 10_000_000n, 100_000_000n, 100n]) };
 assert.deepEqual(settledPayment(c, payment, [log]), { fromL1: '10000000', fromL2: '100000000' });
 assert.equal(settledPayment(c, p, [log]), undefined);
});

test('setup can read included L2 configuration while payments retain settled reads', async () => {
 for (const tag of ['safe', 'latest']) {
  const client=idleClient(), original=client.rpc.bind(client), tags=[];
  client.rpc=async (url,method,params)=>{
   if(url==='l2' && method==='eth_getBlockByNumber' && ['safe','latest'].includes(params[0])) tags.push(params[0]);
   return original(url,method,params);
  };
  await paymentState(client,...(tag==='latest'?['latest']:[]));
  assert.deepEqual(tags,[tag]);
 }
});

test('custom split signs exact contributions for either Safe and destination', () => {
 const config = {...c, safeL1:address('6'), l1:{chainId:10200,front:'l1'}, payments:{...c.payments,alias:address('7'),version:2}};
 for(const source of ['l1','l2']) for(const destination of ['l1','l2']) for(const fromL1 of ['0','1','10000000','40000000']) {
  const payment={...p,source,destination,amount:'40000000',fromL1};
  const tx=paymentTransaction(config,payment,5n), call=decodeFunctionData({abi:paymentAbi,data:tx.message.data});
  assert.equal(call.functionName,'paySplit'); assert.deepEqual(call.args,[payment.recipient,40_000_000n,destination==='l1',100n,BigInt(fromL1)]);
  assert.equal(tx.domain.verifyingContract,source==='l1'?config.safeL1:config.safeL2);
  assert.deepEqual(fundingPreview(s,payment),{fromL1:BigInt(fromL1),fromL2:40_000_000n-BigInt(fromL1)});
  const saved={version:1,instance:config.instance,value:'0',payment,nonce:'5',safeHash:safeTransactionHash(tx),data:'0x1234',sender:address('5'),sourceNonce:'0x1',startBlock:'0x1',l2StartBlock:'0x1'};
  assert.deepEqual(readIntent(config,JSON.stringify(saved)),saved);
  assert.throws(()=>readIntent(config,JSON.stringify({...saved,payment:{...payment,fromL1:String((BigInt(fromL1)+1n)%40_000_001n)}})));
 }
 assert.throws(()=>paymentTransaction({...c,payments:{...c.payments,version:0}},{...p,fromL1:'100000000'},5n),/requires a treasury created with the current setup/);
});
test('custom split rejects invalid amounts and capacity instead of redistributing',()=>{
 const payment={...p,amount:'40000000',fromL1:'10000000'};
 for(const fromL1 of [undefined,'-1','40000001','1e6','1.5','0x1']) assert.throws(()=>checkedPayment({...payment,fromL1}));
 assert.throws(()=>checkedPayment({...payment,funding:'combined'}),/Invalid payment review/);
 assert.throws(()=>checkedPayment({...p,kind:'rule',bps:'1000',fromL1:'0'}));
 assert.throws(()=>fundingPreview({...s,allowanceL2:[100_000_000n,80_000_000n]},payment),/Insufficient/);
 assert.throws(()=>fundingPreview({...s,balanceL1:9_999_999n},payment),/Insufficient/);
 assert.throws(()=>fundingPreview({...s,spent:120_000_000n},payment),/Shared budget/);
});
test('custom split settlement rejects a different allocation even when the total matches',()=>{
 const payment={...p,fromL1:'100000000'};
 const topics=encodeEventTopics({abi:paymentAbi,eventName:'Paid',args:{token:c.payments.tokenL1,recipient:p.recipient}});
 const log=fromL1=>({address:c.payments.policy,topics,data:encodeAbiParameters([{type:'bool'},...Array(4).fill({type:'uint256'})],[true,110_000_000n,fromL1,110_000_000n-fromL1,100n])});
 assert.equal(settledPayment(c,payment,[log(90_000_000n)]),undefined);
 assert.deepEqual(settledPayment(c,payment,[log(100_000_000n)]),{fromL1:'100000000',fromL2:'10000000'});
});

test('current payment ABI omits the asset and preserves historical signed transactions', () => {
 const legacy = {...c, safeL1:address('6'), l1:{chainId:10200,front:'l1'}, payments:{...c.payments,alias:address('7'),version:1}};
 const current = {...legacy, payments:{...legacy.payments,version:2}};
 for (const source of ['l1','l2']) for (const destination of ['l1','l2']) {
  const payment = {...p,source,destination,fromL1:'100000000'};
  const before = paymentTransaction(legacy,payment,5n), after = paymentTransaction(current,payment,5n);
  const oldCall = decodeFunctionData({abi:parseAbi(['function paySplit(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch,uint256 fromL1)']),data:before.message.data}), newCall = decodeFunctionData({abi:paymentAbi,data:after.message.data});
  assert.equal(newCall.functionName,oldCall.functionName); assert.deepEqual(newCall.args,oldCall.args.slice(1));
  assert.equal(before.message.data.length-after.message.data.length,64);
  assert.notEqual(safeTransactionHash(before),safeTransactionHash(after));
  const saved = {version:1,instance:c.instance,value:'0',payment,nonce:'5',safeHash:safeTransactionHash(before),data:'0x1234',sender:address('5'),sourceNonce:'0x1',startBlock:'0x1',l2StartBlock:'0x1'};
  assert.deepEqual(readIntent(legacy,JSON.stringify(saved)),saved);
  assert.throws(()=>readIntent(current,JSON.stringify(saved)),/Saved Safe transaction does not match/);
  const changedPolicy = {...current,payments:{...current.payments,policy:address('8'),alias:address('9')}};
  assert.notEqual(safeTransactionHash(paymentTransaction(changedPolicy,payment,5n)),safeTransactionHash(after));
 }
});

// Removed intents must never be converted to fixed payments or submitted on reload.
test('percentage intents are rejected even with a fixed amount or an old capability flag', () => {
 const config = {...c, payments:{...c.payments, version:2, percentageRules:true}};
 const fixed = {...p,fromL1:'100000000'};
 const saved = {version:1,instance:c.instance,value:'0',payment:fixed,nonce:'5',safeHash:safeTransactionHash(paymentTransaction(config,fixed,5n)),data:'0x1234',sender:address('5'),sourceNonce:'0x1',startBlock:'0x1'};
 for (const payment of [
  {kind:'rule',recipient:p.recipient,bps:'1000',destination:'l1',fromL1:'100000000',epoch:p.epoch},
  {...fixed,kind:'rule',bps:'1000'}, {...fixed,bps:'1000'},
 ]) {
  assert.throws(()=>checkedPayment(payment),/Invalid fixed payment/);
  assert.throws(()=>fundingPreview(s,payment),/Invalid fixed payment/);
  assert.throws(()=>paymentTransaction(config,payment,5n),/Invalid fixed payment/);
  assert.throws(()=>readIntent(config,JSON.stringify({...saved,payment})),/Invalid fixed payment/);
  assert.throws(()=>settledPayment(config,payment,[]),/Invalid fixed payment/);
 }
});

const expiryConfig={...c,safeL1:address('8'),l1:{chainId:10200,front:'l1-front'},payments:{...c.payments,bridgeKind:'standard',pair:{version:2,policyL1:address('9'),peerProxyL2:address('a')}}};
test('optional expiry signs a deadline, not the preview period; zero remains valid after resets',()=>{
 const payment={...p,deadline:'0'},tx=paymentTransaction(expiryConfig,payment,5n);
 const decoded=decodeFunctionData({abi:paymentAbi,data:tx.message.data});assert.equal(decoded.args[3],0n);
 assert.equal(safeTransactionHash(tx),safeTransactionHash(paymentTransaction(expiryConfig,{...payment,epoch:'999'},5n)));
 assert.notEqual(safeTransactionHash(tx),safeTransactionHash(paymentTransaction(expiryConfig,{...payment,deadline:'999999'},5n)));
 assert.deepEqual(fundingPreview({...s,epoch:999n},payment),{fromL1:100_000_000n,fromL2:10_000_000n});
 assert.throws(()=>fundingPreview({...s,epoch:999n,spent:150_000_000n},payment),/Shared budget/);
 assert.throws(()=>fundingPreview({...s,epoch:999n,balanceL1:0n},payment),/Insufficient/);
 assert.throws(()=>paymentTransaction(expiryConfig,p,5n),/explicit deadline/);
 assert.throws(()=>paymentTransaction(c,payment,5n),/period-bound/);
});
test('optional deadlines reject malformed values and respect their explicit expiration',()=>{
 for(const deadline of ['-1','1.5','00','',String(1n<<256n),123])assert.throws(()=>checkedPayment({...p,deadline}),/deadline/);
 assert.doesNotThrow(()=>fundingPreview({...s,observedTimestamp:1000n},{...p,deadline:'1000'}));
 assert.throws(()=>fundingPreview({...s,observedTimestamp:1001n},{...p,deadline:'1000'}),/deadline expired/);
 assert.doesNotThrow(()=>fundingPreview({...s,observedTimestamp:9999999999n},{...p,deadline:'0'}));
});
test('new settlement matches execution-period events while old approvals still bind their signed period',()=>{
 const payment={...p,deadline:'0'},log={address:expiryConfig.payments.policy,
  topics:encodeEventTopics({abi:paymentAbi,eventName:'Paid',args:{token:c.payments.tokenL1,recipient:p.recipient}}),
  data:encodeAbiParameters([{type:'bool'},...Array(4).fill({type:'uint256'})],[true,110_000_000n,100_000_000n,10_000_000n,103n])};
 assert.deepEqual(settledPayment(expiryConfig,payment,[log]),{fromL1:'100000000',fromL2:'10000000'});
 assert.equal(settledPayment(c,p,[log]),undefined);
 const tx=paymentTransaction(expiryConfig,payment,5n),intent={version:1,instance:c.instance,value:'0',payment,submissionChain:'l1',l2StartBlock:'0x1',nonce:'5',safeHash:safeTransactionHash(tx),data:'0x1234',sender:address('5'),sourceNonce:'0x1',startBlock:'0x1'};
 assert.deepEqual(readIntent(expiryConfig,JSON.stringify(intent)),intent);
 assert.throws(()=>readIntent(expiryConfig,JSON.stringify({...intent,payment:{...payment,deadline:'1000'}})));
});
test('v2 quotes each local allowance period independently and reads the shared budget on L2',async()=>{
 const client=idleClient({l2Timestamp:60_599n,sharedEpoch:100n});client.config.payments.pair={version:2,policyL1:address('9'),peerProxyL2:address('a')};
 const state=await paymentState(client);
 assert.equal(state.epoch,100n);assert.equal(state.resetsAt,60600);
 assert.equal(state.allowanceL1[3],1010n);assert.equal(state.allowanceL2[3],1000n);
});
