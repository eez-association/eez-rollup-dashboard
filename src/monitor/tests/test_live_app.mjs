import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const app = source.replace("export function mountMonitor(root)", "function mountMonitor(root)")
  .replace("return () => {", "globalThis.api = { state, refresh, connectLive }; return () => {")
  + "\nglobalThis.dispose = mountMonitor(document);";

function fixture({ unavailable = false, blocked = false } = {}) {
  const elements = new Map(), sockets = [], requests = [], timeouts = new Map(), intervals = new Map(), events = {};
  let timer = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", value: "", dataset: {},
      disabled: false, classList: { toggle() {} }, addEventListener() {}, append() {},
      replaceChildren() {}, querySelector() { return element(id + "-submit"); }, scrollIntoView() {} });
    return elements.get(id);
  };
  class FakeSocket {
    constructor(url) {
      if (FakeSocket.blocked) throw new Error("WebSocket blocked");
      this.url = String(url);
      sockets.push(this);
    }
    close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
    push(snapshot) { this.onmessage?.({ data: JSON.stringify({ type: "snapshot", sequence: 1, snapshot }) }); }
  }
  FakeSocket.blocked = blocked;
  const context = vm.createContext({ URL, AbortController, console,
    window: { location: { href: "https://dashboard.example/#/monitor", origin: "https://dashboard.example" },
      addEventListener: (name, fn) => { events[name] = fn; },
      removeEventListener: name => { delete events[name]; } },
    document: { querySelector: selector => element(selector.slice(5, -2)), getElementById: element, createElement: () => element("created") },
    WebSocket: unavailable ? undefined : FakeSocket,
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url: String(url), resolve, reject });
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    setTimeout: (fn, ms) => { const id = ++timer; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++timer; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  vm.runInContext(app, context);
  return { ...context.api, dispose: context.dispose, element, elements, sockets, requests, timeouts, intervals, events, FakeSocket,
    runTimer(id) { const entry = timeouts.get(id); assert.ok(entry); timeouts.delete(id); entry.fn(); } };
}

function snapshot(height, hash = "aa") {
  return { generatedAt: "2026-09-14T12:00:00Z", healthy: true, errors: [], configuration: { refreshSeconds: 4 },
    chains: { l1: { healthy: true, latest: { number: 23053000 } },
      l2: { healthy: true, latest: { number: height, hash: "0x" + hash.repeat(32) } } } };
}
const response = (data) => ({ ok: true, json: async () => data });
const tick = () => new Promise(setImmediate);

const f = fixture();
assert.equal(f.sockets[0].url, "wss://dashboard.example/monitor/api/live");
assert.equal(f.requests.length, 0, "connected viewers must not poll snapshots");
f.sockets[0].push(snapshot(12));
assert.equal(f.state.snapshot.chains.l2.latest.number, 12);
assert.equal(f.intervals.size, 0);
assert.equal(f.state.socket, f.sockets[0]);

const delayed = snapshot(12);
delayed.healthy = false;
delayed.chains.l1.freshness = { ageSeconds: 138, warningSeconds: 30, status: "delayed" };
delayed.chains.l2.freshness = { ageSeconds: 133, warningSeconds: 30, status: "delayed" };
f.sockets[0].push(delayed);
assert.equal(f.state.socket, f.sockets[0], "head delay must not disconnect a working feed");
assert.match(f.elements.get("network-status").innerHTML, /L1 \+ L2 head delayed/);
assert.match(f.elements.get("l1-freshness").textContent, /Head delayed/);
assert.match(f.elements.get("errors").innerHTML, /snapshot is updating/);
f.sockets[0].push({ ...delayed, stale: true });
assert.match(f.elements.get("network-status").innerHTML, /Stale/);
assert.match(f.elements.get("errors").innerHTML, /Cached snapshot/);
assert.doesNotMatch(f.elements.get("errors").innerHTML, /snapshot is updating/);
const recovered = snapshot(13);
recovered.chains.l1.freshness = { ageSeconds: 3, warningSeconds: 30, status: "current" };
recovered.chains.l2.freshness = { ageSeconds: 2, warningSeconds: 30, status: "current" };
f.sockets[0].push(recovered);
assert.match(f.elements.get("network-status").innerHTML, /Healthy/);
assert.doesNotMatch(f.elements.get("l1-freshness").textContent, /Head delayed/);
assert.doesNotMatch(f.elements.get("errors").innerHTML, /snapshot is updating/);

