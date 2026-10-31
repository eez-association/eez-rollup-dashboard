import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTrace } from '../src/logical.mjs';
import { decodeCrossChainTrace } from '../src/engine.mjs';
import { buildFlowModel, explorerSite, standardRevert } from '../flow/model.mjs';
import { inlineModelSource, preferSavedTrace, renderFlowHtml } from '../flow/render-flow.mjs';
import { scenario, address } from './fixtures/scenarios.mjs';
import { largeTrace } from './fixtures/large-trace.mjs';
import { traceRows } from '../flow/rows.mjs';

const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const decode = async (opts = {}, edit) => {
  const f = scenario(opts);
  edit?.(f);
  return { f, trace: plain(await decodeCrossChainTrace(f.config, f.trigger)) };
};
const byRole = (model, role) => model.transactions.filter(t => t.role === role);

test('an L1-started flow: trigger first, settlement and delivery linked', async () => {
  const { f, trace } = await decode({ deep: true });
  const m = buildFlowModel(trace);
  assert.equal(m.transactions[0].role, 'trigger');
  assert.equal(m.transactions[0].hash, f.trigger);
  assert.equal(m.transactions[0].label, 'Trigger · starts on L1');
  assert.equal(byRole(m, 'settlement').length, 1);
  assert.equal(byRole(m, 'delivery').length, 1);
  assert.ok(m.transactions.every(t => t.inFlow === true));
  assert.equal(m.roots[0].role, 'trigger');
  assert.equal(m.stats.matched, 3);
});

