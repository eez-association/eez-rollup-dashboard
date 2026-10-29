import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import { makeRpc, ChainReader } from '../src/rpc.mjs';
import { enrichTokenMetadata } from '../src/token-metadata.mjs';
import { tokenTransfersByFrame } from '../flow/model.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const abi = new ethers.Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
const notes = trace => [...tokenTransfersByFrame(trace).values()].flat();
function fixture(count = 1, { mixedChains = false, differentBlocks = false } = {}) {
  const frames = [], transactions = [], events = [], blocks = new Map();
  for (let i = 0; i < count; i++) {
    const chain = mixedChains && i % 2 ? 'L1' : 'L2', hash = word(100 + i);
    const blockNumber = '0x' + (32 + (differentBlocks ? i : 0)).toString(16), blockHash = word(200 + (differentBlocks ? i : 0));
    const token = address(10 + i), id = `${chain}:${hash}:0`;
    blocks.set(blockNumber, blockHash);
    frames.push({ id, chain, transactionHash: hash, contextAddress: token, to: token, input: '0x', children: [] });
    transactions.push({ chain, hash, receipt: { status: '0x1', blockNumber, blockHash } });
    const event = { chain, transactionHash: hash, address: token, topics: [topic, word(1), word(2)], data: word(100) };
    events.push({ ...event, id: `trace-${i}`, frameId: id, provenance: 'trace' },
      { ...event, id: `receipt-${i}`, provenance: 'receipt', committed: true });
  }
  const trace = { frames, transactions, events }, requests = [];
  const result = request => request.method === 'eth_getBlockByNumber' ? { hash: blocks.get(request.params[0]) }
    : request.params[0].data === '0x313ce567' ? abi.encodeFunctionResult('decimals', [6]) : abi.encodeFunctionResult('symbol', ['TEST']);
  const reply = request => ({ jsonrpc: '2.0', id: request.id, result: result(request) });
  const transport = async (url, options) => {
    const payload = JSON.parse(options.body); requests.push({ url, payload, signal: options.signal });
    assert(Array.isArray(payload), 'metadata must use HTTP batches');
    return Response.json(payload.map(reply).reverse());
  };
  const readers = fetcher => {
    const rpc = makeRpc({ fetch: fetcher });
    return Object.fromEntries(['L1', 'L2'].map(chain => [chain, new ChainReader(chain, `${chain}-read`, `${chain}-archive`, rpc)]));
  };
  return { trace, requests, transport, reply, readers };
}

test('eight tokens share one canonical check: 17 RPC methods in two HTTP batches', async () => {
  const f = fixture(40), originalEvents = JSON.stringify(f.trace.events);
  await enrichTokenMetadata(f.trace, f.readers(f.transport));
  assert.deepEqual(f.requests.map(r => r.payload.length), [16, 1]);
  assert(f.requests.every(r => r.url === 'L2-archive'));
  assert.equal(Object.keys(f.trace.tokenMetadata).length, 8);
  assert.equal(notes(f.trace).length, 40, 'the budget must not hide transfers');
  assert.equal(notes(f.trace).filter(t => t.decimals === null).length, 32);
  assert.equal(JSON.stringify(f.trace.events), originalEvents);
});

test('different blocks and chains stay separate and cost no more than 24 methods', async () => {
  const f = fixture(8, { mixedChains: true, differentBlocks: true });
  await enrichTokenMetadata(f.trace, f.readers(f.transport));
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests.reduce((sum, r) => sum + r.payload.length, 0), 24);
  for (const r of f.requests) for (const call of r.payload) {
    const tag = call.method === 'eth_call' ? call.params[1] : call.params[0];
    const tx = f.trace.transactions.find(t => t.receipt.blockNumber === tag);
    assert.equal(r.url, `${tx.chain}-archive`);
  }
  assert(notes(f.trace).every(t => t.decimals === 6 && t.symbol === 'TEST'));
});

test('batch rejection does not fan out into individual or alternate-endpoint retries', async () => {
  const f = fixture(8); let calls = 0;
  const readers = f.readers(async (_url, options) => {
    calls++; assert(Array.isArray(JSON.parse(options.body)));
    return Response.json({ error: { code: -32600, message: 'Batch unsupported' } }, { status: 400 });
  });
  await enrichTokenMetadata(f.trace, readers);
  await enrichTokenMetadata(f.trace, readers);
  assert.equal(calls, 1, 'remember a provider that rejects batches within the decode transport');
  assert(notes(f.trace).every(t => t.decimals === null));
});

