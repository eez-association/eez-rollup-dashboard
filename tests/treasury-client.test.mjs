import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, decodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem';
import { actionTransaction, canonicalRequestRetired, parseTreasuryConfig, readIntent, safeAbi, TreasuryClient, unchanged } from '../src/lib/treasury/client.ts';
import { paymentAbi, tokenAbi, moduleAbi, treasuryBridgeAbi } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const address = byte => `0x${byte.repeat(40)}`;
const hash = text => keccak256(stringToHex(text));
const config = { version: 1, environment: 'isolated-devnet', instance: hash('instance'),
  l1: { chainId: 1337, rpc: 'http://127.0.0.1:10001/rpc/l1', genesis: hash('l1') },
  l2: { chainId: 420691, rpc: 'http://127.0.0.1:10001/rpc/l2', front: 'http://127.0.0.1:10001/composer/l2', genesis: hash('l2') },
  registry: address('1'), manager: address('2'), safeL1: address('3'), safeL2: address('4'), adapter: address('5'), action: address('6'),
  code: ['3', '4', '5', '6'].map((b, i) => ({ chain: i === 0 ? 'l1' : 'l2', address: address(b), hash: hash(b) })), ownerLabels: {} };
const intent = { version: 1, instance: config.instance, value: '42', nonce: '0', safeHash: safeTransactionHash(actionTransaction(config, '42', 0n)),
  data: '0x1234', sender: address('7'), sourceNonce: '0x0', startBlock: '0x1', hash: hash('transaction') };
function fixture({ safeHeight = '0x5', canonicalHash = hash('block'), receiptStatus = '0x1', event = 'ExecutionSuccess', receipt = true,
  status = null, transaction = {}, recover = false, legacy = false } = {}) {
  const client = new TreasuryClient(config);
  const log = { address: config.safeL2, transactionHash: intent.hash, // Safe 1.4.1 indexes txHash (contracts/lib/safe/contracts/Safe.sol), so it
    // lives in topic 1; only payment is in data. Match the actual emitted log,
    // independently of the client ABI's indexed-field declarations.
    topics: [encodeEventTopics({ abi: safeAbi, eventName: event })[0], intent.safeHash],
    data: encodeAbiParameters([{ type: 'uint256' }], [0n]) };
  if (legacy) { log.topics = log.topics.slice(0, 1); log.data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [intent.safeHash, 0n]); }
  client.rpc = async (_url, method, params) => {
    if (method === 'eth_getLogs') return recover ? [log] : [];
    if (method === 'eez_getCrossChainTransaction') return status;
    if (method === 'eth_getTransactionReceipt') return receipt ? { status: receiptStatus, blockNumber: '0x5', blockHash: hash('block'), logs: [log] } : null;
    if (method === 'eth_getBlockByNumber') return params[0] === 'safe' ? { number: safeHeight } : { hash: canonicalHash };
    if (method === 'eth_getTransactionByHash') return { from: intent.sender, to: config.safeL2, input: intent.data, ...transaction };
    throw new Error(`Unexpected method ${method}`);
  };
  return client;
}
test('outcome tracking routes Composer status separately from chain receipts and preserves unresolved submissions', async t => {
  let scenario = {}, unavailable = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    const respond = async body => {
    requests.push({ path: req.url, method: body.method });
    const isStatus = body.method === 'eez_getCrossChainTransaction';
    if (req.url !== (isStatus ? '/composer/l2' : '/rpc/l2') || unavailable && isStatus) {
      return { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } };
    }
    try {
      const result = await fixture(scenario).rpc('', body.method, body.params);
      return { jsonrpc: '2.0', id: body.id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: String(error) } };
    }
    };
    res.end(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(respond)) : await respond(body)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new TreasuryClient({ ...config, l2: { ...config.l2, rpc: origin + '/rpc/l2', front: origin + '/composer/l2' } });
  const saved = JSON.stringify(intent);
  for (const [options, expected] of [
    [{}, 'settled'],
    [{ safeHeight: '0x4' }, 'pending'],
    [{ receipt: false, status: null }, 'pending'],
    [{ receipt: false, status: { lifecycle: 'terminal', ownership: { reason: 'PoolDiscarded' } } }, 'rejected'],
  ]) {
    scenario = options;
    assert.equal((await client.outcome(intent)).kind, expected);
    assert.equal(JSON.stringify(intent), saved, 'observations do not rewrite or clear the saved submission');
  }
  unavailable = true; scenario = { receipt: false };
  await assert.rejects(client.outcome(intent), /Method not found/);
  assert.equal(JSON.stringify(intent), saved, 'a missing status endpoint cannot clear or retry the request');
  assert(requests.some(r => r.path === '/composer/l2' && r.method === 'eez_getCrossChainTransaction'));
  assert(requests.some(r => r.path === '/rpc/l2' && r.method === 'eth_getTransactionReceipt'));
  assert(requests.every(r => !/send|sign/i.test(r.method)), 'verification only reads existing work');
});

