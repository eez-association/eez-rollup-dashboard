import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLiveBatchHistory, fetchDebugTrace, inspectDebugTransaction, inspectPostedBatch, inspectExecution,
  jsonDebug, loadMoreDebugBlocks, quantity, relatedTransactions, settlementRange, transactionHashes,
  type CallTrace, type DebugChain, type DebugContext, type DebugTransaction, type LiveBatch, type LiveBatchHistory, type InspectionKind,
} from "../../lib/executionDebugger";
import { ExplorerLink } from "../ExplorerLink";
import { rpcCall } from "../../rpc";
import { contextTransactions, inspectionHash, isEezTransaction, summarizeBatch, txKey, type BatchExecutionSummary } from "../../lib/executionAnalysis";
import { ExecutionInspector, inspectorTab, type InspectorTab } from "./ExecutionInspector";
import { SettlementProgress } from "./SettlementProgress";
import styles from "./ExecutionDebugger.module.css";

type Mode = "inspect" | "live";
export interface DebuggerProps {
  onBack: () => void;
  initialDebugHash?: string | null;
  initialMode?: string | null;
  initialChain?: string | null;
  initialBlock?: string | null;
  initialCounterpart?: string | null;
  initialBatch?: string | null;
  initialSelected?: string | null;
  initialSelectedChain?: string | null;
  initialEvent?: string | null;
  initialTab?: string | null;
  initialCall?: string | null;
}
const short = (value: string) => value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
const batchVersion = (batch: LiveBatch) => `${batch.blockHash}:${batch.l2Range?.first ?? ""}:${batch.l2Range?.last ?? ""}:${batch.canonicalL2 ?? ""}`;
const status = (tx: DebugTransaction) => !tx.receipt ? tx.tx.blockHash ? "Receipt unavailable" : "Pending" : tx.receipt.status === "0x1" ? "Success" : "Reverted";

