import { decodeErrorResult, decodeEventLog, decodeFunctionData, toEventSelector, toHex, type Abi, type Hex } from "viem";
import { eezL1Abi, eezL2Abi } from "../abi/eez";
import { config } from "../config";
import { rpcCall } from "../rpc";

export type DebugChain = "l1" | "l2";
export type Rpc = (url: string, method: string, params?: unknown[]) => Promise<unknown>;
export type RawTransaction = {
  hash: string; from: string; to: string | null; input: string; value: string;
  blockNumber: string | null; blockHash: string | null; transactionIndex: string | null;
};
export type RawLog = {
  address: string; topics: Hex[]; data: Hex; logIndex: string;
  transactionHash: string; blockHash: string; blockNumber: string;
};
export type DebugEvent = {
  name: string; args: Record<string, unknown>; raw: RawLog; protocol: boolean;
};
export type DebugReceipt = {
  status: string; gasUsed: string; blockNumber: string; blockHash: string; logs: RawLog[];
  contractAddress?: string | null;
};
export type DebugTransaction = {
  chain: DebugChain; tx: RawTransaction; receipt: DebugReceipt | null;
  events: DebugEvent[]; payload: DebugPayload | null; warnings: string[];
};
export type DebugPayload = {
  method: string; args: Record<string, unknown>; entries: Record<string, unknown>[];
  staticEntries: Record<string, unknown>[]; immediateEntryCount: number;
};
export type DebugBlock = {
  chain: DebugChain; number: string; hash: string; parentHash: string; timestamp: string;
  gasUsed: string; gasLimit: string; transactions: DebugTransaction[];
};
export type Settlement = {
  l1BlockNumber: string; l1BlockHash: string; l1TransactionHash: string;
  l2Blocks: { number: string; hash: string }[];
  canonicalL2: boolean; l2Finalized: boolean;
};
export function settlementRange(settlement: Pick<Settlement, "l2Blocks">): { first: string; last: string } | undefined {
  if (!settlement.l2Blocks.length) return undefined;
  let first = settlement.l2Blocks[0]!.number;
  let last = first;
  for (const block of settlement.l2Blocks) {
    if (BigInt(block.number) < BigInt(first)) first = block.number;
    if (BigInt(block.number) > BigInt(last)) last = block.number;
  }
  return { first, last };
}
export type DebugContext = {
  sourceChain: DebugChain; sourceBlock: DebugBlock | null; selected: DebugTransaction | null;
  blocks: DebugBlock[]; settlements: Settlement[]; warnings: string[];
  remainingBlocks?: { chain: DebugChain; hash: string }[];
  syncOnly?: boolean;
};
export type CallTrace = {
  type: string; from: string; to?: string; input?: string; output?: string;
  value?: string; gas?: string; gasUsed?: string; error?: string; revertReason?: string;
  calls?: CallTrace[];
};

export const debugAbi = (chain: DebugChain): Abi => chain === "l1" ? eezL1Abi : eezL2Abi;
export const debugRpc = (chain: DebugChain) => chain === "l1" ? config.l1Rpc : config.l2Rpc;
// Scope discoveries to the RPC, so switching networks cannot reuse a registry address.
const discoveredRegistries = new Map<string, string>();
const discoveredBatchTargets = new Map<string, Set<string>>();
const discoveredL2Managers = new Map<string, string>();
export const managerAddress = (chain: DebugChain) => chain === "l1"
  ? config.rollupsAddress || discoveredRegistries.get(config.l1Rpc) || ""
  : config.ccmL2Address || discoveredL2Managers.get(config.l2Rpc) || "0x4200000000000000000000000000000000000007";
export const isDebugManager = (chain: DebugChain, address: string | null | undefined) =>
  !!address && (same(address, managerAddress(chain)) || (chain === "l1" &&
    !!discoveredBatchTargets.get(config.l1Rpc)?.has(address.toLowerCase())));
export const jsonDebug = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
export const quantity = (value: string | number | bigint | undefined | null) => value == null ? "—" : BigInt(value).toLocaleString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const debugRequest: Rpc = async (url, method, params) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try { return await rpcCall(url, method, params, controller.signal); }
  catch (error) { if (controller.signal.aborted) throw new Error(`${method} timed out after 30 seconds`); throw error; }
  finally { clearTimeout(timeout); }
};