test('a speculative successful receipt is still pending', async () => {
  assert.equal((await fixture({ safeHeight: '0x4' }).outcome(intent)).kind, 'pending');
});
test('settlement requires a canonical safe block and the matching Safe success event', async () => {
  const result = await fixture().outcome(intent);
  assert.equal(result.kind, 'settled'); assert.equal(result.block, '5'); assert.deepEqual(result.execution, { l2: intent.hash });
  assert.equal((await fixture({ canonicalHash: hash('replacement') }).outcome(intent)).kind, 'pending');
  assert.equal((await fixture({ event: 'ExecutionFailure' }).outcome(intent)).kind, 'rejected');
  assert.equal((await fixture({ receiptStatus: '0x0' }).outcome(intent)).kind, 'rejected');
});
test('a response hash must identify the reviewed call and submitter', async () => {
  for (const transaction of [{ from: address('8') }, { to: address('8') }, { input: '0xabcd' }])
    await assert.rejects(fixture({ transaction }).outcome(intent), /does not match/);
});
test('no receipt or queue history never establishes success or authorizes retry', async () => {
  for (const status of [null, { lifecycle: 'terminal', ownership: { reason: 'Committed' } }, { lifecycle: 'terminal', ownership: { reason: 'SourceReverted' } }])
    assert.equal((await fixture({ receipt: false, status }).outcome(intent)).kind, 'pending');
});
test('deterministic Composer disposition is an explicit rejection', async () => {
  for (const reason of ['PoolDiscarded', 'AttemptsExhausted', 'NonceGap'])
    assert.equal((await fixture({ receipt: false, status: { lifecycle: 'terminal', ownership: { reason } } }).outcome(intent)).kind, 'rejected');
});
test('a lost wallet response is recovered by the exact Safe hash or remains unresolved', async () => {
  const missing = { ...intent, hash: undefined };
  assert.equal((await fixture().outcome(missing)).kind, 'unknown');
  const recovered = await fixture({ recover: true }).outcome(missing);
  assert.equal(recovered.kind, 'settled'); assert.equal(recovered.hash, intent.hash);
});
test('saved requests are scoped to the deployment and reviewed Safe domain', () => {
  assert.equal(readIntent(config, null), null);
  assert.deepEqual(readIntent(config, JSON.stringify(intent)), intent);
  for (const edit of [{ instance: hash('new-devnet') }, { value: '43' }, { nonce: '1' }, { hash: '0x1234' }, { nonce: '-1' }])
    assert.throws(() => readIntent(config, JSON.stringify({ ...intent, ...edit })));
});
test('only a complete isolated devnet configuration is accepted', () => {
  assert.equal(parseTreasuryConfig(config), config);
  for (const edit of [{ environment: 'mainnet' }, { code: [] }, { action: '0x0' }, { instance: 'arbitrary' },
    { l2: { ...config.l2, chainId: 1 } }, { l2: { ...config.l2, front: undefined } }, { l1: { ...config.l1, rpc: 'https://example.com' } },
    { l1: { ...config.l1, rpc: 'http://user:password@127.0.0.1:10001' } }, { l2: { ...config.l2, genesis: '0x' } }])
    assert.throws(() => parseTreasuryConfig({ ...config, ...edit }));
});
test('nonce or owner/threshold changes invalidate the approval round', () => {
  const s = { nonce: 2n, fingerprint: '2:owners' };
  assert(unchanged(s, { ...s }));
  assert(!unchanged(s, { ...s, nonce: 3n }));
  assert(!unchanged(s, { ...s, fingerprint: '1:owners' }));
  assert(!unchanged(s, { ...s, fingerprint: '2:other-owners' }));
});
test('the action review rejects truncated, negative and noninteger values', () => {
  for (const value of ['-1', '1.5', '1e3', '', (1n << 256n).toString()]) assert.throws(() => actionTransaction(config, value, 0n));
  assert.equal(actionTransaction(config, '42', 3n).message.nonce, 3n);
});
test('multi-owner reads preserve standard address checksums and recheck the L1 block after reads', async () => {
  const { getAddress, isAddress } = await import('viem');
  const owners = ['0xe05fcc23807536bee418f142d19fa0d21bb0cff7', '0x0376aac07ad725e01357b1725b5cec61ae10473c'];
  const client = new TreasuryClient(config);
  const sequence = [];
  client.rpc = async (_url, _method, params) => { sequence.push(params[0]); return { number: '0x3', hash: hash('snapshot') }; };
  client.read = async (_url, _address, _abi, name) => {
    await new Promise(resolve => setTimeout(resolve, 5)); sequence.push(name);
    return { getOwners: owners, getThreshold: 2n, nonce: 0n, value: 0n }[name];
  };
  const snapshot = await client.snapshot();
  assert(snapshot.owners.every(owner => isAddress(owner)), 'every owner uses the standard checksum');
  assert.deepEqual(new Set(snapshot.owners), new Set(owners.map(owner => getAddress(owner))));
  assert.equal(sequence.at(-1), '0x3', 'the canonical-block recheck happens after all state reads');
});

