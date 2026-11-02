import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, toFunctionSelector } from 'viem';

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
globalThis.window = { location: { search: '', origin: 'http://test.invalid' } };
const { setConfig } = await import('../src/config.ts');
const { eezL1Abi, eezL2Abi } = await import('../src/abi/eez.ts');
const { decodeDebugLog, decodeDebugPayload, decodeRevert, inspectDebugTransaction, inspectDebugBlock,
  relatedTransactions, transactionHashes, fetchDebugTrace, loadMoreDebugBlocks, managerAddress, fetchLiveBatchHistory, inspectPostedBatch, inspectExecution } = await import('../src/lib/executionDebugger.ts');

const hash = byte => '0x' + byte.repeat(32);
const address = byte => '0x' + byte.repeat(20);
const registry = address('11'), manager = address('22'), caller = address('33');
const l1Hash = hash('a1'), l2Hash = hash('a2'), l1TxHash = hash('b1'), l2TxHash = hash('b2'), callHash = hash('cc');
setConfig({ l1Rpc: 'http://l1.invalid', l2Rpc: 'http://l2.invalid', l2ProxyRpc: 'http://composer-l2.invalid', rollupsAddress: registry, ccmL2Address: manager });

function event(chain, signature, indexed, types = [], values = [], emitter) {
  return { address: emitter ?? (chain === 'l1' ? registry : manager),
    topics: [keccak256(stringToHex(signature)), ...indexed], data: encodeAbiParameters(types.map(type => ({ type })), values),
    logIndex: '0x0', transactionHash: chain === 'l1' ? l1TxHash : l2TxHash,
    blockHash: chain === 'l1' ? l1Hash : l2Hash, blockNumber: chain === 'l1' ? '0x64' : '0x7' };
}
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const l1Consumed = event('l1', 'ExecutionConsumed(bytes32,uint64,uint256)', [callHash, word(1), word(2)]);
const l2Consumed = event('l2', 'ExecutionConsumed(bytes32,uint256)', [callHash, word(0)]);
const l1Tx = { hash: l1TxHash, from: caller, to: registry, input: '0x', value: '0x0', blockNumber: '0x64', blockHash: l1Hash, transactionIndex: '0x0' };
const l2Tx = { ...l1Tx, hash: l2TxHash, to: manager, blockNumber: '0x7', blockHash: l2Hash };
const settlement = { l1BlockNumber: '0x64', l1BlockHash: l1Hash, l1TransactionHash: l1TxHash,
  l2Blocks: [{ number: '0x7', hash: l2Hash }], canonicalL2: true, l2Finalized: false };

function node({ failL1 = false, indexUnavailable = false, noSettlement = false, noncanonical = false, failed = false, pending = false, receiptUnavailable = false, absentCounterpart = false } = {}) {
  const calls = [];
  const rpc = async (url, method, params) => {
    const chain = url.includes('l1') ? 'l1' : 'l2'; calls.push({ chain, url, method, params });
    if (method.startsWith('eez_get')) assert.equal(url, 'http://composer-l2.invalid');
    if (chain === 'l1' && failL1) throw new Error('L1 offline');
    if (method === 'eth_getTransactionByHash') {
      const tx = chain === 'l1' ? l1Tx : l2Tx;
      return params[0] === tx.hash ? { ...tx, ...(pending ? { blockHash: null, blockNumber: null } : {}) } : null;
    }
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') {
      if (absentCounterpart && chain === 'l1') return null;
      const tx = chain === 'l1' ? l1Tx : l2Tx;
      return { hash: tx.blockHash, number: tx.blockNumber, parentHash: hash('dd'), timestamp: '0x1', gasUsed: '0x5208', gasLimit: '0xffffff', transactions: [tx] };
    }
    if (method === 'eth_getTransactionReceipt') {
      if (receiptUnavailable) throw new Error('receipt not ready');
      if (pending) return null;
      return { status: failed ? '0x0' : '0x1', gasUsed: '0x5208', blockHash: chain === 'l1' ? l1Hash : l2Hash,
        blockNumber: chain === 'l1' ? '0x64' : '0x7', logs: failed ? [] : [chain === 'l1' ? l1Consumed : l2Consumed] };
    }
    if (method.startsWith('eez_get')) {
      if (indexUnavailable) throw new Error('Method not found');
      const result = { ...settlement, canonicalL2: !noncanonical };
      return method === 'eez_getSettlementByL2Block' ? noSettlement ? null : result : noSettlement ? [] : [result];
    }
    if (method === 'debug_traceTransaction') return { type: 'CALL', from: caller, to: registry, error: 'execution reverted', output: '0x' };
    throw new Error(`Unexpected RPC ${method}`);
  };
  return { rpc, calls };
}

test('unified lookup detects transactions and blocks and respects explicit chains', async () => {
  const base = node();
  const rpc = (url, method, params) => method === 'eth_getBlockByHash' && params[0] !== (url.includes('l1') ? l1Hash : l2Hash)
    ? Promise.resolve(null) : base.rpc(url, method, params);
  const transaction = await inspectExecution(l2TxHash, 'auto', 'auto', rpc);
  assert.equal(transaction.kind, 'transaction'); assert.equal(transaction.context.selected.tx.hash, l2TxHash);
  const byHash = await inspectExecution(l2Hash, 'auto', 'auto', rpc);
  assert.equal(byHash.kind, 'block'); assert.equal(byHash.context.sourceChain, 'l2');
  const byNumber = await inspectExecution('100', 'auto', 'auto', rpc);
  assert.equal(byNumber.kind, 'block'); assert.equal(byNumber.context.sourceChain, 'l1');
  assert.equal((await inspectExecution('7', 'l2', 'auto', rpc)).context.sourceChain, 'l2');
  assert.equal((await inspectExecution('latest', 'l2', 'auto', rpc)).context.sourceChain, 'l2');
  await assert.rejects(inspectExecution(hash('ff'), 'auto', 'auto', rpc), /Transaction not found.*Block lookup failed/);
  await assert.rejects(inspectExecution('garbage', 'auto', 'auto', rpc), /transaction hash, block number/);
});

test('unified lookup preserves ambiguous hashes and transaction inspection failures', async () => {
  const base = node();
  const ambiguous = (url, method, params) => method === 'eth_getTransactionByHash' ? Promise.resolve(l1Tx) : base.rpc(url, method, params);
  await assert.rejects(inspectExecution(l1TxHash, 'auto', 'auto', ambiguous), /exists on both chains/);
  assert.equal(base.calls.length, 0, 'ambiguous transactions must not fall through to block inspection');
  await assert.rejects(inspectExecution(l1Hash, 'auto', 'block', base.rpc), /block hash exists on both chains/);
  assert.equal((await inspectExecution(l1Hash, 'l1', 'block', base.rpc)).context.sourceChain, 'l1');
  const missing = (url, method, params) => method === 'eth_getBlockByHash' ? Promise.resolve(null) : base.rpc(url, method, params);
  await assert.rejects(inspectExecution(l1TxHash, 'l1', 'auto', missing), /block .*not found/);
  const offline = async () => { throw new Error('RPC offline'); };
  await assert.rejects(inspectExecution(hash('ff'), 'auto', 'auto', offline), /RPC errors:.*RPC offline.*Block lookup failed/);
});

test('current and deployed L2 ABI selectors and packed L1 batch stay pinned', () => {
  const selectors = eezL2Abi.filter(item => item.type === 'function').map(toFunctionSelector);
  assert.ok(selectors.includes('0xb301bc80'), 'deployed pre-cursor loadExecutionTable ABI is present');
  assert.ok(selectors.includes('0x9e2d7358'), 'deployed incoming call ABI is present');
  assert.equal(toFunctionSelector(eezL1Abi.find(item => item.name === 'postAndVerifyBatch')), '0xe4a480e4');
  for (const load of eezL2Abi.filter(item => item.type === 'function' && item.name === 'loadExecutionTable')) {
    const entry = { proxyEntryHash: callHash, incomingCalls: [], expectedOutgoingCalls: [], rollingHash: hash('44'), success: true, returnData: '0x1234' };
    const staticEntry = { ...entry, expectedEntryIndex: 3n };
    const data = encodeFunctionData({ abi: [load], functionName: 'loadExecutionTable', args: [[entry], [staticEntry]] });
    const decoded = decodeDebugPayload('l2', data);
    assert.equal(decoded.entries[0].proxyEntryHash, callHash);
    assert.equal(decoded.staticEntries[0].returnData, '0x1234');
  }
});

test('decode packed batch entries with nested calls, negative ether delta, static entries and revert data', () => {
  const call = { revertNextNCalls: 2, isStatic: false, gas: 90000n, sourceAddress: caller, sourceRollupId: 1n, targetAddress: registry, value: 7n, data: '0x1234' };
  const entry = { rollupUpdates: [{ rollupId: 1n, etherDelta: -7n, currentRoot: hash('44'), newRoot: hash('55') }], proxyEntryHash: callHash,
    l2ToL1Calls: [call], expectedL1ToL2Calls: [{ expectedL1toL2Hash: hash('66'), l2ToL1Calls: [call], revertedOrStaticRollingHash: hash('77'), success: false, returnData: '0x1234' }],
    rollingHash: hash('88'), destinationRollupId: 1n, success: false, returnData: '0x1234' };
  const batch = { expectedRootPerRollup: [], entries: [entry], staticEntries: [], immediateEntryCount: 1n, immediateStaticEntryCount: 0n,
    proofSystems: [], rollupIdsWithProofSystems: [], blobIndices: [], callData: '0x', proofs: [], blockNumber: 0n, bindMsgSenderInPublicInput: false };
  const data = encodeFunctionData({ abi: eezL1Abi, functionName: 'postAndVerifyBatch', args: [batch] });
  const payload = decodeDebugPayload('l1', data);
  assert.equal(payload.entries[0].rollupUpdates[0].etherDelta, -7n);
  assert.equal(payload.entries[0].expectedL1ToL2Calls[0].l2ToL1Calls[0].revertNextNCalls, 2);
  assert.equal(payload.immediateEntryCount, 1);
});

test('decode new event layouts without legacy actions; do not decode another emitter as EEZ', () => {
  assert.equal(decodeDebugLog('l1', l1Consumed).args.entryQueueIndex, 2n);
  assert.equal(decodeDebugLog('l2', l2Consumed).args.entryIndex, 0n);
  assert.equal(decodeDebugLog('l1', { ...l1Consumed, address: caller }).protocol, false);
  const result = event('l1', 'CallResult(uint256,uint256,bool,bytes)', [word(2), word(0)], ['bool', 'bytes'], [false, '0xdeadbeef']);
  assert.equal(decodeDebugLog('l1', result).args.returnData, '0xdeadbeef');
  const posted = event('l1', 'BatchPosted(bytes32,uint64[])', [], ['bytes32', 'uint64[]'], [hash('99'), [1n]]);
  assert.equal(decodeDebugLog('l1', posted).args.sharedPublicInput, hash('99'));
  assert.equal(decodeDebugLog('l1', event('l1', 'BatchPosted(uint256)', [word(1)])).args.rollupCount, 1n);
  assert.equal(decodeDebugLog('l1', event('l1', 'BatchPosted(uint256)', [], ['uint256'], [1n])).args.rollupCount, 1n);
});

