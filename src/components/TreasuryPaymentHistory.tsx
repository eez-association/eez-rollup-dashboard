import { useEffect, useRef, useState } from "react";
import type { useTreasuryHistory } from "../hooks/useTreasuryHistory";
import type { TreasuryConfig } from "../lib/treasury/client";
import { treasuryTransactions } from "../lib/treasury/settlement";
import { historyLabels, historyStatus } from "../lib/treasury/history";
import type { HistoryEntry, HistoryStatus } from "../lib/treasury/history";
import { formatUSDC } from "../lib/treasury/payments";
import { TreasuryOutcomeDetails } from "./TreasuryOutcomeDetails";
import { TreasuryChainLink } from "./TreasuryPaymentFlow";
import { NetworkIcon } from "./NetworkIcon";
import styles from "./TxHistoryPanel.module.css";
import layout from "./TreasuryTransactionHistory.module.css";
import treasury from "./TreasuryDemo.module.css";

export function TreasuryPaymentHistory({ history, deployment }: { history: ReturnType<typeof useTreasuryHistory>; deployment: TreasuryConfig }) {
  const [filter, setFilter] = useState<HistoryStatus | "all">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const ordered = [...history.entries].reverse();
  useEffect(() => {
    if (!history.entries.length) return;
    const incoming = seen.current === null ? [history.entries[history.entries.length - 1]!]
      : history.entries.filter(entry => !seen.current!.has(entry.id));
    seen.current = new Set(history.entries.map(entry => entry.id));
    if (!incoming.length) return;
    setExpanded(previous => new Set([...previous, ...incoming.map(entry => entry.id)]));
    setFilter("all");
  }, [history.entries]);
  const category = (entry: HistoryEntry) => {
    const observation = history.observations[entry.id];
    return historyStatus(entry, observation?.checking && observation.outcome ? { ...observation, checking: false } : observation);
  };
  const entries = ordered.filter(e => filter === "all" || category(e) === filter);
  const names = { l1: deployment.l1.chainId === 10200 ? "Chiado" : "Ethereum", l2: "EEZ-X" };
  return <section className={styles.card} aria-label="Payment history">
    <div className={styles.cardHeader}><div><h3 className={styles.cardTitle}>Payment history</h3><p className={styles.noHash}>Newest first · Saved in this browser</p></div>
      <div className={styles.headerRight}><span className={styles.count}>{ordered.length} {ordered.length === 1 ? "payment" : "payments"}</span>
        {!!ordered.length && <button className="btn btn-sm btn-ghost" disabled={history.checking} onClick={() => void history.refresh()}>{history.checking ? "Checking history…" : "Refresh history"}</button>}</div></div>
    {!!ordered.length && <div className={`${treasury.fields} ${layout.historyFilter}`}><label htmlFor="treasury-history-filter">Filter history</label>
      <select id="treasury-history-filter" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}>
        <option value="all">All outcomes ({ordered.length})</option>
        {(Object.keys(historyLabels) as HistoryStatus[]).map(status => <option key={status} value={status}>{historyLabels[status]} ({ordered.filter(e => category(e) === status).length})</option>)}
      </select></div>}
    {history.error && <p className={styles.lookupError} role="alert">{history.error}</p>}
    {!entries.length && <p className={styles.emptyState}>{ordered.length ? "No payments match this filter." : "Your payment attempts will appear here."}</p>}
    {!!entries.length && <div className={`${styles.columns} ${layout.paymentColumns}`} aria-hidden="true"><span>Payment</span><span>Route</span><span>Transactions</span><span>Blocks</span><span>Status</span><span>Time</span><span /></div>}
    <ol className={`${styles.list} ${layout.paymentList}`}>{entries.map(entry => {
      const observation = history.observations[entry.id], outcome = observation?.outcome;
      const status = historyStatus(entry, observation), intent = entry.kind === "submitted" ? entry.intent : undefined;
      const payment = entry.kind === "submitted" ? entry.intent.payment! : entry.payment;
      const settledResult = outcome?.kind === "settled";
      const actual = settledResult && outcome?.contributions;
      const amount = actual ? formatUSDC(BigInt(actual.fromL1) + BigInt(actual.fromL2)) : formatUSDC(BigInt(payment.amount));
      const source = payment.source ?? "l2", hash = outcome?.hash ?? intent?.hash;
      const settlement = history.settlementFor(outcome);
      const transactions = treasuryTransactions(intent, outcome, settlement);
      const trace = transactions.find(tx => tx.role === "execution" && tx.chain === (intent?.submissionChain ?? source))
        ?? transactions.find(tx => tx.role === "execution");
      const blocks = transactions.filter((tx, i) => tx.block && !transactions.slice(0, i).some(previous => previous.chain === tx.chain && previous.block === tx.block));
      const open = expanded.has(entry.id), detailsId = `payment-${entry.id}`;
      const badge = status === "settled" ? styles.confirmed : status === "pending" ? styles.pending : styles.failed;
      return <li key={entry.id} className={layout.paymentEntry} data-testid="history-entry" data-status={status} data-safe-hash={intent?.safeHash}>
        <div className={`${styles.row} ${layout.paymentRow}`}>
          <div className={styles.actionCol}><strong className={styles.typeLabel}>{amount} USDC → {names[payment.destination]}</strong>
            <span className={styles.detail}>{payment.kind === "invoice" ? "Invoice" : payment.kind === "transfer" ? "Transfer between Safes" : "Fixed payment"}</span>
            {actual && <div className={layout.paymentSplit} aria-label="Actual funding split"><span><span className={treasury.chainLabel} data-chain="l1">{names.l1}</span> {formatUSDC(BigInt(actual.fromL1))} USDC</span><span><span className={treasury.chainLabel} data-chain="l2">EEZ-X</span> {formatUSDC(BigInt(actual.fromL2))} USDC</span></div>}</div>
          <div className={`${styles.routeCol} ${layout.paymentRoute}`}><NetworkIcon chain={source} decorative /><span>{names[source]} → {names[payment.destination]}</span></div>
          <div className={styles.transactionCol} role="group" aria-label="Transaction links">{transactions.length ? transactions.map(tx =>
            <div className={layout.paymentTransaction} key={`${tx.chain}:${tx.hash}`}>
              <span className={treasury.chainLabel} data-chain={tx.chain}>{names[tx.chain]}{tx.role === "settlement" ? " · settlement" : ""}</span>
              <TreasuryChainLink deployment={deployment} chain={tx.chain} value={tx.hash}>{tx.hash.slice(0, 8)}…{tx.hash.slice(-6)}</TreasuryChainLink>
            </div>) : <span className={styles.noHash}>{entry.kind === "preparation" ? "Not submitted" : "Awaiting wallet"}</span>}
            {settledResult && !settlement && <span className={styles.noHash}>{names.l1} settlement link {settlement === null ? "unavailable" : "loading…"}</span>}
          </div>
          <div className={styles.blockCol} role="group" aria-label="Blocks">{blocks.length ? blocks.map(tx =>
            <TreasuryChainLink key={`${tx.chain}:${tx.block}`} deployment={deployment} chain={tx.chain} type="block" value={tx.block!}>{names[tx.chain]} #{BigInt(tx.block!).toLocaleString()}</TreasuryChainLink>) : <span className={styles.noHash}>—</span>}</div>
          <div className={styles.statusCol}><span className={`${styles.badge} ${badge} ${layout.paymentBadge}`} data-outcome={status}>{observation?.checking ? outcome ? "Rechecking…" : "Checking…" : !observation && entry.kind === "submitted" && history.checking ? "Checking…" : historyLabels[status]}</span></div>
          <time className={styles.timeCol} dateTime={entry.recordedAt} title={new Date(entry.recordedAt).toLocaleString()}>{new Date(entry.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <div className={styles.actionsCol}><button className={styles.inspectBtn} aria-label={open ? "Hide payment details" : "Show payment details"} aria-expanded={open} aria-controls={detailsId} onClick={() => setExpanded(previous => { const next = new Set(previous); if (open) next.delete(entry.id); else next.add(entry.id); return next; })}>{open ? "−" : "+"}</button></div>
        </div>
        {open && <div id={detailsId} className={treasury.historyDetails}>
          {entry.kind === "preparation" ? <><p>{entry.detail}</p><p>Stopped during preparation. Not signed or submitted; no transaction hash.</p></> : <>
            {!settledResult && <p>{observation?.error ? `Verification unavailable: ${observation.error}` : observation?.checking ? "Checking this saved request…" : outcome?.detail ?? "Checking this saved request. Its outcome is not yet verified."}</p>}
            {observation?.checking && outcome && <p className={styles.noHash}>Last verified result · rechecking against the network…</p>}
            <TreasuryOutcomeDetails outcome={outcome} prefix="history-" deployment={deployment} intent={intent} settlement={settlement} />
            {trace && <div><a className="btn btn-sm btn-outline" href={`#/visualizer?mode=trace&chain=${trace.chain}&tx=${encodeURIComponent(trace.hash)}`}>See in trace decoder</a></div>}
            {!settledResult && <p>Recipient: <TreasuryChainLink deployment={deployment} chain={payment.destination} type="address" value={payment.recipient}>{payment.recipient.slice(0, 8)}…{payment.recipient.slice(-6)}</TreasuryChainLink> on {names[payment.destination]}.</p>}
            {hash && !settledResult && <p><TreasuryChainLink deployment={deployment} chain={source} value={hash}>Submitted transaction</TreasuryChainLink></p>}
            {status === "pending" && !settledResult && <p>This saved request is being verified. It will not be resubmitted automatically.</p>}
          </>}
        </div>}
      </li>;
    })}</ol>
  </section>;
}