test('reverse funding validates both bridge counterparts, asset, managers and rollup before enabling payments', async () => {
  const p = { policy: address('7'), alias: address('8'), tokenL1: address('9'), tokenL2: address('a'), moduleL1: address('b'), moduleL2: address('c'), bridgeL1: address('d'), bridgeL2: address('e'), combinedL2: true };
  const abi = [...paymentAbi, ...tokenAbi, ...moduleAbi, ...treasuryBridgeAbi];
  const responses = new Map();
  const put = (chain, target, values) => Object.entries(values).forEach(([name, result]) => responses.set(`${chain}:${target}:${name}`, result));
  put('l2', p.policy, { safeL1: config.safeL1, safeL2: config.safeL2, canonicalToken: p.tokenL1, wrappedToken: p.tokenL2,
    allowanceL2: p.moduleL2, bridge: p.bridgeL2, bridgeL1: p.bridgeL1, rollupId: 42n, GLOBAL_LIMIT: 150_000_000n, PERIOD: 600n });
  for (const chain of ['l1', 'l2']) {
    put(chain, chain === 'l1' ? p.tokenL1 : p.tokenL2, { decimals: 6 });
    put(chain, chain === 'l1' ? config.safeL1 : config.safeL2, { isModuleEnabled: true });
    put(chain, chain === 'l1' ? p.bridgeL1 : p.bridgeL2, { canonicalToken: p.tokenL1, manager: chain === 'l1' ? config.registry : config.manager,
      canonicalBridgeAddress: chain === 'l1' ? p.bridgeL2 : p.bridgeL1, treasuryRollupId: 42n, rollupId: chain === 'l1' ? 0n : 42n });
  }
  put('l2', p.bridgeL2, { getWrappedToken: p.tokenL2 });
  const client = new TreasuryClient({ ...config, payments: p });
  client.rpc = async (url, method, args) => {
    assert.equal(method, 'eth_call');
    const { functionName } = decodeFunctionData({ abi, data: args[0].data });
    const key = `${url === config.l1.rpc ? 'l1' : 'l2'}:${args[0].to}:${functionName}`;
    assert(responses.has(key), key);
    return encodeFunctionResult({ abi, functionName, result: responses.get(key) });
  };
  await client.validatePayments();
  for (const [key, original] of [...responses].filter(([key]) => key.includes(p.bridgeL1) || key.includes(p.bridgeL2) || key.endsWith(':bridgeL1'))) {
    responses.set(key, typeof original === 'bigint' ? original + 1n : address('f'));
    await assert.rejects(client.validatePayments(), /Reverse route/);
    responses.set(key, original);
  }
});