test('L2 hash auto detection loads exact hash-addressed L1 counterpart and matching call evidence', async () => {
  const { rpc, calls } = node();
  const context = await inspectDebugTransaction(l2TxHash, 'auto', rpc);
  assert.equal(context.sourceChain, 'l2');
  assert.equal(context.selected.tx.hash, l2TxHash);
  assert.equal(relatedTransactions(context)[0].tx.hash, l1TxHash);
  assert.ok(calls.some(call => call.method === 'eez_getSettlementByL2Block' && call.params[0] === l2Hash));
  assert.ok(calls.some(call => call.chain === 'l1' && call.method === 'eth_getBlockByHash' && call.params[0] === l1Hash));
  assert.ok(!calls.some(call => call.method.includes('simulate')), 'never simulate historical execution');
});

test('L1 block uses settlement index rather than postBatch calldata block-number guesses', async () => {
  const { rpc, calls } = node();
  const context = await inspectDebugBlock('l1', '100', rpc);
  assert.equal(context.blocks.length, 2);
  assert.ok(calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x64'));
  assert.ok(calls.some(call => call.method === 'eez_getSettledL2RangesByL1Block' && call.params[0] === l1Hash));
});

test('one unavailable RPC does not prevent auto detecting a transaction on the other chain', async () => {
  const context = await inspectDebugTransaction(l2TxHash, 'auto', node({ failL1: true }).rpc);
  assert.equal(context.selected.chain, 'l2');
  assert.ok(context.warnings.some(warning => warning.includes('L1 offline')));
});

test('settlement unavailable, not yet settled, noncanonical and missing counterpart retain source evidence', async () => {
  for (const options of [{ indexUnavailable: true }, { noSettlement: true }, { noncanonical: true }, { absentCounterpart: true }]) {
    const context = await inspectDebugTransaction(l2TxHash, 'l2', node(options).rpc);
    assert.equal(context.blocks.length, 1);
    assert.equal(context.selected.events[0].name, 'ExecutionConsumed');
    assert.ok(context.warnings.length > 0);
  }
});

test('reverted and pending transactions and unavailable receipts remain inspectable', async () => {
  const failed = await inspectDebugTransaction(l2TxHash, 'l2', node({ failed: true }).rpc);
  assert.equal(failed.selected.receipt.status, '0x0');
  assert.equal(failed.selected.events.length, 0);
  const pending = await inspectDebugTransaction(l2TxHash, 'l2', node({ pending: true }).rpc);
  assert.equal(pending.sourceBlock, null);
  assert.equal(pending.selected.receipt, null);
  const unavailable = await inspectDebugTransaction(l2TxHash, 'l2', node({ receiptUnavailable: true }).rpc);
  assert.equal(unavailable.selected.receipt, null);
  assert.ok(unavailable.selected.warnings.some(warning => warning.includes('receipt not ready')));
});

test('reject invalid hashes; preserve trace errors, custom protocol errors and unknown revert bytes', async () => {
  await assert.rejects(inspectDebugTransaction('0x1234'), /transaction hash/);
  const { rpc } = node();
  const context = await inspectDebugTransaction(l1TxHash, 'l1', rpc);
  assert.equal((await fetchDebugTrace(context.selected, rpc)).error, 'execution reverted');
  assert.equal(decodeRevert('l1', keccak256(stringToHex('RollingHashMismatch()')).slice(0, 10)), 'RollingHashMismatch()');
  assert.equal(decodeRevert('l2', '0xdeadbeef'), null);
  assert.equal(transactionHashes({ events: [], payload: { entries: [{ proxyEntryHash: hash('00') }], staticEntries: [] } }).size, 0);
});

test('large settlement ranges paginate by exact hashes without dropping indexed blocks', async () => {
  const { rpc: base } = node();
  const blocks = Array.from({ length: 31 }, (_, i) => ({ number: '0x' + (i + 1).toString(16), hash: hash((i + 1).toString(16).padStart(2, '0')) }));
  const rpc = async (url, method, params) => {
    if (method === 'eez_getSettledL2RangesByL1Block') return [{ ...settlement, l2Blocks: blocks }];
    if (url.includes('l2') && method === 'eth_getBlockByHash') {
      const item = blocks.find(block => block.hash === params[0]);
      return { ...item, parentHash: hash('dd'), timestamp: '0x1', gasUsed: '0x0', gasLimit: '0xffffff', transactions: [] };
    }
    return base(url, method, params);
  };
  let context = await inspectDebugBlock('l1', '100', rpc);
  assert.equal(context.blocks.length, 13);
  assert.equal(context.remainingBlocks.length, 19);
  assert.ok(!context.warnings.some(warning => warning.startsWith("Showing ")));
  assert.equal(context.blocks.at(-1).hash, blocks.at(-1).hash);
  while (context.remainingBlocks.length) {
    context = await loadMoreDebugBlocks(context, rpc);
    assert.ok(!context.warnings.some(warning => warning.startsWith("Showing ")));
  }
  assert.deepEqual(new Set(context.blocks.filter(block => block.chain === 'l2').map(block => block.hash)), new Set(blocks.map(block => block.hash)));
});

test('discover forwarding registries and non-predeploy L2 managers, scoped to their network', async () => {
  setConfig({ l1Rpc: 'http://discovery-l1.invalid', l2Rpc: 'http://discovery-l2.invalid', rollupsAddress: '', ccmL2Address: '' });
  const batch = { expectedRootPerRollup: [], entries: [], staticEntries: [], immediateEntryCount: 0n, immediateStaticEntryCount: 0n,
    proofSystems: [], rollupIdsWithProofSystems: [], blobIndices: [], callData: '0x', proofs: [], blockNumber: 0n, bindMsgSenderInPublicInput: false };
  const input = encodeFunctionData({ abi: eezL1Abi, functionName: 'postAndVerifyBatch', args: [batch] });
  const post = event('l1', 'BatchPosted(bytes32,uint64[])', [], ['bytes32', 'uint64[]'], [hash('99'), [1n]], registry);
  const { rpc: base } = node({ noSettlement: true });
  const rpc = async (url, method, params) => {
    const reply = await base(url, method, params);
    if (url.includes('l1') && method === 'eth_getBlockByNumber') return { ...reply, transactions: [{ ...l1Tx, to: caller, input }] };
    if (url.includes('l1') && method === 'eth_getTransactionReceipt') return { ...reply, logs: [post] };
    return reply;
  };
  const l1 = await inspectDebugBlock('l1', '100', rpc);
  assert.equal(managerAddress('l1'), registry);
  assert.equal(l1.sourceBlock.transactions[0].payload.method, 'postAndVerifyBatch');
  assert.equal(l1.sourceBlock.transactions[0].events[0].name, 'BatchPosted');
  const l2 = await inspectDebugBlock('l2', '7', rpc);
  assert.equal(managerAddress('l2'), manager);
  assert.equal(l2.sourceBlock.transactions[0].events[0].name, 'ExecutionConsumed');
  setConfig({ l1Rpc: 'http://different-l1.invalid', l2Rpc: 'http://different-l2.invalid' });
  assert.equal(managerAddress('l1'), '');
  assert.equal(managerAddress('l2'), '0x4200000000000000000000000000000000000007');
  setConfig({ l1Rpc: 'http://l1.invalid', l2Rpc: 'http://l2.invalid', rollupsAddress: registry, ccmL2Address: manager });
});

function liveNode() {
  setConfig({ l1Rpc: 'http://live-l1.invalid', l2Rpc: 'http://live-l2.invalid', rollupsAddress: registry });
  const state = { head: 3000n, logs: [], calls: [], failLogs: false, failL2: false, failIndex: false, indexed: true, finalized: undefined };
  state.rpc = async (url, method, params) => {
    state.calls.push({ url, method, params });
    if (method === 'eth_blockNumber') {
      if (url.includes('l2') && state.failL2) throw new Error('L2 offline');
      return '0x' + state.head.toString(16);
    }
    if (method === 'eth_getLogs') {
      if (state.failLogs) throw new Error('logs offline');
      const filter = params[0];
      assert.ok(BigInt(filter.toBlock) - BigInt(filter.fromBlock) < 512n);
      return state.logs.filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock));
    }
    if (method === 'eez_getSettledL2RangesByL1Block') {
      assert.equal(url, 'http://composer-l2.invalid', 'live batches query the Composer settlement index');
      if (state.failIndex) throw new Error('index offline');
      if (!state.indexed) return [];
      return state.logs.filter(log => log.blockHash === params[0] && log.address === registry).map(log => ({ l1TransactionHash: log.transactionHash, canonicalL2: true, l2Finalized: state.finalized,
        l2Blocks: Array.from({length: Number(BigInt(log.transactionHash) % 3n) + 1}, (_, i) => ({number: '0x' + i.toString(16), hash: word(i)})) }));
    }
    throw new Error(`Unexpected live RPC ${method}`);
  };
  state.post = (number, id, index = 0) => ({ ...event('l1', 'BatchPosted(bytes32,uint64[])', [], ['bytes32', 'uint64[]'], [callHash, [1n]]),
    transactionHash: word(id), blockHash: word(number), blockNumber: '0x' + BigInt(number).toString(16), logIndex: '0x' + index.toString(16) });
  state.logs = Array.from({ length: 75 }, (_, i) => state.post(2990 - i * 10, i + 1));
  return state;
}

test('live backfills the latest 50 posts, newest first, without loading receipts or empty chain blocks', async () => {
  const state = liveNode();
  const history = await fetchLiveBatchHistory(null, state.rpc);
  assert.equal(history.batches.length, 50);
  assert.equal(history.batches[0].transactionHash, word(1));
  assert.equal(history.batches.at(-1).transactionHash, word(50));
  assert.ok(state.calls.every(call => ['eth_blockNumber', 'eth_getLogs', 'eez_getSettledL2RangesByL1Block'].includes(call.method)));
});

test('live can load only the selected settlement and expand metadata on demand', async () => {
  const state = liveNode();
  const first = await fetchLiveBatchHistory(null, state.rpc, 'latest');
  assert.equal(first.batches.length, 50);
  assert.equal(first.batches.filter(b => b.l2BlockCount !== undefined).length, 1);
  assert.equal(state.calls.filter(c => c.method.startsWith('eez_get')).length, 1);
  const selected = await fetchLiveBatchHistory(first, state.rpc, first.batches[10].transactionHash);
  assert.equal(selected.batches.filter(b => b.l2BlockCount !== undefined).length, 2);
  assert.equal(state.calls.filter(c => c.method.startsWith('eez_get')).length, 2);
  const all = await fetchLiveBatchHistory(selected, state.rpc);
  assert.equal(all.batches.filter(b => b.l2BlockCount !== undefined).length, 50);
  assert.equal(state.calls.filter(c => c.method.startsWith('eez_get')).length, 50);
});

test('an index disappearance clears old settlement metadata and errors cannot refresh cached evidence', async () => {
  const state = liveNode(); state.finalized = false;
  const first = await fetchLiveBatchHistory(null, state.rpc, 'latest');
  const expired = { ...first, batches: first.batches.map(b => ({ ...b, settlementCheckedAt: 0 })) };
  state.indexed = false;
  const missing = await fetchLiveBatchHistory(expired, state.rpc, 'latest');
  assert.equal(missing.batches[0].l2BlockCount, undefined);
  assert.equal(missing.batches[0].l2Range, undefined);
  assert.equal(missing.batches[0].settlement, null);
  state.failIndex = true;
  const failed = await fetchLiveBatchHistory(expired, state.rpc, 'latest');
  assert.equal(failed.batches[0].settlement, undefined);
  assert.ok(failed.warnings.some(w => w.includes('index offline')));
});