const pending = f.refresh();
assert.equal(f.requests.length, 1);
f.sockets[0].push(snapshot(13));
f.requests[0].resolve(response(snapshot(11)));
await pending;
assert.equal(f.state.snapshot.chains.l2.latest.number, 13, "late HTTP response overwrote live state");

f.state.blobQuery = "L2:12";
f.element("decoder-result").innerHTML = "Previously decoded transaction";
f.sockets[0].push(snapshot(11, "bb"));
assert.equal(f.state.snapshot.chains.l2.latest.number, 11, "reorg to a lower height must be accepted");
assert.equal(f.state.blobQuery, "L2:12");
assert.equal(f.elements.get("decoder-result").innerHTML, "Previously decoded transaction");

const old = f.sockets[0];
old.close();
assert.equal(f.intervals.size, 1);
assert.equal([...f.intervals.values()][0].ms, 4000);
assert.equal(f.state.socket, null);
assert.equal(f.timeouts.get(f.state.reconnectTimer).ms, 1000);
f.runTimer(f.state.reconnectTimer);
assert.equal(f.sockets.length, 2);
f.sockets[1].push(snapshot(15, "cc"));
old.push(snapshot(999));
assert.equal(f.state.snapshot.chains.l2.latest.number, 15, "old connection callbacks must be ignored");
assert.equal(f.intervals.size, 0);
f.requests[1].resolve(response(snapshot(14)));
await tick();
assert.equal(f.state.snapshot.chains.l2.latest.number, 15);

f.runTimer(f.state.liveTimer);
assert.equal(f.sockets[1].closed, true, "stalled live feed must reconnect");
assert.equal(f.intervals.size, 1);
f.runTimer(f.state.reconnectTimer);
f.sockets[2].push(snapshot(16));
assert.equal(f.intervals.size, 0);
f.requests[2].resolve(response(snapshot(14)));
await tick();

f.sockets[2].onmessage({ data: "not-json" });
assert.equal(f.sockets[2].closed, true, "malformed payload must fall back safely");
f.events.pagehide();
assert.equal(f.state.stopped, true);
assert.equal(f.state.socket, null);
assert.equal(f.intervals.size, 0);
assert.equal(f.timeouts.has(f.state.reconnectTimer), false);
f.events.pageshow();
assert.equal(f.sockets.length, 4, "restored page must reconnect");
f.sockets[3].push(snapshot(17));
f.requests[3].resolve(response(snapshot(14)));
await tick();
assert.equal(f.state.snapshot.chains.l2.latest.number, 17);
f.events.pagehide();

const unsupported = fixture({ unavailable: true });
assert.equal(unsupported.requests.length, 1);
assert.equal(unsupported.intervals.size, 1);
unsupported.requests[0].resolve(response(snapshot(12)));
await tick();
assert.equal(unsupported.state.snapshot.chains.l2.latest.number, 12);
unsupported.events.pagehide();

const blocked = fixture({ blocked: true });
for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
  assert.equal(blocked.timeouts.get(blocked.state.reconnectTimer).ms, delay);
  blocked.runTimer(blocked.state.reconnectTimer);
}
assert.equal(blocked.requests.length, 1, "fallback HTTP requests must not overlap");
blocked.FakeSocket.blocked = false;
blocked.runTimer(blocked.state.reconnectTimer);
blocked.sockets[0].push(snapshot(12));
assert.equal(blocked.intervals.size, 0);
blocked.requests[0].reject(new Error("old HTTP failure"));
await tick();
assert.match(blocked.elements.get("network-status").innerHTML, /Healthy/);
blocked.events.pagehide();
console.log("live monitor tests passed: WSS URL, push delivery, HTTP race, reorg, persistent inputs, reconnect, watchdog, malformed data, page lifecycle, fallback, bounded retries");

const mounted = fixture();
assert.equal(mounted.sockets.length, 1);
mounted.dispose();
assert.equal(mounted.state.stopped, true);
assert.equal(mounted.state.socket, null);
assert.equal(mounted.timeouts.size, 0);
assert.equal(mounted.intervals.size, 0);
assert.deepEqual(Object.keys(mounted.events), []);
console.log("Native monitor unmount releases its WebSocket, timers, and page listeners");