test('queue removal without fixture evidence does not establish a preparation rejection', async t => {
  const invoice = { ...intent, payment: { kind: 'invoice', invoiceId: hash('invoice'), amount: '110000000', recipient: address('8') } };
  let report = null;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: !!report, status: report ? 200 : 404, json: async () => report }));
  const client = new TreasuryClient({ ...config, payments: { invoiceControl: 'http://127.0.0.1/invoices' } });
  client.rpc = fixture({ receipt: false, status: { lifecycle: 'terminal', ownership: { reason: 'PoolDiscarded' } } }).rpc;
  assert.equal((await client.outcome(invoice)).rejectionStage, undefined);
  report = { phase: 'open', mode: 'preparation', id: invoice.payment.invoiceId, amount: invoice.payment.amount, recipient: invoice.payment.recipient };
  assert.equal((await client.outcome(invoice)).rejectionStage, 'preparation');
  for (const change of [{ mode: 'settlement' }, { id: hash('unrelated') }, { recipient: address('9') }, { amount: '1' }]) {
    const valid = report; report = { ...report, ...change };
    assert.equal((await client.outcome(invoice)).rejectionStage, undefined); report = valid;
  }
  report = { phase: 'unverified', detail: 'trace missing' };
  const result = await client.outcome(invoice);
  assert.equal(result.kind, 'rejected'); assert.equal(result.rejectionStage, undefined); assert.equal(result.rollback, undefined);
});


test('historical request retirement requires both nonces at one canonical safe block, even when queue diagnostics expire', async () => {
  for (const [safeNonce, sourceNonce, expected] of [[0n, '0x0', false], [1n, '0x0', false], [0n, '0x1', false], [1n, '0x1', true]]) {
    const client = new TreasuryClient(config), calls = [];
    client.read = async (_url, target, _abi, method, tag) => {
      assert.equal(target, config.safeL2); assert.equal(method, 'nonce'); assert.equal(tag, '0x5'); return safeNonce;
    };
    client.rpc = async (_url, method, params) => {
      calls.push([method, params]);
      if (method === 'eth_getBlockByNumber') return { number: '0x5', hash: hash('canonical') };
      assert.equal(method, 'eth_getTransactionCount'); assert.deepEqual(params, [intent.sender, '0x5']); return sourceNonce;
    };
    assert.equal(await canonicalRequestRetired(client, intent), expected);
    assert.deepEqual(calls[0], ['eth_getBlockByNumber', ['safe', false]]);
    assert.deepEqual(calls.at(-1), ['eth_getBlockByNumber', ['0x5', false]]);
  }
});
test('missing or reorged canonical nonce observations cannot retire a historical request', async () => {
  const client = new TreasuryClient(config);
  client.read = async () => 10n;
  client.rpc = async () => null;
  await assert.rejects(canonicalRequestRetired(client, intent), /unavailable/);
  client.rpc = async (_url, method, params) => method === 'eth_getTransactionCount' ? '0xa'
    : { number: '0x5', hash: hash(params[0] === 'safe' ? 'before' : 'reorg') };
  await assert.rejects(canonicalRequestRetired(client, intent), /changed/);
});