test('one reverting metadata field does not discard valid batch siblings', async () => {
  const f = fixture(2);
  await enrichTokenMetadata(f.trace, f.readers(async (_url, options) => {
    const payload = JSON.parse(options.body);
    return Response.json(payload.map((r, i) => r.method === 'eth_call' && i === 0
      ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } } : f.reply(r)).reverse());
  }));
  const transfers = notes(f.trace);
  assert.equal(transfers[0].decimals, null); assert.equal(transfers[0].symbol, 'TEST');
  assert.equal(transfers[1].decimals, 6);
});

test('missing, duplicate or unexpected response IDs invalidate the optional batch', async () => {
  for (const corrupt of [r => r.slice(1), r => [r[0], r[0]], r => [r[0], { ...r[1], id: 999999 }]]) {
    const f = fixture(); let calls = 0;
    await enrichTokenMetadata(f.trace, f.readers(async (_url, options) => {
      calls++; return Response.json(corrupt(JSON.parse(options.body).map(f.reply)));
    }));
    assert.equal(calls, 1); assert.deepEqual(f.trace.tokenMetadata, {});
  }
});

test('a failed shared block check discards metadata for every token in that block', async () => {
  const f = fixture(8);
  await enrichTokenMetadata(f.trace, f.readers(async (_url, options) => Response.json(JSON.parse(options.body).map(r =>
    r.method === 'eth_getBlockByNumber' ? { jsonrpc: '2.0', id: r.id, result: { hash: word(999) } } : f.reply(r)))));
  assert.deepEqual(f.trace.tokenMetadata, {});
});

test('metadata respects an exhausted or small remaining worker budget', async () => {
  for (const budget of [{ maxRequests: 0 }, { maxRequests: 2 }, { timeoutMs: 0 }, { maxRequests: 6 }]) {
    const f = fixture(8);
    await enrichTokenMetadata(f.trace, f.readers(f.transport), budget);
    if (budget.maxRequests === 6) {
      assert.equal(f.requests.reduce((sum, r) => sum + r.payload.length, 0), 5);
      assert.equal(Object.keys(f.trace.tokenMetadata).length, 2);
    } else assert.equal(f.requests.length, 0);
  }
});

for (const phase of ['eth_call', 'eth_getBlockByNumber']) {
  test(`metadata deadline aborts ${phase} without waiting for the normal RPC timeout`, { timeout: 2000 }, async () => {
    const f = fixture(8); let signal, calls = 0;
    await enrichTokenMetadata(f.trace, f.readers(async (_url, options) => {
      calls++; signal = options.signal;
      const payload = JSON.parse(options.body);
      if (payload[0].method !== phase) return Response.json(payload.map(f.reply));
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }), { timeoutMs: 20 });
    assert.equal(calls, phase === 'eth_call' ? 1 : 2);
    assert.equal(signal.aborted, true); assert.deepEqual(f.trace.tokenMetadata, {});
  });
}

test('one slow chain cannot discard already validated metadata on the other chain', { timeout: 2000 }, async () => {
  const f = fixture(2, { mixedChains: true });
  await enrichTokenMetadata(f.trace, f.readers(async (url, options) => {
    if (url === 'L1-archive') return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return f.transport(url, options);
  }), { timeoutMs: 30 });
  assert.equal(notes(f.trace)[0].decimals, 6);
  assert.equal(notes(f.trace)[1].decimals, null);
});

test('late transports cannot publish metadata or issue further requests after expiry', { timeout: 2000 }, async () => {
  const f = fixture(8); let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await enrichTokenMetadata(f.trace, f.readers(async (_url, options) => {
    calls++; await pending; return Response.json(JSON.parse(options.body).map(f.reply));
  }), { timeoutMs: 20 });
  const before = JSON.stringify(f.trace);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(JSON.stringify(f.trace), before);
});

test('custom transports without batches retain bounded concurrency and request counts', async () => {
  const f = fixture(8); let calls = 0, active = 0, peak = 0;
  const rpc = async (url, method, params) => {
    assert.equal(url, 'archive'); calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return f.reply({ id: 1, method, params }).result;
  };
  await enrichTokenMetadata(f.trace, { L2: new ChainReader('L2', 'read', 'archive', rpc) });
  assert.equal(calls, 17); assert.equal(peak, 2);
});

test('the default HTTP transport sends two batches to the configured local endpoint', async () => {
  const f = fixture(8), payloads = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); payloads.push(payload);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload.map(f.reply).reverse()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await enrichTokenMetadata(f.trace, { L2: new ChainReader('L2', url, null, makeRpc({})) });
    assert.deepEqual(payloads.map(p => p.length), [16, 1]);
    assert(notes(f.trace).every(t => t.decimals === 6 && t.symbol === 'TEST'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