// Immediate heads must win over a detail request started before that event.
const realtime = fixture();
const initial = snapshot(12);
initial.chains.l2.safe = { number: 10 };
initial.chains.l2.finalized = { number: 9 };
initial.chains.l2.blocks = [{ number: 12, hash: "0x" + "aa".repeat(32) }];
initial.settlementHistory = { available: true };
realtime.sockets[0].push(initial);
const update = (number, hash, parentHash, sequence) => ({sequence, receivedAt: new Date().toISOString(), block: {
  number, hash: "0x" + hash.repeat(32), parentHash: "0x" + parentHash.repeat(32),
  timestamp: Math.floor(Date.now() / 1000), gasUsed: 21000, gasLimit: 30000000, transactionCount: null,
}});
const send = message => realtime.sockets[0].onmessage({data: JSON.stringify(message)});
const thirteen = update(13, "bb", "aa", 2);
send({type: "heads", heads: {l2: thirteen}});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 13);
assert.equal(realtime.state.snapshot.chains.l2.latest.transactionCount, null);
assert.equal(realtime.state.snapshot.chains.l2.blocks.length, 2);
assert.equal(realtime.requests.length, 0, "head notifications must render without HTTP requests");
send({type: "snapshot", snapshot: initial, heads: {l2: thirteen}, collectionStartedSequence: 1});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 13, "slow details must not undo a head event");
const reorg = update(11, "cc", "00", 4);
send({type: "heads", heads: {l2: reorg}});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 11);
assert.equal(realtime.state.snapshot.chains.l2.safe, null);
assert.equal(realtime.state.snapshot.settlementHistory.available, false);
send({type: "snapshot", snapshot: snapshot(14), heads: {l2: reorg}, collectionStartedSequence: 3});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 11, "in-flight old branch must not undo a rollback");
send({type: "snapshot", snapshot: snapshot(12, "dd"), heads: {l2: reorg}, collectionStartedSequence: 4});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 12);
send({type: "heads", heads: {l1: update(23053001, "ee", "ff", 6), l2: reorg}});
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 12, "repeated L2 slot must not undo later reconciliation");
const inflight = realtime.refresh();
send({type: "heads", heads: {l2: update(13, "ee", "dd", 7)}});
realtime.requests[0].resolve(response(snapshot(12, "dd")));
await inflight;
assert.equal(realtime.state.snapshot.chains.l2.latest.number, 13);
assert.match(realtime.element("last-update").textContent, /Last updated/);
realtime.dispose();
const firstHead = fixture();
firstHead.sockets[0].onmessage({data: JSON.stringify({type: "heads", heads: {l2: thirteen}})});
assert.equal(firstHead.state.snapshot.chains.l2.latest.number, 13, "head must render before initial details load");
firstHead.dispose();
console.log("Immediate heads verified: initial load, slow details, HTTP race, rollback, cross-chain updates, and null transaction counts");

// Several heads can arrive while one detail collection is still running.
const stable = fixture();
const emit = message => stable.sockets.at(-1).onmessage({data: JSON.stringify(message)});
const base = structuredClone(initial);
base.blobSettlements = [{transactionHash: '0x' + '55'.repeat(32), isProtocolSettlement: true}];
base.rollup = {status: 'safe', safeBlock: {number: 10}};
stable.sockets[0].push(base);
emit({type: 'heads', heads: {l2: thirteen}});
const fourteen = update(14, 'dd', 'bb', 3);
emit({type: 'heads', heads: {l2: fourteen}});
emit({type: 'snapshot', snapshot: base, heads: {l2: fourteen}, collectionStartedSequence: 1});
assert.equal(stable.state.snapshot.chains.l2.latest.number, 14);
assert.equal(stable.state.snapshot.chains.l2.safe.number, 10, 'slow collection must not manufacture a reorg');
assert.equal(stable.state.snapshot.settlementHistory.available, true);
assert.equal(stable.state.snapshot.blobSettlements.length, 1);
assert.equal(stable.state.snapshot.chains.l2.blocks.length, 3);
assert.equal(Object.keys(stable.state.snapshot.reconciliation).length, 0);

const hydrated = structuredClone(base);
hydrated.chains.l2.latest = {...thirteen.block, transactionCount: 7};
hydrated.chains.l2.blocks = [hydrated.chains.l2.latest, ...base.chains.l2.blocks];
emit({type: 'snapshot', snapshot: hydrated, heads: {l2: fourteen}, collectionStartedSequence: 2});
assert.equal(stable.state.snapshot.chains.l2.blocks.find(b => b.number === 13).transactionCount, 7);
emit({type: 'snapshot', snapshot: base, heads: {l2: fourteen}, collectionStartedSequence: 1});
assert.equal(stable.state.snapshot.chains.l2.blocks.find(b => b.number === 13).transactionCount, 7,
  'already hydrated transaction counts must survive a slower response');