export function ExecutionDebugger({ onBack, initialDebugHash, initialMode, initialChain, initialBlock, initialCounterpart, initialBatch, initialSelected, initialSelectedChain, initialEvent, initialTab, initialCall }: DebuggerProps) {
  const [mode, setMode] = useState<Mode>(initialDebugHash || initialBlock || ["debug", "explorer", "inspect"].includes(initialMode ?? "") ? "inspect" : "live");
  const [chain, setChain] = useState<DebugChain | "auto">(initialChain === "l1" || initialChain === "l2" ? initialChain : initialMode === "explorer" ? "l1" : "auto");
  const [query, setQuery] = useState(initialDebugHash ?? initialBlock ?? "");
  const [counterpart, setCounterpart] = useState(initialCounterpart ?? "");
  const [moreLoading, setMoreLoading] = useState(false);
  const [context, setContext] = useState<DebugContext | null>(null);
  const [selected, setSelected] = useState<DebugTransaction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [history, setHistory] = useState<LiveBatchHistory | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const historyRef = useRef<LiveBatchHistory | null>(null);
  const liveSelection = useRef<string | null>(initialBatch ?? null);
  const initialLiveBatch = useRef(initialBatch && !initialDebugHash && !initialBlock && !["debug", "explorer", "inspect"].includes(initialMode ?? "") ? initialBatch : null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [traces, setTraces] = useState<Record<string, CallTrace>>({});
  const traceRequests = useRef(new Map<string, Promise<CallTrace>>());
  const contextCache = useRef(new Map<string, DebugContext>());
  const [summaries, setSummaries] = useState<Record<string, BatchExecutionSummary>>({});
  const [batchSearch, setBatchSearch] = useState("");
  const [settlementFilter, setSettlementFilter] = useState("all");
  const [executionFilter, setExecutionFilter] = useState("all");
  const [collapsed, setCollapsed] = useState(false);
  const [entryLoading, setEntryLoading] = useState(false);
  const [inspectAll, setInspectAll] = useState(false);
  const allEntries = inspectAll || !!batchSearch.trim() || ["crosschain", "failed", "skipped"].includes(executionFilter);
  const allSettlements = allEntries || settlementFilter !== "all";
  const summariesRef = useRef<Record<string, BatchExecutionSummary>>({});
  const summaryVersions = useRef(new Map<string, string>());
  const batchRequests = useRef(new Map<string, Promise<DebugContext>>());
  const entryLoader = useRef({ enabled: false, running: false, active: new Set<string>(), retryAt: new Map<string, number>() });
  const [tab, setTab] = useState<InspectorTab>(inspectorTab(initialTab));
  const [flowDetailAction, setFlowDetailAction] = useState<string | null>(null);
  const [step, setStep] = useState(Math.max(0, Number(initialEvent) || 0));
  const steps = useRef(new Map<string, number>());
  const [focused, setFocused] = useState<string | null>(initialCall ?? null);
  const [shareStatus, setShareStatus] = useState("");
  const [source, setSource] = useState<{ chain: string; value: string; counterpart: string; kind: InspectionKind }>({ chain: initialChain ?? "auto", value: initialDebugHash ?? initialBlock ?? initialBatch ?? "", counterpart: initialCounterpart ?? "", kind: initialBlock ? "block" : "transaction" });
  const restore = useRef(true);
  const alive = useRef(true);
  const remember = useCallback((hash: string, result: DebugContext) => {
    const key = hash.toLowerCase();
    if (result.blocks.every(block => block.transactions.every(tx => !!tx.receipt)) && result.settlements.some(item => item.canonicalL2 !== false && item.l2Blocks.some(block => result.blocks.some(loaded => loaded.chain === "l2" && loaded.hash === block.hash)))) {
      contextCache.current.delete(key); contextCache.current.set(key, result);
      if (contextCache.current.size > 50) contextCache.current.delete(contextCache.current.keys().next().value!);
    }
    const batch = historyRef.current?.batches.find(item => item.transactionHash.toLowerCase() === key);
    const settlement = result.settlements.find(item => item.l1TransactionHash.toLowerCase() === key);
    if (batch) summaryVersions.current.set(key, batchVersion(settlement
      ? { ...batch, l2Range: settlementRange(settlement), canonicalL2: settlement.canonicalL2 } : batch));
    summariesRef.current = { ...summariesRef.current, [key]: summarizeBatch(result) };
    setSummaries(summariesRef.current);
  }, []);
  const inspectLiveBatch = useCallback(async (hash: string) => {
    const key = hash.toLowerCase();
    const cached = contextCache.current.get(key);
    if (cached) return cached;
    let pending = batchRequests.current.get(key);
    if (!pending) {
      const batch = historyRef.current?.batches.find(item => item.transactionHash.toLowerCase() === key);
      pending = batch ? inspectPostedBatch(batch) : inspectDebugTransaction(hash, "l1", undefined, true);
      batchRequests.current.set(key, pending);
    }
    try { return await pending; }
    finally { if (batchRequests.current.get(key) === pending) batchRequests.current.delete(key); }
  }, []);
  const loadEntries = useCallback(async () => {
    const loader = entryLoader.current;
    if (loader.running || !loader.enabled || !historyRef.current?.batches.length) return;
    loader.running = true; setEntryLoading(true);
    // Read the latest history between jobs; live polls can add or replace
    // batches without restarting either worker or changing the selection.
    const worker = async () => {
      while (loader.enabled && alive.current) {
        const batch = historyRef.current?.batches.find(item => {
          const key = item.transactionHash.toLowerCase();
          return !loader.active.has(key) && summariesRef.current[key]?.state !== "Inspected" && Date.now() >= (loader.retryAt.get(key) ?? 0);
        });
        if (!batch) return;
        const key = batch.transactionHash.toLowerCase(), version = batchVersion(batch);
        loader.active.add(key);
        const current = () => alive.current && historyRef.current?.batches.some(item => item.transactionHash.toLowerCase() === key && batchVersion(item) === version);
        try {
          const result = await inspectLiveBatch(batch.transactionHash);
          if (current() && (!result.selected?.receipt || result.sourceBlock?.hash !== batch.blockHash)) throw new Error("Batch receipt unavailable or block changed; retrying inspection");
          if (current()) { remember(key, result); loader.retryAt.delete(key); }
        } catch (err) {
          if (current()) {
            loader.retryAt.set(key, Date.now() + 30000); summaryVersions.current.set(key, version);
            summariesRef.current = { ...summariesRef.current, [key]: { state: "Unavailable", search: "", failures: 0, skipped: 0, crossChain: false, entries: 0, error: (err as Error).message } };
            setSummaries(summariesRef.current);
          }
        } finally { loader.active.delete(key); }
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally { loader.running = false; if (alive.current) setEntryLoading(false); }
  }, [inspectLiveBatch, remember]);
  useEffect(() => {
    entryLoader.current.enabled = mode === "live" && live && allEntries;
    if (entryLoader.current.enabled && history) void loadEntries();
    return () => { entryLoader.current.enabled = false; };
  }, [mode, live, history, allEntries, loadEntries]);
  const loadTrace = useCallback(async (tx: DebugTransaction) => {
    const key = txKey(tx);
    let pending = traceRequests.current.get(key);
    if (!pending) {
      pending = fetchDebugTrace(tx).catch(err => { traceRequests.current.delete(key); throw err; });
      traceRequests.current.set(key, pending);
      if (traceRequests.current.size > 200) traceRequests.current.delete(traceRequests.current.keys().next().value!);
    }
    const trace = await pending;
    if (alive.current) setTraces(old => {
      if (old[key] === trace) return old;
      const next = { ...old, [key]: trace }; const keys = Object.keys(next);
      if (keys.length > 200) delete next[keys[0]!]; return next;
    });
    return trace;
  }, []);
  const chooseTransaction = (tx: DebugTransaction, event?: number, hash?: string) => {
    if (event === undefined) setFlowDetailAction(null);
    if (selected) steps.current.set(txKey(selected), step);
    const nextStep = event ?? steps.current.get(txKey(tx)) ?? 0;
    steps.current.set(txKey(tx), nextStep); setSelected(tx); setStep(nextStep);
    if (hash) setFocused(hash);
    if (event !== undefined) setTab(current => current === "flow" ? "flow" : "timeline");
  };
  const request = useRef(0);
  const load = useCallback(async (kind: InspectionKind | "auto", nextChain: DebugChain | "auto", value: string, compare = "", fromLive = false) => {
    const id = ++request.current;
    setLoading(true); setError(null); setContext(null); setSelected(null); setFlowDetailAction(null);
    try {
      let result: DebugContext;
      let resolvedKind: InspectionKind = "transaction";
      if (fromLive) result = await inspectLiveBatch(value.trim());
      else {
        const lookup = await inspectExecution(value, nextChain, kind);
        result = lookup.context; resolvedKind = lookup.kind;
      }
      if (compare.trim()) {
        try {
          const other = await inspectDebugTransaction(compare.trim(), "auto", undefined, true);
          const existing = new Set(result.blocks.map(block => `${block.chain}:${block.hash}`));
          result.blocks.push(...other.blocks.filter(block => !existing.has(`${block.chain}:${block.hash}`)));
          result.remainingBlocks = [...(result.remainingBlocks ?? []), ...(other.remainingBlocks ?? [])].filter((block, i, all) =>
            !result.blocks.some(loaded => loaded.chain === block.chain && loaded.hash === block.hash) && all.findIndex(item => item.chain === block.chain && item.hash === block.hash) === i);
          result.warnings.push(...other.warnings);
          if (!other.sourceBlock) result.warnings.push("Supplied counterpart transaction is pending; retry after inclusion.");
        } catch (error) { result.warnings.push(`Counterpart lookup failed: ${(error as Error).message}`); }
      }
      if (id !== request.current) return;
      if (fromLive) remember(value, result);
      let chosen = result.selected ?? contextTransactions(result).find(isEezTransaction) ?? null;
      if (restore.current && initialSelected) chosen = contextTransactions(result).find(tx => tx.tx.hash.toLowerCase() === initialSelected.toLowerCase() && (!initialSelectedChain || tx.chain === initialSelectedChain)) ?? chosen;
      setContext(result); setSelected(chosen); setError(null);
      setStep(restore.current ? Math.min(Math.max(0, Number(initialEvent) || 0), Math.max(0, (chosen?.events.filter(event => event.protocol).length ?? 0) - 1)) : chosen ? steps.current.get(txKey(chosen)) ?? 0 : 0);
      if (!restore.current) setFocused(null);
      restore.current = false;
      if (!fromLive) setSource({ chain: result.sourceChain, value: value.trim(), counterpart: compare.trim(), kind: resolvedKind });
    } catch (err) { if (id === request.current) setError((err as Error).message); }
    finally { if (id === request.current) setLoading(false); }
  }, [remember, inspectLiveBatch, initialSelected, initialSelectedChain, initialEvent]);
  useEffect(() => {
    if (initialDebugHash) {
      setMode("inspect"); setQuery(initialDebugHash);
      const side = initialChain === "l1" || initialChain === "l2" ? initialChain : "auto";
      setChain(side); void load("transaction", side, initialDebugHash, initialCounterpart ?? "");
    } else if (initialBatch) {
      // Live links wait for posting logs so a pruned transaction-hash index
      // does not prevent inspection of a retained block and receipt.
      if (!initialLiveBatch.current) void load("transaction", "l1", initialBatch, "", true);
    } else if (initialBlock) {
      const side = initialChain === "l2" ? "l2" : "l1";
      setMode("inspect"); setQuery(initialBlock); setChain(side); void load("block", side, initialBlock, initialCounterpart ?? "");
    }
  }, [initialDebugHash, initialBlock, initialChain, initialCounterpart, initialBatch, load]);
  useEffect(() => {
    if (mode !== "live") return;
    if (!live) { setLiveLoading(false); return; }
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!historyRef.current) setLiveLoading(true);
      try {
        const result = await fetchLiveBatchHistory(historyRef.current,
          (url, method, params) => rpcCall(url, method, params, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])),
          allSettlements ? undefined : liveSelection.current ?? "latest");
        if (stopped) return;
        historyRef.current = result; setHistory(result);
        const retained = new Set(result.batches.map(batch => batch.transactionHash.toLowerCase()));
        summariesRef.current = Object.fromEntries(Object.entries(summariesRef.current).filter(([hash]) => {
          const batch = result.batches.find(item => item.transactionHash.toLowerCase() === hash);
          return retained.has(hash) && batch && (!summaryVersions.current.has(hash) || summaryVersions.current.get(hash) === batchVersion(batch));
        }));
        setSummaries(summariesRef.current);
        for (const [key, version] of summaryVersions.current) {
          const batch = result.batches.find(item => item.transactionHash.toLowerCase() === key);
          if (!batch || version !== batchVersion(batch)) { summaryVersions.current.delete(key); entryLoader.current.retryAt.delete(key); }
        }
        for (const [hash, cached] of contextCache.current) {
          const batch = result.batches.find(item => item.transactionHash.toLowerCase() === hash);
          const range = cached.settlements[0] ? settlementRange(cached.settlements[0]) : undefined;
          if (!batch || batch.canonicalL2 === false || cached.sourceBlock?.hash !== batch.blockHash || range?.last !== batch.l2Range?.last || range?.first !== batch.l2Range?.first) contextCache.current.delete(hash);
        } setUpdated(new Date()); setLiveError(null);
        if (initialLiveBatch.current) {
          const hash = initialLiveBatch.current; initialLiveBatch.current = null;
          void load("transaction", "l1", hash, "", true);
        } else if (!liveSelection.current && result.batches.length) {
          liveSelection.current = result.batches[0]!.transactionHash;
          void load("transaction", "l1", liveSelection.current, "", true);
        }
      } catch (err) { if (!stopped) setLiveError((err as Error).message); }
      finally { if (!stopped) setLiveLoading(false); }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [mode, live, load, allSettlements]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; entryLoader.current.enabled = false; }; }, []);
  useEffect(() => {
    if (mode !== "inspect" || source.kind !== "transaction" || !/^0x[\da-f]{64}$/i.test(source.value)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const id = request.current;
      try {
        const side = source.chain === "l1" || source.chain === "l2" ? source.chain : "auto";
        const result = await inspectDebugTransaction(source.value, side, undefined, true);
        if (source.counterpart) {
          const other = await inspectDebugTransaction(source.counterpart, "auto", undefined, true);
          result.blocks.push(...other.blocks.filter(block => !result.blocks.some(existing => existing.chain === block.chain && existing.hash === block.hash)));
        }
        if (!stopped && id === request.current) {
          setContext(result);
          setSelected(previous => previous ? contextTransactions(result).find(tx => txKey(tx) === txKey(previous)) ?? result.selected : result.selected);
        }
      } catch { /* The settlement panel reports unavailable evidence while preserving the inspection. */ }
      if (!stopped) timer = setTimeout(refresh, 10000);
    };
    timer = setTimeout(refresh, 10000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [mode, source]);
  useEffect(() => {
    if (loading || !context) return;
    window.history.replaceState(null, "", inspectionHash({ mode, kind: source.kind, chain: source.chain, source: source.value, counterpart: source.counterpart, batch: liveSelection.current, selected, event: step, tab, call: focused }));
  }, [mode, source, selected, step, tab, focused, loading, context]);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setShareStatus("Link copied"); }
    catch { setShareStatus("Copy the inspection link from your browser address bar."); }
    setTimeout(() => { if (alive.current) setShareStatus(""); }, 5000);
  };
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    initialLiveBatch.current = null;
    liveSelection.current = null; request.current++; entryLoader.current.enabled = false; setSource({ chain: "auto", value: "", counterpart: "", kind: "transaction" }); setFocused(null); setStep(0); setMode(next); setChain("auto"); setError(null); setLoading(false); setContext(null); setSelected(null); setQuery(""); setCounterpart("");
    window.history.replaceState(null, "", `#/visualizer?mode=${next}`);
  };
  const loadLatestBatch = async () => {
    const id = ++request.current;
    setLoading(true); setError(null); setContext(null); setSelected(null);
    try {
      const recent = await fetchLiveBatchHistory();
      if (id !== request.current) return;
      historyRef.current = recent; setHistory(recent);
      const batch = recent.batches[0];
      if (!batch) throw new Error("No EEZ batch found in the recent history window. Inspect a transaction hash or a specific block instead.");
      contextCache.current.delete(batch.transactionHash.toLowerCase());
      batchRequests.current.delete(batch.transactionHash.toLowerCase());
      liveSelection.current = null;
      setSource({ chain: "l1", value: batch.transactionHash, counterpart: "", kind: "transaction" });
      setMode("inspect"); setChain("l1"); setQuery(batch.transactionHash); setCounterpart("");
      await load("transaction", "l1", batch.transactionHash, "", true);
    } catch (error) { if (id === request.current) { setError((error as Error).message); setLoading(false); } }
  };
  const inspectSearch = () => {
    if (batchSearch.trim().toLowerCase() === "latest") { void loadLatestBatch(); return; }
    setMode("inspect"); setChain("auto"); setQuery(batchSearch.trim());
    void load("auto", "auto", batchSearch.trim());
  };
  const exportData = () => {
    const blob = new Blob([jsonDebug({ history: mode === "live" ? history : undefined, context, selected, traces })], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `eez-execution-${selected?.tx.hash ?? context?.sourceBlock?.number ?? "live"}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const loadEarlier = async () => {
    if (!context) return;
    const id = request.current;
    setMoreLoading(true);
    try { const result = await loadMoreDebugBlocks(context); if (id === request.current) setContext(result); }
    finally { setMoreLoading(false); }
  };
  const related = context && selected ? relatedTransactions({ ...context, selected }) : [];
  const hashes = focused ? new Set([focused]) : selected ? transactionHashes(selected) : new Set<string>();
  const filteredBatches = history?.batches.filter(batch => {
    const summary = summaries[batch.transactionHash.toLowerCase()];
    const search = batchSearch.trim().toLowerCase();
    const metadata = `${batch.transactionHash} ${batch.blockHash} ${BigInt(batch.blockNumber)} ${quantity(batch.blockNumber)} ${batch.registryAddress} ${batch.l2Range ? `${BigInt(batch.l2Range.first)} ${BigInt(batch.l2Range.last)}` : ""}`.toLowerCase();
    const searchedBlock = /^\d+$/.test(search) ? BigInt(search) : null;
    const inRange = searchedBlock !== null && batch.l2Range && searchedBlock >= BigInt(batch.l2Range.first) && searchedBlock <= BigInt(batch.l2Range.last);
    if (search && !inRange && !metadata.includes(search) && !summary?.search.includes(search)) return false;
    const settlement = batch.canonicalL2 === false ? "noncanonical" : batch.l2BlockCount === undefined ? batch.settlement === null ? "awaiting" : "unloaded" : batch.l2Finalized ? "finalized" : "indexed";
    if (settlementFilter !== "all" && settlementFilter !== settlement) return false;
    return executionFilter === "all" || executionFilter === "uninspected" && !summary || executionFilter === "unavailable" && summary?.state === "Unavailable" || summary?.state === "Inspected" && (executionFilter === "crosschain" && summary.crossChain || executionFilter === "failed" && summary.failures > 0 || executionFilter === "skipped" && summary.skipped > 0);
  });
  const coverage = history?.batches.filter(batch => summaries[batch.transactionHash.toLowerCase()]?.state === "Inspected").length ?? 0;
  return <main id="main" tabIndex={-1} className={styles.page}>
    <div className={styles.intro}><button className="btn btn-sm btn-outline" onClick={onBack}>← Dashboard</button>
      <p className="eez-eyebrow">[ EXECUTION VISUALIZER ]</p><h1 className="eez-page-heading"><strong>Follow execution.</strong> On both chains.</h1>
      <p className="eez-description">Inspect transactions, nested calls, and settlement with recorded L1 and L2 evidence.</p></div>
    <nav className={styles.tabs} aria-label="Visualizer modes">{(["live", "inspect"] as const).map(item => <button key={item} className={`${styles.tab} ${mode === item ? styles.activeTab : ""}`} aria-current={mode === item ? "page" : undefined} onClick={() => switchMode(item)}>{item === "live" ? "Live" : "Inspect"}</button>)}<a className={styles.tab} href="#/visualizer?mode=trace">Trace</a></nav>
    {mode !== "live" ? <form className={styles.search} aria-label="Inspect execution" onSubmit={event => { event.preventDefault(); if (query.trim().toLowerCase() === "latest") void loadLatestBatch(); else void load("auto", chain, query, counterpart); }}>
      <label>Chain<select aria-label="Chain" value={chain} onChange={event => setChain(event.target.value as DebugChain | "auto")}>
        <option value="auto">Auto detect</option><option value="l1">L1</option><option value="l2">L2</option></select></label>
      <label className={styles.query}>Transaction hash or block<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Transaction hash, block number or hash, or latest" spellCheck={false} required /></label>
      <button className="btn btn-solid" type="submit" disabled={loading}>{loading ? "Inspecting…" : "Inspect"}</button>
      <button className="btn btn-outline" type="button" disabled={loading} onClick={() => void loadLatestBatch()}>Latest EEZ batch</button>
      <button className="btn btn-outline" type="button" disabled={loading} onClick={() => { setQuery("latest"); void load("block", chain, "latest", counterpart); }}>Latest block</button>
      <details className={styles.compare}><summary>Counterpart transaction (optional)</summary><label>Counterpart hash<input value={counterpart} onChange={event => setCounterpart(event.target.value)} placeholder="Inspect both sides before settlement" spellCheck={false} /></label></details>
      <p className={styles.muted}>“latest” opens the newest EEZ batch. Hashes are detected on either chain. Block numbers and Latest block use L1 unless you select L2.</p>
    </form> : <div className={styles.liveBar}><span className={styles.liveDot} />Latest 50 posted batches<button className="btn btn-sm btn-outline" onClick={() => setLive(!live)}>{live ? "Pause" : "Resume"}</button><span className={styles.muted}>{updated ? `Updated ${updated.toLocaleTimeString()}` : "Connecting…"}</span></div>}
    {mode === "live" && <section className={styles.batchHistory} aria-label="Posted batch history">
      <div className={styles.cardHeader}><h2>Latest Posted Batches</h2><button className="btn btn-sm btn-outline" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "Expand batches" : "Collapse batches"}</button><span className={styles.muted}>{history && `L1 #${quantity(history.l1Head)} · L2 #${quantity(history.l2Head)}`}</span></div>
      <p className={styles.muted}>Newest first. Select a batch to follow its execution on both chains.</p>
      {liveLoading && <p className={styles.muted} role="status">Loading recent batch history…</p>}
      {history?.warnings.map(warning => <p key={warning} className={styles.warning}>{warning}</p>)}
      {!collapsed && <><div className={styles.batchTools}>
        <label>Search batches<input aria-label="Search batches" value={batchSearch} onChange={event => setBatchSearch(event.target.value)} placeholder="TX, block, contract, or call hash" spellCheck={false} /></label>
        <label>Settlement<select aria-label="Settlement filter" value={settlementFilter} onChange={event => setSettlementFilter(event.target.value)}><option value="all">All settlement states</option><option value="indexed">Indexed</option><option value="finalized">Finalized</option><option value="awaiting">Awaiting settlement</option><option value="noncanonical">Noncanonical</option></select></label>
        <label>Execution<select aria-label="Execution filter" value={executionFilter} onChange={event => setExecutionFilter(event.target.value)}><option value="all">All executions</option><option value="crosschain">Cross-chain calls observed</option><option value="failed">Reverted transactions</option><option value="skipped">Skipped entries</option><option value="uninspected">Entries pending</option><option value="unavailable">Inspection unavailable</option></select></label>
        {!allEntries && coverage < (history?.batches.length ?? 0) && <button className="btn btn-sm btn-outline" disabled={!live} onClick={() => setInspectAll(true)}>Load all details</button>}
        {Object.values(summaries).some(summary => summary.state === "Unavailable") && <button className="btn btn-sm btn-outline" disabled={!live} onClick={() => { entryLoader.current.retryAt.clear(); setInspectAll(true); void loadEntries(); }}>Retry unavailable batches</button>}
      </div><p className={styles.muted} role="status">Showing {filteredBatches?.length ?? 0} / {history?.batches.length ?? 0} batches · execution details loaded for {coverage} / {history?.batches.length ?? 0}.{!live ? " Live updates paused." : entryLoading ? " Loading entry details…" : coverage < (history?.batches.length ?? 0) ? allEntries ? " Pending entry details retry automatically." : " Select a batch to load its details. Search and execution filters load all details." : " Entry details up to date."}</p>
      <div className={styles.batchList}>
      {!liveLoading && filteredBatches?.length === 0 && <div className={styles.empty}><p>{history?.batches.length ? "No batches match these filters." : "No EEZ batches found in the recent history window."}</p>
        {!!batchSearch.trim() && /^(latest|\d+|0x[\da-f]+)$/i.test(batchSearch.trim()) && <button className="btn btn-outline" disabled={loading} onClick={inspectSearch}>Inspect ‘{batchSearch.trim()}’ →</button>}
        {!!history?.batches.length && <button className="btn btn-outline" onClick={() => { setBatchSearch(""); setSettlementFilter("all"); setExecutionFilter("all"); }}>Clear filters</button>}
      </div>}
      {filteredBatches?.map(batch => {
        const settlement = context?.settlements.find(item => item.l1TransactionHash.toLowerCase() === batch.transactionHash.toLowerCase());
        const blocks = settlement?.canonicalL2 === false ? undefined : settlement?.l2Blocks;
        const count = blocks?.length ?? batch.l2BlockCount;
        const range = settlement ? settlementRange(settlement) : batch.l2Range;
        const canonical = settlement?.canonicalL2 === false || batch.canonicalL2 === false ? false : settlement?.canonicalL2 ?? batch.canonicalL2;
        const finalized = settlement?.l2Finalized || batch.l2Finalized;
        const loaded = blocks && context ? context.blocks.filter(block => block.chain === "l2" && blocks.some(item => item.hash === block.hash)).length : null;
        const summary = summaries[batch.transactionHash.toLowerCase()];
        return <div key={batch.transactionHash}
          className={`${styles.batchRow} ${liveSelection.current === batch.transactionHash ? styles.selectedTx : ""}`}>
          <button className={styles.batchSelect} aria-label={`Inspect batch ${batch.transactionHash}`} aria-pressed={liveSelection.current === batch.transactionHash} onClick={() => {
            if (liveSelection.current === batch.transactionHash && context) return;
            liveSelection.current = batch.transactionHash; void load("transaction", "l1", batch.transactionHash, "", true);
          }} />
          <div className={styles.batchSummary}>
            <ExplorerLink value={BigInt(batch.blockNumber).toString()} type="block" chain="l1" label={`L1 #${quantity(batch.blockNumber)}`} className={styles.batchBlock} />
            <span>postAndVerifyBatch</span>
            <span>{count === undefined ? batch.settlement === null ? "Awaiting L2 settlement" : "Select to load settlement" : loaded !== null && context?.syncOnly ? `${quantity(count)} L2 block${BigInt(count) === 1n ? "" : "s"} · sync block loaded` : loaded !== null ? `L2 blocks: ${quantity(loaded)} / ${quantity(count)} loaded` : `${quantity(count)} L2 block${BigInt(count) === 1n ? "" : "s"}`}</span>
          </div>
          <div className={styles.batchSettlement}>
            <span className={styles.batchRange}>{range ? <>L2 <ExplorerLink value={BigInt(range.first).toString()} type="block" chain="l2" label={`#${quantity(range.first)}`} />
              {BigInt(range.last) !== BigInt(range.first) && <> – <ExplorerLink value={BigInt(range.last).toString()} type="block" chain="l2" label={`#${quantity(range.last)}`} /></>}</> : count === 0 ? "No L2 blocks" : "L2 range pending"}</span>
            <span className={canonical === false ? styles.failed : styles.muted}>{canonical === false ? "Noncanonical" : count === undefined ? batch.settlement === null ? "Awaiting settlement" : "Not loaded" : finalized ? "Finalized" : "Indexed"}</span>
          </div>
          <div className={styles.batchMeta}><ExplorerLink value={batch.transactionHash} type="tx" chain="l1" label={short(batch.transactionHash)} />
            <span>{batch.rollupIds ? `Rollups ${String(batch.rollupIds)}` : "BatchPosted"}</span><span title={summary?.error}>{!summary ? live && allEntries ? "Loading entries…" : "Entries not loaded" : summary.state === "Unavailable" ? "Inspection unavailable" : `${summary.entries} ${summary.entries === 1 ? "entry" : "entries"} · ${summary.failures} reverted txs · ${summary.skipped} skipped`}</span></div>
        </div>;
      })}</div>{history?.batches.length && !filteredBatches?.length ? <p className={styles.muted}>No batches match these filters.{coverage < (history?.batches.length ?? 0) && " Execution results update as entry details load."}</p> : null}</>}
      {history && !history.batches.length && <p className={styles.muted}>{history.before ? "No posts in the scanned blocks yet; continuing to search earlier history." : "No posted batches found."}</p>}
    </section>}
    {mode === "live" && liveError && <p className={styles.error} role="alert">{liveError}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}{loading && <p className={styles.muted} role="status">Fetching blocks, receipts, and cross-chain settlement…</p>}
    {context && <>
      {(context.selected ?? selected) && <SettlementProgress transaction={(context.selected ?? selected)!} onCounterpart={hash => { void load(source.kind, source.chain === "l1" || source.chain === "l2" ? source.chain : "auto", source.value, hash); }} />}
      <div className={styles.workspaceHeader}><div><strong>{mode === "live" ? "Selected batch" : "Inspection"}</strong> <code>{short(context.selected?.tx.hash ?? context.sourceBlock?.hash ?? "pending")}</code>{focused && <p className={styles.muted}>Call hash: {short(focused)} <button className="btn btn-sm btn-outline" onClick={() => setFocused(null)}>Clear focus</button></p>}</div><div className={styles.buttons}><button className="btn btn-sm btn-outline" onClick={() => void share()}>Copy inspection link</button><button className="btn btn-sm btn-outline" onClick={exportData}>Export JSON</button></div>{shareStatus && <span role="status" className={styles.muted}>{shareStatus}</span>}</div>
      {context.warnings.map((warning, i) => <p className={styles.warning} key={i}>{warning}</p>)}
      {mode !== "live" && !!context.settlements.length && <section className={styles.settlements} aria-label="Settlement links"><h2>Settlement links</h2>{context.settlements.map(item => {
        const blocks = [...item.l2Blocks].sort((a, b) => BigInt(a.number) < BigInt(b.number) ? -1 : BigInt(a.number) > BigInt(b.number) ? 1 : 0);
        const first = blocks[0], last = blocks[blocks.length - 1];
        return <div key={item.l1TransactionHash}>
        <ExplorerLink value={BigInt(item.l1BlockNumber).toString()} type="block" chain="l1" label={`L1 #${quantity(item.l1BlockNumber)}`} />
        <span>→</span><span>L2 {first ? <><ExplorerLink value={BigInt(first.number).toString()} type="block" chain="l2" label={`#${quantity(first.number)}`} />
          {last && last.number !== first.number && <> – <ExplorerLink value={BigInt(last.number).toString()} type="block" chain="l2" label={`#${quantity(last.number)}`} /></>}</> : "No indexed blocks"}</span>
        <ExplorerLink value={item.l1TransactionHash} type="tx" chain="l1" short /><span>{item.canonicalL2 === false ? "Noncanonical" : item.l2Finalized ? "Finalized" : "Indexed"}</span>
      </div>;
      })}<p className={styles.muted}>Settlement links blocks. Candidates share call hashes; repeated calls can produce the same hash.</p></section>}
      <div className={styles.workspace}><aside className={styles.chainNavigation}><div className={styles.lanes}>{(["l1", "l2"] as const).map(side => <section className={styles.lane} key={side} data-chain={side}>
        <div className={styles.laneHeader}><h2>{side.toUpperCase()}</h2><span>{context.blocks.filter(block => block.chain === side).length} {side === "l2" && context.syncOnly ? context.blocks.filter(block => block.chain === side).length === 1 ? "sync block" : "sync blocks" : context.blocks.filter(block => block.chain === side).length === 1 ? "block" : "blocks"}</span></div>
        {context.blocks.filter(block => block.chain === side).map(block => {
          const transactions = block.transactions.filter(isEezTransaction);
          const gas = transactions.every(tx => tx.receipt) ? transactions.reduce((total, tx) => total + BigInt(tx.receipt!.gasUsed), 0n) : null;
          return <div className={styles.block} key={block.hash}>
          <div className={styles.cardHeader}><ExplorerLink value={BigInt(block.number).toString()} chain={side} type="block" label={`Block #${quantity(block.number)}`} short={false} /><span className={styles.muted}>{transactions.length} EEZ tx{transactions.length === 1 ? "" : "s"} · {gas === null ? "Gas unavailable" : `${quantity(gas)} gas`}</span></div>
          <code className={styles.blockHash}>{block.hash}</code>
          {transactions.map(tx => {
            const matched = [...transactionHashes(tx)].some(hash => hashes.has(hash));
            return <button key={tx.tx.hash} className={`${styles.txRow} ${selected?.chain === side && selected.tx.hash === tx.tx.hash ? styles.selectedTx : matched ? styles.matchedTx : ""}`} onClick={() => chooseTransaction(tx)}>
              <div><code>{short(tx.tx.hash)}</code><span className={status(tx) === "Reverted" ? styles.failed : styles.muted}>{status(tx)}</span></div>
              <div><span>{tx.payload?.method ?? (tx.tx.to ? `→ ${short(tx.tx.to)}` : "Contract creation")}</span><span>{matched ? "Matching call hash" : `${tx.events.filter(event => event.protocol).length} EEZ events`}</span></div>
            </button>;
          })}{!transactions.length && <p className={styles.muted}>No EEZ transactions in this block.</p>}
        </div>;
        })}
        {!context.blocks.some(block => block.chain === side) && <p className={styles.muted}>No {side.toUpperCase()} block loaded. Search this chain directly or enter a counterpart hash.</p>}
      </section>)}</div>
      {!!context.remainingBlocks?.length && <button className="btn btn-outline" disabled={moreLoading} onClick={() => void loadEarlier()}>{moreLoading ? "Loading blocks…" : `Load earlier counterpart blocks (${context.remainingBlocks.length} remaining)`}</button>}
      </aside><div className={styles.inspectorColumn}>{selected && <>{!!related.length && <div className={styles.related}><strong>Related by call hash</strong>{related.map(tx => <button key={`${tx.chain}-${tx.tx.hash}`} className="btn btn-sm btn-outline" onClick={() => chooseTransaction(tx)}>{tx.chain.toUpperCase()} {short(tx.tx.hash)}</button>)}</div>}
        <ExecutionInspector key={txKey(selected)} tx={selected} context={context} traces={traces} loadTrace={loadTrace} tab={tab} onTab={next => { setTab(next); setFlowDetailAction(null); }} flowDetailAction={flowDetailAction} onFlowDetailAction={setFlowDetailAction} step={step} focused={focused} onFocus={setFocused} onSelect={chooseTransaction} /></>}
      {!selected && <div className={styles.empty}><p>{contextTransactions(context).some(isEezTransaction) ? "Select a transaction on either chain to inspect its execution." : "No EEZ execution found in these blocks. Inspect a transaction hash or start with the latest EEZ batch."}</p><button className="btn btn-outline" disabled={loading} onClick={() => void loadLatestBatch()}>Inspect latest EEZ batch →</button></div>}</div></div>
    </>}
    {!context && !loading && !error && mode !== "live" && <div className={styles.empty}><h2>Start with a transaction or block</h2><p>Follow calls and settlement on both chains, including reverted transactions and contract deployments. No wallet is needed.</p></div>}
  </main>;
}