test('batch inspection reuses only fresh settlement evidence bound to the posting block and transaction', async () => {
  for (const variant of ['fresh', 'expired', 'wrong-block', 'wrong-tx', 'noncanonical']) {
    const state = node();
    const known = { ...settlement, canonicalL2: variant !== 'noncanonical',
      ...(variant === 'wrong-block' ? { l1BlockHash: hash('ff') } : {}),
      ...(variant === 'wrong-tx' ? { l1TransactionHash: hash('ff') } : {}) };
    const context = await inspectPostedBatch({ transactionHash: l1TxHash, blockHash: l1Hash, blockNumber: '0x64',
      settlement: known, settlementCheckedAt: variant === 'expired' ? 0 : Date.now() }, state.rpc);
    assert.equal(state.calls.filter(c => c.method.startsWith('eez_get')).length,
      ['fresh', 'noncanonical'].includes(variant) ? 0 : 1, variant);
    assert.equal(context.blocks.some(b => b.chain === 'l2'), variant !== 'noncanonical', variant);
  }
});

test('ordinary Chiado blocks preserve live history; new posts deduplicate and cap at 50, including same-block batches', async () => {
  const state = liveNode();
  const history = await fetchLiveBatchHistory(null, state.rpc);
  state.head++;
  const unchanged = await fetchLiveBatchHistory(history, state.rpc);
  assert.deepEqual(unchanged.batches, history.batches);
  state.logs.push(state.post(3001, 76, 0), state.post(3001, 77, 1), state.post(3001, 77, 1));
  const updated = await fetchLiveBatchHistory(unchanged, state.rpc);
  assert.equal(updated.batches.length, 50);
  assert.deepEqual(updated.batches.slice(0, 2).map(batch => batch.transactionHash), [word(77), word(76)]);
  assert.equal(updated.batches.at(-1).transactionHash, word(48));
  assert.deepEqual(history.batches, unchanged.batches, 'updates do not mutate the retained history');
});

test('live removes replaced posts after a shallow reorg and refills the 50-post window', async () => {
  const state = liveNode();
  const history = await fetchLiveBatchHistory(null, state.rpc);
  state.logs = state.logs.filter(log => log.transactionHash !== word(1));
  const updated = await fetchLiveBatchHistory(history, state.rpc);
  assert.equal(updated.batches.length, 50);
  assert.equal(updated.batches[0].transactionHash, word(2));
  assert.equal(updated.batches.at(-1).transactionHash, word(51));
});

test('sparse live history continues backfilling from its saved cursor across polls', async () => {
  const state = liveNode(); state.head = 10000n; state.logs = [state.post(5000, 1)];
  const first = await fetchLiveBatchHistory(null, state.rpc);
  assert.equal(first.batches.length, 0);
  const second = await fetchLiveBatchHistory(first, state.rpc);
  assert.equal(second.batches.length, 1);
  assert.equal(second.batches[0].transactionHash, word(1));
  assert.ok(BigInt(second.before) < BigInt(first.before));
});

test('live retains the previous data on log failures and keeps working when L2 is unavailable', async () => {
  const state = liveNode();
  const history = await fetchLiveBatchHistory(null, state.rpc);
  state.failLogs = true;
  await assert.rejects(fetchLiveBatchHistory(history, state.rpc), /logs offline/);
  assert.equal(history.batches.length, 50);
  state.failLogs = false; state.failL2 = true;
  const degraded = await fetchLiveBatchHistory(history, state.rpc);
  assert.deepEqual(degraded.batches, history.batches);
  assert.ok(degraded.warnings.some(warning => warning.includes('L2 offline')));
});


test('batch rows obtain per-transaction L2 counts from the index, cache them, and share lookups for same-block posts', async () => {
  const state = liveNode();
  state.logs.push(state.post(2990, 100, 1));
  const first = await fetchLiveBatchHistory(null, state.rpc);
  assert.equal(first.batches[0].l2BlockCount, 2);
  assert.equal(first.batches[1].l2BlockCount, 2);
  assert.equal(first.batches[2].l2BlockCount, 3);
  assert.deepEqual(first.batches[0].l2Range, {first:'0x0',last:'0x1'});
  assert.deepEqual(first.batches[2].l2Range, {first:'0x0',last:'0x2'});
  assert.equal(state.calls.filter(call => call.method === 'eez_getSettledL2RangesByL1Block').length, 49);
  state.calls.length = 0;
  const next = await fetchLiveBatchHistory(first, state.rpc);
  assert.deepEqual(next.batches, first.batches);
  assert.ok(!state.calls.some(call => call.method === 'eez_getSettledL2RangesByL1Block'));
});

test('missing batch counts retry after the throttle and index failures preserve history', async () => {
  const state = liveNode(); state.indexed = false;
  const first = await fetchLiveBatchHistory(null, state.rpc);
  assert.ok(first.batches.every(batch => batch.l2BlockCount === undefined));
  state.calls.length = 0;
  state.indexed = true;
  await fetchLiveBatchHistory(first, state.rpc);
  assert.ok(!state.calls.some(call => call.method === 'eez_getSettledL2RangesByL1Block'));
  const expired = {...first, batches: first.batches.map(batch => ({...batch, settlementCheckedAt: 0}))};
  const indexed = await fetchLiveBatchHistory(expired, state.rpc);
  assert.ok(indexed.batches.every(batch => batch.l2BlockCount > 0));
  state.failIndex = true;
  const unavailable = await fetchLiveBatchHistory(expired, state.rpc);
  assert.equal(unavailable.batches.length, 50);
  assert.ok(unavailable.warnings.some(warning => warning.includes('index offline')));
});


test('unconfigured live history selects the registry indexed by this L2 and refills 50 posts from that deployment', async () => {
  const state = liveNode();
  setConfig({rollupsAddress: ''});
  const other = address('99');
  state.logs.push(...Array.from({length:75},(_,i)=>({...state.post(2995-i*10, 1000+i), address:other})));
  const first = await fetchLiveBatchHistory(null, state.rpc);
  assert.equal(first.registryAddress, registry);
  assert.equal(first.batches.length,50);
  assert.ok(first.batches.every(batch=>batch.registryAddress===registry && batch.l2BlockCount > 0));
  assert.equal(first.batches.at(-1).transactionHash,word(50));
  state.calls.length=0;
  const next=await fetchLiveBatchHistory(first,state.rpc);
  assert.deepEqual(next.batches,first.batches);
  assert.ok(state.calls.filter(call=>call.method==='eth_getLogs').every(call=>call.params[0].address===registry));
});

test('sync-only inspection loads the terminal indexed L2 hash and retains the full settlement range', async () => {
  setConfig({ l1Rpc:'http://l1.invalid',l2Rpc:'http://l2.invalid',rollupsAddress:registry,ccmL2Address:manager });
  const {rpc:base}=node();
  const blocks=[{number:'0x9',hash:hash('f9')},{number:'0x7',hash:l2Hash},{number:'0x8',hash:hash('f8')}];
  const calls=[];
  const rpc=async(url,method,params)=>{
    calls.push({url,method,params});
    if(method==='eez_getSettledL2RangesByL1Block')return [{...settlement,l2Blocks:blocks}];
    if(url.includes('l2')&&method==='eth_getBlockByHash')return {hash:params[0],number:'0x9',transactions:[],parentHash:hash('dd'),timestamp:'0x1',gasUsed:'0x0',gasLimit:'0xffffff'};
    return base(url,method,params);
  };
  const context=await inspectDebugBlock('l1','100',rpc,true);
  assert.equal(context.syncOnly,true);
  assert.deepEqual(context.blocks.filter(block=>block.chain==='l2').map(block=>block.hash),[hash('f9')]);
  assert.deepEqual(context.settlements[0].l2Blocks,blocks);
  assert.equal(context.remainingBlocks.length,0);
  assert.equal(calls.filter(call=>call.url.includes('l2')&&call.method==='eth_getBlockByHash').length,1);
});


test("selecting a batch in an L1 block with multiple posts loads only that batch’s sync block", async () => {
  setConfig({l1Rpc:'http://l1.invalid',l2Rpc:'http://l2.invalid',rollupsAddress:registry,ccmL2Address:manager});
  const batch={expectedRootPerRollup:[],entries:[],staticEntries:[],immediateEntryCount:0n,immediateStaticEntryCount:0n,proofSystems:[],rollupIdsWithProofSystems:[],blobIndices:[],callData:'0x',proofs:[],blockNumber:0n,bindMsgSenderInPublicInput:false};
  const input=encodeFunctionData({abi:eezL1Abi,functionName:'postAndVerifyBatch',args:[batch]});
  const {rpc:base}=node();
  const rpc=async(url,method,params)=>{
    if(method==='eez_getSettledL2RangesByL1Block')return [settlement,{...settlement,l1TransactionHash:hash('bb'),l2Blocks:[{number:'0x8',hash:hash('f8')}]}];
    const reply=await base(url,method,params);
    if(url.includes('l1')&&method==='eth_getTransactionByHash')return reply&&{...reply,input};
    if(url.includes('l1')&&method==='eth_getBlockByHash')return {...reply,transactions:[{...l1Tx,input}]};
    return reply;
  };
  const context=await inspectDebugTransaction(l1TxHash,'l1',rpc,true);
  assert.equal(context.settlements.length,1);
  assert.equal(context.settlements[0].l1TransactionHash,l1TxHash);
  assert.deepEqual(context.blocks.filter(block=>block.chain==='l2').map(block=>block.hash),[l2Hash]);
});


test('batch settlement status refreshes from indexed to finalized without discarding cached ranges', async () => {
  const state=liveNode();state.finalized=false;
  const first=await fetchLiveBatchHistory(null,state.rpc);
  assert.ok(first.batches.every(batch=>batch.l2Finalized===false));
  state.finalized=true;
  const expired={...first,batches:first.batches.map(batch=>({...batch,settlementCheckedAt:0}))};
  const finalized=await fetchLiveBatchHistory(expired,state.rpc);
  assert.ok(finalized.batches.every(batch=>batch.l2Finalized===true));
  assert.deepEqual(finalized.batches.map(batch=>batch.l2Range),first.batches.map(batch=>batch.l2Range));
  state.calls.length=0;
  await fetchLiveBatchHistory(finalized,state.rpc);
  assert.ok(!state.calls.some(call=>call.method==='eez_getSettledL2RangesByL1Block'));
});

