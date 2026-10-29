import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { parseTreasuryConfig, requireDashboardTreasury, TreasuryClient } from '../src/lib/treasury/client.ts';
import { ETHEREUM_USDC, EIP1967_IMPLEMENTATION_SLOT, USDC_IMPLEMENTATION_SLOT, treasuryExplorer, validateMainnet } from '../src/lib/treasury/mainnet.ts';
import { paymentTransaction, tokenAbi, moduleAbi, allowanceAbi } from '../src/lib/treasury/payments.ts';
import { pairedPolicyAbi, validatePairedPayments } from '../src/lib/treasury/pairedPolicy.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const a = n => toHex(n, { size: 20 }), h = s => keccak256(toHex(s));
const implementation = a(23);
function config() {
  const c = { version: 1, environment: 'ethereum-mainnet', instance: h('mainnet-only'),
    l1: { chainId: 1, rpc: 'https://mainnet.example/rpc/l1', front: 'https://mainnet.example/composer/l1', genesis: h('ethereum'), explorer: 'https://etherscan.io' },
    l2: { chainId: 700001, rpc: 'https://mainnet.example/rpc/l2', front: 'https://mainnet.example/composer/l2', genesis: h('eez-mainnet-fixture'), explorer: 'https://eez-mainnet.example/explorer' },
    registry: a(2), manager: a(3), safeL1: a(4), safeL2: a(5), adapter: a(6), ownerLabels: {},
    safeImplementations: { l1: a(7), l2: a(8) }, fees: { maxTotalWei: '1000000000000000', l1MaxTotalWei: '10000000000000000' },
    protocol: [{ chain: 'l1', proxy: a(2), implementation: a(9) }, { chain: 'l2', proxy: a(3), implementation: a(10) }],
    safeAppUrl: `https://app.safe.global/home?safe=eth:${a(4)}`,
    mainnet: { rollupId: 7, usdcImplementation: implementation, bridgeImplementations: { l1: { kind: 'immutable' }, l2: { kind: 'immutable' } } },
    payments: { bridgeKind: "standard", safeL2Alias: a(26), bridgeExecutorL1: a(27), policy: a(11), alias: a(12), tokenL1: ETHEREUM_USDC, tokenL2: a(14), moduleL1: a(15), moduleL2: a(16), bridgeL1: a(17), bridgeL2: a(18),
      recipient: a(20), decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'USDC',
      combinedL2: true, l1Initiation: true, exactSplits: true } };
  c.code = [['l1', [2, 4, 7, 9, 12, 15, 17, 19, 23, 26, 27]], ['l2', [3, 5, 6, 8, 10, 11, 14, 16, 18]]]
    .flatMap(([chain, addresses]) => addresses.map(n => ({ chain, address: a(n), hash: keccak256('0x6000600055') })));
  c.code.push({ chain: 'l1', address: ETHEREUM_USDC, hash: keccak256('0x6000600055') });
  return c;
}

test('explicit mainnet manifests preserve both Safe signing domains and exact split calldata', () => {
  const c = parseTreasuryConfig(config());
  const p = { recipient: a(20), destination: 'l2', amount: '110000000', fromL1: '100000000', epoch: '2' };
  const l1 = paymentTransaction(c, { ...p, source: 'l1' }, 4n), l2 = paymentTransaction(c, { ...p, source: 'l2' }, 4n);
  assert.equal(l1.domain.chainId, 1n); assert.equal(l2.domain.chainId, 700001n);
  assert.equal(l1.domain.verifyingContract, c.safeL1); assert.equal(l2.domain.verifyingContract, c.safeL2);
  assert.notEqual(safeTransactionHash(l1), safeTransactionHash(l2));
  assert.equal(l1.message.to.toLowerCase(), c.payments.alias); assert.equal(l2.message.to.toLowerCase(), c.payments.policy);
  assert.equal(l1.message.data, l2.message.data);
});

test('mainnet rejects test chains, fake USDC, missing identity, demo controls and unbounded fees', () => {
  for (const change of [
    c => c.l1.chainId = 10200, c => c.l2.chainId = 906969, c => c.l2.chainId = 1,
    c => c.payments.tokenL1 = a(12), c => c.payments.assetLabel = 'Test USDC', c => c.payments.decimals = 18,
    c => delete c.payments.bridgeKind, c => delete c.payments.safeL2Alias,
    c => delete c.mainnet, c => delete c.safeImplementations, c => delete c.protocol,
    c => c.code = c.code.filter(b => b.address !== implementation), c => c.code.push(c.code[0]),
    c => c.mainnet.bridgeImplementations.l2 = { kind: 'eip1967', address: a(100) },
    c => c.mainnet.rollupId = 0, c => c.payments.invoiceControl = 'https://mainnet.example/treasury-fixture/invoices',
    c => c.payments.invoiceMerchant = a(19), c => c.action = a(6), c => delete c.fees,
    c => c.fees.l1MaxTotalWei = '0', c => c.payments.combinedL2 = false, c => delete c.l1.front,
    c => c.safeAppUrl = `https://app.safe.global/home?safe=chiado:${c.safeL1}`,
    c => c.l2.explorer = 'javascript:alert(1)', c => c.l1.rpc = 'http://mainnet.example/rpc',
    c => c.l1.rpc = 'https://user:secret@mainnet.example/rpc',
  ]) { const c = config(); change(c); assert.throws(() => parseTreasuryConfig(c), undefined, change.toString()); }
});

