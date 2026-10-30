import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichAccountTypes } from '../src/account-types.mjs';
import { decodeCrossChainTrace } from '../src/engine.mjs';
import { buildFlowModel } from '../flow/model.mjs';
import { renderTrace } from '../src/logical.mjs';
import { ChainReader, makeRpc } from '../src/rpc.mjs';
import { scenario, address } from './fixtures/scenarios.mjs';

const hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32);
function fixture(addresses = [address(1000)]) {
  const frames = addresses.map((to, i) => ({ id: `L2:${hash}:0.${i}`, chain: 'L2', transactionHash: hash,
    blockNumber: 10, to, type: 'CALL', role: 'application', children: [], output: '0x', decoded: { contractName: 'Unknown contract' } }));
  const trace = { frames, transactions: [{ chain: 'L2', hash, blockHash, blockNumber: 10 }], events: [] };
  const calls = [];
  const reader = {
    async optionalBatch(method, params, signal) {
      calls.push({ method, params, signal });
      return params.map(() => method === 'eth_getCode' ? '0x' : { hash: blockHash });
    },
  };
  return { trace, calls, reader, readers: { L2: reader } };
}

test('a single empty-code target is EOA and repeated calls share one historical lookup', async () => {
  const f = fixture([address(1000), address(1000).toUpperCase().replace('0X', '0x')]);
  await enrichAccountTypes(f.trace, f.readers);
  assert.deepEqual(f.calls.map(call => [call.method, call.params.length]), [['eth_getCode', 1], ['eth_getBlockByNumber', 1]]);
  assert.deepEqual(f.calls[0].params, [[address(1000), '0xa']]);
  assert.ok(f.trace.frames.every(frame => frame.decoded.contractName === 'EOA' && frame.decoded.accountType === 'eoa'));
  assert.equal(f.trace.frames[0].decoded.nameProvenance.blockHash, blockHash);
});

test('multiple distinct EOAs get stable labels, independent of call and response order', async () => {
  const f = fixture([address(1001), address(1000), address(1001)]);
  await enrichAccountTypes(f.trace, f.readers);
  assert.deepEqual(f.trace.frames.map(frame => frame.decoded.contractName), ['EOA_2', 'EOA_1', 'EOA_2']);
});

test('empty returns with deployed code, malformed code or unavailable reads stay unknown', async () => {
  for (const code of ['0x00', '0x6000', '0xef0100' + '11'.repeat(20), null, undefined, '', '0', '0x0', { error: 'missing state' }]) {
    const f = fixture();
    f.reader.optionalBatch = async method => { assert.equal(method, 'eth_getCode'); return [code]; };
    await enrichAccountTypes(f.trace, f.readers);
    assert.equal(f.trace.frames[0].decoded.contractName, 'Unknown contract', JSON.stringify(code));
  }
  const f = fixture();
  f.reader.optionalBatch = async () => { throw new Error('Archive unavailable'); };
  await enrichAccountTypes(f.trace, f.readers);
  assert.equal(f.trace.frames[0].decoded.contractName, 'Unknown contract');
});

test('precompiles, protocol targets, creations and observed code execution are not EOAs', async () => {
  for (const edit of [
    frame => { frame.to = address(1); },
    frame => { frame.role = 'system-value-transfer'; },
    frame => { frame.type = 'CREATE'; },
    frame => { frame.type = 'CREATE2'; },
    frame => { frame.children = ['child']; },
    frame => { frame.output = '0x01'; },
    frame => { frame.decoded.contractName = 'Known contract'; },
  ]) {
    const f = fixture(); edit(f.trace.frames[0]);
    await enrichAccountTypes(f.trace, f.readers);
    assert.equal(f.calls.length, 0);
    assert.equal(f.trace.frames[0].decoded.accountType, undefined);
  }
  const f = fixture();
  f.trace.events.push({ chain: 'L2', transactionHash: hash, address: address(1000) });
  await enrichAccountTypes(f.trace, f.readers);
  assert.equal(f.calls.length, 0, 'observed event emission establishes code execution');
});

test('an address created in the traced block is not called EOA from its empty end-of-block code', async () => {
  const f = fixture([address(1000), address(1000)]);
  f.trace.frames[0].type = 'CREATE2';
  await enrichAccountTypes(f.trace, f.readers);
  assert.equal(f.calls.length, 0);
});