const { buildExecutionPairs, compareExecution, eventCallHash, executionPlans, firstFailurePath, flattenTrace, inspectionHash, summarizeBatch, txKey } = await import('../src/lib/executionAnalysis.ts');
const { decodeTraceCall, getExecutionAbi } = await import('../src/lib/executionAbi.ts');
test('precompile ABI lookup never contacts an explorer on either chain', async () => {
  const originalFetch = globalThis.fetch;
  setConfig({ l1Explorer: 'https://abi-test.invalid', l2ExplorerApi: 'https://abi-test.invalid/l2' });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('precompiles must not request a contract ABI'); };
  try {
    for (const chain of ['l1', 'l2']) for (const value of [1, 2, 9, 10, 17, 256]) {
      assert.equal(await getExecutionAbi(chain, '0x' + value.toString(16).padStart(40, '0')), null);
    }
    assert.equal(requests, 0, 'precompile lookups must never reach the explorer, even when errors are caught');
  } finally { globalThis.fetch = originalFetch; setConfig({ l1Explorer: '', l2ExplorerApi: '' }); }
});

test('posted batch inspection uses log block evidence when the transaction hash index is missing', async () => {
  const state = node();
  const rpc = (url, method, params) => {
    assert.notEqual(method, 'eth_getTransactionByHash');
    return state.rpc(url, method, params);
  };
  const batch = { transactionHash: l1TxHash, blockHash: l1Hash, blockNumber: '0x64' };
  const context = await inspectPostedBatch(batch, rpc);
  assert.equal(context.selected.tx.hash, l1TxHash);
  assert.equal(context.selected.chain, 'l1');
  assert.equal(context.sourceBlock.hash, l1Hash);
  await assert.rejects(inspectPostedBatch({ ...batch, transactionHash: hash('ff') }, rpc), /missing from its block/);
  await assert.rejects(inspectPostedBatch({ ...batch, blockNumber: '0x65' }, rpc), /Batch block changed/);
});
const analysisEvent = (name, args) => ({ name, args, protocol: true, raw: l1Consumed });
const analysisTx = (chain, entries, events = [], opts = {}) => ({ chain, tx: { ...(chain === 'l1' ? l1Tx : l2Tx), ...opts.tx }, receipt: { status: '0x1', logs: [], gasUsed: '0x1', ...opts.receipt }, payload: entries === null ? null : { method: opts.method ?? 'postAndVerifyBatch', entries, staticEntries: [], args: {}, immediateEntryCount: 0 }, events, warnings: [] });
const analysisContext = (...txs) => ({ sourceChain: txs[0].chain, selected: txs[0], sourceBlock: { transactions: txs }, blocks: [{ transactions: txs }], settlements: [], warnings: [] });
const planned = (overrides = {}) => ({ proxyEntryHash: callHash, rollingHash: hash('dd'), success: true, returnData: '0x1234', ...overrides });

test('paired execution retains per-chain event positions and marks repeated hashes ambiguous', () => {
  const l1 = analysisTx('l1', [planned()], [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: callHash })]);
  const l2 = analysisTx('l2', null, [analysisEvent('IncomingCrossChainCallExecuted', { crossChainCallHash: callHash }), analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 0n }), analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: hash('dd') })]);
  const pair = buildExecutionPairs(analysisContext(l1, l2))[0];
  assert.equal(pair.direction, 'L1 → L2'); assert.equal(pair.ambiguous, false);
  assert.equal(pair.occurrences[2].eventIndex, 1); assert.equal(eventCallHash(l2, 2), callHash);
  l2.events.push(analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 1n }));
  assert.equal(buildExecutionPairs(analysisContext(l1, l2))[0].ambiguous, true);
});

test('entry comparison proves recorded outcome and rolling hash without inventing return bytes', () => {
  const tx = analysisTx('l1', [planned()], [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryQueueIndex: 7n }), analysisEvent('EntryExecuted', { entryIndex: 7n, rollingHash: hash('dd') })]);
  const evidence = compareExecution(analysisContext(tx))[0];
  assert.equal(evidence.checks[0].state, 'Match'); assert.equal(evidence.checks[1].state, 'Match');
  assert.equal(evidence.checks[2].state, 'Missing evidence');
  tx.events[1].args.rollingHash = hash('ee');
  assert.equal(compareExecution(analysisContext(tx))[0].state, 'Mismatch');
});

test('repeated identical plans are ambiguous and posting success cannot prove planned execution', () => {
  const tx = analysisTx('l1', [planned(), planned()], [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryQueueIndex: 9n }), analysisEvent('EntryExecuted', { entryIndex: 9n, rollingHash: hash('dd') })]);
  assert.ok(compareExecution(analysisContext(tx)).every(item => item.state === 'Ambiguous'));
  tx.events = []; tx.payload.entries = [planned({ success: false })];
  assert.equal(compareExecution(analysisContext(tx))[0].checks[0].observed, undefined);
});

test('L2 evidence belongs to its preceding table, never another load with the same hash', () => {
  const first = analysisTx('l2', [planned()], [], { tx: { transactionIndex: '0x0' }, method: 'loadExecutionTable' });
  const second = analysisTx('l2', [planned()], [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 0n }), analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: hash('dd') })], { tx: { hash: hash('d2'), transactionIndex: '0x2' }, method: 'executeIncomingCrossChainCall' });
  const evidence = compareExecution(analysisContext(first, second));
  assert.equal(evidence[0].checks[0].state, 'Missing evidence');
  // An identical plan in a replaced table must not make the current table ambiguous.
  assert.equal(evidence[1].checks[0].state, 'Match');
});

test('direct incoming trace checks decoded bytes and preserves expected reverts with rolled-back logs', () => {
  const tx = analysisTx('l2', [planned()], [], { method: 'executeIncomingCrossChainCall' });
  const root = { type: 'CALL', from: caller, to: manager, output: encodeAbiParameters([{ type: 'bytes' }], ['0x1234']) };
  const evidence = compareExecution(analysisContext(tx), { [txKey(tx)]: root })[0];
  assert.equal(evidence.checks[0].state, 'Match'); assert.equal(evidence.checks[2].state, 'Match');
  tx.payload.entries[0].success = false; root.error = 'execution reverted'; root.output = '0x1234';
  assert.equal(compareExecution(analysisContext(tx), { [txKey(tx)]: root })[0].checks[0].state, 'Match');
  assert.equal(flattenTrace(tx, root)[0].classification, 'Expected revert'); assert.equal(firstFailurePath(tx, root), null);
  root.output = '0x9876'; assert.equal(compareExecution(analysisContext(tx), { [txKey(tx)]: root })[0].state, 'Mismatch');
});

test('failure navigation skips handled nested reverts and locates the propagated failure', () => {
  const tx = analysisTx('l1', []);
  const root = { type: 'CALL', from: caller, error: 'reverted', output: '0x12', calls: [
    { type: 'CALL', from: caller, calls: [{ type: 'CALL', from: caller, error: 'caught', output: '0xff' }] },
    { type: 'CALL', from: caller, error: 'reverted', output: '0x12' },
  ] };
  assert.equal(flattenTrace(tx, root).find(frame => frame.path === '0.0.0').classification, 'Handled revert');
  assert.equal(firstFailurePath(tx, root), '0.1');
});

test('skips and execution-table entries survive summary search; payload and events do not duplicate plans', () => {
  const entry = planned({ incomingCalls: [{ targetAddress: caller }] });
  const tx = analysisTx('l2', [entry], [analysisEvent('ExecutionTableLoaded', { entries: [entry], staticEntries: [] }), analysisEvent('L2TxSkipped', { entryIndex: 0n })]);
  assert.equal(executionPlans(tx).length, 1); assert.equal(compareExecution(analysisContext(tx))[0].state, 'Skipped');
  const summary = summarizeBatch(analysisContext(tx)); assert.equal(summary.skipped, 1); assert.ok(summary.search.includes(caller)); assert.ok(summary.search.includes(callHash));
});

test('inspection links restore a Live batch and separate L2 selection without forcing Debug TX', () => {
  const tx = analysisTx('l2', null);
  const route = inspectionHash({ mode: 'live', chain: 'auto', batch: l1TxHash, selected: tx, event: 4, tab: 'entries', call: callHash });
  const params = new URLSearchParams(route.split('?')[1]);
  assert.equal(params.get('mode'), 'live'); assert.equal(params.get('batch'), l1TxHash); assert.equal(params.get('selected'), l2TxHash); assert.equal(params.get('selectedChain'), 'l2'); assert.equal(params.get('event'), '4'); assert.equal(params.get('tab'), 'entries'); assert.equal(params.has('tx'), false);
  assert.equal(new URLSearchParams(inspectionHash({ mode: 'debug', chain: 'l1', source: l1TxHash, selected: tx }).split('?')[1]).get('tx'), l1TxHash);
  const block = new URLSearchParams(inspectionHash({ mode: 'inspect', kind: 'block', chain: 'l2', source: l2Hash }).split('?')[1]);
  assert.equal(block.get('mode'), 'inspect'); assert.equal(block.get('block'), l2Hash); assert.equal(block.has('tx'), false);
  const transaction = new URLSearchParams(inspectionHash({ mode: 'inspect', kind: 'transaction', chain: 'l2', source: l2TxHash }).split('?')[1]);
  assert.equal(transaction.get('tx'), l2TxHash); assert.equal(transaction.has('block'), false);
});