// Missing notifications are uncertain ancestry, not proof of a reorg.
const sixteen = update(16, 'ee', 'ff', 5);
emit({type: 'heads', heads: {l2: sixteen}});
assert.equal(stable.state.snapshot.chains.l2.latest.number, 16);
assert.equal(stable.state.snapshot.blobSettlements.length, 1);
assert.equal(stable.state.snapshot.chains.l2.safe.number, 10);
assert.equal(stable.state.snapshot.reconciliation.l2, 'gap');
assert.match(stable.element('errors').innerHTML, /last verified/);
assert.match(stable.element('commit-status').innerHTML, /Verifying/);
assert.equal(stable.state.snapshot.metrics.l2UnsafeLag, null);

// A later canonical read wins at equal height, and also on a lower rollback.
const canonical = structuredClone(base);
canonical.chains.l2.latest = {...sixteen.block, hash: '0x' + '99'.repeat(32)};
canonical.chains.l2.blocks = [canonical.chains.l2.latest];
emit({type: 'snapshot', snapshot: canonical, heads: {l2: sixteen}, collectionStartedSequence: 5});
assert.equal(stable.state.snapshot.chains.l2.latest.hash, canonical.chains.l2.latest.hash);
assert.equal(Object.keys(stable.state.snapshot.reconciliation).length, 0);
const lower = structuredClone(base);
emit({type: 'snapshot', snapshot: lower, heads: {l2: sixteen}, collectionStartedSequence: 5});
assert.equal(stable.state.snapshot.chains.l2.latest.number, 12);

// A real replacement invalidates old-branch claims through further heads and
// responses that started before the branch change, even if their tip matches.
const replacement = update(12, 'cc', '00', 6);
emit({type: 'heads', heads: {l2: replacement}});
assert.equal(stable.state.snapshot.reconciliation.l2, 'reorg');
assert.equal(stable.state.snapshot.blobSettlements.length, 0);
emit({type: 'heads', heads: {l2: update(13, 'ee', 'cc', 7)}});
const racing = structuredClone(base);
racing.chains.l2.latest = update(13, 'ee', 'cc', 7).block;
emit({type: 'snapshot', snapshot: racing, collectionStartedSequence: 5});
assert.equal(stable.state.snapshot.chains.l2.safe, null);
assert.equal(stable.state.snapshot.blobSettlements.length, 0);
emit({type: 'snapshot', snapshot: racing, collectionStartedSequence: 7});
assert.equal(stable.state.snapshot.chains.l2.safe.number, 10);
assert.equal(stable.state.snapshot.blobSettlements.length, 1);

// Failed collection must not appear as empty history or an empty chain.
const partial = { ...snapshot(13, 'ee'), errors: [{component:'l2', message:'RPC timeout'},
  {component:'settlement-history', message:'RPC timeout'}],
  settlementHistory: {available: false}, blobSettlements: [] };
partial.chains.l2 = {healthy: false, error: 'RPC timeout'};
emit({type: 'snapshot', snapshot: partial, collectionStartedSequence: 8});
assert.equal(stable.state.snapshot.chains.l2.latest.number, 13);
assert.equal(stable.state.snapshot.blobSettlements.length, 1);
assert.match(stable.element('errors').innerHTML, /RPC timeout/);
assert.match(stable.element('network-status').innerHTML, /Verifying/);
// New connections reset sequence-scoped invalidation markers.
stable.sockets[0].close();
stable.runTimer(stable.state.reconnectTimer);
assert.equal(Object.keys(stable.state.pendingChains).length, 0);
stable.dispose();
console.log('Reorg regressions passed: multi-head continuity, hydration, missed events, same-height and lower reconciliation, pending reorgs, partial failures, reconnect');

const details = fixture();
const deliver = message => details.sockets[0].onmessage({data: JSON.stringify(message)});
const detailBase = structuredClone(base);
detailBase.chains.l2.latest.transactionCount = 0;
detailBase.chains.l2.blocks[0].transactionCount = 0;
details.sockets[0].push(detailBase);
const gapHead = update(15, 'dd', 'cc', 2);
deliver({type:'heads',heads:{l2:gapHead}});
assert.match(details.element('l2-blocks').innerHTML, /Pending/);
const blockDetails = [gapHead.block, update(14,'cc','bb',1).block, thirteen.block]
  .map((block,index)=>({...block,transactionCount:3-index}));