export function decodeDebugLog(chain: DebugChain, raw: RawLog): DebugEvent {
  if (isDebugManager(chain, raw.address)) return decodeProtocolLog(chain, raw);
  return { name: "Raw log", args: { topics: raw.topics, data: raw.data }, raw, protocol: false };
}

function decodeProtocolLog(chain: DebugChain, raw: RawLog): DebugEvent {
  // Compatibility forms can share topic0 but differ in indexing.
  for (const item of debugAbi(chain)) {
    if (item.type !== "event") continue;
    try {
      const decoded = decodeEventLog({ abi: [item], topics: raw.topics as [Hex, ...Hex[]], data: raw.data });
      return { name: decoded.eventName, args: decoded.args as Record<string, unknown>, raw, protocol: true };
    } catch { /* another ABI signature */ }
  }
  return { name: "Raw log", args: { topics: raw.topics, data: raw.data }, raw, protocol: false };
}

export function decodeDebugPayload(chain: DebugChain, input: string): DebugPayload | null {
  try {
    const decoded = decodeFunctionData({ abi: debugAbi(chain), data: input as Hex });
    const values = decoded.args ?? [];
    const fn = debugAbi(chain).find(item => item.type === "function" && item.name === decoded.functionName);
    const args: Record<string, unknown> = {};
    if (fn?.type === "function") fn.inputs.forEach((field, i) => { args[field.name || String(i)] = values[i]; });
    if (decoded.functionName === "postAndVerifyBatch") {
      const batch = values[0] as Record<string, unknown>;
      return { method: decoded.functionName, args: batch,
        entries: batch.entries as Record<string, unknown>[], staticEntries: batch.staticEntries as Record<string, unknown>[],
        immediateEntryCount: Number(batch.immediateEntryCount) };
    }
    const hasTable = decoded.functionName === "loadExecutionTable" || decoded.functionName === "executeIncomingCrossChainCall";
    return { method: decoded.functionName, args,
      entries: hasTable ? values[0] as Record<string, unknown>[] : [],
      staticEntries: hasTable ? values[1] as Record<string, unknown>[] : [], immediateEntryCount: 0 };
  } catch { return null; }
}

export function decodeRevert(chain: DebugChain, data?: string): string | null {
  if (!data || data === "0x") return null;
  try {
    const result = decodeErrorResult({ abi: debugAbi(chain), data: data as Hex });
    return `${result.errorName}(${(result.args ?? []).map(value => typeof value === "object" ? jsonDebug(value) : String(value)).join(", ")})`;
  } catch { return null; }
}

export function transactionHashes(tx: DebugTransaction): Set<string> {
  const hashes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value)) hashes.add(value.toLowerCase());
  };
  for (const event of tx.events) {
    add(event.args.crossChainCallHash);
    if (event.name === "ExecutionTableLoaded") {
      for (const entry of (event.args.entries ?? []) as Record<string, unknown>[]) add(entry.proxyEntryHash);
      for (const entry of (event.args.staticEntries ?? []) as Record<string, unknown>[]) add(entry.proxyEntryHash);
    }
  }
  for (const entry of [...(tx.payload?.entries ?? []), ...(tx.payload?.staticEntries ?? [])]) add(entry.proxyEntryHash);
  return hashes;
}

export function relatedTransactions(context: DebugContext): DebugTransaction[] {
  if (!context.selected) return [];
  const hashes = transactionHashes(context.selected);
  return context.blocks.flatMap(block => block.transactions).filter(tx =>
    !(tx.chain === context.selected!.chain && same(tx.tx.hash, context.selected!.tx.hash)) &&
    [...transactionHashes(tx)].some(hash => hashes.has(hash)));
}