test('trace decoding uses local protocol ABI and preserves unknown contract data', async () => {
  setConfig({ ccmL2Address: manager });
  const input = encodeFunctionData({ abi: [{ type: 'function', name: 'ping', inputs: [{ name: 'n', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }], functionName: 'ping', args: [42n] });
  const contract = { name: 'Test contract', abi: [{ type: 'function', name: 'ping', inputs: [{ name: 'n', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }] };
  const trace = { type: 'CALL', from: caller, to: manager, input, output: encodeAbiParameters([{ type: 'bool' }], [true]) };
  const decoded = decodeTraceCall('l2', trace, contract); assert.equal(decoded.method, 'ping'); assert.deepEqual(decoded.args, [42n]); assert.equal(decoded.result, true);
  assert.equal(decodeTraceCall('l2', trace, null).method, undefined);
  assert.equal((await getExecutionAbi('l2', manager)).name, 'EEZL2');
});

test('unrelated L1 transactions do not mark the selected batch as failed or duplicate its plans', () => {
  const source = analysisTx('l1', [planned()], []);
  const unrelated = analysisTx('l1', null, [], { tx: { hash: hash('e1') }, receipt: { status: '0x0' } });
  const ctx = analysisContext(source, unrelated);
  assert.equal(summarizeBatch(ctx).failures, 0);
  const matching = analysisTx('l1', null, [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryQueueIndex: 0n })], { tx: { hash: hash('e2') }, receipt: { status: '0x0' } });
  assert.equal(summarizeBatch(analysisContext(source, matching)).failures, 1);
});

test('explorer ABI lookup preserves tuple components, caches requests, and limits concurrent fetches', async () => {
  const originalFetch = globalThis.fetch;
  setConfig({ l1Explorer: 'https://abi-test.invalid', l2ExplorerApi: 'https://abi-test.invalid/l2' });
  const tupleAbi = [{ type: 'function', name: 'withTuple', stateMutability: 'view', inputs: [{ name: 'entry', type: 'tuple', components: [{ name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], outputs: [] }];
  let active = 0, peak = 0, requests = 0;
  globalThis.fetch = async () => { requests++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { ok: true, json: async () => ({ abi: tupleAbi, name: 'TupleContract' }) }; };
  try {
    const contracts = await Promise.all(['81','82','83','84','85','86'].map(byte => getExecutionAbi('l1', address(byte))));
    assert.equal(peak, 4); assert.equal(requests, 6);
    assert.equal(await getExecutionAbi('l1', address('81')), contracts[0]); assert.equal(requests, 6);
    const input = encodeFunctionData({ abi: tupleAbi, functionName: 'withTuple', args: [{ value: 7n, data: '0x1234' }] });
    const decoded = decodeTraceCall('l1', { type: 'CALL', from: caller, to: address('81'), input }, contracts[0]);
    assert.equal(decoded.method, 'withTuple'); assert.deepEqual(decoded.args, [{ value: 7n, data: '0x1234' }]);
  } finally { globalThis.fetch = originalFetch; setConfig({ l1Explorer: '', l2ExplorerApi: '' }); }
});

test('chain lanes exclude unrelated transactions and keep direct, nested, and reverted EEZ calls on both chains', async () => {
  const { isEezTransaction } = await import('../src/lib/executionAnalysis.ts');
  setConfig({ rollupsAddress: registry, ccmL2Address: manager });
  for (const chain of ['l1', 'l2']) {
    const ordinary = analysisTx(chain, null, [], { tx: { to: address('99'), input: '0x' } });
    assert.equal(isEezTransaction(ordinary), false);
    ordinary.events = [{ ...analysisEvent('Raw log', {}), protocol: false }];
    assert.equal(isEezTransaction(ordinary), false);
    const nested = analysisTx(chain, null, [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash })], { tx: { to: address('99') } });
    assert.equal(isEezTransaction(nested), true);
    const reverted = analysisTx(chain, null, [], { receipt: { status: '0x0' } });
    assert.equal(isEezTransaction(reverted), true);
    assert.equal(isEezTransaction(analysisTx(chain, [planned()], [])), true);
  }
});

const { alignTimelineRows, buildExecutionTimeline, describeTimelineEvent } = await import('../src/lib/executionTimeline.ts');
const timelineContext = (...transactions) => ({ sourceChain: 'l1', sourceBlock: null, selected: null, settlements: [], warnings: [], blocks: transactions.map(tx => ({ chain: tx.chain, number: tx.tx.blockNumber, timestamp: '0x64', transactions: [tx] })) });

test('timeline preserves block, transaction, and log order independently on both chains, without rendering plans as execution', () => {
  setConfig({ rollupsAddress: registry, ccmL2Address: manager });
  const late = analysisTx('l1', [planned()], [analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: hash('dd') })], { tx: { hash: hash('f1'), blockNumber: '0x65', transactionIndex: '0x0' } });
  const early = analysisTx('l1', null, [analysisEvent('BatchPosted', {})], { tx: { hash: hash('f2'), blockNumber: '0x64', transactionIndex: '0x2' } });
  const first = analysisTx('l1', null, [analysisEvent('EntryExecuted', { entryIndex: 0n }), analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryQueueIndex: 0n })], { tx: { hash: hash('f3'), blockNumber: '0x64', transactionIndex: '0x1' } });
  first.events[0].raw = { ...l1Consumed, logIndex: '0x4' }; first.events[1].raw = { ...l1Consumed, logIndex: '0x3' };
  const l2 = analysisTx('l2', [planned()], [analysisEvent('ExecutionTableLoaded', { entries: [planned()], staticEntries: [] })]);
  const timeline = buildExecutionTimeline(timelineContext(late, early, first, l2));
  assert.deepEqual(timeline.chains.l1.map(group => group.tx.tx.hash), [first.tx.hash, early.tx.hash, late.tx.hash]);
  assert.deepEqual(timeline.chains.l1.flatMap(group => group.steps).map(step => step.order), [1, 2, 3, 4]);
  assert.equal(timeline.chains.l1[0].steps[0].event.name, 'ExecutionConsumed'); assert.equal(timeline.chains.l1[0].steps[0].eventIndex, 1);
  assert.equal(timeline.chains.l2[0].steps[0].order, 1); assert.equal(timeline.steps.length, 5);
  assert.equal(timeline.chains.l2[0].steps[0].kind, 'Table'); assert.match(timeline.chains.l2[0].steps[0].description, /execution plan/);
});

test('timeline keeps reverted EEZ transactions visible without inventing receipt steps and excludes non-EEZ transactions', () => {
  const failed = analysisTx('l1', null, [], { receipt: { status: '0x0' } });
  const ordinary = analysisTx('l1', null, [], { tx: { to: address('99'), hash: hash('f4') } });
  const timeline = buildExecutionTimeline(timelineContext(failed, ordinary));
  assert.equal(timeline.chains.l1.length, 1); assert.equal(timeline.chains.l1[0].tx.receipt.status, '0x0'); assert.equal(timeline.steps.length, 0);
});

test('timeline call-hash links retain repeated occurrences as ambiguous candidates', () => {
  const source = analysisTx('l1', null, [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: callHash })]);
  const target = analysisTx('l2', null, [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 0n }), analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 1n })]);
  const timeline = buildExecutionTimeline(timelineContext(source, target));
  assert.equal(timeline.connections.length, 2); assert.ok(timeline.connections.every(link => link.ambiguous && link.basis === 'Matching call hash'));
});

test('timeline connects replay candidates through source/data/value and uniquely associated L2 table results despite different trigger hashes', () => {
  const incoming = { sourceAddress: caller, sourceRollupId: 0n, targetAddress: address('55'), data: '0x12345678', value: 5n };
  const source = analysisTx('l1', null, [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: hash('fe'), sourceAddress: caller, callData: incoming.data, value: 5n })]);
  const table = analysisTx('l2', [planned({ incomingCalls: [incoming] })], [analysisEvent('ExecutionTableLoaded', { entries: [planned({ incomingCalls: [incoming] })], staticEntries: [] })], { method: 'loadExecutionTable', tx: { transactionIndex: '0x0' } });
  const consumer = analysisTx('l2', null, [analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 0n }), analysisEvent('CallResult', { entryIndex: 0n, callNumber: 0n, success: true, returnData: '0x' }), analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: hash('dd') })], { tx: { hash: hash('f5'), transactionIndex: '0x1' } });
  const ctx = timelineContext(source, table, consumer);
  let timeline = buildExecutionTimeline(ctx);assert.equal(timeline.connections.length, 1);assert.equal(timeline.connections[0].basis, 'Replay candidate');assert.equal(timeline.connections[0].ambiguous, false);
  source.events[0].args.value = 6n;assert.equal(buildExecutionTimeline(ctx).connections.length, 0);
  source.events[0].args.value = 5n;source.events.push({ ...source.events[0] });timeline = buildExecutionTimeline(ctx);assert.equal(timeline.connections.length, 2);assert.ok(timeline.connections.every(link => link.ambiguous));
});

test('immediate L1 replay candidates link a proven entry completion without guessing nested call-result indices', () => {
  const source = analysisTx('l2', null, [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: callHash, sourceAddress: caller, callData: '0x12345678', value: 0n })]);
  const entry = planned({ proxyEntryHash: hash('00'), l2ToL1Calls: [{ sourceAddress: caller, sourceRollupId: 1n, data: '0x12345678', value: 0n }] });
  const target = analysisTx('l1', [entry], [analysisEvent('EntryExecuted', { entryIndex: 9n, rollingHash: entry.rollingHash })]);
  const timeline = buildExecutionTimeline(timelineContext(source, target));assert.equal(timeline.connections.length, 1);assert.equal(timeline.steps.find(step => step.id === timeline.connections[0].to).event.name, 'EntryExecuted');
});

test('timeline explains call reverts and rollback spans without treating every revert as an unexpected failure', () => {
  assert.match(describeTimelineEvent('l2', analysisEvent('CallResult', { callNumber: 0n, entryIndex: 0n, success: false, returnData: '0x1234' })).description, /may be expected/);
  const rollback = describeTimelineEvent('l1', analysisEvent('CallsReverted', { startL2ToL1Call: 2n, nCalls: 3n, entryIndex: 0n }));assert.equal(rollback.title, 'Calls 2–4 rolled back');assert.equal(rollback.kind, 'Rollback');
});

test('timeline never links a static replay or a replay from a different connected rollup to a nonstatic outgoing call', () => {
  const source = analysisTx('l2', null, [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: callHash, sourceAddress: caller, callData: '0x12345678', value: 0n })]);
  const call = { sourceAddress: caller, sourceRollupId: 2n, data: '0x12345678', value: 0n, isStatic: false };
  const entry = planned({ proxyEntryHash: hash('00'), l2ToL1Calls: [call] });
  const target = analysisTx('l1', [entry], [analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: entry.rollingHash })]);const ctx=timelineContext(source,target);
  setConfig({ rollupId:'1' });assert.equal(buildExecutionTimeline(ctx).connections.length,0);
  setConfig({ rollupId:'2' });assert.equal(buildExecutionTimeline(ctx).connections.length,1);
  call.isStatic=true;assert.equal(buildExecutionTimeline(ctx).connections.length,0);setConfig({ rollupId:'1' });
});

const alignmentFixture = (left, right, links = []) => {
  const steps = (chain, names) => names.map((name, index) => ({ id: `${chain}:${index}`, order: index + 1, tx: { chain }, event: { name } }));
  const l1 = steps('l1', left), l2 = steps('l2', right);
  return { chains: { l1: [{ steps: l1 }], l2: [{ steps: l2 }] }, steps: [...l1, ...l2], connections: links.map(([a, b, basis = 'Replay candidate', ambiguous = false]) => ({ from: l1[a].id, to: l2[b].id, basis, ambiguous, hash: null })) };
};
const assertAlignmentOrder = (timeline, rows) => {
  for (const chain of ['l1', 'l2']) assert.deepEqual(rows.flatMap(row => row[chain] ? [row[chain].id] : []), timeline.chains[chain].flatMap(group => group.steps.map(step => step.id)));
  assert.equal(new Set(rows.flatMap(row => [row.l1, row.l2].filter(Boolean).map(step => step.id))).size, timeline.steps.length);
};

test('shared timeline pairs an outgoing call with its actual incoming event before consumed-entry evidence', () => {
  const source = analysisTx('l1', null, [analysisEvent('CrossChainCallExecuted', { crossChainCallHash: callHash })]);
  const target = analysisTx('l2', null, [analysisEvent('IncomingCrossChainCallExecuted', { crossChainCallHash: callHash }), analysisEvent('ExecutionConsumed', { crossChainCallHash: callHash, entryIndex: 0n })]);
  const timeline = buildExecutionTimeline(timelineContext(source, target));
  const rows = alignTimelineRows(timeline);
  assert.equal(rows.length, 2); assert.equal(rows[0].l1.event.name, 'CrossChainCallExecuted'); assert.equal(rows[0].l2.event.name, 'IncomingCrossChainCallExecuted');
  assert.equal(rows[0].connection.basis, 'Matching call hash'); assert.equal(rows[1].l1, null);
  assert.equal(timeline.connections.length, 2); assertAlignmentOrder(timeline, rows);
});

test('nested crossing links keep both log sequences intact and align the longest consistent replay sequence', () => {
  const timeline = alignmentFixture(['Outgoing', 'Outgoing', 'Completion'], ['Outgoing', 'Result', 'Result'], [[0,1],[1,2],[2,0]]);
  const rows = alignTimelineRows(timeline);
  assert.equal(rows.filter(row => row.connection).length, 2);
  assert.deepEqual(rows.filter(row => row.connection).map(row => [row.l1.id, row.l2.id]), [['l1:0','l2:1'],['l1:1','l2:2']]);
  assert.equal(timeline.connections.length, 3); assertAlignmentOrder(timeline, rows);
});