test('mainnet manifests must match the dashboard, while links stay bound to the manifest', () => {
  const c = config(), d = { l1ChainId: '0x1', l2ChainId: toHex(c.l2.chainId), l1Rpc: c.l1.rpc, l2Rpc: c.l2.rpc, l1Front: c.l1.front, l2Front: c.l2.front,
    registry: c.registry, manager: c.manager, feesEnabled: true, maxTotalWei: c.fees.maxTotalWei, l1FeesEnabled: true, l1MaxTotalWei: c.fees.l1MaxTotalWei };
  requireDashboardTreasury(c, d);
  for (const patch of [{ l1ChainId: '10200' }, { manager: a(100) }, { l2Front: 'https://other.example' }, { maxTotalWei: '1' }, { l1FeesEnabled: false }])
    assert.throws(() => requireDashboardTreasury(c, { ...d, ...patch }));
  assert.equal(treasuryExplorer(c, 'l1', 'https://gnosis-chiado.blockscout.com'), 'https://etherscan.io');
  assert.equal(treasuryExplorer(c, 'l2', 'https://chiado-rollup.example'), c.l2.explorer);
});

const abi = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function paused() view returns (bool)',
  'function MAINNET_ROLLUP_ID() view returns (uint64)', 'function ROLLUP_ID() view returns (uint64)',
  'function getTokenAllowance(address,address,address) view returns (uint256[5])',
  'function rollupId() view returns (uint64)', 'function wrappedTokenInfo(address) view returns (address,uint64)', 'function BRIDGE() view returns (address)',
]);
function fixture() {
  const c = config(), client = new TreasuryClient(c), calls = [], changes = { results: {}, codes: {}, slots: {}, reorg: false };
  client.rpc = async (url, method, params = []) => {
    const chain = url === c.l1.rpc ? 'l1' : 'l2'; calls.push({ chain, method, params });
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: changes.reorg && params[0] !== 'latest' ? h('reorg') : h(chain) };
    if (method === 'eth_getCode') return changes.codes[params[0]] ?? '0x6000600055';
    if (method === 'eth_getStorageAt') {
      const key = `${params[0]}:${params[1]}`;
      if (changes.slots[key]) return changes.slots[key];
      const impl = params[0] === ETHEREUM_USDC ? implementation : params[0] === c.safeL1 ? c.safeImplementations.l1 : params[0] === c.safeL2 ? c.safeImplementations.l2
        : c.protocol.find(p => p.proxy === params[0])?.implementation ?? zeroAddress;
      return toHex(BigInt(impl), { size: 32 });
    }
    if (method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      const result = changes.results[functionName] ?? { symbol: 'USDC', decimals: 6, paused: false, MAINNET_ROLLUP_ID: 0n, ROLLUP_ID: 7n, rollupId: 7n,
        wrappedTokenInfo: [ETHEREUM_USDC, 0n], BRIDGE: c.payments.bridgeL2, getTokenAllowance: [100_000_000n, 0n, 10n, 0n, 0n] }[functionName];
      assert.notEqual(result, undefined); return encodeFunctionResult({ abi, functionName, result });
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  return { c, client, calls, changes };
}

test('mainnet validation binds USDC implementation, rollup and wrapped mint authority using only reads', async () => {
  const f = fixture(), result = await validateMainnet(f.client);
  assert.equal(result.l1.number, '0x10');
  assert(f.calls.some(c => c.method === 'eth_getStorageAt' && c.params[0] === ETHEREUM_USDC && c.params[1] === USDC_IMPLEMENTATION_SLOT));
  assert(f.calls.filter(c => c.method === 'eth_call').every(c => c.params[1] === '0x10'));
  assert(f.calls.every(c => ['eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(c.method)));
});

test('each mainnet action reads bytecode once, overlaps reads, and verifies fresh state again on the next action', async () => {
  const f = fixture(), rpc = f.client.rpc;
  let active = 0, peak = 0;
  f.client.rpc = async (url, method, params) => {
    const chain = url === f.c.l1.rpc ? 'l1' : 'l2';
    if (method === 'eth_chainId') return toHex(f.c[chain].chainId);
    if (method === 'eth_getBlockByNumber' && params[0] === '0x0') return { hash: f.c[chain].genesis };
    if (method !== 'eth_getCode') return rpc(url, method, params);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    try { return await rpc(url, method, params); } finally { active--; }
  };
  // Isolate the deployment audit; paired-policy bindings have their own validation.
  f.client.validatePayments = async () => {};
  f.client.read = async (_url, _address, _abi, name) => ({
    VERSION: '1.4.1', getOwners: [f.c.adapter], getThreshold: 1n, safeL1: f.c.safeL1, manager: f.c.manager,
  })[name];
  await f.client.validate();
  assert(peak > 1, 'bytecode reads should overlap');
  const codeReads = f.calls.filter(c => c.method === 'eth_getCode');
  assert.equal(codeReads.length, f.c.code.length, 'no duplicate latest-state bytecode sweep');
  assert(codeReads.every(c => c.params[1] === '0x10'), 'all bytecode reads use the checked observation block');
  f.changes.codes[implementation] = '0x6001';
  await assert.rejects(f.client.validate(), /code changed/, 'successful validation must not cache state across actions');
});

test('a proxy upgrade blocks verification even while the proxy bytecode is unchanged', async () => {
  for (const [target, slot] of [[ETHEREUM_USDC, USDC_IMPLEMENTATION_SLOT], [a(17), EIP1967_IMPLEMENTATION_SLOT], [a(4), toHex(0, { size: 32 })], [a(2), EIP1967_IMPLEMENTATION_SLOT]]) {
    const f = fixture(); f.changes.slots[`${target}:${slot}`] = toHex(100, { size: 32 });
    await assert.rejects(validateMainnet(f.client), /proxy implementation changed/);
  }
});

test('known test bridges cannot become mainnet bridges by pinning their correct bytecode', async () => {
  const artifacts = JSON.parse(readFileSync(new URL('../src/lib/treasury/deployment-artifacts.json', import.meta.url)));
  for (const name of ['ConfiguredTreasuryBridge', 'BootstrapTreasuryBridge', 'SharedTreasuryBridge']) {
    const f = fixture(), code = artifacts.contracts[name].runtime, target = f.c.payments.bridgeL2;
    f.changes.codes[target] = code; f.c.code.find(b => b.address === target).hash = keccak256(code);
    await assert.rejects(validateMainnet(f.client), /test-only/);
    const metadataChanged = code.slice(0, -10) + (code.slice(-10, -8) === '00' ? '01' : '00') + code.slice(-8);
    f.changes.codes[target] = metadataChanged; f.c.code.find(b => b.address === target).hash = keccak256(metadataChanged);
    await assert.rejects(validateMainnet(f.client), /test-only/);
  }
});

test('code changes, paused USDC, wrong asset origin, mint authority and reorg all stop validation', async () => {
  for (const [results, message] of [[{ paused: true }, /paused/], [{ decimals: 18 }, /metadata/], [{ ROLLUP_ID: 8n }, /rollup/],
    [{ wrappedTokenInfo: [a(100), 0n] }, /origin/], [{ wrappedTokenInfo: [ETHEREUM_USDC, 2n] }, /origin/], [{ BRIDGE: a(100) }, /authority/], [{ getTokenAllowance: [200_000_000n, 0n, 10n, 0n, 0n] }, /spending limits/], [{ getTokenAllowance: [100_000_000n, 0n, 0n, 0n, 0n] }, /spending limits/]]) {
    const f = fixture(); f.changes.results = results; await assert.rejects(validateMainnet(f.client), message);
  }
  const changed = fixture(); changed.changes.codes[implementation] = '0x6001'; await assert.rejects(validateMainnet(changed.client), /code changed/);
  const reorg = fixture(); reorg.changes.reorg = true; await assert.rejects(validateMainnet(reorg.client), /state changed/);
});

test('mainnet validation failure prevents asking the wallet to sign', async () => {
  const f = fixture(); f.client.validate = async () => { throw new Error('production bridge not verified'); };
  const p = { recipient: a(20), destination: 'l1', amount: '1000000', fromL1: '1000000', epoch: '2' };
  await assert.rejects(f.client.approve({ request() { assert.fail('wallet must not be called'); } }, paymentTransaction(f.c, p, 0n), {}, a(100)), /production bridge/);
});

test('mainnet preflight verifies both Composer source chains and rejects unsupported signing quorums', async () => {
  const { mainnetPreflight } = await import('../src/lib/treasury/mainnet.ts');
  const { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } = await import('../src/lib/composerDiscovery.ts');
  const f = fixture(); let validated = false, swapped = false, contractOwner = false;
  f.client.validate = async () => { validated = true; };
  f.client.snapshot = async () => ({ owners: [a(100)], threshold: 1, l1Block: '16' });
  const methods = [];
  f.client.rpc = async (url, method, params = []) => {
    methods.push(method);
    if (method === 'eth_getCode') return contractOwner ? '0x6000' : '0x';
    const chainId = url === f.c.l1.front && !swapped ? 1 : f.c.l2.chainId;
    if (method === 'eth_chainId') return toHex(chainId);
    assert.equal(method, 'eth_call');
    const { args: [nonce] } = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data });
    return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, BigInt(chainId), toHex(JSON.stringify({
      version: 'fixture', supportedNetworks: { eezL1: 1, eezL2: f.c.l2.chainId }, eezContracts: { eezRegistryAddress: f.c.registry, eezL2Address: f.c.manager },
    }))] });
  };
  const report = await mainnetPreflight(f.client);
  assert(validated); assert(report.configurationVerified); assert.equal(report.productionReady, false);
  assert(methods.every(method => ['eth_getCode', 'eth_chainId', 'eth_call'].includes(method)));
  swapped = true; await assert.rejects(mainnetPreflight(f.client), /Composer/);
  swapped = false; contractOwner = true; await assert.rejects(mainnetPreflight(f.client), /contract-owner signatures/);
});