test('the optional Safe app link must select this isolated L1 Safe', () => {
  const safeAppUrl = `http://127.0.0.1:39027/settings/setup?safe=trl1:${config.safeL1}`;
  assert.equal(parseTreasuryConfig({ ...config, safeAppUrl }).safeAppUrl, safeAppUrl);
  for (const value of ['https://app.safe.global', 'javascript:alert(1)', safeAppUrl.replace('127.0.0.1', 'example.com'),
    safeAppUrl.replace(config.safeL1, address('9')), safeAppUrl.replace('trl1:', 'eth:'), safeAppUrl.replace('127.0.0.1', 'user:secret@127.0.0.1')])
    assert.throws(() => parseTreasuryConfig({ ...config, safeAppUrl: value }));
});

test('shared testnet configuration requires retained identity, fees and isolated-only controls stay disabled', () => {
  const shared = { ...config, environment: 'dashboard-testnet', fees: { maxTotalWei: '100000000000000000' },
    l1: { chainId: 10200, rpc: 'https://dashboard.example/rpc/l1', checkpoint: { number: '0x1684787', hash: hash('checkpoint') } },
    l2: { ...config.l2, chainId: 906969, rpc: 'https://dashboard.example/rpc/l2', front: 'https://dashboard.example/composer/l2' },
    safeAppUrl: `https://app.safe.global/settings/setup?safe=chiado:${config.safeL1}`,
    protocol: [{ chain: 'l1', proxy: config.registry, implementation: address('a') }, { chain: 'l2', proxy: config.manager, implementation: address('b') }],
    code: [...config.code, ...[['l1', config.registry], ['l2', config.manager], ['l1', address('a')], ['l2', address('b')]].map(([chain, address]) => ({ chain, address, hash: hash(address) }))] };
  assert.equal(parseTreasuryConfig(shared), shared);
  for (const edit of [{ protocol: undefined }, { protocol: [] }, { fees: undefined }, { fees: { maxTotalWei: '0' } }, { l1: { ...shared.l1, chainId: 1 } },
    { l2: { ...shared.l2, chainId: 906970 } }, { l1: { ...shared.l1, checkpoint: { number: '-1', hash: hash('checkpoint') } } },
    { l1: { ...shared.l1, genesis: hash('conflicting') } }, { l1: { ...shared.l1, rpc: 'http://dashboard.example/rpc/l1' } },
    { safeAppUrl: shared.safeAppUrl.replace('chiado:', 'eth:') }, { payments: { invoiceControl: 'https://dashboard.example/treasury-fixture/invoices' } }])
    assert.throws(() => parseTreasuryConfig({ ...shared, ...edit }));
});

test('shared treasury must bind to the actual dashboard RPCs, chains, manager and fee cap', async () => {
  const { requireDashboardTreasury } = await import('../src/lib/treasury/client.ts');
  const c = { ...config, environment: 'dashboard-testnet', fees: { maxTotalWei: '1000' } };
  const d = { l1ChainId: '0x539', l2ChainId: '0x66b53', l1Rpc: c.l1.rpc, l2Rpc: c.l2.rpc, l2Front: c.l2.front,
    registry: c.registry, manager: c.manager, feesEnabled: true, maxTotalWei: '1000' };
  d.l2ChainId = '0x' + c.l2.chainId.toString(16);
  requireDashboardTreasury(c, d);
  for (const edit of [{ l1ChainId: '0x1' }, { manager: address('9') }, { registry: address('9') },
    { l2Front: 'http://127.0.0.1:20000/composer/l2' }, { feesEnabled: false }, { maxTotalWei: '1001' }])
    assert.throws(() => requireDashboardTreasury(c, { ...d, ...edit }));
});