test('proven call hashes take precedence over conflicting replay candidates', () => {
  const timeline = alignmentFixture(['Outgoing', 'Outgoing', 'Outgoing'], ['IncomingCrossChainCallExecuted', 'Result', 'Result'], [[0,1],[1,2],[2,0,'Matching call hash']]);
  const rows = alignTimelineRows(timeline);
  assert.equal(rows.filter(row => row.connection).length, 1); assert.equal(rows.find(row => row.connection).connection.basis, 'Matching call hash');
  assertAlignmentOrder(timeline, rows);
});

test('ambiguous matches and independent events never become a shared execution step', () => {
  const timeline = alignmentFixture(['Outgoing','BatchPosted'], ['IncomingCrossChainCallExecuted','EntryExecuted'], [[0,0,'Matching call hash',true]]);
  const rows = alignTimelineRows(timeline);
  assert.equal(rows.length, 4); assert.ok(rows.every(row => !row.connection && !(row.l1 && row.l2)));
  assert.equal(timeline.connections.length, 1); assertAlignmentOrder(timeline, rows);
});

test('shared timeline handles one-sided and empty evidence without fabricated counterparts', () => {
  for (const timeline of [alignmentFixture(['BatchPosted'],[]), alignmentFixture([],['ExecutionTableLoaded','EntryExecuted']), alignmentFixture([],[])]) {
    const rows = alignTimelineRows(timeline); assert.equal(rows.length, timeline.steps.length); assertAlignmentOrder(timeline, rows);
  }
});

const { buildExecutionFlow, flowReturnKind, flowExecutionConnections } = await import('../src/lib/executionFlow.ts');
const proxy = address('44'), destination = address('55');
const dispatchInput = (data = '0x12345678') => toFunctionSelector('executeOnBehalf(address,uint64,bytes)') + encodeAbiParameters([{type:'address'},{type:'uint64'},{type:'bytes'}],[destination,0n,data]).slice(2);
const outgoingInput = (source = caller, data = '0x12345678') => encodeFunctionData({abi:eezL1Abi,functionName:'executeCrossChainCall',args:[source,data]});
const bytesResult = data => encodeAbiParameters([{type:'bytes'}],[data]);
const identityHash = (chain, source = caller, data = '0x12345678', target = destination) => keccak256(encodeAbiParameters([{type:'bool'},{type:'address'},{type:'uint64'},{type:'address'},{type:'uint64'},{type:'uint256'},{type:'uint64'},{type:'bytes'}],[false,source,chain==='l1'?0n:1n,target,chain==='l1'?1n:0n,0n,0n,data]));
const callLog = (chain, source = caller, data = '0x12345678') => ({...analysisEvent('CrossChainCallExecuted',{crossChainCallHash:identityHash(chain,source,data),proxy,sourceAddress:source,callData:data,value:0n}),raw:{...l1Consumed,address:chain==='l1'?registry:manager}});
const resultLog = (chain, data = '0x', success = true) => ({...analysisEvent('CallResult',{entryIndex:0n,callNumber:0n,l2ToL1CallNumber:0n,success,returnData:data}),raw:{...l1Consumed,address:chain==='l1'?registry:manager}});
const incomingPlan = (chain, data = '0x12345678', source = caller) => planned({proxyEntryHash:hash('00'),...(chain==='l1'?{l2ToL1Calls:[{targetAddress:destination,sourceAddress:source,sourceRollupId:1n,data,value:0n,gas:0n,isStatic:false}]}:{incomingCalls:[{targetAddress:destination,sourceAddress:source,sourceRollupId:0n,data,value:0n,gas:0n,isStatic:false}]})});
const sourceTrace = (chain, result = '0x') => ({type:'CALL',from:proxy,to:chain==='l1'?registry:manager,input:outgoingInput(),output:bytesResult(result),value:'0x0'});
const dispatchTrace = (chain, data = '0x12345678', result = '0x') => ({type:'CALL',from:chain==='l1'?registry:manager,to:proxy,input:dispatchInput(data),output:result,value:'0x0'});
const rootTrace = child => ({type:'CALL',from:caller,to:registry,calls:[child]});
const pairedFixture = (chain) => {
  const remote=chain==='l1'?'l2':'l1'; const entry=incomingPlan(remote);
  const source=analysisTx(chain,null,[callLog(chain)]);
  const target=analysisTx(remote,[entry],[resultLog(remote),analysisEvent('EntryExecuted',{entryIndex:0n,rollingHash:entry.rollingHash})]);
  return {source,target,ctx:timelineContext(source,target),traces:{[txKey(source)]:sourceTrace(chain),[txKey(target)]:rootTrace(dispatchTrace(remote))}};
};

test('flow hides consumed/completed markers and preserves original indices for result inspection', () => {
  const tx=analysisTx('l2',null,[analysisEvent('ExecutionConsumed',{entryIndex:4n}),resultLog('l2'),analysisEvent('CallsReverted',{nCalls:2n}),analysisEvent('EntryExecuted',{entryIndex:4n})]);
  const flow=buildExecutionFlow(timelineContext(tx));
  assert.deepEqual(flow.nodes.map(node=>node.event.name),['CallResult','CallsReverted']);assert.deepEqual(flow.nodes.map(node=>node.eventIndex),[1,2]);
  assert.deepEqual(flow.timeline.steps.map(node=>node.event.name),['ExecutionConsumed','CallResult','CallsReverted','EntryExecuted']);
});

test('both call directions have aligned requests and a return to the original caller', () => {
  for(const chain of ['l1','l2']){
    const {ctx,source,traces}=pairedFixture(chain);const flow=buildExecutionFlow(ctx,source,traces);
    assert.equal(flow.calls.length,1);assert.equal(flow.calls[0].source.tx.chain,chain);assert.equal(flow.calls[0].target.tx.chain,chain==='l1'?'l2':'l1');
    assert.equal(flow.calls[0].destination,destination);assert.equal(flow.calls[0].result.evidence,'Caller trace');assert.equal(flow.calls[0].result.data,'0x');
    assert.deepEqual(flow.actions.map(action=>[action.kind,action.depth]),[['request',0],['return',0]]);assert.equal(flow.actions[1].anchor.event.name,'CallResult');
  }
});

test('flow separates immediate entries with repeated queue indices using rolling hashes', () => {
  const {source,target,ctx,traces}=pairedFixture('l2');const first=planned({proxyEntryHash:hash('00'),rollingHash:hash('ab'),l2ToL1Calls:[]});
  target.payload.entries.unshift(first);target.events.unshift(analysisEvent('EntryExecuted',{entryIndex:0n,rollingHash:first.rollingHash}));
  const flow=buildExecutionFlow(ctx,source,traces);assert.equal(flow.entries.length,2);assert.equal(flow.entries[0].plans[0].index,0);assert.equal(flow.entries[0].actions.length,0);
  assert.equal(flow.calls[0].targetPlan.index,1);assert.equal(flow.entries[1].plans[0].index,1);
});

test('nested ordinal-zero results are matched in dispatch postorder and returns unwind to the right caller', () => {
  const outer=incomingPlan('l1'), nestedData='0xaabbccdd', nestedSource=address('66');
  outer.expectedL1ToL2Calls=[{l2ToL1Calls:[{...outer.l2ToL1Calls[0],sourceAddress:nestedSource,data:nestedData}]}];
  const l1=analysisTx('l1',[outer],[callLog('l1'),resultLog('l1'),resultLog('l1'),analysisEvent('EntryExecuted',{entryIndex:0n,rollingHash:outer.rollingHash})]);
  const l2=analysisTx('l2',null,[callLog('l2'),callLog('l2',nestedSource,nestedData)]);
  const dispatch=dispatchTrace('l1');const outgoing=sourceTrace('l1');const nested=dispatchTrace('l1',nestedData);
  dispatch.calls=[outgoing];outgoing.calls=[nested];
  const a=sourceTrace('l2'),b={...sourceTrace('l2'),input:outgoingInput(nestedSource,nestedData)};
  const traces={[txKey(l1)]:rootTrace(dispatch),[txKey(l2)]:{type:'CALL',from:caller,calls:[a,b]}};
  const flow=buildExecutionFlow(timelineContext(l1,l2),l1,traces);const outerCall=flow.calls.find(call=>call.source.tx.chain==='l2'&&call.source.eventIndex===0),nestedCall=flow.calls.find(call=>call.source.tx.chain==='l2'&&call.source.eventIndex===1),middle=flow.calls.find(call=>call.source.tx.chain==='l1');
  assert.equal(outerCall.target.eventIndex,2);assert.equal(nestedCall.target.eventIndex,1);assert.equal(middle.parent,outerCall.id);assert.equal(nestedCall.parent,middle.id);
  assert.deepEqual(flow.actions.map(action=>[action.call.id,action.kind,action.depth]),[[outerCall.id,'request',0],[middle.id,'request',1],[nestedCall.id,'request',2],[nestedCall.id,'return',2],[middle.id,'return',1],[outerCall.id,'return',0]]);
});

test('missing traces never turn entry completion or expected return bytes into a call return', () => {
  const {ctx,source}=pairedFixture('l2');const flow=buildExecutionFlow(ctx,source);
  assert.equal(flow.calls[0].target,undefined);assert.equal(flow.calls[0].result,undefined);assert.equal(flow.calls[0].basis,'Unlinked');
  assert.ok(flow.nodes.every(node=>node.event.name!=='EntryExecuted'));assert.equal(flow.actions[1].kind,'return');
});

test('repeated cross-chain invocations stay unlinked rather than matching by ordinal alone', () => {
  const {ctx,source,traces}=pairedFixture('l2');source.events.push(callLog('l2'));traces[txKey(source)]={type:'CALL',from:caller,calls:[sourceTrace('l2'),sourceTrace('l2')]};
  const flow=buildExecutionFlow(ctx,source,traces);assert.ok(flow.calls.every(call=>!call.target));assert.ok(flow.calls.every(call=>call.result?.evidence==='Caller trace'));
});

test('rolled-back dispatches do not steal surviving result logs', () => {
  const {ctx,source,target,traces}=pairedFixture('l2');traces[txKey(target)]={type:'CALL',from:caller,calls:[{type:'CALL',from:caller,error:'execution reverted',calls:[dispatchTrace('l1')]},dispatchTrace('l1')]};
  const flow=buildExecutionFlow(ctx,source,traces);assert.equal(flow.calls[0].target.event.name,'CallResult');assert.equal(flow.calls[0].target.eventIndex,0);
});

test('caller and destination return disagreement is explicit and preserves both evidence sources', () => {
  const {ctx,source,traces}=pairedFixture('l1');traces[txKey(source)].output=bytesResult('0x1234');const flow=buildExecutionFlow(ctx,source,traces);
  assert.equal(flow.calls[0].result.data,'0x1234');assert.equal(flow.calls[0].target.event.args.returnData,'0x');assert.equal(flow.calls[0].mismatch,true);
});

