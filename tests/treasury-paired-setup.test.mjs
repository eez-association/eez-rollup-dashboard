// Planner regressions against the genuine packaged paired-policy release.
// These tests do not execute the bytecode or establish native-runtime behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex, zeroHash } from 'viem';
import { MainnetSetup, mainnetSetupStepsFor, pairedSetupAvailable, pairedReleaseVersion, readMainnetSetup } from '../src/lib/treasury/mainnetSetup.ts';
import { paymentAbi, paymentTransaction, settledPayment } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { findIncomingCallEvidence } from '../src/lib/treasury/mainnetSetupRelay.ts';
import { transferAbi } from '../src/lib/treasury/transfers.ts';
const read = path => JSON.parse(readFileSync(path));
const archived = read('src/lib/treasury/deployment-artifacts.json');
const oldMainnet = read('src/lib/treasury/mainnet-artifacts.json');
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`);
const network = read('src/lib/treasury/mainnet-network.json');
const a = n => getAddress(toHex(n, { size: 20 }));
const pairedAbi = parseAbi([
  'constructor(address safe_,address module_,address token_,address bridge_,uint64 l2RollupId_)',
  'function PAIR_VERSION() view returns(uint256)', 'function connectPeer(address)', 'function activate()',
]);
const artifacts = { ...release, contracts: { ...archived.contracts, ...oldMainnet.contracts, ...release.contracts } };
const target = { l1: { rpc: 'l1', front: 'l1-front', explorer: 'https://etherscan.io' },
  l2: { rpc: 'l2', front: 'l2-front', explorer: 'https://explorer.eez.dev' }, fees: { l1: '1', l2: '1' } };
function fixture() {
  const engine = new MainnetSetup(target, artifacts);
  const state = { version: 3, build: release.build, identity: keccak256(toHex(JSON.stringify(network))), salt: zeroHash, deployer: a(1),
    addresses: { safeL1: a(10), safeL2: a(11), moduleL1: a(12), moduleL2: a(13), multiSendL1: a(14), multiSendL2: a(15),
      policyL1: a(16), policy: a(17), alias: a(18), bridgeExecutorL1: a(19), bootstrapL2: a(20) }, code: [], completed: [] };
  engine.io.rpc = async (_chain, method) => { assert.equal(method, 'eth_getTransactionCount'); return '0x1'; };
  engine.io.read = async (_chain, _address, _artifact, method) => ({ sequence: 1n, owner: state.deployer, closed: false })[method];
  return { engine, state };
}
function innerCalls(engine, tx) {
  const decoded = decodeFunctionData({ abi: artifacts.contracts.MultiSendCallOnly.abi, data: tx.message.data });
  assert.equal(decoded.functionName, 'multiSend');
  const bytes = decoded.args[0].slice(2), result = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes.slice(offset, offset + 2), '00');
    const to = getAddress(`0x${bytes.slice(offset + 2, offset + 42)}`);
    assert.equal(BigInt(`0x${bytes.slice(offset + 42, offset + 106)}`), 0n);
    const size = Number(BigInt(`0x${bytes.slice(offset + 106, offset + 170)}`));
    const data = `0x${bytes.slice(offset + 170, offset + 170 + size * 2)}`;
    const abi = [...pairedAbi, ...artifacts.contracts.Safe.abi, ...artifacts.contracts.AllowanceModule.abi, ...artifacts.contracts.StandardBridgeDelegate.abi];
    result.push({ to, ...decodeFunctionData({ abi, data }) });
    offset += 170 + size * 2;
  }
  return result;
}
test('fresh setup requires the packaged paired policy and rejects old journals', () => {
  assert.equal(pairedSetupAvailable(artifacts), true);
  assert.equal(pairedSetupAvailable({ ...release, contracts: { ...release.contracts, PairedTreasuryPolicy: undefined } }), false);
  assert.throws(() => mainnetSetupStepsFor({ version: 2 }), /Legacy treasury setup is retired/);
  assert.match(mainnetSetupStepsFor({ version: 3 })[0].details.join(' '), /local treasury policy/);
  const { state } = fixture();
  assert.equal(readMainnetSetup(JSON.stringify(state)).version, 3);
  assert.throws(() => readMainnetSetup(JSON.stringify({ ...state, build: undefined })), /Invalid Ethereum setup/);
});
test('both policy deployments use the same artifact with local constructor bindings', async () => {
  const { engine, state } = fixture();
  delete state.addresses.policyL1;
  const l1 = await engine.batch(state, '0x2');
  const [l1Actions] = decodeAbiParameters(artifacts.contracts.TreasuryBootstrap.abi.find(x => x.type === 'constructor').inputs,
    `0x${l1.data.slice(artifacts.contracts.TreasuryBootstrap.bytecode.length)}`);
  const l1Policy = l1.outputs.find(o => o.key === 'policyL1');
  assert.equal(l1Policy.artifact, 'PairedTreasuryPolicy');
  assert(!l1.outputs.some(o => o.key === 'bridgeExecutorL1'));
  const constructor = pairedAbi.find(x => x.type === 'constructor').inputs;
  const args1 = decodeAbiParameters(constructor, `0x${l1Actions.at(-1).data.slice(artifacts.contracts.PairedTreasuryPolicy.bytecode.length)}`);
  assert.equal(args1[0].toLowerCase(), state.addresses.safeL1.toLowerCase());
  assert.equal(args1[1].toLowerCase(), state.addresses.moduleL1.toLowerCase());
  assert.equal(args1[2].toLowerCase(), network.contracts.usdcProxy.address.toLowerCase());
  state.addresses.policyL1 = l1Policy.address;
  delete state.addresses.policy;
  state.completed = [{}, {}];
  const l2 = await engine.batch(state, '0x3');
  const actions2 = decodeFunctionData({ abi: artifacts.contracts.TreasuryBootstrap.abi, data: l2.data }).args[1];
  assert.equal(l2.outputs.find(o => o.key === 'policy').artifact, 'PairedTreasuryPolicy');
  const args2 = decodeAbiParameters(constructor, `0x${actions2.at(-1).data.slice(artifacts.contracts.PairedTreasuryPolicy.bytecode.length)}`);
  assert.equal(args2[0].toLowerCase(), state.addresses.safeL2.toLowerCase());
  assert.equal(args2[1].toLowerCase(), state.addresses.moduleL2.toLowerCase());
  assert.equal(args2[2].toLowerCase(), network.contracts.wrappedUSDC.address.toLowerCase());
  assert.equal(args2[4], BigInt(network.rollupId));
});
test('each Safe signs one connection/allowance batch and only the final batch activates', () => {
  const { engine, state } = fixture();
  const review = chain => ({ chain, nonce: '7', moduleEnabled: false });
  for (const chain of ['l1', 'l2']) {
    const tx = engine.tx(state, review(chain)), calls = innerCalls(engine, tx);
    assert.deepEqual(calls.map(c => c.functionName), ['connectPeer', 'enableModule', 'addDelegate', 'setAllowance', ...(chain === 'l2' ? ['activate'] : [])]);
    assert.equal(calls[0].to, state.addresses[chain === 'l1' ? 'policyL1' : 'policy']);
    assert.equal(calls[0].args[0], state.addresses[chain === 'l1' ? 'policy' : 'policyL1']);
    assert.equal(calls[3].args[0], calls[0].to);
    assert.equal(calls[3].args[2], 100_000_000n);
    const changed = { ...state, addresses: { ...state.addresses, policyL1: a(99) } };
    assert.notEqual(safeTransactionHash(tx), safeTransactionHash(engine.tx(changed, review(chain))));
  }
  assert(!innerCalls(engine, engine.tx(state, { ...review('l1'), moduleEnabled: true })).some(c => c.functionName === 'enableModule'));
  assert.throws(() => engine.tx({ ...state, version: 2 }, review('l1')), /paired setup/);
  assert.throws(() => readMainnetSetup(JSON.stringify({ ...state, version: 2 })), /Invalid Ethereum setup/);
});
test('paired signatures and Paid evidence target the initiating chain local policy', () => {
  const p = { version: 2, bridgeKind: 'standard', pair: { version: 1, policyL1: a(16), peerProxyL2: a(21) }, policy: a(17), alias: a(18),
    tokenL1: a(30), bridgeL1: a(31), bridgeL2: a(32) };
  const c = { safeL1: a(10), safeL2: a(11), l1: { chainId: 1, front: 'l1-front' }, l2: { chainId: 10 }, payments: p };
  const payment = { source: 'l1', recipient: a(40), destination: 'l2', epoch: '100', amount: '100000000', fromL1: '60000000' };
  assert.equal(paymentTransaction(c, payment, 7n).message.to, p.pair.policyL1);
  assert.equal(paymentTransaction(c, { ...payment, source: 'l2' }, 7n).message.to, p.policy);
  const log = { address: p.pair.policyL1,
    topics: encodeEventTopics({ abi: paymentAbi, eventName: 'Paid', args: { token: p.tokenL1, recipient: payment.recipient } }),
    data: encodeAbiParameters([{ type: 'bool' }, ...Array(4).fill({ type: 'uint256' })], [false, 100000000n, 60000000n, 40000000n, 100n]) };
  assert.deepEqual(settledPayment(c, payment, [log]), { fromL1: '60000000', fromL2: '40000000' });
  assert.equal(settledPayment(c, payment, [{ ...log, address: p.policy }]), undefined);
});

test('peer-call evidence uses the selected network and rejects ambiguous or missing receipt evidence', async () => {
  const bindings = { registry: a(101), manager: a(102) }, destination = a(103);
  const p = { id: 'paired-payment', chain: 'l1', sender: a(104), to: a(105), nonce: '0x1', data: '0x1234' };
  const h = n => toHex(n, { size: 32 }), callHash = h(1), l1Hash = h(2), l2Hash = h(3);
  const outgoing = { address: bindings.registry,
    topics: encodeEventTopics({ abi: transferAbi, eventName: 'CrossChainCallExecuted', args: { crossChainCallHash: callHash, proxy: p.to } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], [p.sender, p.data, 0n]),
    blockHash: l1Hash, blockNumber: '0x20', transactionHash: h(4) };
  const incoming = { address: bindings.manager,
    topics: encodeEventTopics({ abi: transferAbi, eventName: 'IncomingCrossChainCallExecuted', args: { crossChainCallHash: callHash } }),
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'address' }, { type: 'uint64' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes' }], [false, p.sender, 0n, destination, 0n, 8000000n, p.data]),
    blockHash: l2Hash, blockNumber: '0x30', transactionHash: h(5) };
  const source = { blockHash: l1Hash, blockNumber: '0x20', logs: [outgoing] };
  async function evidence({ duplicate = false, omitted = false, canonical = true, safeHeight = '0x30', start = '0x0', ranges = [] } = {}) {
    const io = { async rpc(chain, method, params) {
      if (method === 'eth_getLogs') {
        assert.equal(params[0].address, chain === 'l1' ? bindings.registry : bindings.manager);
        if (chain === 'l1') return duplicate ? [outgoing, outgoing] : [outgoing];
        const { fromBlock, toBlock } = params[0];
        ranges.push([fromBlock, toBlock]);
        assert(BigInt(toBlock) - BigInt(fromBlock) < 4096n);
        return BigInt(fromBlock) <= BigInt(incoming.blockNumber) && BigInt(toBlock) >= BigInt(incoming.blockNumber) ? [incoming] : [];
      }
      if (method === 'eth_getBlockByNumber') return params[0] === 'safe' ? { number: safeHeight } : chain === 'l1'
        ? { hash: l1Hash, number: '0x20' } : { hash: l2Hash, number: '0x30' };
      if (method === 'eez_getSettlementByL2Block') return { canonicalL2: canonical, l1BlockHash: l1Hash,
        l1BlockNumber: '0x20', l2Blocks: [{ hash: l2Hash, number: '0x30' }] };
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockHash: l2Hash, logs: omitted ? [] : [incoming] };
      assert.fail(method);
    } };
    return findIncomingCallEvidence(io, destination, p, source, bindings, start);
  }
  assert.equal((await evidence()).transactionHash, incoming.transactionHash);
  assert.equal(await evidence({ omitted: true }), null);
  assert.equal(await evidence({ canonical: false }), null);
  await assert.rejects(evidence({ duplicate: true }), /Ambiguous cross-chain source call/);
  const ranges = [];
  assert.equal((await evidence({ safeHeight: '0x2030', start: '0x20', ranges })).transactionHash, incoming.transactionHash,
    'a payment remains recoverable after more than 4096 L2 blocks');
  assert.deepEqual(ranges, [['0x20', '0x101f'], ['0x1020', '0x201f'], ['0x2020', '0x2030']]);
  assert.equal(await evidence({ start: '0x31' }), null, 'never accept events before the recorded submission point');
  assert.equal(await evidence({ safeHeight: '0x2f' }), null, 'never accept events above the safe head');
  await assert.rejects(evidence({ start: 'latest' }), /Invalid incoming-call recovery block/);
});

test('create-both journals resume before L1 exists and require it after the first confirmation', () => {
  const {state} = fixture(); state.creation = 'create-both'; delete state.addresses.safeL1;
  assert.equal(readMainnetSetup(JSON.stringify(state)).creation,'create-both');
  assert.throws(()=>readMainnetSetup(JSON.stringify({...state,creation:'other'})),/Invalid Ethereum setup/);
  assert.throws(()=>readMainnetSetup(JSON.stringify({...state,creation:undefined})),/Invalid Ethereum setup/);
  const completed=[{hash:zeroHash,blockHash:zeroHash,number:'0x1',chain:'l1'}];
  assert.throws(()=>readMainnetSetup(JSON.stringify({...state,completed})),/Invalid Ethereum setup/);
  assert.match(mainnetSetupStepsFor(state)[0].label,/Create/);
  assert.match(mainnetSetupStepsFor(state)[5].details[0],/Replace the wallet owner/);
});
test('both fresh Safe initializers explicitly use the selected wallet, never the bootstrap caller', async () => {
  const {engine,state}=fixture();state.creation='create-both';state.deployer=a(55);
  delete state.addresses.safeL1;delete state.addresses.safeL2;
  state.addresses.singletonL1=a(56);state.addresses.factoryL1=a(57);
  const read=engine.io.read;engine.io.read=async(...args)=>args[3]==='proxyCreationCode'?artifacts.contracts.SafeProxyFactory.proxyCreationCode:read(...args);
  for(const chain of ['l1','l2']){
    state.completed=chain==='l1'?[]:[{}];
    const batch=await engine.batch(state,'0x10');
    const args=decodeAbiParameters(artifacts.contracts.TreasuryBootstrap.abi.find(x=>x.type==='constructor').inputs,`0x${batch.data.slice(artifacts.contracts.TreasuryBootstrap.bytecode.length)}`);
    const actions=args.at(-1),creation=actions.filter(x=>!x.create).map(x=>{try{return decodeFunctionData({abi:artifacts.contracts.SafeProxyFactory.abi,data:x.data});}catch{return null;}}).find(x=>x?.functionName==='createProxyWithNonce');
    assert(creation);
    const init=decodeFunctionData({abi:artifacts.contracts.Safe.abi,data:creation.args[1]});
    assert.deepEqual(init.args[0],[state.deployer]);assert.equal(init.args[1],1n);
    assert.notEqual(init.args[0][0],batch.executor);
    if(chain==='l1')state.addresses.safeL1=batch.outputs.find(x=>x.key==='safeL1').address;
  }
});
test('fresh L2 first approval batches owner handover before peer connection and activation', () => {
  const {engine,state}=fixture();state.creation='create-both';state.addresses.adapter=a(50);state.deployer=a(51);
  const r={chain:'l2',nonce:'0',moduleEnabled:false};
  const calls=innerCalls(engine,engine.tx(state,r));
  assert.deepEqual(calls.map(x=>x.functionName),['swapOwner','connectPeer','enableModule','addDelegate','setAllowance','activate']);
  assert.equal(calls[0].to,state.addresses.safeL2);
  assert.deepEqual(calls[0].args,[a(1),state.deployer,state.addresses.adapter]);
  assert(!innerCalls(engine,engine.tx(state,{...r,chain:'l1'})).some(c=>c.functionName==='swapOwner'));
  assert.notEqual(safeTransactionHash(engine.tx(state,r)),safeTransactionHash(engine.tx({...state,creation:undefined},r)));
});

const {matchingSafePlan,matchingDeployer,matchingDeployerRuntime}=await import('../src/lib/treasury/matchingSafes.ts');
test('matching Safe plan is independent of wallet transaction nonces and binds owner/salt/release',()=>{
 const one=matchingSafePlan(a(60),zeroHash,artifacts),two=matchingSafePlan(a(60),zeroHash,artifacts);
 assert.deepEqual(one,two);
 assert.notEqual(one.safe,matchingSafePlan(a(61),zeroHash,artifacts).safe);
 assert.notEqual(one.safe,matchingSafePlan(a(60),toHex(1n,{size:32}),artifacts).safe);
 assert.notEqual(one.safe,matchingSafePlan(a(60),zeroHash,{...artifacts,contracts:{...artifacts.contracts,Safe:{...artifacts.contracts.Safe,bytecode:'0x6000'}}}).safe);
});
test('matching setup keeps all six steps within creation limits and moves L1 policy into step four',async()=>{
 const {engine,state}=fixture();state.creation='create-both';state.deployer=a(60);state.addresses={};state.matching=matchingSafePlan(state.deployer,state.salt,artifacts);
 engine.io.rpc=async(_chain,method,params)=>method==='eth_getCode'?(params[0].toLowerCase()===matchingDeployer.toLowerCase()?matchingDeployerRuntime:'0x'):'0x1';
 engine.io.read=async(_chain,_address,_artifact,method,args)=>method==='computeCrossChainProxyAddress'?args[0]:({sequence:1n,owner:state.deployer,closed:false})[method];
 for(let step=0;step<4;step++){
  state.completed=Array.from({length:step},()=>({}));const batch=await engine.batch(state,toHex(step+20));
  if(step<2)assert((batch.data.length-2)/2<=49152);
  if(step===0){assert(!batch.outputs.some(o=>o.key==='policyL1'||o.key==='moduleL1'));assert.equal(batch.outputs.find(o=>o.key==='safeL1').address,state.matching.safe);}
  if(step===1)assert.equal(batch.outputs.find(o=>o.key==='safeL2').address,state.matching.safe);
  if(step===3){assert(batch.outputs.some(o=>o.key==='policyL1'));assert(batch.outputs.some(o=>o.key==='moduleL1'));}
  Object.assign(state.addresses,Object.fromEntries(batch.outputs.map(o=>[o.key,o.address])));
 }
 assert.equal(state.addresses.safeL1,state.addresses.safeL2);
 assert.match(mainnetSetupStepsFor(state)[3].details[0],/Deploy the Ethereum policy/);
 assert.throws(()=>readMainnetSetup(JSON.stringify({...state,completed:[],addresses:{},matching:{...state.matching,version:2}})),/Invalid matching Safe plan/);
});

test('new releases select optional expiry while retained paired releases keep epoch signing',()=>{
 assert.equal(pairedReleaseVersion(artifacts),2);
 const previous=read('src/lib/treasury/builds/1d5f54a1c619b6efc34101e494bbad0d11f3a77ae647d02863af8089e8fe84fb.json');
 assert.equal(pairedReleaseVersion(previous),1);
});