test('shared payment submission uses a bound Composer quote rather than the isolated gas/fee defaults', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount('0x' + '0'.repeat(59) + 'a11ce');
  const c = { ...config, fees: { maxTotalWei: '100000000000000000' } };
  const client = new TreasuryClient(c), tx = actionTransaction(c, '42', 0n);
  const snapshot = { owners: [account.address], threshold: 1, nonce: 0n, value: 0n, fingerprint: '1:A' };
  client.validate = async () => {};
  client.snapshot = async () => snapshot;
  client.wallet = async () => account.address;
  let quotes = 0;
  client.rpc = async (url, method, params) => {
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    assert.equal(url, c.l2.front); assert.equal(method, 'eez_quoteFee'); quotes++;
    const [requested] = params;
    assert.equal(requested.to, c.safeL2); assert.equal(requested.nonce, '0x0'); assert.equal(requested.gas, undefined);
    const normalized = { ...requested, from: requested.from.toLowerCase(), to: requested.to.toLowerCase(), data: requested.data.toLowerCase(), gas: '0x493e0' };
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(normalized).sort().map(key => [key, normalized[key]])));
    return { version: 1, chainId: requested.chainId, nonce: '0x0', expiresAt: '0x' + (Math.floor(Date.now()/1000)+25).toString(16),
      options: [{ type: requested.type, gas: normalized.gas, requestHash: hash(canonical), estimatedFee: '0x64',
        ...(requested.type === '0x0' ? { gasPrice: '0x14' } : { maxPriorityFeePerGas: '0xa', maxFeePerGas: '0x14' }) }] };
  };
  const approvals = [{ owner: account.address, signature: await account.signTypedData(tx) }];
  for (const isRabby of [false, true]) {
    const prepared = await client.prepare({ isRabby }, tx, snapshot, approvals);
    assert.equal(prepared.request.gas, '0x493e0'); assert(prepared.expiresAt);
    assert.equal(prepared.request.type, isRabby ? '0x0' : '0x2');
    assert.equal(prepared.request[isRabby ? 'gasPrice' : 'maxFeePerGas'], '0x14');
  }
  assert.equal(quotes, 2);
  client.config.fees.maxTotalWei = '1';
  await assert.rejects(client.prepare({}, tx, snapshot, approvals), /app limit/);
  client.rpc = async (_url, method) => {
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    throw new Error('fee service unavailable');
  };
  await assert.rejects(client.prepare({}, tx, snapshot, approvals), /fee service unavailable/);
});


test('Safe singleton bindings are checked independently of proxy code and retain older manifest compatibility', async () => {
  assert.equal(parseTreasuryConfig(config), config);
  const impl = { l1: address('a'), l2: address('b') }, code = '0x6000';
  const bound = { ...config, safeImplementations: impl, code: [...config.code, ...['l1', 'l2'].map(chain => ({ chain, address: impl[chain], hash: hash('impl') }))] };
  assert.equal(parseTreasuryConfig(bound), bound);
  assert.throws(() => parseTreasuryConfig({ ...config, safeImplementations: impl }), /implementation code binding/);
  for (const wrong of ['l1', 'l2', undefined]) {
    const client = new TreasuryClient({ ...bound, code: bound.code.map(b => ({ ...b, hash: keccak256(code) })) });
    client.rpc = async (url, method, params) => {
      const chain = url === config.l1.rpc ? 'l1' : 'l2';
      if (method === 'eth_chainId') return String(config[chain].chainId);
      if (method === 'eth_getBlockByNumber') return { hash: config[chain].genesis };
      if (method === 'eth_getCode') return code;
      assert.equal(method, 'eth_getStorageAt'); assert.equal(params[1], '0x0');
      return '0x' + (wrong === chain ? address('f') : impl[chain]).slice(2).padStart(64, '0');
    };
    client.read = async (_url, _target, _abi, name) => ({ VERSION: '1.4.1', getOwners: [config.adapter], getThreshold: 1n, safeL1: config.safeL1, manager: config.manager, safe: config.safeL2 })[name];
    if (wrong) await assert.rejects(client.validate(), /Safe implementation changed/);
    else for (const versions of [['1.4.1', '1.4.1'], ['1.3.0', '1.4.1'], ['1.4.1', '1.3.0'], ['1.3.0', '1.3.0'], ['1.5.0', '1.4.1'], ['1.5.0', '1.3.0'], ['1.2.0', '1.4.1'], ['1.4.1', '1.3.0+L2'], ['1.4.1', '1.5.0'], ['1.5.0', '1.5.0']]) {
      const read = client.read;
      client.read = async (url, target, abi, name) => name === 'VERSION' ? versions[url === config.l1.rpc ? 0 : 1] : read(url, target, abi, name);
      if (['1.3.0', '1.4.1', '1.5.0'].includes(versions[0]) && ['1.3.0', '1.4.1'].includes(versions[1])) await client.validate();
      else await assert.rejects(client.validate(), /Safe or owner-adapter binding changed/);
      client.read = read;
    }
  }
});

