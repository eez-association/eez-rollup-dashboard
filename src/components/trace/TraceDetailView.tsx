import { useEffect, useRef, useState, type FormEvent } from "react";
import { useDecodedTrace } from "../../hooks/useDecodedTrace";
import { config } from "../../config";
import { ExplorerLink } from "../ExplorerLink";
import { TraceDiagram, textValue } from "./TraceDiagram";
import { TokenDetails } from "./TokenTransfers";
import type { TraceChain, TraceGas, TraceModel, TraceNode, TraceResult, TraceSource } from "../../../trace-decoder/service/types";
import styles from "./TraceDetailView.module.css";
import visualizerStyles from "../visualizer/ExecutionDebugger.module.css";

function download(result: TraceResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = result.model.txHash + ".trace.json"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CallInspector({ node, model, tokens }: { node: TraceNode | undefined; model: TraceModel; tokens: boolean }) {
  if (!node) return <aside className={styles.inspector}><h2>Call details</h2><p className={styles.muted}>Select a call to inspect its arguments, return value, and cross-chain evidence.</p></aside>;
  const chain = node.chain === "L1" ? "l1" : "l2", crossing = node.crossing || node.outgoing;
  return <aside className={styles.inspector} aria-label="Selected call details">
    <p className="eez-eyebrow">[ {node.chain} · {node.callType} ]</p>
    <h2>{node.contract}</h2><code>{node.signature || node.fn}</code>
    {node.address && <p><ExplorerLink value={node.address} chain={chain} /></p>}
    {(node.failed || node.reverted) && <p className={styles.warning}>This call reverted or occurred in a reverted context.</p>}
    {node.preparedResult && <p className={styles.muted}>Prepared result · no L2 delivery expected.</p>}
    {node.preparedResponse && <p className={styles.muted}>This proxy returned the response from its prepared execution table.</p>}
    {node.kind === "ghost" && <p className={styles.warning}>The remote execution has not been observed. Any precomputed return value is not proof of execution.</p>}
    <dl className={styles.fields}><dt>Value</dt><dd>{node.value} wei</dd><dt>Gas used</dt><dd>{node.gasUsed ?? "Not observed"}</dd>
      <dt>Transaction</dt><dd>{node.tx ? <ExplorerLink value={node.tx} type="tx" chain={chain} /> : "Not observed"}</dd>
      <dt>Block</dt><dd>{node.block !== null ? <ExplorerLink value={String(node.block)} type="block" chain={chain} /> : "Not observed"}</dd>
      {node.abiSource && <><dt>Decoded using</dt><dd>{node.abiSource}{node.abiProvider ? " · " + node.abiProvider : ""}</dd></>}
    </dl>
    {node.impl && <p className={styles.muted}>Implementation: <ExplorerLink value={node.impl.address} chain={chain} /></p>}
    <h3>Arguments</h3>
    {node.args.length ? node.args.map((argument, index) => <div className={styles.argument} key={index}>
      <span>{argument.name || "Argument " + (index + 1)} <small>{argument.type}</small></span><pre>{textValue(argument.value)}</pre>
    </div>) : <p className={styles.muted}>No decoded arguments.</p>}
    <h3>Return value</h3><p className={node.ret.status === "revert" ? styles.failure : styles.muted}>{node.ret.reason || node.ret.status}</p>
    {node.ret.items?.map((item, index) => <pre key={index}>{item.name ? item.name + ": " : ""}{textValue(item.value)}</pre>)}
    {tokens && <TokenDetails model={model} chain={node.chain} transfers={node.tokenTransfers ?? []} />}
    {crossing && <><h3>Cross-chain execution</h3><p>{crossing.from} → {crossing.to} · {crossing.status}</p>
      {crossing.remoteTx && <ExplorerLink value={crossing.remoteTx} type="tx" chain={crossing.to === "L1" ? "l1" : "l2"} />}
      {crossing.evidence.length > 0 && <ul>{crossing.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
    </>}
    <details><summary>Calldata and raw return</summary><h3>Input</h3><pre>{node.input}</pre><h3>Output</h3><pre>{node.output ?? node.ret.raw ?? "Not observed"}</pre></details>
  </aside>;
}
function ContractList({ model }: { model: TraceModel }) {
  const contracts = new Map<string, { chain: TraceChain; address: string; name: string; roles: Set<string> }>();
  const add = (chain: TraceChain, address: string | null, name: string, role: string) => {
    if (!address || !/^0x[\da-f]{40}$/i.test(address) || BigInt(address) <= 255n) return;
    const key = `${chain}:${address.toLowerCase()}`, existing = contracts.get(key);
    if (existing) {
      existing.roles.add(role);
      if (existing.name === "Unknown contract" && name) existing.name = name;
    } else contracts.set(key, { chain, address, name: name || "Unknown contract", roles: new Set([role]) });
  };
  for (const node of model.nodes) {
    if (node.kind === "ghost") continue;
    add(node.chain, node.address, node.contract, node.impl ? "Proxy" : "Call target");
    if (node.impl) add(node.chain, node.impl.address, node.impl.contract, "Implementation");
  }
  if (!contracts.size) return null;
  return <section className={styles.transactions} aria-label="Contracts touched">
    <h2>Contracts touched <span className={styles.muted}>({contracts.size})</span></h2>
    <p className={styles.muted}>Observed call targets and proxy implementations across the decoded transactions, including calls hidden by filters.</p>
    <div className={styles.tableScroll}><table className={styles.sequence}>
      <thead><tr><th>Chain</th><th>Contract</th><th>Address</th><th>Role</th></tr></thead>
      <tbody>{[...contracts.values()].sort((a, b) => a.chain.localeCompare(b.chain) || a.name.localeCompare(b.name)).map(contract =>
        <tr key={`${contract.chain}:${contract.address.toLowerCase()}`}>
          <td><span className={styles.chain} data-chain={contract.chain}>{contract.chain}</span></td>
          <td>{contract.name}</td>
          <td><ExplorerLink value={contract.address} label={contract.address} chain={contract.chain === "L1" ? "l1" : "l2"} /></td>
          <td>{[...contract.roles].join(" · ")}</td>
        </tr>)}</tbody>
    </table></div>
  </section>;
}
const gasUnits = (value: string | null) => value === null ? "Unavailable" : BigInt(value).toLocaleString("en-US");
const chains: TraceChain[] = ["L1", "L2"];
// Totals describe the requested flow and stay fixed across views and visibility filters.
function GasSummary({ gas }: { gas: Record<TraceChain, TraceGas> }) {
  const rows = chains.flatMap(chain => gas[chain].contributions.map(row => ({ chain, ...row })));
  return <details className={styles.gas} open aria-label="Gas used by this flow">
    <summary><strong>Gas used by this flow</strong>
      <span className={styles.muted}>{chains.map(chain => `${chain} ${gasUnits(gas[chain].gasUsed)}`).join(" · ")}</span></summary>
    <div className={styles.gasTotals}>{chains.map(chain => <div key={chain} className={styles.gasTotal} data-chain={chain}>
      <span>{chain} flow gas</span><strong>{gasUnits(gas[chain].gasUsed)}</strong>
      {gas[chain].partial && <em>Partial</em>}
    </div>)}</div>
    <p className={styles.muted}>Gas units, not fees. Includes EEZ plumbing, nested calls and reverted calls, each counted once.
      Totals cover the requested flow and do not change when calls are hidden.</p>
    <details className={styles.gasBreakdown}><summary>Breakdown and whole transaction totals</summary>
      <div className={styles.tableScroll}><table className={styles.sequence}>
        <thead><tr><th>Chain</th><th>Contribution</th><th>Measured from</th><th>Gas used</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.frameId}>
          <td className={styles.chain} data-chain={row.chain}>{row.chain}</td>
          <td>{row.label}{row.hash && <> · <ExplorerLink value={row.hash} type="tx" chain={row.chain === "L1" ? "l1" : "l2"} /></>}</td>
          <td>{row.basis === "receipt" ? "Transaction receipt" : "Call frame, including children"}</td>
          <td className={styles.gasValue}>{gasUnits(row.gasUsed)}</td>
        </tr>)}</tbody>
      </table></div>
      <p className={styles.muted}>Whole related transactions: {chains.map(chain => `${chain} ${gasUnits(gas[chain].transactionGasUsed)}${gas[chain].transactionGasPartial ? " (partial)" : ""}`).join(" · ")}.
        These receipt totals include the full settlement batch, which may contain other flows.</p>
      <p className={styles.muted}>Whole transactions use receipt gas; isolated subtrees use call-trace gas. Shared settlement work,
        transaction overhead and refunds cannot be allocated exactly to an isolated entry. Partial totals indicate missing gas or attribution.</p>
    </details>
  </details>;
}
export function TraceDetailView({ hash, source, ready, onBack }: {
  hash: string; source: TraceSource; ready: boolean; onBack: () => void;
}) {
  const trace = useDecodedTrace(hash, source, ready);
  const [query, setQuery] = useState(hash);
  const [chain, setChain] = useState<TraceSource>(source);
  const [view, setView] = useState<"map" | "flow" | "sequence" | "raw">("map");
  const [transaction, setTransaction] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);
  // Receipt-confirmed token transfers are visible by default.
  const [tokens, setTokens] = useState(true);
  const viewer = useRef<HTMLElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [showDetails, setShowDetails] = useState(true);
  useEffect(() => {
    const changed = () => {
      const active = document.fullscreenElement === viewer.current;
      setFullscreen(active);
      if (!active) fullscreenButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === viewer.current) await document.exitFullscreen();
      else await viewer.current?.requestFullscreen();
    } catch {
      setFullscreenError("Fullscreen is unavailable in this browser. Hide call details to give the trace more room.");
    }
  };
  const linkedModel = trace.result?.model;
  const model = recorded && linkedModel?.recordedView ? linkedModel.recordedView : linkedModel;
  const gas = model?.gas ?? linkedModel?.gas;
  useEffect(() => { setRecorded(false); }, [linkedModel]);
  useEffect(() => { setSelected(null); setTransaction(""); }, [model]);
  const busy = trace.phase === "queued" || trace.phase === "running";
  const inspect = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!/^0x[0-9a-f]{64}$/i.test(value)) return;
    if (value.toLowerCase() === hash.toLowerCase() && chain === source) trace.refresh();
    else window.location.hash = "#/visualizer?mode=trace&chain=" + chain + "&tx=" + value;
  };
  const inspectorLink = "#/visualizer?mode=inspect&chain=" + source + "&tx=" + hash;
  return <main id="main" tabIndex={-1} className={styles.page}>
    <header className={styles.intro}>
      <button className="btn btn-sm btn-outline" onClick={onBack}>← Dashboard</button>
      <p className="eez-eyebrow">[ {config.rollupName} · TRANSACTION TRACE ]</p>
      <h1 className="eez-page-heading"><strong>Trace a transaction.</strong> Across both chains.</h1>
      <p className="eez-description">Explore the calls, return values, and related transactions across both chains.</p>
    </header>
    <nav className={visualizerStyles.tabs} aria-label="Visualizer modes">
      <a className={visualizerStyles.tab} href="#/visualizer?mode=live">Live</a>
      <a className={visualizerStyles.tab} href="#/visualizer?mode=inspect">Inspect</a>
      <a className={`${visualizerStyles.tab} ${visualizerStyles.activeTab}`} href="#/visualizer?mode=trace" aria-current="page">Trace</a>
    </nav>
    <form className={styles.searchBar} onSubmit={inspect}>
      <label>Source network<select value={chain} onChange={event => setChain(event.target.value as TraceSource)}>
        <option value="auto">Detect automatically</option><option value="l1">{config.l1NetworkName} · L1</option><option value="l2">{config.rollupName} · L2</option>
      </select></label>
      <label className={styles.query}>Transaction hash<input value={query} onChange={event => setQuery(event.target.value)}
        pattern="0x[a-fA-F0-9]{64}" required placeholder="0x…" spellCheck={false} /></label>
      <button className="btn btn-solid" disabled={!ready || busy}>Inspect</button>
      {hash && <a className="btn btn-outline" href={inspectorLink}>Blocks & settlement →</a>}
    </form>
    {!ready && <p className={styles.muted} role="status">Loading network configuration…</p>}
    {busy && <div className={styles.progress} role="status"><span className={styles.pulse} />{trace.progress}
      <button className="btn btn-sm btn-outline" onClick={trace.cancel}>Cancel</button></div>}
    {trace.error && <div className={styles.warning} role="alert"><p>{trace.error}</p>
      <button className="btn btn-sm btn-outline" onClick={trace.refresh}>Retry</button></div>}
    {trace.phase === "cancelled" && <p className={styles.muted} role="status">Decoding cancelled. <button className="btn btn-sm btn-outline" onClick={trace.refresh}>Retry</button></p>}
    {!hash && <p className={styles.empty}>Enter an L1 or L2 transaction hash to see its execution.</p>}
    {model && trace.result && <>
      {trace.result.partial && <div className={styles.warning} role="status"><strong>Some evidence is missing</strong>
        <p>The diagram shows the available data. Missing traces or settlement data do not establish success or failure.</p>
        <ul>{model.unresolved.slice(0, 8).map((item, index) => <li key={index}>{item.message}</li>)}</ul>
        {model.unresolved.length > 8 && <p>{model.unresolved.length - 8} more diagnostics are included in the JSON download.</p>}
      </div>}
      <section ref={viewer} className={styles.viewer} aria-label="Trace viewer">
      <div className={styles.viewerToolbar}>
        <nav className={styles.tabs} aria-label="Trace views">{(["map", "flow", "sequence", "raw"] as const).map(item =>
          <button key={item} className={"btn btn-sm " + (view === item ? "btn-solid" : "btn-outline")} aria-pressed={view === item} onClick={() => setView(item)}>
            {item === "map" ? "Call map" : item === "flow" ? "Lanes" : item === "sequence" ? "Sequence" : "Decoded data"}</button>)}</nav>
        <div className={styles.actions}>
          <button className="btn btn-sm btn-outline" onClick={trace.refresh}>Refresh</button>
          <button className="btn btn-sm btn-outline" onClick={() => trace.result && download(trace.result)}>Download JSON</button>
          {view !== "raw" && <button className="btn btn-sm btn-outline" aria-expanded={showDetails}
            onClick={() => setShowDetails(value => !value)}>{showDetails ? "Hide call details" : "Show call details"}</button>}
          <button ref={fullscreenButton} className="btn btn-sm btn-outline" aria-pressed={fullscreen}
            onClick={toggleFullscreen} title={fullscreen ? "Return to the dashboard (Esc)" : "Use the whole screen for the trace"}>
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
        </div>
      </div>
      {transaction && view !== "raw" && <div className={styles.actions} aria-label="Transaction filter">
        <span className={styles.muted}>Showing calls for {transaction.split(":")[0]} transaction {transaction.split(":")[1]}</span>
        <button className="btn btn-sm btn-outline" onClick={() => setTransaction("")}>Show connected flow</button>
      </div>}
      {fullscreenError && <p className={styles.warning} role="alert">{fullscreenError}</p>}
      {fullscreen && trace.result.partial && <p className={styles.warning} role="status">Some evidence is missing. This diagram shows the available data.</p>}
      {linkedModel?.recordedView && <nav className={styles.tabs} aria-label="Trace presentation">
        <button className={"btn btn-sm " + (!recorded ? "btn-solid" : "btn-outline")} aria-pressed={!recorded} onClick={() => setRecorded(false)}>Linked flow</button>
        <button className={"btn btn-sm " + (recorded ? "btn-solid" : "btn-outline")} aria-pressed={recorded} onClick={() => setRecorded(true)}>Recorded traces</button>
      </nav>}
      {model.executionNotice && <p className={styles.warning} role="status">{model.executionNotice}</p>}
      {!!model.matchingNotes?.length && <details><summary>Call association notes ({model.matchingNotes.length})</summary>
        <ul>{model.matchingNotes.map((item, index) => <li key={index}><code>{item.code}</code>: {item.message}</li>)}</ul>
      </details>}
      {view === "raw" ? <section className={styles.raw}><h2>Decoded flow model</h2><pre>{JSON.stringify(model, null, 2)}</pre></section>
        : <div className={styles.workspace} data-details={showDetails}><TraceDiagram key={model.mode || "combined"} model={model} view={view} transaction={transaction} selected={selected} onSelect={setSelected} tokens={tokens} onTokens={setTokens} />
          {showDetails && <CallInspector node={selected === null ? undefined : model.nodes[selected]} model={model} tokens={tokens} />}</div>}
      </section>
      <section className={styles.transactions} aria-label="Related transactions">
        <h2>Transactions</h2><p className={styles.muted}>Roles describe each transaction's part in execution. Transactions sharing a batch are not necessarily part of this call.</p>
        <div className={styles.transactionList}>{model.transactions.map(tx => <div key={tx.chain + tx.hash} className={styles.transaction} data-selected={transaction === tx.chain + ":" + tx.hash}>
          <span className={styles.chain} data-chain={tx.chain}>{tx.chain}</span>
          <button className={styles.textButton} onClick={() => { setTransaction(tx.chain + ":" + tx.hash); setSelected(null); }}><strong>{tx.label}</strong><span>{tx.requested ? "Requested · " : ""}{tx.status}{!tx.traced ? " · trace unavailable" : ""}</span></button>
          <ExplorerLink value={tx.hash} type="tx" chain={tx.chain === "L1" ? "l1" : "l2"} />
        </div>)}</div>
      </section>
      {model.settlements.length > 0 && <section className={styles.settlements} aria-label="Observed settlement">
        <h2>L1 posting observed</h2><p className={styles.muted}>This is a snapshot of the verified posting. Open Blocks & settlement for current safety and finality.</p>
        {model.settlements.map(item => <div key={item.id}><ExplorerLink value={item.l1Tx} type="tx" chain="l1" />
          <span>L2 blocks {item.firstL2Block}–{item.lastL2Block}</span></div>)}
      </section>}
      <ContractList model={linkedModel?.recordedView ?? linkedModel ?? model} />
      {gas && <GasSummary gas={gas} />}
    </>}
  </main>;
}
