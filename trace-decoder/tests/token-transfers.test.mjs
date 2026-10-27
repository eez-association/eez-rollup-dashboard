import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlowModel, tokenTransfersByFrame } from '../flow/model.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = '0x' + '12'.repeat(32), token = address(5);
const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture() {
  const root = `L2:${hash}:0`, child = root + '.0';
  const frames = [
    { id: root, chain: 'L2', transactionHash: hash, type: 'CALL', from: address(1), to: token, contextAddress: token, input: '0xa9059cbb', children: [child], path: '0' },
    { id: child, parentId: root, chain: 'L2', transactionHash: hash, type: 'DELEGATECALL', from: token, to: address(6), contextAddress: token, input: '0xa9059cbb', children: [], path: '0.0' },
  ];
  const log = { chain: 'L2', transactionHash: hash, address: token, topics: [topic, word(1), word(2)], data: word(123456789012345678901234567890n) };
  const events = [{ ...log, id: 'trace-0', provenance: 'trace', frameId: child, committed: null }, { ...log, id: 'receipt-0', provenance: 'receipt', committed: true }];
  return { txHash: hash, origin: { chain: 'L2', transactionId: `L2:${hash}` }, metadata: {}, frames, events,
    transactions: [{ chain: 'L2', hash, receipt: { status: '0x1' } }], logicalNodes: frames.map(f => ({ ...f })), logicalRoots: [root] };
}
const notes = t => [...tokenTransfersByFrame(t).values()].flat();
function read(t, selector, value, extra = {}) {
  t.frames.push({ id: 'read-' + t.frames.length, chain: 'L2', transactionHash: hash, to: token, contextAddress: token, input: selector, decoded: { returns: [{ value }] }, ...extra });
}

test('transfer notes require persisted events, retain exact amounts and follow folded delegatecalls', () => {
  const t = fixture();
  assert.equal(notes(t).length, 1);
  assert.equal(notes(t)[0].amount, '123456789012345678901234567890');
  assert.equal(notes(t)[0].decimals, null);
  const model = buildFlowModel(t);
  assert.equal(model.nodes.length, 1);
  assert.equal(model.nodes[0].tokenTransfers.length, 1);
  assert.equal(model.nodes[0].tokenTransfers[0].token, token);
  t.events.pop();
  assert.equal(notes(t).length, 0);
});

test('repeated transfers retain multiplicity and mismatched counts remain unannotated', () => {
  const t = fixture();
  t.events.push({ ...t.events[0], id: 'trace-1' });
  assert.equal(notes(t).length, 0);
  t.events.push({ ...t.events[1], id: 'receipt-1' });
  assert.equal(notes(t).length, 2);
});

test('reverted calls, failed transactions, removed logs and NFT-shaped events produce no transfer notes', () => {
  for (const edit of [
    t => { t.frames[1].reverted = true; },
    t => { t.transactions[0].receipt.status = '0x0'; },
    t => { t.events[1].removed = true; },
    t => { t.events[0].reverted = true; },
    t => { t.events[0].address = address(99); },
    t => { t.events.forEach(e => { e.topics = [...e.topics, word(3)]; e.data = '0x'; }); },
    t => { t.events.forEach(e => { e.data = '0x'; }); },
  ]) {
    const t = fixture(); edit(t); assert.equal(notes(t).length, 0);
  }
});

test('metadata is scoped to token, chain and transaction; conflicts never guess decimals', () => {
  const t = fixture();
  read(t, '0x313ce567', '18', { chain: 'L1' });
  read(t, '0x313ce567', '18', { transactionHash: '0xother' });
  read(t, '0x313ce567', '18', { contextAddress: address(99) });
  read(t, '0x313ce567', '18', { reverted: true });
  assert.equal(notes(t)[0].decimals, null);
  read(t, '0x313ce567', '6'); read(t, '0x95d89b41', 'USDC');
  assert.equal(notes(t)[0].decimals, 6); assert.equal(notes(t)[0].symbol, 'USDC');
  read(t, '0x313ce567', '18');
  assert.equal(notes(t)[0].decimals, null);
});