async function inspectTransaction(chain: DebugChain, tx: RawTransaction, rpc: Rpc): Promise<DebugTransaction> {
  const warnings: string[] = [];
  let receipt: DebugReceipt | null = null;
  try { receipt = await rpc(debugRpc(chain), "eth_getTransactionReceipt", [tx.hash]) as DebugReceipt | null; }
  catch (error) { warnings.push(`Receipt unavailable: ${message(error)}`); }
  if (tx.blockHash && !receipt) warnings.push("Receipt is not available for this included transaction; refresh to retry.");
  if (chain === "l2" && !config.ccmL2Address && receipt?.status === "0x1") {
    // Public networks can deploy EEZL2 away from the development predeploy.
    // Identify its distinct table/consumption events, rather than the sender
    // of the first transaction in the block.
    const observed = receipt.logs.map(log => decodeProtocolLog(chain, log)).find(event =>
      ["ExecutionTableLoaded", "ExecutionConsumed", "IncomingCrossChainCallExecuted"].includes(event.name) ||
      (event.name === "CrossChainCallExecuted" && event.args.callGas !== undefined));
    if (observed) discoveredL2Managers.set(config.l2Rpc, observed.raw.address);
  }
  // A successfully mined, ABI-decodable batch with a BatchPosted log identifies
  // its registry even when the runtime config lacks a deployment address.
  if (chain === "l1" && tx.to && receipt?.status === "0x1") {
    const payload = decodeDebugPayload(chain, tx.input);
    const posted = payload?.method === "postAndVerifyBatch" && receipt.logs.find(log =>
      eezL1Abi.some(item => {
        if (item.type !== "event" || item.name !== "BatchPosted") return false;
        try { decodeEventLog({ abi: [item], topics: log.topics as [Hex, ...Hex[]], data: log.data }); return true; }
        catch { return false; }
      }));
    if (posted && (!config.rollupsAddress || isDebugManager(chain, tx.to) || isDebugManager(chain, posted.address))) {
      discoveredRegistries.set(config.l1Rpc, posted.address);
      const targets = discoveredBatchTargets.get(config.l1Rpc) ?? new Set<string>();
      targets.add(posted.address.toLowerCase()); targets.add(tx.to.toLowerCase());
      discoveredBatchTargets.set(config.l1Rpc, targets);
    }
  }
  return { chain, tx, receipt, events: (receipt?.logs ?? []).map(log => decodeDebugLog(chain, log)), warnings,
    payload: isDebugManager(chain, tx.to) ? decodeDebugPayload(chain, tx.input) : null };
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let i = 0; i < items.length; i += 8) output.push(...await Promise.all(items.slice(i, i + 8).map(fn)));
  return output;
}

export async function fetchDebugBlock(chain: DebugChain, selector: string, rpc: Rpc = debugRequest): Promise<DebugBlock> {
  const byHash = /^0x[\da-f]{64}$/i.test(selector);
  const normalized = byHash || selector === "latest" ? selector : toHex(BigInt(selector));
  const block = await rpc(debugRpc(chain), byHash ? "eth_getBlockByHash" : "eth_getBlockByNumber", [normalized, true]) as
    Omit<DebugBlock, "chain" | "transactions"> & { transactions: (RawTransaction | string)[] } | null;
  if (!block) throw new Error(`${chain.toUpperCase()} block ${selector} was not found`);
  const transactions = await mapLimited(block.transactions, async item => {
    const tx = typeof item === "string" ? await rpc(debugRpc(chain), "eth_getTransactionByHash", [item]) as RawTransaction | null : item;
    if (!tx) throw new Error(`Transaction ${item} is unavailable`);
    return inspectTransaction(chain, tx, rpc);
  });
  // Discovery can finish after a neighbouring transaction's receipt was read.
  for (const tx of transactions) {
    tx.events = (tx.receipt?.logs ?? []).map(log => decodeDebugLog(chain, log));
    tx.payload = isDebugManager(chain, tx.tx.to) ? decodeDebugPayload(chain, tx.tx.input) : null;
  }
  return { ...block, chain, transactions };
}