test('upgradeable bridge implementations must be explicitly bound and verified', async () => {
  const f = fixture(), proxy = f.c.payments.bridgeL1, target = a(24);
  f.c.mainnet.bridgeImplementations.l1 = { kind: 'eip1967', address: target };
  f.c.code.push({ chain: 'l1', address: target, hash: keccak256('0x6000600055') });
  f.changes.slots[`${proxy}:${EIP1967_IMPLEMENTATION_SLOT}`] = toHex(BigInt(target), { size: 32 });
  await validateMainnet(f.client);
  f.changes.codes[target] = '0x6001';
  await assert.rejects(validateMainnet(f.client), /code changed/);
});


test('parallel paired-policy verification still rejects changed bindings, inactive policies, wrong proxies and reorgs', async () => {
  const c = config();
  c.payments.pair = { version: 2, policyL1: a(40), peerProxyL2: a(41) };
  const p = c.payments, pair = p.pair;
  const registry = parseAbi(['function computeCrossChainProxyAddress(address,uint64) view returns(address)', 'function authorizedProxies(address) view returns(bool,address,uint64)']);
  const abi = [...pairedPolicyAbi, ...tokenAbi, ...moduleAbi, ...allowanceAbi, ...registry];
  let change = '';
  const client = new TreasuryClient(c);
  client.rpc = async (url, method, params) => {
    const onL1 = url === c.l1.rpc, chain = onL1 ? 'l1' : 'l2';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: h(change === 'reorg' && params[0] !== 'latest' ? 'reorg' : chain) };
    assert.equal(method, 'eth_call'); assert.equal(params[1], '0x10');
    const { functionName: name, args } = decodeFunctionData({ abi, data: params[0].data });
    const safe = onL1 ? c.safeL1 : c.safeL2, peerPolicy = onL1 ? p.policy : pair.policyL1;
    const proxy = onL1 ? p.alias : pair.peerProxyL2;
    let result = { configuration: [safe, p.tokenL1, onL1 ? p.bridgeL1 : p.bridgeL2, onL1 ? p.bridgeL2 : p.bridgeL1,
      onL1 ? 0n : 7n, 7n, change === 'binding' ? a(99) : peerPolicy, proxy],
      PAIR_VERSION: 2n, active: change !== 'inactive', PERIOD: 600n, GLOBAL_LIMIT: 150000000n,
      token: onL1 ? p.tokenL1 : p.tokenL2, allowanceModule: onL1 ? p.moduleL1 : p.moduleL2, manager: onL1 ? c.registry : c.manager,
      peerSafe: onL1 ? c.safeL2 : c.safeL1, localAliasOnPeer: onL1 ? pair.peerProxyL2 : p.alias,
      isModuleEnabled: true, decimals: 6, getTokenAllowance: [100000000n, 0n, 10n, 0n, 0n] }[name];
    if (name === 'computeCrossChainProxyAddress') result = args[0].toLowerCase() === c.safeL2.toLowerCase() ? p.safeL2Alias : proxy;
    if (name === 'authorizedProxies') result = [change !== 'proxy', args[0].toLowerCase() === p.safeL2Alias.toLowerCase() ? c.safeL2 : peerPolicy, onL1 ? 7n : 0n];
    assert.notEqual(result, undefined, name);
    return encodeFunctionResult({ abi, functionName: name, result });
  };
  await validatePairedPayments(client);
  for (const [failure, message] of [['binding', /configuration changed/], ['inactive', /activation/], ['proxy', /proxy identity/], ['reorg', /observations changed/]]) {
    change = failure;
    await assert.rejects(validatePairedPayments(client), message);
  }
});