test('zero addresses distinguish mint and burn events', () => {
  for (const [from, to, kind] of [[0, 2, 'mint'], [1, 0, 'burn'], [1, 2, 'transfer']]) {
    const t = fixture(); t.events.forEach(e => { e.topics = [topic, word(from), word(to)]; });
    assert.equal(notes(t)[0].kind, kind);
  }
});

// Missing display metadata is read at the transfer's block, not guessed.
const { enrichTokenMetadata } = await import('../src/token-metadata.mjs');
const { ethers } = await import('ethers');
const metadataAbi = new ethers.Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
function metadataFixture() {
  const t = fixture(), blockHash = '0x' + 'ab'.repeat(32);
  Object.assign(t.transactions[0].receipt, { blockHash, blockNumber: '0x20' });
  const calls = [];
  const reader = { async send(method, params) {
    calls.push({ method, params });
    if (method === 'eth_getBlockByNumber') return { hash: blockHash };
    const field = params[0].data === '0x313ce567' ? 'decimals' : 'symbol';
    return metadataAbi.encodeFunctionResult(field, [field === 'decimals' ? 6 : 'TESTUSDC']);
  } };
  return { t, calls, reader, blockHash };
}
test('missing token metadata is queried once per token/block on the correct chain and formats existing receipt events', async () => {
  const { t, calls, reader } = metadataFixture();
  t.events.push({ ...t.events[0], id: 'trace-1' }, { ...t.events[1], id: 'receipt-1' });
  await enrichTokenMetadata(t, { L2: reader, L1: { send() { throw new Error('wrong chain'); } } });
  assert.equal(calls.length, 3);
  assert(calls.filter(c => c.method === 'eth_call').every(c => c.params[0].to === token && c.params[1] === '0x20'));
  assert.equal(notes(t).length, 2);
  assert.equal(notes(t)[0].decimals, 6); assert.equal(notes(t)[0].symbol, 'TESTUSDC');
  assert.equal(t.frames.length, 2, 'metadata reads are not fabricated execution frames');
});
test('observed metadata avoids redundant RPC calls and conflicting trace reads stay unknown', async () => {
  const { t, calls, reader } = metadataFixture();
  read(t, '0x313ce567', '6'); read(t, '0x95d89b41', 'USDC');
  await enrichTokenMetadata(t, { L2: reader }); assert.equal(calls.length, 0);
  read(t, '0x313ce567', '18');
  await enrichTokenMetadata(t, { L2: reader });
  assert.equal(notes(t)[0].decimals, null); assert.equal(notes(t)[0].symbol, 'USDC');
});
test('metadata failures, malformed responses and reorgs keep raw units without querying latest', async () => {
  for (const mode of ['archive-error', 'malformed', 'reorg']) {
    const { t, reader, calls } = metadataFixture();
    const send = reader.send.bind(reader);
    reader.send = async (method, params) => {
      if (mode === 'archive-error') throw new Error('unavailable');
      if (mode === 'malformed' && method === 'eth_call') return '0x01';
      if (mode === 'reorg' && method === 'eth_getBlockByNumber') return { hash: '0x' + 'cd'.repeat(32) };
      return send(method, params);
    };
    await enrichTokenMetadata(t, { L2: reader });
    assert.equal(notes(t)[0].decimals, null); assert.equal(notes(t)[0].symbol, null);
    assert(!JSON.stringify(calls).includes('latest'));
  }
});
test('metadata is isolated by chain and receipt block; unsuccessful transfers cause no calls', async () => {
  const { t, reader, calls } = metadataFixture();
  t.transactions[0].receipt.status = '0x0';
  await enrichTokenMetadata(t, { L2: reader }); assert.equal(calls.length, 0);
  t.transactions[0].receipt.status = '0x1';
  await enrichTokenMetadata(t, { L2: reader });
  const copy = structuredClone(t); copy.events.forEach(e => e.chain = 'L1'); copy.frames.forEach(f => f.chain = 'L1'); copy.transactions[0].chain = 'L1';
  assert.equal(notes(copy)[0].decimals, null);
});