test('an exact inbound hash stays linked without treating consumed entries as calls', () => {
  const source=analysisTx('l1',null,[callLog('l1')]);const target=analysisTx('l2',null,[analysisEvent('IncomingCrossChainCallExecuted',{crossChainCallHash:identityHash('l1'),destination}),analysisEvent('ExecutionConsumed',{crossChainCallHash:identityHash('l1'),entryIndex:0n})]);
  const flow=buildExecutionFlow(timelineContext(source,target));assert.equal(flow.calls[0].basis,'Matching call hash');assert.equal(flow.calls[0].target.event.name,'IncomingCrossChainCallExecuted');assert.equal(flow.calls[0].result,undefined);
});

test('a static incoming dispatch does not prevent associating a neighboring nonstatic result', () => {
  const {ctx,source,target,traces}=pairedFixture('l2');target.payload.entries[0].l2ToL1Calls.push({...target.payload.entries[0].l2ToL1Calls[0],isStatic:true,data:'0xaabbccdd'});
  target.events.splice(1,0,resultLog('l1'));traces[txKey(target)]={type:'CALL',from:caller,calls:[dispatchTrace('l1'),{...dispatchTrace('l1','0xaabbccdd'),type:'STATICCALL'}]};
  const flow=buildExecutionFlow(ctx,source,traces);assert.equal(flow.calls[0].target.eventIndex,0);assert.equal(flow.calls[0].destination,destination);
});

test('incomplete dispatch traces and mismatched result bytes cannot create destination links', () => {
  for(const mode of ['missing','mismatch']) {
    const {ctx,source,target,traces}=pairedFixture('l2');
    traces[txKey(target)]=mode==='missing'?rootTrace({type:'CALL',from:caller,to:destination}):rootTrace(dispatchTrace('l1','0x12345678','0x1234'));
    const flow=buildExecutionFlow(ctx,source,traces);assert.equal(flow.calls[0].target,undefined);assert.equal(flow.calls[0].basis,'Unlinked');assert.equal(flow.calls[0].result.evidence,'Caller trace');
  }
});


test('the reported rollback/retry call resolves ordinal one to its real L2 destination', () => {
  const sourceAddress='0x9c3EEbC10149757FEC9E6AD0308D1519222e96FD',targetAddress='0x05f731276c57592a59f27b94007Ffa4aba04ba23',outProxy='0x9fb62Bc9798e241e554533B4Fca6073B05d29EBc',data='0xd09de08a';
  const expectedHash='0x8902935e44b7ccd55a7c4ef4f04dd79ff6ed579f487c1e58349d66ab17d09b7b';
  assert.equal(identityHash('l1',sourceAddress,data,targetAddress),expectedHash);
  const call={sourceAddress,sourceRollupId:0n,targetAddress,value:0n,gas:0n,data,isStatic:false};
  const entry=planned({proxyEntryHash:hash('00'),incomingCalls:[{...call,revertNextNCalls:1},{...call,revertNextNCalls:0}]});
  const source=analysisTx('l1',null,[{...callLog('l1',sourceAddress,data),args:{crossChainCallHash:expectedHash,proxy:outProxy,sourceAddress,callData:data,value:0n}}]);
  const result=encodeAbiParameters([{type:'uint256'}],[1n]);
  const target=analysisTx('l2',[entry],[analysisEvent('CallsReverted',{entryIndex:0n,startCallNumber:0n,nCalls:1n}),{...resultLog('l2',result),args:{entryIndex:0n,callNumber:1n,success:true,returnData:result}},analysisEvent('EntryExecuted',{entryIndex:0n,rollingHash:entry.rollingHash})]);
  const dispatch={...dispatchTrace('l2',data,result),input:toFunctionSelector('executeOnBehalf(address,uint64,bytes)')+encodeAbiParameters([{type:'address'},{type:'uint64'},{type:'bytes'}],[targetAddress,0n,data]).slice(2)};
  const traces={[txKey(source)]:{...sourceTrace('l1',result),from:outProxy,input:outgoingInput(sourceAddress,data)},[txKey(target)]:{type:'CALL',from:caller,calls:[{type:'CALL',from:caller,error:'execution reverted',calls:[dispatch]},dispatch]}};
  const flow=buildExecutionFlow(timelineContext(source,target),source,traces);
  assert.equal(flow.calls[0].target.eventIndex,1);assert.equal(flow.calls[0].destination,targetAddress);assert.equal(flow.calls[0].basis,'Matching call hash');assert.equal(flowReturnKind(flow.calls[0]),'cross-chain');assert.equal(flow.calls[0].result.data,result);
});

test('source-only cached results cannot imply a return from the remote chain', () => {
  const {ctx,source,traces,target}=pairedFixture('l1');delete traces[txKey(target)];
  const flow=buildExecutionFlow(ctx,source,traces);assert.equal(flow.calls[0].target,undefined);assert.equal(flowReturnKind(flow.calls[0]),'local');
  assert.equal(flowReturnKind(buildExecutionFlow(ctx,source).calls[0]),'unavailable');
});

test('the call identity distinguishes same-selector calls to different remote targets', () => {
  const {ctx,source,target,traces}=pairedFixture('l2');
  const anotherTarget=address('77');target.payload.entries[0].l2ToL1Calls.push({...target.payload.entries[0].l2ToL1Calls[0],targetAddress:anotherTarget});
  target.events.splice(1,0,{...resultLog('l1'),args:{entryIndex:0n,l2ToL1CallNumber:1n,success:true,returnData:'0x'}});
  source.events.push({...callLog('l2'),args:{...callLog('l2').args,crossChainCallHash:identityHash('l2',caller,'0x12345678',anotherTarget),proxy:address('88')}});
  traces[txKey(source)]={type:'CALL',from:caller,calls:[sourceTrace('l2'),{...sourceTrace('l2'),from:address('88')}]};
  traces[txKey(target)]={type:'CALL',from:caller,calls:[dispatchTrace('l1'),{...dispatchTrace('l1'),input:toFunctionSelector('executeOnBehalf(address,uint64,bytes)')+encodeAbiParameters([{type:'address'},{type:'uint64'},{type:'bytes'}],[anotherTarget,0n,'0x12345678']).slice(2)}]};
  const flow=buildExecutionFlow(ctx,source,traces);assert.deepEqual(flow.calls.map(call=>call.destination),[destination,anotherTarget]);assert.ok(flow.calls.every(call=>call.basis==='Matching call hash'));
});

test('a conflicting recorded call hash cannot be replaced by a parameter-only guess', () => {
  const {ctx,source,traces}=pairedFixture('l1');source.events[0].args.crossChainCallHash=hash('ff');const flow=buildExecutionFlow(ctx,source,traces);
  assert.equal(flow.calls[0].target,undefined);assert.equal(flow.calls[0].basis,'Unlinked');assert.equal(flowReturnKind(flow.calls[0]),'local');
});


test('vertical execution joins the destination to its result, never a waiting caller to its resume', () => {
  for (const chain of ['l1','l2']) {
    const {ctx,source,traces}=pairedFixture(chain),flow=buildExecutionFlow(ctx,source,traces);
    const edges=flowExecutionConnections(flow.entries[0]);assert.equal(edges.length,1);assert.equal(edges[0].chain,chain==='l1'?'l2':'l1');
    assert.equal(edges[0].from.kind,'request');assert.equal(edges[0].to.kind,'return');assert.equal(edges[0].from.call.id,edges[0].to.call.id);
  }
});

const executionEntryFixture = (chains, parents = []) => {
  const calls=chains.map((chain,index)=>{
    const {ctx,source,traces}=pairedFixture(chain);const call=buildExecutionFlow(ctx,source,traces).calls[0];
    return {...call,id:`call-${index}`,number:index+1,parent:parents[index],source:{...call.source,id:`source-${index}`}};
  });
  const actions=[];const visit=(call,depth)=>{actions.push({id:call.id+':request',call,kind:'request',depth,anchor:call.source});calls.filter(child=>child.parent===call.id).forEach(child=>visit(child,depth+1));actions.push({id:call.id+':return',call,kind:'return',depth,anchor:call.target});};
  calls.filter(call=>!call.parent).forEach(call=>visit(call,0));return {id:'entry',plans:[],calls,actions};
};

test('nested execution stays continuous through child callers, child resumes, and parent results', () => {
  const entry=executionEntryFixture(['l1','l2','l1'],[undefined,'call-0','call-1']);const edges=flowExecutionConnections(entry);
  assert.deepEqual(edges.map(edge=>[edge.chain,edge.from.id,edge.to.id]),[
    ['l2','call-0:request','call-1:request'],['l2','call-1:return','call-0:return'],
    ['l1','call-1:request','call-2:request'],['l1','call-2:return','call-1:return'],
    ['l2','call-2:request','call-2:return'],
  ]);
});

test('consecutive calls connect a resumed caller to its next invocation only within the same contract and transaction', () => {
  const entry=executionEntryFixture(['l2','l2']);let edges=flowExecutionConnections(entry);
  assert.equal(edges.length,3);assert.equal(edges[2].chain,'l2');assert.equal(edges[2].from.id,'call-0:return');assert.equal(edges[2].to.id,'call-1:request');
  entry.calls[1].caller=address('99');assert.equal(flowExecutionConnections(entry).length,2);
  entry.calls[1].caller=entry.calls[0].caller;entry.calls[1].source.tx={...entry.calls[1].source.tx,tx:{...entry.calls[1].source.tx.tx,hash:hash('99')}};assert.equal(flowExecutionConnections(entry).length,2);
});

test('unobserved destination execution never gets a vertical execution arrow', () => {
  const entry=executionEntryFixture(['l1']);entry.calls[0].target=undefined;assert.equal(flowReturnKind(entry.calls[0]),'local');assert.equal(flowExecutionConnections(entry).length,0);
  entry.calls[0].result=undefined;assert.equal(flowReturnKind(entry.calls[0]),'unavailable');assert.equal(flowExecutionConnections(entry).length,0);
});

