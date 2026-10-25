import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getContractAddress, toHex, zeroAddress } from 'viem';
import { TestnetAsset, CLAIM_AMOUNT, readAssetJournal } from '../src/lib/treasury/testnetAsset.ts';
import { MainnetSetup, setupIdentity } from '../src/lib/treasury/mainnetSetup.ts';
import { transferAbi } from '../src/lib/treasury/transfers.ts';
const read = path => JSON.parse(readFileSync(path));
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`);
const a = n => toHex(n, { size: 20 }), h = n => toHex(n, { size: 32 });
const target = { l1: { rpc: 'http://127.0.0.1:1', front: 'http://127.0.0.1:1', explorer: 'https://example.com' },
  l2: { rpc: 'http://127.0.0.1:2', front: 'http://127.0.0.1:2', explorer: 'https://example.com' }, fees: { l1: '100', l2: '100' } };
const fixture = () => new TestnetAsset(target, release, a(1), a(2));
test('active release contains only the current treasury, normal bridge and fixed faucet contracts', () => {
  for (const name of ['PairedTreasuryPolicy','TestUSDC','Bridge']) assert(release.contracts[name]);
  for (const name of ['TreasuryPolicy','StandardBridgeTreasuryPolicy','StandardBridgeDelegate','TreasuryAliasReader','SharedTreasuryBridge','SharedTestUSDC','TestUSDCFaucet','TestUSDCClaim']) assert.equal(release.contracts[name], undefined);
});
test('testnet deploys genuine TestUSDC and claims cannot encode an arbitrary amount', () => {
  const d = fixture(), artifact = release.contracts.TestUSDC;
  const creation = d.data('deploy', a(3));
  const args = decodeAbiParameters(artifact.abi.find(x => x.type === 'constructor').inputs, `0x${creation.slice(artifact.bytecode.length)}`);
  assert.deepEqual(args.map(String), [a(1), '1']);
  for (const [kind, method] of [['l1','claim'], ['l2','claimOnL2']]) {
    const call = decodeFunctionData({ abi: artifact.abi, data: d.data(kind, a(3)) });
    assert.equal(call.functionName, method); assert.deepEqual(call.args, [a(3)]);
  }
  assert.equal(CLAIM_AMOUNT, 1_000_000_000n);
});
test('retired test tokens and mismatched immutable faucet bindings are rejected', async () => {
  for (const patch of [{}, { bridgeL1: a(9) }, { destinationRollup: 2n }, { MAX_REQUEST_AMOUNT: 450_000_000n }, { code: '0x6000' }]) {
    const d = fixture();
    d.rpc = async () => patch.code ?? release.contracts.TestUSDC.runtime;
    d.read = async (_chain, _token, _abi, method) => ({ bridgeL1: a(1), destinationRollup: 1n, MAX_REQUEST_AMOUNT: CLAIM_AMOUNT, ...patch })[method];
    if (Object.keys(patch).length) await assert.rejects(d.validateToken(a(4)), /current fixed/);
    else await d.validateToken(a(4));
  }
});
test('asset recovery preserves pending identity and only accepts the exact canonical fixed mint', async () => {
  const d = fixture(), token = a(4), recipient = a(5);
  const p = { id: 'l1', kind: 'l1', chain: 'l1', sender: a(3), nonce: '0x2', data: d.data('l1', recipient),
    token, to: token, recipient, l2StartBlock: '0x10', hash: h(9), build: release.build };
  const journal = { token, pending: p };
  assert.deepEqual(readAssetJournal(JSON.stringify(journal)), journal);
  assert.throws(() => readAssetJournal(JSON.stringify({ ...journal, pending: { ...p, to: a(99) } })), /Invalid saved/);
  const mint = amount => ({ address: token, topics: encodeEventTopics({ abi: release.contracts.TestUSDC.abi, eventName: 'Transfer', args: { from: zeroAddress, to: recipient } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
  let canonical = true, amount = CLAIM_AMOUNT;
  d.trackPending = async s => s;
  d.rpc = async (_chain, method) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x20', blockHash: h(1), logs: [mint(amount)] };
    if (method === 'eth_getTransactionByHash') return { from: p.sender, to: p.to, input: p.data, nonce: p.nonce, value: '0x0' };
    if (method === 'eth_getBlockByNumber') return { hash: canonical ? h(1) : h(2) };
    assert.fail(method);
  };
  assert.equal((await d.reconcile(journal)).pending, undefined);
  canonical = false; assert.equal((await d.reconcile(journal)).pending, p);
  canonical = true; amount = 450_000_000n; await assert.rejects(d.reconcile(journal), /exact 1,000-token mint/);
  await assert.rejects(d.reconcile({ ...journal, pending: { ...p, data: '0x1234' } }), /another contract release/);
});
test('testnet uses both local paired-policy constructors and never a treasury bridge or delegate', async () => {
  const mainnet = read('src/lib/treasury/mainnet-network.json');
  const network = { ...mainnet, testnet: true, chains: { ...mainnet.chains, l1: { ...mainnet.chains.l1, chainId: 10200 } },
    contracts: { ...mainnet.contracts, usdcProxy: { ...mainnet.contracts.usdcProxy, address: a(30) }, wrappedUSDC: { ...mainnet.contracts.wrappedUSDC, address: a(31) } } };
  const engine = new MainnetSetup(target, release, network);
  const state = { version: 3, build: release.build, identity: setupIdentity(network), salt: h(1), deployer: a(3), addresses: { safeL1: a(10), safeL2: a(11) }, code: [], completed: [] };
  engine.io.read = async (_chain, _address, _abi, method) => ({ owner: state.deployer, closed: false, sequence: 1n })[method];
  engine.io.rpc = async () => '0x1';
  const first = await engine.batch(state, '0x2');
  assert.deepEqual(first.outputs.map(x => x.artifact), ['TreasuryBootstrap','AllowanceModule','MultiSendCallOnly','PairedTreasuryPolicy']);
  const [actions] = decodeAbiParameters(release.contracts.TreasuryBootstrap.abi.find(x => x.type === 'constructor').inputs, `0x${first.data.slice(release.contracts.TreasuryBootstrap.bytecode.length)}`);
  const artifact = release.contracts.PairedTreasuryPolicy;
  const args = decodeAbiParameters(artifact.abi.find(x => x.type === 'constructor').inputs, `0x${actions.at(-1).data.slice(artifact.bytecode.length)}`);
  assert.equal(args[0].toLowerCase(), state.addresses.safeL1.toLowerCase()); assert.equal(args[2].toLowerCase(), a(30));
  state.addresses.bootstrapL2 = getContractAddress({ from: state.deployer, nonce: 3n }); state.completed = [{}, {}];
  const second = await engine.batch(state, '0x3');
  assert.deepEqual(second.outputs.map(x => x.artifact), ['AllowanceModule','PairedTreasuryPolicy']);
  await assert.rejects(engine.batch({ ...state, version: 2 }, '0x3'), /paired setup/);
});

test('L2 fixed claims require the exact canonical bridge call and wrapped mint', async () => {
  const d = fixture(), profile = read('src/lib/treasury/shared-network.json'), token = a(4), recipient = a(5), wrapped = a(7);
  const p = { id:'l2',kind:'l2',chain:'l1',sender:a(3),nonce:'0x2',data:d.data('l2',recipient),token,to:token,recipient,l2StartBlock:'0x10',hash:h(9),build:release.build };
  const journal = { token,pending:p }, callHash = h(100), peerData = '0x1234';
  const outgoing = { address:profile.registry, topics:encodeEventTopics({abi:transferAbi,eventName:'CrossChainCallExecuted',args:{crossChainCallHash:callHash,proxy:a(8)}}),
    data:encodeAbiParameters([{type:'address'},{type:'bytes'},{type:'uint256'}],[a(1),peerData,0n]),blockHash:h(1),blockNumber:'0x20',transactionHash:p.hash };
  const incoming = { address:profile.manager, topics:encodeEventTopics({abi:transferAbi,eventName:'IncomingCrossChainCallExecuted',args:{crossChainCallHash:callHash}}),
    data:encodeAbiParameters([{type:'bool'},{type:'address'},{type:'uint64'},{type:'address'},{type:'uint256'},{type:'uint64'},{type:'bytes'}],[false,a(1),0n,a(2),0n,8_000_000n,peerData]),blockHash:h(2),blockNumber:'0x30',transactionHash:h(10) };
  const mint = { address:wrapped,topics:encodeEventTopics({abi:release.contracts.TestUSDC.abi,eventName:'Transfer',args:{from:zeroAddress,to:recipient}}),data:encodeAbiParameters([{type:'uint256'}],[CLAIM_AMOUNT]) };
  let missing = false, canonical = true, wrongToken = false, omitted = false;
  d.trackPending = async s => s;
  d.read = async () => wrapped;
  d.rpc = async (chain,method,params) => {
    if (method === 'eth_getTransactionReceipt') return chain === 'l1'
      ? {status:'0x1',blockHash:h(1),blockNumber:'0x20',logs:[outgoing]}
      : {status:'0x1',blockHash:h(2),blockNumber:'0x30',logs:[incoming,...(omitted?[]:[{...mint,address:wrongToken?token:wrapped}])]};
    if (method === 'eth_getTransactionByHash') return {from:p.sender,to:p.to,input:p.data,nonce:p.nonce,value:'0x0'};
    if (method === 'eth_getBlockByNumber') return chain === 'l1' ? {hash:h(1),number:'0x20'} : {hash:h(2),number:'0x30'};
    if (method === 'eth_getLogs') return chain === 'l1' ? [outgoing] : missing ? [] : [incoming];
    if (method === 'eez_getSettlementByL2Block') return {canonicalL2:canonical,l1BlockHash:h(1),l1BlockNumber:'0x20',l2Blocks:[{hash:h(2),number:'0x30'}]};
    assert.fail(`${method}: ${JSON.stringify(params)}`);
  };
  assert.equal((await d.reconcile(journal)).last.destination,'l2');
  missing=true; assert.equal((await d.reconcile(journal)).pending,p); missing=false;
  canonical=false; assert.equal((await d.reconcile(journal)).pending,p); canonical=true;
  wrongToken=true; await assert.rejects(d.reconcile(journal),/exact 1,000-token mint/); wrongToken=false;
  omitted=true; await assert.rejects(d.reconcile(journal),/exact 1,000-token mint/);
});
