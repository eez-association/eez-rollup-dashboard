import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEventTopics, encodeAbiParameters, parseAbi, parseAbiParameters } from 'viem';
import { VerificationWorker, creations, loadBuilds, loadAdditionalSources, publicJob } from '../scripts/verification/worker.mjs';
import { appendSourceRequest, sourceRequests, deliverSourceRequest, retainSourceRequests } from '../src/lib/treasury/sourceVerification.ts';
import { blockscoutApiUrl, verificationEndpoint } from '../scripts/verification/network.mjs';
const build = 'ab'.repeat(32), tx = '0x'+'12'.repeat(32), blockHash = '0x'+'34'.repeat(32), address = '0x'+'56'.repeat(20);
const runtime = '0x60006000556001a164736f6c6343000822000a';
const artifact = { runtime, bytecode: '0x6000', immutables: [], immutableGroups: [], input: 'source', compiler: '0.8.34+commit.80d5c536', target: 'A.sol:A' };
const manifest = { contracts: { A: artifact }, inputs: { source: { language:'Solidity', sources: {'A.sol':{content:'contract A {}'}}, settings:{} } } };
const request = { build, chainId: 906969, transactionHash: tx };
function fixture(t, change = {}) {
  mkdirSync('.runtime/treasury-auto-verification-20261022', { recursive: true });
  const directory = mkdtempSync('.runtime/treasury-auto-verification-20261022/test-');
  const state = { time: 1_000_000, code: runtime, parentCode: '0x', receipt: { status:'0x1', blockNumber:'0x20', blockHash, contractAddress:address, logs:[] },
    chainId: request.chainId, block: blockHash, explorer: { is_verified:false, is_partially_verified:false }, posts:[], calls:[], sourcify: null, fail:false, ...change };
  const fetcher = async (url, options={}) => {
    state.calls.push(url);
    if (url === 'https://rpc.invalid') {
      const {method,params} = JSON.parse(options.body);
      const results = { eth_chainId:'0x'+state.chainId.toString(16), eth_getTransactionReceipt: state.receipt,
        eth_getBlockByNumber: {hash:state.block}, eth_getCode: params[1]==='0x1f'?state.parentCode:state.code };
      return Response.json({result:results[method]});
    }
    if(state.fail) return new Response('',{status:503});
    if(options.method==='POST') { state.posts.push({url,body:options.body}); return Response.json(url.includes('sourcify')?{verificationId:'job-1'}:{message:'Smart-contract verification started'}); }
    if(url.includes('sourcify')) return Response.json(state.sourcify ?? {isJobCompleted:false});
    return Response.json({...state.explorer,deployed_bytecode:state.code});
  };
  const config = { directory, builds:{[build]:manifest}, networks:{[state.chainId]:{rpc:'https://rpc.invalid',explorerApi:'https://explorer.invalid/api'}}, fetcher, now:()=>state.time };
  return {state,config,worker:new VerificationWorker(config)};
}
test('explorer website roots and explicit API bases normalize to the same Blockscout endpoint', () => {
  for (const path of ['/explorer', '/explorer/', '/explorer/api', '/explorer/api/', '/explorer/api/v2'])
    assert.equal(blockscoutApiUrl(`https://example.invalid${path}`, '', 'http://127.0.0.1:8083'), 'https://example.invalid/explorer/api');
  assert.equal(blockscoutApiUrl('', 'https://example.invalid', ''), 'https://example.invalid/api');
  assert.equal(blockscoutApiUrl('', '', 'http://127.0.0.1:8083'), '');
});
test('verification routes preserve configured API query parameters without corrupting the path', () => {
  const base = blockscoutApiUrl('https://example.invalid/explorer?key=fixture#ignored', '', '');
  const url = new URL(verificationEndpoint(base, 'v2/smart-contracts/0x1234'));
  assert.equal(url.pathname, '/explorer/api/v2/smart-contracts/0x1234');
  assert.equal(url.searchParams.get('key'), 'fixture'); assert.equal(url.hash, '');
});
test('accepted explorer publications stay on short polls and manual retry preserves the job', async t => {
  const { state, worker } = fixture(t), job = worker.enqueue(request);
  job.attempts = 12; await worker.tick();
  assert.equal(job.nextAttempt - state.time, 15000);
  const copy = JSON.stringify(job.contracts); worker.retry(job.id);
  assert.equal(job.nextAttempt, 0); assert.equal(job.attempts, 0); assert.equal(JSON.stringify(job.contracts), copy);
  worker.processing = job.id; job.nextAttempt = 999; worker.retry(job.id); assert.equal(job.nextAttempt, 999);
});
test('supplemental sources verify factory children without changing the requested deployment build', async t => {
  const sources = loadAdditionalSources('verification/supplemental'); assert(sources.length);
  const a = sources[0], { state, config } = fixture(t, { code: a.runtime });
  const worker = new VerificationWorker({ ...config, additionalSources: sources }), job = await worker.admit(request);
  assert.equal(job.request.build, build); await worker.tick();
  assert.equal(job.contracts[0].name, 'CrossChainProxy'); assert.equal(job.contracts[0].status, 'pending');
  const submitted = JSON.parse(await state.posts[0].body.get('files[0]').text()); assert.deepEqual(submitted, a.sourceInput);
});
test('receipt discovery includes nested creation, Safe factories, aliases, wrapped tokens and claim transfers', () => {
  const abis = parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)',
    'event CrossChainProxyCreated(address indexed proxy,address indexed originalAddress,uint64 indexed originalRollupId)',
    'event WrappedTokenDeployed(address indexed wrappedToken,address indexed originalToken,uint64 indexed originalRollupId)',
    'event ProxyCreation(address indexed proxy,address singleton)']);
  const targets = [1,2,3,4,5].map(n=>'0x'+n.toString(16).padStart(40,'0'));
  const logs = [
    {eventName:'Created',args:{index:0n,target:targets[1]},data:encodeAbiParameters(parseAbiParameters('bytes32'),[tx])},
    {eventName:'CrossChainProxyCreated',args:{proxy:targets[2],originalAddress:address,originalRollupId:1n},data:'0x'},
    {eventName:'WrappedTokenDeployed',args:{wrappedToken:targets[3],originalToken:address,originalRollupId:0n},data:'0x'},
    {eventName:'ProxyCreation',args:{proxy:targets[4]},data:encodeAbiParameters(parseAbiParameters('address'),[address])},
  ].map(e=>({address, topics:encodeEventTopics({abi:abis,eventName:e.eventName,args:e.args}),data:e.data}));
  assert.deepEqual(creations({contractAddress:targets[0],logs}).map(x=>x.address),targets);
});
test('a queued explorer response is pending; deduplicated delivery survives restart and later completes', async t => {
  const {state,worker,config} = fixture(t);
  const job = worker.enqueue(request); assert.equal(worker.enqueue(request),job);
  await worker.tick(); assert.equal(job.status,'pending'); assert.equal(state.posts.length,1);
  assert.equal(readdirSync(config.directory).filter(x=>x.endsWith('.json')).length,1);
  const resumed = new VerificationWorker(config); state.time+=16000;
  await resumed.tick(); assert.equal(state.posts.length,1,'do not resubmit an already queued verification');
  state.explorer={is_verified:true,is_partially_verified:false};state.time+=31000;await resumed.tick();
  assert.equal(resumed.jobs.get(job.id).status,'verified'); assert.equal(state.posts.length,1);
  assert(!JSON.stringify(publicJob(job)).includes(runtime));
});
test('metadata-only runtime changes are rejected before publishing any sources', async t=>{
  const {state,worker}=fixture(t,{code:runtime.slice(0,-2)+'ff'});const job=worker.enqueue(request);await worker.tick();
  assert.equal(job.status,'source-unavailable');assert.equal(state.posts.length,0);
});
test('foreign chain IDs and noncanonical receipts cannot authorize source publication', async t=>{
  const {state,worker}=fixture(t);const job=worker.enqueue(request);state.chainId=1;await worker.tick();
  assert.equal(job.status,'retrying');assert.equal(state.posts.length,0);
  state.chainId=request.chainId;state.block='0x'+'78'.repeat(32);state.time+=16000;await worker.tick();
  assert.equal(job.status,'retrying');assert.equal(state.posts.length,0);
});
test('provider outages retain a retryable job, and stale verification is rechecked after a reorg', async t=>{
  const {state,worker,config}=fixture(t,{fail:true});const job=worker.enqueue(request);await worker.tick();
  assert.equal(job.status,'pending');assert.equal(new VerificationWorker(config).jobs.size,1);
  state.fail=false;state.explorer={is_verified:true,is_partially_verified:false};state.time+=16000;await worker.tick();assert.equal(job.status,'verified');
  state.block='0x'+'78'.repeat(32);state.time+=24*60*60_000;await worker.tick();assert.equal(job.status,'retrying');
  assert(publicJob(job).contracts.every(c=>c.status!=='verified'));
});
test('partial explorer and Sourcify matches never count as exact verification', async t=>{
  const {state,worker}=fixture(t,{chainId:10200,explorer:{is_verified:true,is_partially_verified:true},sourcify:{isJobCompleted:true,contract:{runtimeMatch:'match',creationMatch:null}}});
  const job=worker.enqueue({...request,chainId:10200});await worker.tick();assert.equal(job.status,'pending');
  state.sourcify={isJobCompleted:true,contract:{runtimeMatch:'exact_match',creationMatch:null}};state.time+=16000;await worker.tick();
  assert.equal(job.status,'sourcify-verified');assert.notEqual(job.contracts[0].explorer,'verified');
});
test('failed deployment receipts do not publish contracts', async t=>{
  const {state,worker}=fixture(t);state.receipt.status='0x0';const job=worker.enqueue(request);await worker.tick();
  assert.equal(job.status,'reverted');assert.equal(state.posts.length,0);
});
test('the worker admits only retained builds, configured chains and transaction hashes', t=>{
  const {worker}=fixture(t);
  for(const invalid of [{...request,build:'../secrets'},{...request,chainId:1},{...request,transactionHash:'https://other.invalid'}])assert.throws(()=>worker.enqueue(invalid));
});
test('release bundles retain compiler inputs for every new deployment artifact',()=>{
  const builds=loadBuilds('verification/builds');const current=JSON.parse(readFileSync('src/lib/treasury/current-build.json')).build;
  const bundle=JSON.parse(readFileSync(`src/lib/treasury/builds/${current}.json`));
  assert.deepEqual(Object.keys(bundle.contracts).sort(), ['Safe','SafeL2','SafeProxyFactory','SafeProxy','AllowanceModule','MultiSendCallOnly',
    'L1Owners','TreasuryBootstrap','PairedTreasuryPolicy','TestUSDC','WrappedToken','Bridge'].sort());
  assert.equal(bundle.contracts.InvoiceMerchant, undefined);
  for (const name of ['PairedTreasuryPolicy']) {
    const abi=bundle.contracts[name].abi;
    assert.equal(abi.find(x=>x.type==='constructor').inputs.length,5);
    assert(abi.some(x=>x.name==='paySplit'));
    assert(!abi.some(x=>['payRule','RulePaid','BPS_DENOMINATOR','InvalidFraction'].includes(x.name)));
    assert(!abi.some(x=>x.name==='pay' || x.name==='payRouted'));
    assert(!abi.some(x=>/invoice/i.test(x.name??'')));
    for (const method of ['PAIR_VERSION','connectPeer','activate','payFromPeer']) assert(abi.some(x=>x.name===method));
  }
  for(const [name,a] of Object.entries(bundle.contracts)){const v=builds[current].contracts[name];assert.equal(a.runtime,v.runtime);assert.equal(a.bytecode,v.bytecode);assert(builds[current].inputs[v.input]);}
  assert(bundle.contracts.SafeProxyFactory.runtime.includes(bundle.contracts.SafeProxy.bytecode.slice(2)));
  assert(Object.values(builds[current].inputs).every(i=>Object.keys(i.sources).every(p=>!p.startsWith('/'))),'source paths must be portable');
});
test('confirmation outbox ignores historical and incomplete setup, survives delivery failure',async()=>{
  assert.equal(appendSourceRequest(undefined,undefined,906969,tx),undefined);
  const outbox=appendSourceRequest(undefined,build,906969,tx);
  const entries=new Map([['eez:treasury:deployment:new',JSON.stringify({sourceRequests:outbox})],['eez:treasury:deployment:old',JSON.stringify({transactions:[tx]})]]);
  const storage={length:entries.size,key:i=>[...entries.keys()][i],getItem:key=>entries.get(key)};
  assert.deepEqual(sourceRequests(storage),outbox);
  await assert.rejects(deliverSourceRequest(outbox[0],'/jobs',async()=>new Response('',{status:503})),/retry automatically/);
  assert.deepEqual(sourceRequests(storage),outbox);
});