test('payment treasuries can omit the action fixture without weakening action-only manifests', async () => {
  const p = { policy: address('a'), alias: address('b'), tokenL1: address('c'), tokenL2: address('d'),
    moduleL1: address('e'), moduleL2: address('f'), bridgeL1: address('8'), bridgeL2: address('9'), recipient: address('7'),
    decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Devnet USDC' };
  const c = { ...config, action: undefined, payments: p, code: [...config.code,
    ...[['l1', ['alias', 'tokenL1', 'moduleL1', 'bridgeL1']], ['l2', ['policy', 'tokenL2', 'moduleL2', 'bridgeL2']]]
      .flatMap(([chain, keys]) => keys.map(key => ({ chain, address: p[key], hash: hash(key) })))] };
  assert.equal(parseTreasuryConfig(c), c);
  assert.throws(() => parseTreasuryConfig({ ...c, payments: undefined }), /action/);
  for (const invalid of ['', null, '0x0', address('0')]) assert.throws(() => parseTreasuryConfig({ ...c, action: invalid }), /action/);
  assert.throws(() => actionTransaction(c, '1', 0n), /no owner-action fixture/);
  const client = new TreasuryClient(c);
  client.rpc = async () => ({ number: '0x1', hash: hash('block') });
  client.read = async (_rpc, target, _abi, method) => {
    assert.ok(target); assert.notEqual(method, 'value');
    return method === 'getOwners' ? [address('7')] : method === 'getThreshold' ? 1n : 0n;
  };
  assert.equal((await client.snapshot()).value, 0n);
});

test('Safe 1.3.0 L2 execution results and lost wallet responses retain canonical checks', async () => {
  assert.equal((await fixture({ legacy: true }).outcome(intent)).kind, 'settled');
  assert.equal((await fixture({ legacy: true, recover: true }).outcome({ ...intent, hash: undefined })).kind, 'settled');
  assert.equal((await fixture({ legacy: true, event: 'ExecutionFailure' }).outcome(intent)).kind, 'rejected');
  assert.equal((await fixture({ legacy: true, canonicalHash: hash('reorg') }).outcome(intent)).kind, 'pending');
  await assert.rejects(fixture({ legacy: true, transaction: { to: address('a') } }).outcome(intent), /does not match/);
});


test('signing and submission still reject a wallet on the other Safe network', async () => {
  const { paymentTransaction } = await import('../src/lib/treasury/payments.ts');
  const c = { ...config, l1: { ...config.l1, front: 'http://127.0.0.1:10001/composer/l1' }, payments: {
    policy: address('a'), alias: address('b'), tokenL1: address('c'), tokenL2: address('d'),
    moduleL1: address('e'), moduleL2: address('f'), bridgeL1: address('8'), bridgeL2: address('9'), recipient: address('7'),
    decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Devnet USDC', version: 2,
  } };
  for (const source of ['l1', 'l2']) {
    const payment = { source, recipient: address('7'), destination: 'l2', epoch: '1', amount: '1000000', fromL1: '0' };
    const tx = paymentTransaction(c, payment, 0n), client = new TreasuryClient(c);
    const snapshot = { source, owners: [address('7')], threshold: 1, nonce: 0n, value: 0n, fingerprint: '1:A' };
    client.validate = async () => {};
    client.snapshot = async () => snapshot;
    const calls = [];
    const provider = { request: async ({ method }) => {
      calls.push(method);
      if (method === 'eth_accounts') return [address('7')];
      if (method === 'eth_chainId') return String(c[source === 'l1' ? 'l2' : 'l1'].chainId);
      throw new Error(`Unexpected wallet request: ${method}`);
    } };
    await assert.rejects(client.approve(provider, tx, snapshot, address('7')), /Switch your wallet to the selected Safe/);
    await assert.rejects(client.prepare(provider, tx, snapshot, [], payment), /Switch your wallet to the selected Safe/);
    assert(calls.every(method => ['eth_accounts', 'eth_chainId'].includes(method)));
  }
});

test('standard policy validates its canonical alias and Safe-bound delegate without an alias reader', async () => {
  const p = { policy: address('7'), alias: address('8'), tokenL1: address('9'), tokenL2: address('a'), moduleL1: address('b'), moduleL2: address('c'),
    bridgeL1: address('d'), bridgeL2: address('e'), bridgeKind: 'standard', bridgeExecutorL1: address('f'), safeL2Alias: address('0') };
  const registryAbi = parseAbi(['function computeCrossChainProxyAddress(address,uint64) view returns(address)', 'function authorizedProxies(address) view returns(bool,address,uint64)']);
  const delegateAbi = parseAbi(['function safe() view returns(address)', 'function policyAlias() view returns(address)', 'function allowance() view returns(address)', 'function token() view returns(address)', 'function bridge() view returns(address)', 'function rollupId() view returns(uint64)']);
  const abi = [...paymentAbi, ...tokenAbi, ...moduleAbi, ...registryAbi, ...delegateAbi], calls = [];
  let mode;
  const client = new TreasuryClient({ ...config, payments: p });
  client.rpc = async (url, method, params) => {
    assert.equal(method, 'eth_call');
    const { functionName: name, args } = decodeFunctionData({ abi, data: params[0].data });
    calls.push(name); let result;
    if (name === 'computeCrossChainProxyAddress') result = args[0] === p.policy ? mode === 'canonical' ? address('1') : p.alias : p.safeL2Alias;
    else if (name === 'authorizedProxies') result = args[0] === p.alias ? [mode !== 'registered', mode === 'origin' ? config.safeL2 : p.policy, mode === 'rollup' ? 0n : 42n] : [true, config.safeL2, 42n];
    else if (params[0].to === p.bridgeExecutorL1) result = { safe: config.safeL1, policyAlias: mode === 'delegate' ? address('1') : p.alias,
      allowance: p.moduleL1, token: p.tokenL1, bridge: p.bridgeL1, rollupId: 42n }[name];
    else result = { safeL1: config.safeL1, safeL2: config.safeL2, canonicalToken: p.tokenL1, wrappedToken: p.tokenL2, allowanceL2: p.moduleL2,
      bridge: p.bridgeL2, bridgeExecutorL1: p.bridgeExecutorL1, rollupId: 42n, GLOBAL_LIMIT: 150_000_000n, PERIOD: 600n, decimals: 6, isModuleEnabled: true }[name];
    assert.notEqual(result, undefined, name);
    return encodeFunctionResult({ abi, functionName: name, result });
  };
  await client.validatePayments();
  assert(!calls.some(n => /aliasReader|aliasOf/.test(n)));
  for (mode of ['canonical', 'registered', 'origin', 'rollup']) await assert.rejects(client.validatePayments(), /Policy alias binding changed/);
  mode = 'delegate'; await assert.rejects(client.validatePayments(), /funding delegate binding changed/);
});