async function withCounterpart(sourceBlock: DebugBlock, selected: DebugTransaction | null, rpc: Rpc, syncOnly = false, knownSettlement?: Settlement): Promise<DebugContext> {
  const context: DebugContext = { sourceChain: sourceBlock.chain, sourceBlock, selected, blocks: [sourceBlock], settlements: [], warnings: [], syncOnly: syncOnly && sourceBlock.chain === "l1" };
  try {
    const response = knownSettlement ? [knownSettlement] : await rpc(config.l2ProxyRpc, sourceBlock.chain === "l1" ? "eez_getSettledL2RangesByL1Block" : "eez_getSettlementByL2Block", [sourceBlock.hash]);
    context.settlements = (Array.isArray(response) ? response : response ? [response] : []) as Settlement[];
    if (selected?.payload?.method === "postAndVerifyBatch") context.settlements = context.settlements.filter(item => same(item.l1TransactionHash, selected.tx.hash));
  } catch (error) {
    context.warnings.push(`Settlement index unavailable: ${message(error)}. Inspect either chain directly or supply the counterpart transaction hash.`);
    return context;
  }
  if (!context.settlements.length) {
    context.warnings.push("No indexed settlement for this block yet. Cross-chain execution may precede settlement; inspect the counterpart hash directly.");
  }
  const targets = new Map<string, DebugChain>();
  for (const settlement of context.settlements) {
    if (settlement.canonicalL2 === false) {
      context.warnings.push(`Settlement ${settlement.l1TransactionHash} references noncanonical L2 blocks.`);
      continue;
    }
    if (sourceBlock.chain === "l2") targets.set(settlement.l1BlockHash, "l1");
    else if (syncOnly) {
      // The protocol settles through its terminal Sync block. Resolve that
      // exact indexed hash, including resumed batches sharing the endpoint.
      const terminal = settlement.l2Blocks.reduce<{ number: string; hash: string } | null>((last, block) =>
        !last || BigInt(block.number) > BigInt(last.number) ? block : last, null);
      if (terminal) targets.set(terminal.hash, "l2");
    } else for (const block of settlement.l2Blocks) targets.set(block.hash, "l2");
  }
  const maxBlocks = 12;
  // Settlement often ends with the synchronous work; start at the newest end,
  // while retaining every indexed hash for explicit pagination.
  const ordered = [...targets.entries()];
  context.remainingBlocks = ordered.slice(0, Math.max(0, ordered.length - maxBlocks)).map(([hash, chain]) => ({ hash, chain }));
  const results = await mapLimited(ordered.slice(-maxBlocks), async ([hash, chain]) => {
    try { return await fetchDebugBlock(chain, hash, rpc); }
    catch (error) { context.warnings.push(`${chain.toUpperCase()} counterpart ${hash}: ${message(error)}`); return null; }
  });
  context.blocks.push(...results.filter((block): block is DebugBlock => block !== null));
  for (const block of context.blocks) for (const tx of block.transactions) {
    tx.events = (tx.receipt?.logs ?? []).map(log => decodeDebugLog(block.chain, log));
  }
  if (!managerAddress("l1") && context.blocks.some(block => block.chain === "l1")) context.warnings.push("L1 registry address is not configured and no batch identified it. Raw receipts and traces are available; set the rollups URL parameter to decode L1 EEZ events.");
  return context;
}

export async function loadMoreDebugBlocks(context: DebugContext, rpc: Rpc = debugRequest): Promise<DebugContext> {
  const remaining = context.remainingBlocks ?? [];
  const next = remaining.slice(-12);
  const warnings = [...context.warnings];
  const blocks = await mapLimited(next, async ({ chain, hash }) => {
    try { return await fetchDebugBlock(chain, hash, rpc); }
    catch (error) { warnings.push(`${chain.toUpperCase()} counterpart ${hash}: ${message(error)}`); return null; }
  });
  const rest = remaining.slice(0, Math.max(0, remaining.length - 12));
  return { ...context, blocks: [...context.blocks, ...blocks.filter((block): block is DebugBlock => !!block)], remainingBlocks: rest, warnings };
}

export async function inspectDebugBlock(chain: DebugChain, selector: string, rpc: Rpc = debugRequest, syncOnly = false): Promise<DebugContext> {
  return withCounterpart(await fetchDebugBlock(chain, selector, rpc), null, rpc, syncOnly);
}