test('starting another treasury retains undelivered verification independently of setup history', () => {
  const data = new Map(), storage = {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),key:i=>[...data.keys()][i],get length(){return data.size}};
  const requests = appendSourceRequest(undefined,build,906969,tx);
  storage.setItem('eez:treasury:deployment:test', JSON.stringify({sourceRequests:requests}));
  retainSourceRequests(storage,requests); retainSourceRequests(storage,requests);
  data.delete('eez:treasury:deployment:test'); assert.deepEqual(sourceRequests(storage),requests);
});
test('changing configured networks does not discard old queued work or prevent a worker restart', t => {
  const {worker, config} = fixture(t); const job=worker.enqueue(request);
  const other = new VerificationWorker({...config, networks:{10200:config.networks[906969]}});
  assert(other.jobs.has(job.id));assert.throws(()=>other.enqueue(request),/Unknown/);
});

test('public admission does not store unknown or unmined transaction hashes', async t => {
  const {state,worker}=fixture(t);state.receipt=null;
  await assert.rejects(worker.admit(request),/canonical receipt/);assert.equal(worker.jobs.size,0);
});

test('already fully verified factory output is reused only when explorer and chain bytes agree', async t => {
  const {state,worker}=fixture(t,{code:'0x600000',explorer:{is_verified:true,is_partially_verified:false,name:'PreviouslyVerifiedFactoryChild'}});
  const job=worker.enqueue(request);await worker.tick();assert.equal(job.status,'verified');assert.equal(state.posts.length,0);
});