test('an L2-started flow is matched to the L2Tx batch entry (proxyEntryHash = 0)', async () => {
  const { f, trace } = await decode({ direction: 'L2' });
  const m = buildFlowModel(trace);
  const trigger = m.transactions[0];
  assert.equal(trigger.role, 'trigger');
  assert.equal(trigger.chain, 'L2');
  assert.equal(trigger.hash, f.trigger);
  assert.ok(trigger.evidence.some(e => /L2Tx entry #0 .*started on L2/.test(e)), trigger.evidence.join('; '));
  assert.equal(byRole(m, 'table-load').length, 1);
});

test('L2-started repeated calls retain their exact L1 proxy callers without duplicating execution', async () => {
  const { trace } = await decode({ direction: 'L2', repeat: 2, attempts: true });
  const model = buildFlowModel(trace), frames = new Map(trace.frames.map(frame => [frame.id, frame]));
  assert.equal(model.protocolLinks.length, 2);
  assert.equal(new Set(model.protocolLinks.map(link => link.to)).size, 2);
  for (const link of model.protocolLinks) {
    const caller = model.nodes[link.from], target = model.nodes[link.to];
    assert.equal(caller.role, 'incoming-proxy');
    assert.match(caller.fn, /^executeOnBehalf\(/);
    assert.equal(caller.chain, 'L1');
    assert.equal(frames.get(target.frameId).parentId, caller.frameId);
    assert.equal(target.crossing.status, 'matched');
    const logicalCaller = model.nodes.find(node => node.children.includes(target.id));
    assert.equal(logicalCaller.chain, 'L2', 'the original cross-chain arrow is preserved');
    assert.ok(!caller.children.includes(target.id), 'the recorded connection is not another tree traversal');
    assert.equal(model.nodes.filter(node => node.frameId === target.frameId).length, 1);
    const shown = traceRows(model, { protocol: true });
    assert.equal(shown.filter(row => row.node.id === target.id).length, 1);
    assert.ok(shown.some(row => row.node.id === caller.id));
    assert.ok(!traceRows(model, { protocol: false }).some(row => row.node.id === caller.id));
  }
  physicalLinks(trace);
  assert.deepEqual(buildFlowModel(trace, { mode: 'physical' }).protocolLinks, [], 'recorded trees already contain these edges');
});

test('L1-started reentrant calls retain both chains’ recorded proxy callers', async () => {
  const { trace } = await decode({ deep: true });
  const model = buildFlowModel(trace), frames = new Map(trace.frames.map(frame => [frame.id, frame]));
  assert.equal(model.protocolLinks.length, 3, 'initial delivery, L1 reentry and nested L2 reentry are connected');
  assert.deepEqual(model.protocolLinks.map(link => model.nodes[link.from].chain).sort(), ['L1', 'L2', 'L2']);
  const shown = traceRows(model, { protocol: true });
  for (const link of model.protocolLinks) {
    const caller = model.nodes[link.from], target = model.nodes[link.to];
    assert.equal(caller.role, 'incoming-proxy');
    assert.match(caller.fn, /^executeOnBehalf\(/);
    assert.equal(caller.chain, target.chain);
    assert.equal(caller.tx, target.tx);
    assert.equal(frames.get(target.frameId).parentId, caller.frameId);
    assert.equal(target.crossing.status, 'matched');
    assert.equal(shown.filter(row => row.node.id === target.id).length, 1);
    assert(shown.some(row => row.node.id === caller.id));
    assert(!caller.children.includes(target.id), 'preserve logical parentage');
    assert.notEqual(model.nodes.find(node => node.children.includes(target.id)).chain, target.chain);
  }
  physicalLinks(trace);
  assert.deepEqual(buildFlowModel(trace, { mode: 'physical' }).protocolLinks, []);
});

test('static incoming proxy calls remain visible as cross-chain evidence when local reads are hidden', async () => {
  const { trace } = await decode({ direction: 'L2', isStatic: true });
  const model = buildFlowModel(trace);
  assert.equal(model.protocolLinks.length, 1);
  const caller = model.nodes[model.protocolLinks[0].from];
  assert.equal(caller.isStatic, true);
  assert.equal(caller.crossChainRead, true);
  const rows = traceRows(model, { protocol: true, localReads: false });
  assert(rows.some(row => row.node.id === caller.id));
  assert(rows.some(row => row.node.id === model.protocolLinks[0].to));
});

test('L1 proxy links require the exact observed parent and matching execution', async () => {
  const { trace } = await decode({ deep: true });
  const model = buildFlowModel(trace);
  const targetFrame = model.nodes[model.protocolLinks[0].to].frameId;
  const changed = structuredClone(trace);
  changed.frames.find(frame => frame.id === targetFrame).parentId = changed.logicalRoots[0];
  const changedModel = buildFlowModel(changed);
  assert(!changedModel.protocolLinks.some(link => changedModel.nodes[link.to].frameId === targetFrame));
  for (const status of ['unresolved', 'ambiguous']) {
    const unlinked = structuredClone(trace);
    const outgoing = unlinked.outgoing.find(out => out.remoteFrameId === targetFrame);
    outgoing.status = status;
    const unlinkedModel = buildFlowModel(unlinked);
    assert(!unlinkedModel.protocolLinks.some(link => unlinkedModel.nodes[link.to].frameId === targetFrame));
  }
});

test('proxy connections do not infer ambiguous or unavailable remote execution', async () => {
  const { trace: ambiguous } = await decode({ direction: 'L2', repeat: 2, ambiguous: true });
  assert.deepEqual(buildFlowModel(ambiguous).protocolLinks, []);
  const { trace: missing } = await decode({ direction: 'L2' }, f => {
    f.failure.transactionTrace.add(f.posting); f.failure.allTrace.add(f.posting);
  });
  assert.deepEqual(buildFlowModel(missing).protocolLinks, []);
});

test('the connected L2 flow prunes unrelated L1 attempts and their entire subtrees', async () => {
  const { f, trace } = await decode({ direction: 'L2', repeat: 2, attempts: true, unrelatedAttempts: true });
  const model = buildFlowModel(trace);
  assert.equal(model.nodes.filter(node => node.flowAttempt === 'related').length, 2);
  const others = model.nodes.filter(node => node.flowAttempt === 'other');
  assert.equal(others.length, 2, 'empty and nonempty unrelated entries are classified');
  const excluded = new Set(), collect = id => {
    excluded.add(id); model.nodes[id].children.forEach(collect);
  };
  others.forEach(node => collect(node.id));
  assert.ok(excluded.size > 2, 'the nonempty attempt includes application calls');
  for (const protocol of [false, true]) {
    const rows = traceRows(model, { protocol });
    assert.ok(rows.every(row => !excluded.has(row.node.id)), 'hidden wrappers must not promote unrelated children');
    if (protocol) for (const link of model.protocolLinks) {
      assert.ok(rows.some(row => row.node.id === link.from));
      assert.ok(rows.some(row => row.node.id === link.to));
    }
  }
  assert.ok(traceRows(model, { protocol: true, search: '_attempt' }).every(row => !excluded.has(row.node.id)));
  const fullBatch = traceRows(model, { protocol: true, transaction: `L1:${f.posting}` });
  assert.ok([...excluded].every(id => fullBatch.some(row => row.node.id === id)), 'explicit settlement inspection restores the complete batch');
});

test('one L1 attempt retains each of its multiple verified proxy calls', async () => {
  const { trace } = await decode({ direction: 'L2', repeat: 2, sharedAttempt: true, unrelatedAttempts: true });
  const model = buildFlowModel(trace), attempts = model.nodes.filter(node => node.flowAttempt === 'related');
  assert.equal(attempts.length, 1);
  assert.equal(model.protocolLinks.length, 2);
  for (const link of model.protocolLinks) assert.ok(attempts[0].children.includes(link.from));
  assert.equal(new Set(model.protocolLinks.map(link => link.to)).size, 2, 'identical calldata remains separate execution occurrences');
});

test('unattributed and ambiguous attempts remain available as evidence', async () => {
  const { trace } = await decode({ direction: 'L2', repeat: 2, attempts: true, ambiguous: true });
  const model = buildFlowModel(trace);
  assert.equal(model.protocolLinks.length, 0);
  assert.equal(model.nodes.filter(node => node.flowAttempt === 'other').length, 0);
  assert.equal(traceRows(model, { protocol: true }).filter(row => row.node.fn.startsWith('_attemptExecute')).length, 2);
});

test('a transaction without cross-chain calls in the settled range is not part of the flow', async () => {
  const { trace } = await decode({ direction: 'L2' });
  const hash = '0x' + 'ab'.repeat(32), id = `L2:${hash}:0`;
  const decoded = { contractName: 'Setup', functionName: 'configure', signature: 'configure()', arguments: [], returns: [] };
  trace.transactions.push({ chain: 'L2', hash, blockNumber: 200, transactionIndex: 9, receipt: { status: '0x1' }, trace: { available: true } });
  trace.frames.push({ id, chain: 'L2', transactionHash: hash, blockNumber: 200, path: '0', parentId: null, children: [], type: 'CALL', role: 'application', from: address(98), to: address(77), input: '0x12345678', output: '0x', value: '0', decoded });
  trace.logicalNodes.push({ id, physicalFrameId: id, chain: 'L2', role: 'application', decoded, children: [], reverted: false });
  trace.logicalRoots.push(id);
  const m = buildFlowModel(trace);
  const setup = m.transactions.find(t => t.hash === hash);
  assert.equal(setup.role, 'other');
  assert.equal(setup.inFlow, false);
  assert.equal(m.transactions.at(-1).hash, hash, 'unrelated transactions are listed last');
  assert.notEqual(m.roots[0].tx, hash);
});

test('an untraced requested transaction is "unknown", never excluded or renamed', async () => {
  const { f, trace } = await decode({ direction: 'L2' }, fx => { fx.failure.transactionTrace.add(fx.trigger); fx.failure.allTrace.add(fx.trigger); });
  const m = buildFlowModel(trace);
  const requested = m.transactions.find(t => t.hash === f.trigger);
  assert.equal(requested.role, 'untraced');
  assert.equal(requested.inFlow, null);
  assert.match(m.label, /^Untraced L2 transaction/);
});

test('explorer links keep only scheme, host and path', () => {
  assert.equal(explorerSite('https://user:pw@scan.example/api/v2?apikey=SECRET#x'), 'https://scan.example');
  assert.equal(explorerSite('https://scan.example/explorer/api'), 'https://scan.example/explorer');
  assert.equal(explorerSite('https://api.etherscan.io/v2/api?chainid=1&apikey=SECRET'), null);
  assert.equal(explorerSite('javascript:alert(1)'), null);
});

test('compiler-level reverts are decoded', () => {
  const reason = '0x08c379a0' + '0000000000000000000000000000000000000000000000000000000000000020'
    + '0000000000000000000000000000000000000000000000000000000000000006' + Buffer.from('LOCKED').toString('hex').padEnd(64, '0');
  assert.equal(standardRevert(reason), 'Error("LOCKED")');
  assert.equal(standardRevert('0x4e487b71' + '11'.padStart(64, '0')), 'Panic(0x11)');
  assert.equal(standardRevert('0xdeadbeef'), null);
});

test('the page escapes embedded data and carries the chosen views', async () => {
  const { trace } = await decode();
  const m = buildFlowModel(trace, { label: '</script><script>alert(1)</script>' });
  const html = renderFlowHtml([{ model: m }], { views: ['flow', 'sequence'] });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!/__FLOW_(DATA|CONFIG|SCRIPT)__/.test(html));
  assert.match(html, /id="flow-config">\{"views":\["flow","sequence"\]\}/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
});

test('render-flow refuses a trace with an untraced transaction unless --allow-partial', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { trace } = await decode({ direction: 'L2' }, fx => { fx.failure.transactionTrace.add(fx.posting); fx.failure.allTrace.add(fx.posting); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-')), input = path.join(dir, 'trace.json'), out = path.join(dir, 'page.html');
  fs.writeFileSync(input, JSON.stringify(trace));
  const cli = new URL('../flow/render-flow.mjs', import.meta.url).pathname;
  try {
    const refused = spawnSync(process.execPath, [cli, input, '-o', out], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No call trace for 1 transaction[\s\S]*L1_TRACE_RPC/);
    assert.ok(!fs.existsSync(out));
    const allowed = spawnSync(process.execPath, [cli, input, '-o', out, '--allow-partial'], { encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.ok(fs.existsSync(out));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a 10,000-frame trace builds quickly', async () => {
  const trace = plain(await largeTrace(10_000));
  const start = performance.now();
  const m = buildFlowModel(trace);
  assert.ok(m.nodes.length >= 10_000);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});


test('a requested plain L1 transfer never inherits another same-block trigger or title', async () => {
  const { trace } = await decode();
  const hash = '0x' + 'cd'.repeat(32), id = `L1:${hash}:0`;
  const decoded = { contractName: 'RequestedRecipient', functionName: 'receive', arguments: [], returns: [] };
  trace.transactions.push({ chain: 'L1', hash, blockNumber: 100, transactionIndex: 2, receipt: { status: '0x1' }, trace: { available: true } });
  trace.frames.push({ id, chain: 'L1', transactionHash: hash, path: '0', parentId: null, children: [], type: 'CALL', role: 'application', to: address(77), input: '0x', output: '0x', value: '1', decoded });
  trace.logicalNodes.push({ id, decoded, children: [] }); trace.logicalRoots.push(id);
  trace.origin = { chain: 'L1', transactionId: `L1:${hash}` }; trace.txHash = hash;
  const m = buildFlowModel(trace);
  assert.equal(m.label, 'RequestedRecipient.receive()');
  assert.equal(m.stats.crossings, 0);
  assert.equal(m.roots[0].tx, hash);
  assert.ok(m.transactions.filter(t => !t.requested).every(t => t.inFlow === false));
});

test('shared L1 posting does not connect a second trigger to the requested call tree', async () => {
  const { f, trace } = await decode({ direction: 'L2' });
  const second = '0x' + 'ef'.repeat(32), oldPrefix = `L2:${f.trigger}`, prefix = `L2:${second}`;
  const replace = x => JSON.parse(JSON.stringify(x).replaceAll(oldPrefix, prefix).replaceAll(f.trigger, second));
  trace.transactions.push({ ...replace(trace.transactions.find(t => t.hash === f.trigger)), transactionIndex: 2 });
  const copiedFrames = trace.frames.filter(f => f.id.startsWith(oldPrefix)).map(replace);
  trace.frames.push(...copiedFrames);
  // An unresolved second trigger loads the same table. That dependency must not
  // expand the requested flow to its calls, even when the call bytes are identical.
  const copiedIds = new Set(copiedFrames.map(f => f.id));
  trace.logicalNodes.push(...trace.logicalNodes.filter(n => n.id.startsWith(oldPrefix)).map(replace).map(n => ({ ...n, children: n.children.filter(id => copiedIds.has(id)) })));
  trace.logicalRoots.push(`${prefix}:0`);
  const out = replace(trace.outgoing[0]); delete out.remoteFrameId; out.status = 'unresolved'; trace.outgoing.push(out);
  trace.unresolved.push({ code: 'remote-execution-unavailable', message: 'Unrelated batch entry', frameId: out.frameId });
  const m = buildFlowModel(trace);
  assert.equal(m.transactions.find(t => t.hash === second).inFlow, false);
  assert.equal(m.roots.find(r => r.tx === second).inFlow, false);
  assert.ok(m.nodes.filter(n => n.tx === second).every(n => n.inFlow === false));
  assert.ok(!m.unresolved.some(u => u.frameId === out.frameId));
  assert.equal(m.stats.crossings, 1);
  assert.equal(m.stats.matched, 1);
});


function physicalLinks(trace) {
  trace.transactionLinks = [{ state: 'complete', sourceChain: trace.origin.chain, sourceHash: trace.txHash,
    references: trace.transactions.map(t => ({ chain: t.chain, hash: t.hash,
      role: t.hash === trace.txHash ? 'source' : t.chain === 'L1' ? 'l1-post-batch' : 'l2-delivery' })) }];
}

test('physical views keep proxy inconsistencies and missing identity unresolved', async () => {
  const { trace } = await decode(); physicalLinks(trace);
  const frameId = trace.outgoing[0].managerFrameId;
  const codes = ['proxy-forwarding-mismatch', 'proxy-identity-unavailable'];
  trace.unresolved = codes.map(code => ({ code, message: 'Cannot validate proxy request', frameId }));
  const model = buildFlowModel(trace, { mode: 'physical' });
  assert.deepEqual(model.unresolved.map(u => u.code), codes);
  assert.equal(model.matchingNotes.length, 0);
});

test('legacy prepared labels cannot hide rejected remote return values', async () => {
  const { trace } = await decode({ isStatic: true }, f => {
    f.txs.L2.get(f.deliveries[0]).trace.calls[0].calls[0].output = '0xdeadbeef';
  });
  const out = trace.outgoing[0];
  assert.ok(out.rejectedCandidates.length);
  out.resultKind = 'precomputed-result-only'; // Older decoder incorrectly used this for a mismatch.
  physicalLinks(trace);
  const model = buildFlowModel(trace, { mode: 'physical' });
  assert.ok(!model.nodes.some(n => n.preparedResult));
  assert.ok(model.unresolved.some(u => u.frameId === out.frameId));
  assert.ok(!renderTrace(trace).includes('no L2 delivery expected'));
});

test('prepared status is shared by HTML and text; unrelated errors stay unresolved', async () => {
  const { trace } = await decode({ isStatic: true }); physicalLinks(trace);
  const out = trace.outgoing[0];
  out.status = 'prepared-result'; delete out.resultKind;
  trace.unresolved = [{ code: 'receipt-unavailable', message: 'Receipt missing', frameId: out.frameId }];
  const model = buildFlowModel(trace, { mode: 'physical' });
  assert.equal(model.stats.preparedResults, 1);
  assert.equal(model.unresolved[0].code, 'receipt-unavailable');
  assert.ok(renderTrace(trace).includes('no L2 delivery expected'));
});


test('verified links default to matched cross-chain arrows with an independent recorded alternative', async () => {
  const { trace } = await decode({ deep:true }); physicalLinks(trace);
  const model = buildFlowModel(trace);
  assert.equal(model.mode,'combined'); assert.equal(model.recordedView.mode,'physical');
  assert.equal(model.nodes.filter(n=>n.crossing?.status==='matched').length,3);
  assert.ok(!model.recordedView.nodes.some(n=>n.crossing));
});

test('new complete decodes replace saved captures even when match counts drop', () => {
  const transaction = {chain:'L1',hash:'tx',blockHash:'block',blockNumber:10,transactionIndex:0,receipt:{status:1},trace:{available:true}};
  const previous = {schemaVersion:'1.0.0',transactions:[transaction],outgoing:[{status:'matched'}]};
  const current = {...previous,outgoing:[{status:'unresolved'}]};
  assert.equal(preferSavedTrace(previous,current),false);
  const incomplete = {...current,transactions:[{...transaction,trace:{available:false}}]};
  assert.equal(preferSavedTrace(previous,incomplete),true);
  assert.equal(preferSavedTrace(previous,{...incomplete,schemaVersion:'2.0.0'}),false);
  assert.equal(preferSavedTrace(previous,{...incomplete,transactions:[{...incomplete.transactions[0],hash:'other'}]}),false);
});


test('saved captures never hide changed inclusion or fresh validation failures', () => {
  const transaction={chain:'L1',hash:'tx',blockHash:'block',blockNumber:10,transactionIndex:0,receipt:{status:1},trace:{available:true}};
  const previous={schemaVersion:'1',txHash:'tx',transactions:[transaction]};
  const current={...previous,transactions:[{...transaction,trace:{available:false}}]};
  for(const mutation of [
    {transactions:[{...current.transactions[0],blockHash:'reorg'}]},
    {transactions:[{...current.transactions[0],transactionIndex:1}]},
    {transactions:[{...current.transactions[0],blockHash:null}]},
    {metadata:{transactionLinks:{state:'invalid'}}},
    {metadata:{transactionLinks:{state:'pending'}}},
    {unresolved:[{code:'invalid-transaction-links'}]},
    {unresolved:[{code:'correlation-lookup-failed'}]},
    {outgoing:[{rejectedCandidates:[{reason:'return-or-revert-mismatch'}]}]},
    {metadata:{chainIds:{L1:'different chain'}}},
  ]) assert.equal(preferSavedTrace(previous,{...current,...mutation}),false);
});

for(const quote of ["'",'"'])for(const newline of ['\n','\r\n'])test(`model inlining tolerates quote ${quote} and newline ${JSON.stringify(newline)}`,()=>{
  const code=`import { isPreparedResult } from ${quote}../src/prepared-result.mjs${quote};${newline}export const marker = 1;${newline}`;
  const inline=inlineModelSource(code);
  assert.doesNotMatch(inline,/^import/m);assert.doesNotMatch(inline,/^export/m);
  assert.equal(new Function(`${inline}; return marker;`)(),1);
});
test('model inlining rejects unbundled imports explicitly',()=>{
  assert.throws(()=>inlineModelSource('import x from "./unbundled.mjs";'),/Unbundled import/);
});


async function gasFixture() {
  const { f, trace } = await decode({ direction: 'L2', repeat: 2 });
  for (const frame of trace.frames) frame.gasUsed = '0x100';
  const entry = trace.frames.find(frame => frame.chain === 'L1' && frame.path === '0.0');
  entry.gasUsed = '0x64';
  // A different entry in the same batch must not be charged to this source.
  trace.frames.find(frame => frame.chain === 'L1' && frame.path === '0.1').gasUsed = '0xffff';
  for (const t of trace.transactions) t.receipt.gasUsed = t.chain === 'L1' ? '0x3e8' : t.hash === f.trigger ? '0xc8' : '0x12c';
  trace.transactionLinks = [{ state: 'complete', sourceChain: 'L2', sourceHash: f.trigger,
    l1Execution: { frameId: entry.id, entryIndex: 0, basis: 'test isolation' },
    references: trace.transactions.map(t => ({ chain: t.chain, hash: t.hash,
      role: t.hash === f.trigger ? 'source' : t.chain === 'L1' ? 'l1-post-batch' : 'l2-table-load' })) }];
  return { f, trace, entry };
}

test('flow gas counts isolated physical subtrees once and includes L2 table loading', async () => {
  const { trace, entry } = await gasFixture();
  trace.transactionLinks[0].references.push({ ...trace.transactionLinks[0].references[0] });
  // Reverted children and hidden plumbing are already included by their parent.
  trace.frames.find(f => f.parentId === entry.id).reverted = true;
  const m = buildFlowModel(trace);
  assert.equal(m.gas.L1.gasUsed, '100');
  assert.equal(m.gas.L1.partial, false);
  assert.equal(m.gas.L1.transactionGasUsed, '1000');
  assert.deepEqual(m.gas.L1.contributions.map(r => r.frameId), [entry.id]);
  assert.equal(m.gas.L2.gasUsed, '500');
  assert.equal(m.gas.L2.transactionGasUsed, '500');
  assert.equal(m.gas.L2.contributions.length, 2);
  assert.deepEqual(m.gas, m.recordedView.gas);
});

test('missing entry attribution and missing gas are partial rather than zero or a full batch charge', async () => {
  const { trace, entry } = await gasFixture();
  delete entry.gasUsed;
  let m = buildFlowModel(trace);
  assert.equal(m.gas.L1.gasUsed, null);
  assert.equal(m.gas.L1.partial, true);
  delete trace.transactionLinks[0].l1Execution;
  m = buildFlowModel(trace);
  assert.equal(m.gas.L1.partial, true);
  assert.ok(m.gas.L1.contributions.every(r => r.basis === 'frame'));
  delete trace.transactions.find(t => t.chain === 'L2' && t.hash !== trace.txHash).receipt.gasUsed;
  m = buildFlowModel(trace);
  assert.equal(m.gas.L2.gasUsed, '200');
  assert.equal(m.gas.L2.partial, true);
  assert.equal(m.gas.L2.transactionGasPartial, true);
});

test('gas totals preserve integer precision and never add nested remote calls to delivery receipts', async () => {
  const { trace } = await decode({ deep: true });
  physicalLinks(trace);
  for (const f of trace.frames) f.gasUsed = '999999999';
  for (const t of trace.transactions) t.receipt.gasUsed = '9007199254740993';
  const m = buildFlowModel(trace);
  assert.equal(m.gas.L1.gasUsed, '9007199254740993');
  assert.equal(m.gas.L2.gasUsed, '9007199254740993');
  assert.equal(m.gas.L1.transactionGasUsed, '18014398509481986');
  assert.equal(m.gas.L1.contributions.length, 1);
  assert.equal(m.gas.L2.contributions.length, 1);
});