export async function inspectDebugTransaction(hash: string, chain: DebugChain | "auto" = "auto", rpc: Rpc = debugRequest, syncOnly = false): Promise<DebugContext> {
  if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Enter a transaction hash: 0x followed by 64 hexadecimal characters.");
  const chains: DebugChain[] = chain === "auto" ? ["l1", "l2"] : [chain];
  const results = await Promise.allSettled(chains.map(async candidate => ({ chain: candidate,
    tx: await rpc(debugRpc(candidate), "eth_getTransactionByHash", [hash]) as RawTransaction | null })));
  const found = results.flatMap(result => result.status === "fulfilled" && result.value.tx ? [result.value as { chain: DebugChain; tx: RawTransaction }] : []);
  if (found.length > 1) throw new Error("This hash exists on both chains. Select L1 or L2 to inspect it.");
  if (!found.length) {
    const errors = results.flatMap((result, i) => result.status === "rejected" ? [`${chains[i]!.toUpperCase()}: ${message(result.reason)}`] : []);
    throw new Error(`Transaction not found on ${chain === "auto" ? "L1 or L2" : chain.toUpperCase()}.${errors.length ? ` RPC errors: ${errors.join("; ")}` : ""}`);
  }
  const source = found[0]!;
  if (!source.tx.blockHash) {
    const selected = await inspectTransaction(source.chain, source.tx, rpc);
    return { sourceChain: source.chain, sourceBlock: null, selected, blocks: [], settlements: [], warnings: ["Transaction is pending. Refresh after inclusion to inspect execution."] };
  }
  const block = await fetchDebugBlock(source.chain, source.tx.blockHash, rpc);
  const selected = block.transactions.find(tx => same(tx.tx.hash, hash));
  if (!selected) throw new Error("Transaction is missing from its reported block; retry after the chain head stabilizes.");
  return withCounterpart(block, selected, rpc, syncOnly);
}

export type InspectionKind = "transaction" | "block";

/** One lookup for transaction hashes, block hashes, and block numbers.
 * Numeric selectors use L1 unless a chain is selected; hashes search both chains. */
export async function inspectExecution(value: string, chain: DebugChain | "auto" = "auto", kind: InspectionKind | "auto" = "auto", rpc: Rpc = debugRequest): Promise<{ context: DebugContext; kind: InspectionKind }> {
  const query = value.trim();
  if (!/^(latest|\d+|0x[\da-f]+)$/i.test(query)) throw new Error("Enter a transaction hash, block number, block hash, or latest.");
  const hash = /^0x[\da-f]{64}$/i.test(query);
  let transactionError: Error | undefined;
  if (kind === "transaction" || kind === "auto" && hash) {
    try { return { context: await inspectDebugTransaction(query, chain, rpc, true), kind: "transaction" }; }
    catch (error) {
      // Ambiguity, missing receipts, or failed block inspection must remain visible.
      if (kind === "transaction" || !/^Transaction not found on /.test((error as Error).message)) throw error;
      transactionError = error as Error;
    }
  }
  const chains: DebugChain[] = chain === "auto" ? hash ? ["l1", "l2"] : ["l1"] : [chain];
  const results = await Promise.allSettled(chains.map(side => inspectDebugBlock(side, query, rpc, true)));
  const found = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (found.length > 1) throw new Error("This block hash exists on both chains. Select L1 or L2 to inspect it.");
  if (found[0]) return { context: found[0], kind: "block" };
  const errors = results.flatMap((result, i) => result.status === "rejected" ? [`${chains[i]!.toUpperCase()}: ${message(result.reason)}`] : []);
  throw new Error(`${transactionError ? `${transactionError.message} ` : ""}Block lookup failed. ${errors.join("; ")}`);
}

export async function fetchDebugTrace(tx: DebugTransaction, rpc: Rpc = debugRequest): Promise<CallTrace> {
  const trace = await rpc(debugRpc(tx.chain), "debug_traceTransaction", [tx.tx.hash, { tracer: "callTracer", timeout: "20s" }]) as CallTrace | null;
  if (!trace || typeof trace.type !== "string") throw new Error("The RPC did not return a callTracer tree.");
  return trace;
}

export type LiveBatch = {
  transactionHash: string; blockHash: string; blockNumber: string; logIndex: string; registryAddress: string; rollupIds?: unknown;
  l2BlockCount?: number; settlementCheckedAt?: number;
  settlement?: Settlement | null;
  l2Range?: { first: string; last: string }; canonicalL2?: boolean; l2Finalized?: boolean;
};
export type LiveBatchHistory = {
  batches: LiveBatch[]; l1Head: string; l2Head: string | null; before: string | null; warnings: string[]; registryAddress?: string;
};
export const LIVE_BATCH_LIMIT = 50;