deliver({type:'heads',heads:{l2:gapHead},blocks:{l2:blockDetails}});
assert.equal(details.state.snapshot.chains.l2.latest.number,15);
assert.equal(details.state.snapshot.chains.l2.latest.transactionCount,3);
assert.deepEqual(Array.from(details.state.snapshot.chains.l2.blocks,b=>b.number),[15,14,13,12]);
assert.doesNotMatch(details.element('l2-blocks').innerHTML,/Pending/);
// Late details from an orphaned branch must neither move the tip nor supply
// transaction counts for another block at the same height.
const fork=update(15,'ee','cc',3);
deliver({type:'heads',heads:{l2:fork}});
deliver({type:'heads',heads:{l2:fork},blocks:{l2:blockDetails}});
assert.equal(details.state.snapshot.chains.l2.latest.hash,fork.block.hash);
assert.equal(details.state.snapshot.chains.l2.latest.transactionCount,null);
details.dispose();
console.log('Recent block hydration passed: missing ancestors, transaction counts, unchanged heads, and delayed orphan data');

const expanded = fixture();
const makeBlocks = (count, top, timestamp) => Array.from({length:count},(_,i)=>({
 number:top-i, hash:'0x'+(top-i+1).toString(16).padStart(64,'0'),
 parentHash:'0x'+(top-i).toString(16).padStart(64,'0'), timestamp:timestamp-i,
 transactionCount:0,gasUsed:0,gasLimit:30000000}));
const expandedSnapshot = snapshot(200);
expandedSnapshot.configuration = {refreshSeconds:4,recentBlockWindows:{l1:20,l2:100},syncSlotSeconds:5};
for(const [name,count] of [['l1',20],['l2',100]]){
 const blocks=makeBlocks(count,200,1000);
 expandedSnapshot.chains[name]={healthy:true,latest:blocks[0],blocks};
}
expanded.sockets[0].push(expandedSnapshot);
assert.equal(expanded.state.snapshot.chains.l1.blocks.length,20);
assert.equal(expanded.state.snapshot.chains.l2.blocks.length,100);
assert.equal((expanded.element('l2-blocks').innerHTML.match(/class="sync-block-row"/g)||[]).length,20,
 'sync labels follow the time grid, not the empty transaction count');
assert.doesNotMatch(expanded.element('l1-blocks').innerHTML,/sync-block/);
expandedSnapshot.configuration.syncSlotSeconds=null;
expanded.sockets[0].push(expandedSnapshot);
assert.doesNotMatch(expanded.element('l2-blocks').innerHTML,/sync-block/);
expanded.dispose();
console.log('Independent 20/100 block windows and configured sync-slot classification passed');

const clocked = fixture();
const clockSnapshot = snapshot(50);
clockSnapshot.chains.l2.latest.timestamp = Math.floor(Date.now()/1000)-10;
clockSnapshot.chains.l2.freshness = {ageSeconds:0,warningSeconds:30};
clocked.sockets[0].push(clockSnapshot);
assert.match(clocked.element('l2-freshness').textContent,/Latest block 10 s ago/);
const rowsBeforeTick = clocked.element('l2-blocks').innerHTML;
clocked.state.snapshot.chains.l2.latest.timestamp -= 1;
clocked.runTimer(clocked.state.ageTimer);
assert.match(clocked.element('l2-freshness').textContent,/Latest block 11 s ago/);
assert.equal(clocked.element('l2-blocks').innerHTML,rowsBeforeTick,'age clock must not rebuild the table');
assert.equal(clocked.requests.length,0,'age clock must not poll RPC');
clocked.state.snapshot.chains.l2.latest.timestamp -= 25;
clocked.runTimer(clocked.state.ageTimer);
assert.match(clocked.element('l2-freshness').textContent,/Head delayed/);
clocked.events.pagehide();
assert.equal(clocked.state.ageTimer,null);
clocked.events.pageshow();
assert.equal(clocked.timeouts.get(clocked.state.ageTimer).ms,1000);
clocked.dispose();
assert.equal(clocked.timeouts.size,0);
console.log('One-second head age clock passed: idle feed, current timestamps, delay threshold, no network polling, lifecycle cleanup');