test('direct failures stay unknown while an EOA in a reverted parent context can still be identified', async () => {
  for (const error of ['execution reverted', 'out of gas', 'invalid opcode']) {
    const f = fixture(); f.trace.frames[0].error = error;
    await enrichAccountTypes(f.trace, f.readers);
    assert.equal(f.trace.frames[0].decoded.contractName, 'Unknown contract');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.trace.frames[0].reverted = true;
  await enrichAccountTypes(f.trace, f.readers);
  assert.equal(f.trace.frames[0].decoded.contractName, 'EOA');
});

test('the HTTP batch transport associates reordered code replies with the correct addresses', async () => {
  const f = fixture([address(1000), address(1001)]), requests = [];
  const rpc = makeRpc({ fetch: async (_url, options) => {
    const payload = JSON.parse(options.body); requests.push(payload);
    return Response.json(payload.map(request => ({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'eth_getCode' ? request.params[0] === address(1000) ? '0x' : '0x00' : { hash: blockHash },
    })).reverse());
  } });
  await enrichAccountTypes(f.trace, { L2: new ChainReader('L2', 'read', 'archive', rpc) });
  assert.deepEqual(requests.map(batch => batch.map(request => request.method)), [['eth_getCode', 'eth_getCode'], ['eth_getBlockByNumber']]);
  assert.deepEqual(f.trace.frames.map(frame => frame.decoded.contractName), ['EOA', 'Unknown contract']);
});

test('code observations stay scoped to the chain and transaction block', async () => {
  const f = fixture([address(1000), address(1000), address(1000)]);
  const laterBlockHash = '0x' + 'ef'.repeat(32);
  f.trace.frames[1].chain = 'L1';
  f.trace.frames[2].transactionHash = 'later'; f.trace.frames[2].blockNumber = 11;
  f.trace.transactions.push({ chain: 'L1', hash, blockNumber: 10, blockHash },
    { chain: 'L2', hash: 'later', blockNumber: 11, blockHash: laterBlockHash });
  f.readers.L1 = { optionalBatch: async () => ['0x00'] };
  f.reader.optionalBatch = async (method, params) => params.map(p => method === 'eth_getCode'
    ? p[1] === '0xa' ? '0x' : '0x6000' : { hash: p[0] === '0xa' ? blockHash : laterBlockHash });
  await enrichAccountTypes(f.trace, f.readers);
  assert.deepEqual(f.trace.frames.map(frame => frame.decoded.contractName), ['EOA', 'Unknown contract', 'Unknown contract']);
});

test('a changed canonical block discards the empty-code classification', async () => {
  const f = fixture();
  f.reader.optionalBatch = async method => [method === 'eth_getCode' ? '0x' : { hash: 'reorg' }];
  await enrichAccountTypes(f.trace, f.readers);
  assert.equal(f.trace.frames[0].decoded.accountType, undefined);
});

test('optional code reads respect the remaining request budget and cannot publish after expiry', async () => {
  const f = fixture([address(1000), address(1001)]);
  await enrichAccountTypes(f.trace, f.readers, { maxRequests: 2 });
  assert.equal(f.trace.frames[0].decoded.contractName, 'EOA');
  assert.equal(f.trace.frames[1].decoded.contractName, 'Unknown contract');
  const slow = fixture(); let release;
  const pending = new Promise(resolve => { release = resolve; });
  slow.reader.optionalBatch = async () => { await pending; return ['0x']; };
  await enrichAccountTypes(slow.trace, slow.readers, { timeoutMs: 10 });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(slow.trace.frames[0].decoded.contractName, 'Unknown contract');
});

test('the engine passes the EOA label to both logical and visual models', async () => {
  const f = scenario({ direction: 'L2' }), tx = f.txs.L2.get(f.trigger), to = address(1000);
  Object.assign(tx.trace, { to, input: '0x', output: '0x', calls: [] });
  Object.assign(tx.transaction, { to, input: '0x' }); tx.receipt.logs = [];
  const rpc = f.config.rpc;
  f.config.rpc = async (url, method, params) => method === 'eth_getCode' ? '0x' : rpc(url, method, params);
  const trace = await decodeCrossChainTrace(f.config, f.trigger);
  const node = buildFlowModel(trace).nodes.find(node => node.address === to);
  assert.equal(node.contract, 'EOA'); assert.equal(node.accountType, 'eoa');
  assert.match(renderTrace(trace), /EOA/);
  assert.equal(trace.logicalNodes.find(node => node.id === `${trace.origin.transactionId}:0`).decoded.contractName, 'EOA');
});