export async function inspectPostedBatch(batch: LiveBatch, rpc: Rpc = debugRequest): Promise<DebugContext> {
  // Some L1 nodes retain block bodies and receipts after pruning their hash
  // lookup index. A posting log supplies the exact block and transaction hash.
  const block = await fetchDebugBlock("l1", batch.blockHash, rpc);
  if (!same(block.hash, batch.blockHash) || BigInt(block.number) !== BigInt(batch.blockNumber)) {
    throw new Error("Batch block changed; retrying inspection");
  }
  const selected = block.transactions.find(tx => same(tx.tx.hash, batch.transactionHash));
  if (!selected) throw new Error("Posted transaction is missing from its block; retrying inspection");
  // Reuse only the recent history observation for this exact posting block/tx.
  // Later inspections recheck the mutable settlement index, including reorgs.
  const known = batch.settlement;
  const fresh = Date.now() - (batch.settlementCheckedAt ?? 0) < 5000;
  return withCounterpart(block, selected, rpc, true, fresh && known && same(known.l1BlockHash, block.hash) && same(known.l1TransactionHash, selected.tx.hash) ? known : undefined);
}

// Read compact posting logs, rather than hydrating thousands of L2 blocks on
// every poll. Selecting a post loads its exact receipts and settlement range.
export async function fetchLiveBatchHistory(previous: LiveBatchHistory | null = null, rpc: Rpc = debugRequest, settlementBatch?: string): Promise<LiveBatchHistory> {
  const heads = await Promise.allSettled([rpc(debugRpc("l1"), "eth_blockNumber", []), rpc(debugRpc("l2"), "eth_blockNumber", [])]);
  if (heads[0].status === "rejected") throw new Error(`L1 batch history unavailable: ${message(heads[0].reason)}`);
  const l1Head = heads[0].value as string;
  const head = BigInt(l1Head);
  const l2Head = heads[1].status === "fulfilled" ? heads[1].value as string : previous?.l2Head ?? null;
  const warnings = heads[1].status === "rejected" ? [`L2 RPC: ${message(heads[1].reason)}. L1 batch history remains available.`] : [];
  let registryAddress = previous?.registryAddress || config.rollupsAddress || "";
  const topics = [...new Set(eezL1Abi.filter(item => item.type === "event" && item.name === "BatchPosted").map(item => toEventSelector(item)))];
  const read = async (from: bigint, to: bigint): Promise<LiveBatch[]> => {
    const logs = await rpc(debugRpc("l1"), "eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [topics], ...(registryAddress ? { address: registryAddress } : {}) }]) as (RawLog & { removed?: boolean })[];
    return logs.flatMap(log => {
      const event = decodeProtocolLog("l1", log);
      if (log.removed || event.name !== "BatchPosted" || (registryAddress && !same(registryAddress, log.address))) return [];
      return [{ transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: log.blockNumber, logIndex: log.logIndex, registryAddress: log.address, rollupIds: event.args.rollupIds }];
    });
  };
  const newest = (batches: LiveBatch[]) => [...new Map(batches.map(batch => [batch.transactionHash.toLowerCase(), batch])).values()]
    .sort((a, b) => BigInt(a.blockNumber) === BigInt(b.blockNumber) ? Number(BigInt(b.logIndex) - BigInt(a.logIndex)) : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : 1)
    .slice(0, LIVE_BATCH_LIMIT);
  let batches: LiveBatch[] = [];
  let before: bigint | null;
  if (previous && head >= BigInt(previous.l1Head)) {
    // Re-read a head overlap so removed/replaced posts do not linger after a
    // shallow reorg. Ordinary Chiado blocks leave the older history intact.
    const from = BigInt(previous.l1Head) > 12n ? BigInt(previous.l1Head) - 12n : 0n;
    batches = previous.batches.filter(batch => BigInt(batch.blockNumber) < from);
    for (let to = head; to >= from;) {
      const start = to - from >= 511n ? to - 511n : from;
      batches.push(...await read(start, to));
      to = start - 1n;
    }
    batches = newest(batches);
    before = previous.before === null ? null : BigInt(previous.before);
    // If the overlap previously contained the oldest retained post, refill
    // directly below it rather than skipping posts dropped by the 50-row cap.
    if (batches.length < LIVE_BATCH_LIMIT && previous.batches.length === LIVE_BATCH_LIMIT) {
      const oldest = BigInt(previous.batches[previous.batches.length - 1]!.blockNumber);
      before = from === 0n ? null : oldest < from ? oldest : from - 1n;
    }
  } else before = head;
  // Bound each refresh's backfill work, retaining the cursor for sparse chains.
  for (let page = 0; batches.length < LIVE_BATCH_LIMIT && before !== null && page < 8; page++) {
    const from: bigint = before > 511n ? before - 511n : 0n;
    batches = newest([...batches, ...await read(from, before)]);
    before = from > 0n ? from - 1n : null;
  }
  const checkedAt = Date.now();
  const cached = new Map((previous?.batches ?? []).map(batch => [batch.transactionHash.toLowerCase(), batch]));
  const lookups = new Map<string, Promise<Settlement[]>>();
  let indexError: string | null = null;
  const enrich = async () => {
    batches = batches.map(batch => {
      const old = cached.get(batch.transactionHash.toLowerCase());
      return old && same(old.blockHash, batch.blockHash) ? { ...old, ...batch } : batch;
    });
    if (heads[1].status === "fulfilled") {
      // Without a configured registry, retain index-based discovery before
      // presenting logs as this rollup's history. Scoped loading applies after it.
      const selectedHash = registryAddress ? settlementBatch === "latest" ? batches[0]?.transactionHash : settlementBatch : undefined;
      const missing = batches.filter(batch => (!selectedHash || same(batch.transactionHash, selectedHash)) &&
        (batch.l2BlockCount === undefined || batch.l2Finalized === false) && checkedAt - (batch.settlementCheckedAt ?? 0) >= 30000);
      await mapLimited([...new Set(missing.map(batch => batch.blockHash))], async hash => {
        if (!indexError) {
          try {
            let lookup = lookups.get(hash);
            if (!lookup) {
              lookup = rpc(config.l2ProxyRpc, "eez_getSettledL2RangesByL1Block", [hash]).then(value => (value ?? []) as Settlement[]);
              lookups.set(hash, lookup);
            }
            const settlements = await lookup;
            for (const batch of missing.filter(item => same(item.blockHash, hash))) {
              const settlement = settlements.find(item => same(item.l1TransactionHash, batch.transactionHash));
              batch.settlement = settlement ?? null;
              if (settlement) {
                batch.l2Range = settlementRange(settlement);
                batch.canonicalL2 = settlement.canonicalL2;
                batch.l2Finalized = settlement.l2Finalized;
                batch.l2BlockCount = settlement.canonicalL2 === false ? undefined : settlement.l2Blocks.length;
              } else {
                batch.l2Range = undefined; batch.canonicalL2 = undefined;
                batch.l2Finalized = undefined; batch.l2BlockCount = undefined;
              }
            }
          } catch (error) { indexError ??= message(error); }
        }
        for (const batch of missing.filter(item => same(item.blockHash, hash))) {
          batch.settlementCheckedAt = checkedAt;
          if (indexError) batch.settlement = undefined;
        }
      });
    }
    for (const batch of batches) cached.set(batch.transactionHash.toLowerCase(), batch);
  };
  await enrich();
  if (!registryAddress) {
    // A matching canonical record identifies the registry followed by this
    // L2 node. A shared event signature alone can include other deployments.
    const indexed = batches.find(batch => batch.l2BlockCount !== undefined);
    if (indexed) {
      registryAddress = indexed.registryAddress;
      batches = batches.filter(batch => same(batch.registryAddress, registryAddress));
      // Refill from the head with the address filter: truncating the mixed
      // 50-row window may have discarded valid posts in already-read blocks.
      before = head;
      for (let page = 0; batches.length < LIVE_BATCH_LIMIT && before !== null && page < 8; page++) {
        const from: bigint = before > 511n ? before - 511n : 0n;
        batches = newest([...batches, ...await read(from, before)]);
        before = from > 0n ? from - 1n : null;
      }
      await enrich();
    }
  }
  if (indexError) warnings.push(`Batch block counts unavailable: ${indexError}. Batch history remains available.`);
  return { batches, l1Head, l2Head, before: before === null ? null : toHex(before), warnings, registryAddress: registryAddress || undefined };
}
