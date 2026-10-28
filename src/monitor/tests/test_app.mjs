import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const elements = new Map();

function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      disabled: false,
      className: "",
      dataset: {},
      listeners: {},
      classList: { toggle() {} },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      append() {},
      replaceChildren() {},
      querySelector() { return element(`${id}-submit`); },
      scrollIntoView() {},
    });
  }
  return elements.get(id);
}

globalThis.document = {
  querySelector: selector => element(selector.slice(5, -2)), getElementById: element,
  createElement: () => element(`created-${elements.size}`),
};
globalThis.window = { location: { href: "https://dashboard.example/#/monitor", origin: "https://dashboard.example" } };
globalThis.fetch = () => new Promise(() => {});
globalThis.WebSocket = undefined;
globalThis.setInterval = () => 0;
let nextTimeout = 1;
const scheduledTimeouts = new Map();
globalThis.setTimeout = (callback, delay) => {
  const id = nextTimeout++;
  scheduledTimeouts.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = (id) => scheduledTimeouts.delete(id);

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const app = source.replace("export function mountMonitor(root) {", "const root = document;").replace(/return \(\) => \{[\s\S]*$/, "");
const styles = readFileSync(new URL("../monitor.css", import.meta.url), "utf8");
assert.match(
  styles,
  /\.decoder-summary \.semantic-message-details dl \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
);
assert.match(
  styles,
  /\.decoder-summary \.semantic-message-details dd \{[^}]*overflow: visible/,
);
const assertions = String.raw`
// Search debounce assertions below concern search timers. Transport startup
// timers have their own coverage in test_live_app.mjs.
scheduledTimeouts.clear();
state.snapshot = { configuration: { explorers: {
  l1: "https://dashboard.example:4444",
  l2: "https://dashboard.example:4445",
  blobscan: "https://dashboard.example:4443",
} } };

const txHash = "0x" + "11".repeat(32);
const l1Hash = "0x" + "22".repeat(32);
const blobHash = "0x" + "33".repeat(32);
const parentHash = "0x" + "44".repeat(32);
const stateRoot = "0x" + "55".repeat(32);
renderDecoded({
  transactionHash: txHash,
  l1BlockNumber: 114,
  l1BlockHash: l1Hash,
  registryAddress: "0x" + "66".repeat(20),
  blobVersionedHashes: [blobHash],
  protocolVersion: 0,
  profile: "native-semantics",
  blobCount: 1,
  physicalBytes: 131072,
  logicalCapacityBytes: 126976,
  usedStreamBytes: 4096,
  paddingBytes: 122880,
  messages: ["ChainOperation", "InitiateCrossChainTransaction", "Call", "ReturnSuccess", "FinishCrossChainTransaction", "CloseBlobStream"],
  chainOperation: { chainId: 1, operations: {
    tag: 2,
    format: "self-contained-blocks",
    bytes: 4082,
    blockCount: 1,
    transactionCount: 2,
    l2EntryCount: 0,
    blocks: [{ number: 673, parentHash, stateRoot, transactionCount: 2,
      gasUsed: 42000, gasLimit: 30000000, timestamp: 1700000000, rlpBytes: 900 }],
  } },
  semanticTransactions: [{ originChain: 1, txDataBytes: 128, txDataPreview: "0x7478", callCount: 1,
    snapshotCount: 0, rollbackRegionCount: 0, forcedRollbackCallCount: 0,
    maxCallDepth: 1, successReturnCount: 1, failedReturnCount: 0,
    messages: [
      { type: "InitiateCrossChainTransaction", chainId: 1, txDataBytes: 128, txDataPreview: "0x7478" },
      { type: "Call", index: 0, parentIndex: null, depth: 0, fromChain: 1, toChain: 0,
        fromAddress: "0x" + "77".repeat(20), toAddress: "0x" + "88".repeat(20),
        value: "7", gas: 0, dataBytes: 4, dataPreview: "0xdeadbeef" },
      { type: "ReturnSuccess", callIndex: 0, returnDataBytes: 2, returnDataPreview: "0xbeef" },
      { type: "FinishCrossChainTransaction" },
    ],
    calls: [{ index: 0, parentIndex: null, depth: 0,
      type: "Call", fromChain: 1, toChain: 0,
      fromAddress: "0x" + "77".repeat(20), toAddress: "0x" + "88".repeat(20),
      value: "7", dataBytes: 4, dataPreview: "0xdeadbeef",
      result: { type: "ReturnSuccess", returnDataBytes: 2, returnDataPreview: "0xbeef" } }],
    rollbackRegions: [] }],
});
const decoded = element("decoder-result").innerHTML;
assert.match(decoded, /:4444\/tx\/0x11/);
assert.match(decoded, /:4444\/block\/114/);
assert.match(decoded, /:4444\/block\/0x22/);
assert.match(decoded, /:4443\/blob\/0x33/);
assert.match(decoded, /:4445\/block\/673/);
assert.match(decoded, /:4445\/block\/0x44/);
assert.match(decoded, /How this result maps to the blob bytes/);
assert.match(decoded, /RLP\(\[blocks, l2Entries, outboundGroupSizes\]\)/);
assert.match(decoded, /Cross-chain tx 1/);
assert.match(decoded, /ReturnSuccess/);
assert.match(decoded, /CROSS-CHAIN MESSAGE STREAM/);
assert.match(decoded, /InitiateCrossChainTransaction/);
assert.match(decoded, /0xdeadbeef/);
assert.match(decoded, /0xbeef/);
assert.match(decoded, /4 messages/);
assert.match(decoded, /Message type/);
assert.match(decoded, /Important parameters/);
assert.match(decoded, /Expand info/);
assert.doesNotMatch(decoded, /<i>2<\/i>Call/);
assert.match(decoded, /Each originating cross-chain transaction is encoded afterward/);

renderDecoded({ chainOperation: { chainId: 1, operations: {
  tag: 3, profileId: 1, format: "derivable-ordinary", firstBlockNumber: 1,
  terminalBlockNumber: 155, derivedBlockCount: 154, implicitEmptyBlockCount: 154,
  blockCount: 155, transactionCount: 0, blocks: [{number: 155, parentHash, stateRoot,
    transactionCount: 0, gasUsed: 0, gasLimit: 30000000, timestamp: 1700000000, rlpBytes: 613}],
} } });
assert.match(element("decoder-result").innerHTML, /154 derived ordinary blocks/);
assert.match(element("decoder-result").innerHTML, /154 implicit empty blocks/);
assert.match(element("decoder-result").innerHTML, /Derived state roots and block hashes require execution replay/);
assert.match(element("decoder-result").innerHTML, /ordinaryBlockCount, environment, records/);
assert.match(element("decoder-result").innerHTML, /block\/155/);
assert.doesNotMatch(element("decoder-result").innerHTML, /block\/154/);

renderDecoded({ chainOperation: { chainId: 1, operations: {
  tag: 0, format: "direct-v0", bytes: 31, blockCount: 165, transactionCount: 0,
  implicitEmptyBlockCount: 165, l2EntryCount: null, blocks: [],
  countRuns: [{ position: 0, blocks: 165, transactionsPerBlock: 0 }],
} } });
const direct = element("decoder-result").innerHTML;
assert.match(direct, /Reconstructed during execution/);
assert.match(direct, /transaction-count tokens, beneficiary runs/);
assert.match(direct, /165 empty ordinary prefixes/);
assert.match(direct, /Pure L2 transactions per block/);
assert.doesNotMatch(direct, /RLP\(\[blockTxCounts/);
assert.doesNotMatch(direct, /operation RLP/);
assert.match(direct, /operation columns carry ordinary transaction prefixes and metadata/);

const noSemantics = decodedSemantics({
  messages: ["ChainOperation", "CloseBlobStream"],
  semanticTransactions: [],
});
assert.match(noSemantics, /chain-local synchronization batch/);

const correlation = renderCorrelationResult({ result: {
  canonicalL2: true,
  l2Finalized: true,
  l1BlockNumber: "0x72",
  l1BlockHash: l1Hash,
  l1TransactionHash: txHash,
  l2Range: { firstBlockNumber: "0x2a1", lastBlockNumber: "0x2a6", blockCount: "0x6" },
  l2Blocks: [{ number: "0x2a1", hash: parentHash }],
} });
assert.match(correlation, /:4444\/block\/114/);
assert.match(correlation, /:4444\/tx\/0x11/);
assert.match(correlation, /:4445\/block\/673/);
assert.match(correlation, /:4445\/block\/0x44/);

renderChain("L1", { chainId: 7331, latest: { number: 128, hash: l1Hash },
  safe: { number: 96 }, finalized: { number: 64 }, peerCount: 2 });
assert.match(element("l1-latest").innerHTML, /:4444\/block\/128/);
assert.match(element("l1-hash").innerHTML, /:4444\/block\/0x22/);
assert.match(element("l1-safe").innerHTML, /:4444\/block\/96/);
assert.match(element("l1-finalized").innerHTML, /:4444\/block\/64/);

renderComposerRpc({
  l1ToL2: "https://dashboard.example/composer/l1",
  l2ToL1: "https://dashboard.example/composer/l2",
}, { l1: 7331, l2: 6290 });
const composer = element("composer-rpc").innerHTML;
assert.match(composer, /L1 → L2/);
assert.match(composer, /L2 → L1/);
assert.match(composer, /composer\/l1/);
assert.match(composer, /composer\/l2/);
assert.match(composer, /chain 7331/);
assert.match(composer, /chain 6290/);

const searchableSettlement = {
  transactionHash: txHash,
  l1BlockNumber: 114,
  l1BlockHash: l1Hash,
  status: "confirmed",
  totalCostWei: "112514000918670",
  executionCostWei: "112514000787598",
  blobCostWei: "131072",
  isProtocolSettlement: true,
  blobVersionedHashes: [blobHash],
  beacon: { slot: 771 },
  l2Ranges: [{ l2Range: {
    firstBlockNumber: "0x2a1",
    lastBlockNumber: "0x2a6",
    blockCount: "0x6",
  } }],
};
assert.equal(settlementMatches(searchableSettlement, "0x111111"), true);
assert.equal(settlementMatches(searchableSettlement, "0x333333"), true);
assert.equal(settlementMatches(searchableSettlement, "#114"), true);
assert.equal(settlementMatches(searchableSettlement, "L1:0x72"), true);
assert.equal(settlementMatches(searchableSettlement, "L1:114"), true);
assert.equal(settlementMatches(searchableSettlement, "L2:674"), true);
assert.equal(settlementMatches(searchableSettlement, "L2:114"), false);
assert.equal(settlementMatches(searchableSettlement, "674"), true);
assert.equal(settlementMatches(searchableSettlement, "EEZ batch"), true);
assert.equal(settlementMatches(searchableSettlement, "999999"), false);
assert.equal(isExactSettlementQuery("L1:#114"), true);
assert.equal(isExactSettlementQuery("0x" + "11".repeat(32)), true);
assert.equal(isExactSettlementQuery("0x1111zz"), false);
assert.match(blobRows([], "missing"), /No blob settlements match/);
assert.match(blobRows([{
  ...searchableSettlement, beacon: { configured: false, available: null },
}]), /not configured/);
assert.doesNotMatch(blobRows([{
  ...searchableSettlement, beacon: { configured: false, available: null },
}]), /unavailable/);

const searchInput = element("blob-search");
searchInput.value = "6983";
searchInput.listeners.input({ target: searchInput });
assert.match(element("blob-search-status").textContent, /searching indexed history automatically/i);
assert.match(element("blob-rows").innerHTML, /Searching indexed settlement history/);
assert.equal(element("window-label").textContent, "Searching full history");
assert.equal(scheduledTimeouts.size, 1);
assert.equal([...scheduledTimeouts.values()][0].delay, 400);

searchInput.value = "protocol";
searchInput.listeners.input({ target: searchInput });
assert.match(element("blob-search-status").textContent, /Filtering the recent window/);
assert.equal(scheduledTimeouts.size, 0);

assert.equal(apiUrl("api/snapshot").pathname, "/monitor/api/snapshot");
assert.equal(formatEth("112514000918670"), "0.00011251 ETH");
assert.equal(formatEth("131072"), "<0.00000001 ETH");
assert.equal(formatEth(null), "—");
const policySnapshot = {
  configuration: { ...state.snapshot.configuration, nativeCurrency: "ETH", settlementPolicy: {
    enabled: true, source: "operator-configuration", pureL2Mode: "always", pureL2IntervalMs: null,
    maxUnsettledL2Blocks: 150, nominalGeneralIntervalMs: 300000, blobFullnessBps: null,
  } },
  settlementProgress: { available: true, unsettledL2Blocks: 96, remainingL2Blocks: 54,
    generalThresholdReached: false, estimatedGeneralRemainingMs: 108000 },
  settlementHistory: { available: true, limit: 12, fromL1Block: 1, toL1Block: 140, intervalsSeconds: [300] },
  blobSettlements: [{ ...searchableSettlement, receiptStatus: 1, timestamp: 1700000000, blobCount: 2,
    beacon: { available: true, source: "full-blobs", blobCount: 2 } }],
};
state.snapshot = policySnapshot;
renderSettlementPolicy(policySnapshot);
assert.match(element("policy-rules").innerHTML, /5 min/);
assert.match(element("policy-rules").innerHTML, /Always/);
assert.match(element("policy-rules").innerHTML, /including reverted transactions/);
assert.match(element("policy-progress").innerHTML, /value="96" max="150"/);
assert.match(element("policy-progress").innerHTML, /1 min 48 s/);
assert.match(element("latest-settlement").innerHTML, /2 blobs/);
assert.match(element("latest-settlement").innerHTML, /:4444\/tx\/0x11/);
renderSettlementPolicy({ ...policySnapshot, settlementProgress: { ...policySnapshot.settlementProgress,
  unsettledL2Blocks: 156, remainingL2Blocks: 0, generalThresholdReached: true } });
assert.match(element("policy-status").innerHTML, /Threshold reached/);
assert.match(element("policy-progress").innerHTML, /value="150" max="150"/);
assert.match(element("policy-progress").innerHTML, /Waiting for canonical L1 inclusion/);
renderSettlementPolicy({ ...policySnapshot, stale: true });
assert.match(element("policy-progress").innerHTML, /Snapshot is stale/);
assert.doesNotMatch(element("policy-progress").innerHTML, /<progress/);
renderSettlementPolicy({ configuration: {} });
assert.match(element("policy-status").innerHTML, /Not supplied/);
assert.doesNotMatch(element("policy-rules").innerHTML, /5 min/);
renderSettlementPolicy({ ...policySnapshot, configuration: { settlementPolicy: {
  ...policySnapshot.configuration.settlementPolicy, pureL2Mode: "interval", pureL2IntervalMs: 900000,
  blobFullnessBps: 1000,
} } });
assert.match(element("policy-rules").innerHTML, /15 min/);
assert.match(element("policy-rules").innerHTML, /earlier general rule/);
assert.match(element("policy-progress").innerHTML, /10% across all permitted blobs/);
state.snapshot.configuration.nativeCurrency = "GNO";
assert.equal(formatEth("112514000918670"), "0.00011251 GNO");
assert.match(blobRows(policySnapshot.blobSettlements), /full blobs/);
assert.match(blobRows([{ ...searchableSettlement, totalCostWei: null }]), /Receipt cost unavailable/);
`;

eval(`${app}\n${assertions}`);
console.log("dashboard contextual explorer-link tests passed");