const repeatedCallbackFixture = (chain, { childResults = ['0x01', '0x02'], parentResults = ['0x', '0x'] } = {}) => {
  const remote = chain === 'l1' ? 'l2' : 'l1', childCaller = address('66'), childTarget = address('77'), childData = '0xaabbccdd';
  const childHash = identityHash(remote, childCaller, childData, childTarget);
  const childCall = { sourceAddress: childCaller, sourceRollupId: remote === 'l1' ? 0n : 1n, targetAddress: childTarget, data: childData, value: 0n, gas: 0n, isStatic: false };
  const sourceEntries = parentResults.map((result, i) => planned({ proxyEntryHash: identityHash(chain), rollingHash: hash(i ? 'ad' : 'ac'), returnData: result,
    ...(chain === 'l1' ? { l2ToL1Calls: [childCall] } : { incomingCalls: [childCall] }) }));
  const targetEntries = parentResults.map((result, i) => ({ ...incomingPlan(remote), proxyEntryHash: identityHash(chain), rollingHash: hash(i ? 'af' : 'ae'), returnData: result,
    ...(remote === 'l1' ? { expectedL1ToL2Calls: [{ l2ToL1Calls: [], returnData: childResults[i] }] } : { expectedOutgoingCalls: [{ incomingCalls: [], returnData: childResults[i] }] }) }));
  const source = analysisTx(chain, sourceEntries, sourceEntries.flatMap((entry, i) => [callLog(chain), resultLog(chain, childResults[i]), analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: entry.rollingHash })]));
  // Reverse the remote execution order deliberately. Pairing occurrence N with
  // occurrence N across chains would put both callbacks under the wrong parent.
  const target = analysisTx(remote, targetEntries, [1, 0].flatMap(i => [{ ...callLog(remote, childCaller, childData), args: { ...callLog(remote, childCaller, childData).args, crossChainCallHash: childHash } }, resultLog(remote, parentResults[i]), analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash: targetEntries[i].rollingHash })]));
  const sources = parentResults.map((result, i) => {
    const callback = { ...dispatchTrace(chain, childData, childResults[i]), input: toFunctionSelector('executeOnBehalf(address,uint64,bytes)') + encodeAbiParameters([{type:'address'},{type:'uint64'},{type:'bytes'}], [childTarget, 0n, childData]).slice(2) };
    return { ...sourceTrace(chain, result), calls: [callback] };
  });
  const targets = [1, 0].map(i => ({ ...dispatchTrace(remote, '0x12345678', parentResults[i]), calls: [{ ...sourceTrace(remote, childResults[i]), input: outgoingInput(childCaller, childData) }] }));
  return { source, target, ctx: timelineContext(source, target), traces: { [txKey(source)]: { type: 'CALL', from: caller, calls: sources }, [txKey(target)]: { type: 'CALL', from: caller, calls: targets } } };
};

const assertRepeatedCallbacks = ({ctx, source, target, traces}) => {
  const flow = buildExecutionFlow(ctx, source, traces);
  const parents = flow.calls.filter(call => call.source.tx.chain === source.chain);
  assert.equal(parents.length, 2);assert.equal(parents[0].source.hash, parents[1].source.hash);
  assert.deepEqual(parents.map(call => call.target.eventIndex), [4, 1]);
  assert.deepEqual(parents.map(call => call.plan.index), [0, 1]);assert.deepEqual(parents.map(call => call.targetPlan.index), [0, 1]);
  const children = flow.calls.filter(call => call.source.tx.chain === target.chain);
  assert.deepEqual(children.map(call => call.target.eventIndex), [4, 1]);
  assert.deepEqual(children.map(call => call.parent), [parents[1].id, parents[0].id]);
  assert.ok(flow.calls.every(call => call.basis === 'Matching call hash' && flowReturnKind(call) === 'cross-chain' && !call.mismatch));
  assert.deepEqual(flow.entries.filter(entry => entry.calls.length).map(entry => entry.actions.map(action => [action.kind, action.depth])), Array(2).fill([['request',0],['request',1],['return',1],['return',0]]));
  assert.equal(new Set(flow.calls.map(call => call.target.id)).size, 4);
  return flow;
};

test('repeated empty parent returns resolve through distinct callbacks on both chains despite reversed remote order and reset indices', () => {
  for (const chain of ['l1','l2']) assertRepeatedCallbacks(repeatedCallbackFixture(chain));
});

test('resolved parent frames distinguish repeated callbacks with identical return values', () => {
  for (const chain of ['l1','l2']) assertRepeatedCallbacks(repeatedCallbackFixture(chain, { childResults: ['0x01','0x01'], parentResults: ['0x01','0x02'] }));
});

test('identical repeated parents and callbacks remain ambiguous instead of being paired by occurrence order', () => {
  for (const chain of ['l1','l2']) {
    const {ctx,source,traces} = repeatedCallbackFixture(chain, { childResults: ['0x01','0x01'] });
    const flow = buildExecutionFlow(ctx,source,traces);assert.equal(flow.calls.length,4);
    assert.ok(flow.calls.every(call => !call.target && !call.parent && flowReturnKind(call) === 'local'));
  }
});

test('missing counterpart traces and ambiguous entry scopes cannot resolve repeated call trees', () => {
  for (const mode of ['source trace','target trace','entry scope']) {
    const {ctx,source,target,traces} = repeatedCallbackFixture('l1');
    if (mode === 'source trace') delete traces[txKey(source)];
    else if (mode === 'target trace') delete traces[txKey(target)];
    else {
      const rolling = target.payload.entries[0].rollingHash;target.payload.entries[1].rollingHash = rolling;
      for (const event of target.events.filter(event => event.name === 'EntryExecuted')) event.args.rollingHash = rolling;
    }
    const flow = buildExecutionFlow(ctx,source,traces);
    if (mode === 'entry scope') {
      assert.ok(flow.calls.filter(call => call.source.tx.chain === source.chain).every(call => !call.target));
      assert.equal(flow.calls.filter(call => call.source.tx.chain === target.chain && call.target).length,2, 'independently verified callbacks remain inspectable');
    } else assert.ok(flow.calls.every(call => !call.target && !call.parent),mode);
  }
});

test('repeated standalone calls use recorded return evidence without weakening call-hash validation', () => {
  for (const chain of ['l1','l2']) {
    const {ctx,source,target,traces} = pairedFixture(chain);
    target.payload.entries[0].incomingCalls?.push({...target.payload.entries[0].incomingCalls[0]});
    target.payload.entries[0].l2ToL1Calls?.push({...target.payload.entries[0].l2ToL1Calls[0]});
    target.events.splice(1,0,{...resultLog(target.chain,'0x01'),args:{...resultLog(target.chain,'0x01').args,callNumber:1n,l2ToL1CallNumber:1n}});
    source.events.push(callLog(chain));
    traces[txKey(source)] = {type:'CALL',from:caller,calls:[sourceTrace(chain,'0x01'),sourceTrace(chain,'0x')]};
    traces[txKey(target)] = {type:'CALL',from:caller,calls:[dispatchTrace(target.chain),dispatchTrace(target.chain,'0x12345678','0x01')]};
    let flow = buildExecutionFlow(ctx,source,traces);assert.deepEqual(flow.calls.map(call=>call.target.eventIndex),[1,0]);
    assert.equal(new Set(flow.calls.map(call=>call.target.id)).size,2);
    source.events[0].args.crossChainCallHash = hash('ff');flow = buildExecutionFlow(ctx,source,traces);
    assert.equal(flow.calls[0].target,undefined);assert.equal(flow.calls[1].target.eventIndex,0);
  }
});

function pureStateFixture(entries, events, opts = {}) {
  const tx = analysisTx('l1', entries, events, opts);
  tx.payload.immediateEntryCount = entries.length;
  return { tx, flow: buildExecutionFlow(timelineContext(tx), tx) };
}
const pureEntry = (rolling, before, after, rollupId = 1) => planned({ proxyEntryHash: hash('00'), rollingHash: rolling,
  rollupUpdates: [{ rollupId, currentRoot: before, newRoot: after, etherDelta: 0n }] });
const stateEvent = (root, rollupId = 1) => analysisEvent('L2ExecutionPerformed', { rollupId, newRoot: root, etherBalance: 0n });
const completionEvent = rollingHash => analysisEvent('EntryExecuted', { entryIndex: 0n, rollingHash });

test('pure L2 entries expose distinct applied state updates despite every completion using index zero', () => {
  const entries = [pureEntry(hash('d1'), hash('41'), hash('42')), pureEntry(hash('d2'), hash('42'), hash('43'))];
  const { flow } = pureStateFixture(entries, [stateEvent(hash('42')), completionEvent(hash('d1')), stateEvent(hash('43')), completionEvent(hash('d2'))]);
  assert.equal(flow.entries.length, 2); assert.equal(flow.calls.length, 0); assert.equal(flow.actions.length, 0);
  const updates = flow.entries.flatMap(entry => entry.updates);
  assert.deepEqual(updates.map(update => [update.plan.index, update.status, update.rollups[0].newRoot, update.anchor.eventIndex]), [[0, 'Applied', hash('42'), 1], [1, 'Applied', hash('43'), 3]]);
  assert.ok(updates.every(update => update.rollups[0].observed.event.name === 'L2ExecutionPerformed'));
});

test('pure state updates require entry-scoped receipts rather than batch success or matching roots elsewhere', () => {
  const entry = pureEntry(hash('d1'), hash('41'), hash('42'));
  for (const events of [[analysisEvent('BatchPosted', {})], [stateEvent(hash('42')), completionEvent(hash('d2'))],
    [stateEvent(hash('42')), analysisEvent('CallResult', {}), completionEvent(hash('d1'))],
    [stateEvent(hash('42')), completionEvent(hash('d1')), completionEvent(hash('d1'))]]) {
    const { flow } = pureStateFixture([entry], events);
    assert.equal(flow.entries[0].updates[0].status, 'Unconfirmed');
    assert.equal(flow.entries[0].updates[0].rollups[0].observed, undefined);
  }
  const { flow } = pureStateFixture([entry, entry], [stateEvent(hash('42')), completionEvent(hash('d1'))]);
  assert.ok(flow.entries.every(group => group.updates[0].status === 'Unconfirmed'));
});

test('state updates identify skips, reverted receipts, root mismatches, and every participating rollup', () => {
  const entry = pureEntry(hash('d1'), hash('41'), hash('42'));
  const skipped = pureStateFixture([entry], [analysisEvent('L2TxSkipped', { entryIndex: 0n })]).flow.entries[0].updates[0];
  assert.equal(skipped.status, 'Skipped'); assert.equal(skipped.anchor.event.name, 'L2TxSkipped');
  const mismatch = pureStateFixture([entry], [stateEvent(hash('43')), completionEvent(hash('d1'))]).flow.entries[0].updates[0];
  assert.equal(mismatch.status, 'Mismatch'); assert.equal(mismatch.rollups[0].observed.event.args.newRoot, hash('43'));
  const reverted = pureStateFixture([entry], [], { receipt: { status: '0x0' } }).flow.entries[0].updates[0];
  assert.equal(reverted.status, 'Unconfirmed');
  const multiple = { ...entry, rollupUpdates: [...entry.rollupUpdates, ...pureEntry(hash('d1'), hash('51'), hash('52'), 2).rollupUpdates] };
  const valid = pureStateFixture([multiple], [stateEvent(hash('42')), stateEvent(hash('52'), 2), completionEvent(hash('d1'))]).flow.entries[0].updates[0];
  assert.equal(valid.status, 'Applied'); assert.equal(valid.rollups.length, 2);
  const foreign = stateEvent(hash('42')); foreign.raw = { ...foreign.raw, address: address('99') };
  assert.equal(pureStateFixture([entry], [foreign, completionEvent(hash('d1'))]).flow.entries[0].updates[0].status, 'Unconfirmed');
});

test('only the declared leading immediate L2 run gains a state-update step', () => {
  const entries = [pureEntry(hash('d1'), hash('41'), hash('42')), planned(), pureEntry(hash('d2'), hash('42'), hash('43'))];
  const { tx } = pureStateFixture(entries, []);
  assert.equal(buildExecutionFlow(timelineContext(tx), tx).entries.flatMap(group => group.updates).length, 1);
  tx.payload.immediateEntryCount = 0;
  assert.equal(buildExecutionFlow(timelineContext(tx), tx).entries.flatMap(group => group.updates).length, 0);
  tx.payload.immediateEntryCount = 3; tx.chain = 'l2';
  assert.equal(buildExecutionFlow(timelineContext(tx), tx).entries.flatMap(group => group.updates).length, 0);
});