test('configuration-only confirmations do not create verification jobs or claim verification', async t => {
  const {state,worker,config}=fixture(t);
  state.receipt.contractAddress=null;
  const result=await worker.admit(request);
  assert.equal(result.status,'not-applicable');assert.equal(worker.jobs.size,0);
  assert.equal(readdirSync(config.directory).filter(x=>x.endsWith('.json')).length,0);
  assert.equal(state.posts.length,0);
});
test('unknown deployment bytes cannot consume the public queue', async t => {
  const {state,worker,config}=fixture(t,{code:'0x600100'});
  const result=await worker.admit(request);
  assert.equal(result.status,'source-unavailable');assert.equal(worker.jobs.size,0);
  assert.equal(readdirSync(config.directory).length,0);assert.equal(state.posts.length,0);
});
test('creation events naming an existing known contract cannot consume queue space', async t => {
  const {state,worker}=fixture(t,{parentCode:runtime});
  state.receipt.contractAddress=null;
  state.receipt.logs=[{address,topics:encodeEventTopics({abi:parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)']),eventName:'Created',args:{index:0n,target:address}}),data:tx}];
  const result=await worker.admit(request);assert.equal(result.status,'not-applicable');assert.equal(worker.jobs.size,0);
});
test('an exact new deployment is admitted and duplicate delivery does not repeat RPC work',async t=>{
  const {state,worker}=fixture(t);const result=await worker.admit(request);
  assert.equal(result.status,'queued');assert.equal(worker.jobs.size,1);
  const calls=state.calls.length;assert.equal(await worker.admit(request),result);assert.equal(state.calls.length,calls);
});
test('completed jobs release bounded queue capacity while unresolved jobs survive restart',async t=>{
  const {state,config}=fixture(t,{explorer:{is_verified:true,is_partially_verified:false}});
  const worker=new VerificationWorker({...config,capacity:2});
  const first=await worker.admit(request);await worker.tick();assert.equal(first.status,'verified');
  const second=await worker.admit({...request,transactionHash:'0x'+'22'.repeat(32)});
  state.time+=1000;
  const third=await worker.admit({...request,transactionHash:'0x'+'33'.repeat(32)});
  assert.equal(worker.jobs.size,2);assert(!worker.jobs.has(first.id));assert(worker.jobs.has(second.id));assert(worker.jobs.has(third.id));
  assert.equal(readdirSync(config.directory).filter(x=>x.endsWith('.json')).length,2);
  const resumed=new VerificationWorker({...config,capacity:2});assert.equal(resumed.jobs.size,2);
  await assert.rejects(resumed.admit({...request,transactionHash:'0x'+'44'.repeat(32)}),/queue is full/);
  assert.equal(resumed.jobs.get(second.id).status,'queued');
});


test('capacity pressure cannot evict a completed job while canonical rechecking owns it', async t => {
  const {state,config}=fixture(t,{explorer:{is_verified:true,is_partially_verified:false}});
  let hold=false, entered, release;
  const waiting=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  const fetcher=async(url,options)=>{
    if(hold && url==='https://rpc.invalid' && JSON.parse(options.body).method==='eth_chainId'){
      hold=false;entered();await gate;
    }
    return config.fetcher(url,options);
  };
  const worker=new VerificationWorker({...config,fetcher,capacity:1});
  const job=await worker.admit(request);await worker.tick();assert.equal(job.status,'verified');
  state.time+=24*60*60_000;hold=true;const running=worker.tick();await waiting;
  try { await assert.rejects(worker.admit({...request,transactionHash:'0x'+'22'.repeat(32)}),/queue is full/); }
  finally {release();await running;}
  assert.equal(worker.jobs.size,1);assert(worker.jobs.has(job.id));
});
