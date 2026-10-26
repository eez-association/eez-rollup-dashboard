import { useEffect, useMemo, useRef, useState } from "react";
import { traceRows } from "../../../trace-decoder/flow/rows.mjs";
import type { TraceModel, TraceNode } from "../../../trace-decoder/service/types";
import { CallMap } from "./CallMap";
import { FlowConnections } from "./FlowConnections";
import { TokenNotes } from "./TokenTransfers";
import styles from "./TraceDetailView.module.css";

export const textValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "—";
const short = (value: string | null | undefined) => value ? value.slice(0, 10) + "…" + value.slice(-6) : "—";
const CONTRACT_COLORS = 8;
const contractKey = (node: TraceNode) => node.chain + ":" + (node.address?.toLowerCase() || node.contract);
function returnLabel(node: TraceNode): string {
  if (node.ret.reason) return node.ret.reason;
  if (node.ret.items?.length) return node.ret.items.map(item => textValue(item.value)).join(", ");
  if (node.ret.status === "void") return "No return value";
  if (node.ret.status === "unknown") return "Return not observed";
  return node.ret.status === "raw" ? "Raw return data" : node.ret.status;
}
export function TraceDiagram({ model, view, transaction, onSelect, selected, tokens, onTokens }: {
  model: TraceModel; view: "map" | "flow" | "sequence"; transaction: string;
  onSelect: (id: number) => void; selected: number | null;
  tokens: boolean; onTokens: (enabled: boolean) => void;
}) {
  const flowBody = useRef<HTMLDivElement>(null);
  const [protocol, setProtocol] = useState(false);
  const [localReads, setLocalReads] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const [compact, setCompact] = useState(true);
  // Contract colours follow first appearance in the whole model, so search and paging never reshuffle them.
  const contractColor = useMemo(() => {
    const colors = new Map<string, number>();
    for (const node of model.nodes) if (!colors.has(contractKey(node))) colors.set(contractKey(node), colors.size % CONTRACT_COLORS);
    return colors;
  }, [model]);
  const transferCount = useMemo(() => model.nodes.reduce((total, node) => total + (node.tokenTransfers?.length ?? 0), 0), [model]);
  const selectedContract = selected === null || !model.nodes[selected] ? null : contractKey(model.nodes[selected]!);
  const rows = useMemo(() => traceRows(model, { transaction, protocol, localReads, search, collapsed }),
    [model, transaction, protocol, localReads, search, collapsed]);
  useEffect(() => { setPage(0); }, [transaction, protocol, localReads, search, collapsed, model]);
  const physical = model.mode === "physical";
  const chainSteps = { L1: 0, L2: 0 };
  const steps = rows.map(row => ++chainSteps[row.node.chain]);
  const pages = Math.max(1, Math.ceil(rows.length / 100)), currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * 100, (currentPage + 1) * 100);
  const visibleSteps = visible.map((_, index) => physical ? steps[currentPage * 100 + index]! : currentPage * 100 + index + 1);
  const toggle = (id: number) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const card = (node: TraceNode, depth: number, step: number) => <div className={styles.callGroup} style={{ paddingInlineStart: Math.min(depth, 6) * 10 }}>
    {node.children.length > 0 && <button className={styles.fold} aria-expanded={!collapsed.has(node.id)}
      aria-label={(collapsed.has(node.id) ? "Expand " : "Collapse ") + node.contract + " " + node.fn}
      onClick={() => toggle(node.id)}>{collapsed.has(node.id) ? "+" : "−"}</button>}
    <button className={styles.call} data-flow-node={node.id} data-chain={node.chain} data-selected={selected === node.id}
      data-failed={node.failed || node.reverted} data-ghost={node.kind === "ghost"} data-folds={node.children.length > 0}
      data-compact={compact} data-contract={contractColor.get(contractKey(node))}
      data-same={selected !== node.id && selectedContract === contractKey(node)}
      onClick={() => onSelect(node.id)} title={compact ? node.contract + " · " + node.fn + " · " + returnLabel(node) : undefined}
      aria-pressed={selected === node.id}>
      {compact ? <span className={styles.compactLine}>
        <span className={styles.step} aria-label={"Step " + step}>{step}</span>
        <strong>{node.contract}</strong><code>{node.fn}</code>
        {(node.failed || node.reverted) && <span className={styles.failure} aria-label="Reverted">✕</span>}
        {node.kind === "ghost" && <span className={styles.warningText} aria-label="Remote execution not observed">?</span>}
        {tokens && <TokenNotes model={model} chain={node.chain} transfers={node.tokenTransfers ?? []} compact />}
        <span className={styles.returnValue} data-state={node.failed || node.reverted ? "failed" : node.ret.status}>{returnLabel(node)}</span>
      </span> : <>
      <span className={styles.callTitle}><strong><span className={styles.step} aria-label={"Step " + step}>{step}</span>{node.contract}</strong><span>{node.callType}</span></span>
      <code>{node.fn}</code>
      <span className={styles.muted}>{short(node.address)}{node.gasUsed ? " · " + node.gasUsed + " gas" : ""}</span>
      {(node.crossing || node.outgoing) && <span className={styles.crossingBadge} data-state={(node.crossing || node.outgoing)?.status}>
        {(node.crossing || node.outgoing)?.from} → {(node.crossing || node.outgoing)?.to} · {(node.crossing || node.outgoing)?.status}
      </span>}
      {node.preparedResult && <span className={styles.crossingBadge}>Prepared result · no L2 delivery expected</span>}
      {node.preparedResponse && <span className={styles.crossingBadge}>Prepared table response</span>}
      <span className={styles.returnValue} data-state={node.failed || node.reverted ? "failed" : node.ret.status}>↩ {returnLabel(node)}</span>
      {tokens && <TokenNotes model={model} chain={node.chain} transfers={node.tokenTransfers ?? []} />}
      {node.reverted && <span className={styles.failure}>Reverted context</span>}
      {node.kind === "ghost" && <span className={styles.warningText}>Remote execution not observed</span>}
      </>}
    </button>
  </div>;
  return <section className={styles.diagram} aria-label={view === "map" ? "Cross-chain call map" : view === "flow" ? "Cross-chain call flow" : "Call sequence"}>
    <div className={styles.tools}>
      <label className={styles.search}>Find a call<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Contract, function, address…" /></label>
      <label className={styles.checkbox}><input type="checkbox" checked={localReads} onChange={event => setLocalReads(event.target.checked)} />Show local reads</label>
      <label className={styles.checkbox}><input type="checkbox" checked={protocol} onChange={event => setProtocol(event.target.checked)} />Show protocol calls</label>
      {view !== "sequence" && <label className={styles.checkbox} title="Show ERC20 Transfer events confirmed in both the trace and the receipt">
        <input type="checkbox" checked={tokens} onChange={event => onTokens(event.target.checked)} />
        Token transfers{transferCount ? " (" + transferCount + ")" : ""} <span className={styles.experimental}>experimental</span></label>}
      {view === "flow" && <label className={styles.checkbox}><input type="checkbox" checked={compact} onChange={event => setCompact(event.target.checked)} />Compact cards</label>}
      <button className="btn btn-sm btn-outline" onClick={() => setCollapsed(new Set())}>Expand all</button>
    </div>
    <p className={styles.muted}>{physical
      ? "Recorded call order within each transaction. The chains have independent sequences; this is not a shared timeline."
      : "Logical call order across both chains. Missing execution appears with a dashed border; settlement is shown separately."}</p>
    {view !== "sequence" && <div className={styles.legend} aria-label="Flow legend">
      <span><i className={styles.legendLine} />Caller → child</span>
      <span><i className={styles.legendCross} />Cross-chain call</span>
      <span><i className={styles.legendMissing} />Uncertain / missing execution</span>
      <span><i className={styles.legendContract} />Contract (same colour = same contract)</span>
      <span>Select a call to highlight its connections and other calls to that contract</span>
    </div>}
    {view === "map" ? <CallMap model={model} rows={visible} steps={visibleSteps} physical={physical}
      selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={toggle}
      contractColor={contractColor} contractKey={contractKey} returnLabel={returnLabel} tokens={tokens} />
    : view === "flow" ? <div className={styles.flowScroller}>
      <div className={styles.flowHead}><strong><span className={styles.laneDot} />{model.chains.L1.name} · L1</strong><span>↓ Call order</span><strong><span className={styles.laneDot} />{model.chains.L2.name} · L2</strong></div>
      <div className={styles.flowBody} ref={flowBody} data-compact={compact}>
      <FlowConnections container={flowBody} rows={visible} physical={physical} selected={selected} />
      {visible.map(({ node, depth, parent }, index) => {
        const parentNode = parent === null ? undefined : model.nodes[parent];
        const crossing = node.crossing;
        const crosses = !physical && (!!crossing || !!parentNode && parentNode.chain !== node.chain);
        const step = visibleSteps[index]!;
        const offPage = parent !== null && !visible.some(row => row.node.id === parent);
        return <div className={styles.flowRow} key={node.id}>
          <div className={styles.lane}>{node.chain === "L1" && card(node, depth, step)}</div>
          <div className={styles.arrow} data-chain={node.chain} aria-label={crosses ? (crossing?.from || parentNode?.chain) + " to " + node.chain : undefined}>
            {crosses && <small className={styles.crossingLabel} data-state={crossing?.status}>
              {node.chain === "L2" ? "L1 → L2" : "L2 → L1"}<span>{crossing?.status || "Call"}</span>
            </small>}
            {offPage && <small className={styles.continued}>Caller on an earlier page</small>}
          </div>
          <div className={styles.lane}>{node.chain === "L2" && card(node, depth, step)}</div>
        </div>;
      })}
      </div>
    </div> : <div className={styles.tableScroll}><table className={styles.sequence}>
      <thead><tr><th>Step</th><th>Chain</th><th>Call</th><th>Return / status</th></tr></thead>
      <tbody>{visible.map(({ node }, index) => <tr key={node.id} data-selected={selected === node.id}>
        <td>{visibleSteps[index]}</td><td>{node.crossing ? node.crossing.from + " → " + node.chain : node.chain}</td>
        <td><button className={styles.textButton} onClick={() => onSelect(node.id)} aria-pressed={selected === node.id}>
          <strong>{node.contract}</strong><code>{node.fn}</code></button></td>
        <td className={node.failed || node.reverted ? styles.failure : undefined}>{returnLabel(node)}{node.kind === "ghost" && " · execution not observed"}</td>
      </tr>)}</tbody>
    </table></div>}
    {!rows.length && <p className={styles.empty}>No calls match this view. Enable local reads or protocol calls, or clear the search to see more.</p>}
    <div className={styles.pagination}><span>{rows.length} calls · page {currentPage + 1} of {pages}</span>
      <button className="btn btn-sm btn-outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <button className="btn btn-sm btn-outline" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
  </section>;
}
