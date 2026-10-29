import { useEffect, useRef, useState } from 'react';
import { L1_CHAIN, L2_CHAIN } from '../config';
import { displayAmount, swapOutcome, type CowOrder } from '../lib/cowLight';
import { ExplorerLink } from './ExplorerLink';
import { NetworkIcon } from './NetworkIcon';
import history from './TxHistoryPanel.module.css';
import layout from './TreasuryTransactionHistory.module.css';
import treasury from './TreasuryDemo.module.css';
import styles from './CowSwapHistory.module.css';

const labels = { settled: 'Settled', pending: 'Pending', failed: 'Failed', expired: 'Expired' };
function detailError(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try { return detailError(JSON.parse(value)); } catch { return value; }
  }
  if (typeof value === 'object') {
    const error = value as { message?: string; reason?: string; code?: string };
    return [error.message || error.code, error.reason].filter(Boolean).join(' · ') || JSON.stringify(value);
  }
  return String(value);
}

export function CowSwapHistory({ orders, connected, sellSymbol, error, checking, onRefresh }: {
  orders: CowOrder[]; connected: boolean; sellSymbol: string; error: string; checking: boolean; onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<'all' | keyof typeof labels>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!orders.length) return;
    const incoming = seen.current === null ? [orders[0]!] : orders.filter(order => !seen.current!.has(order.id));
    seen.current = new Set(orders.map(order => order.id));
    if (incoming.length) {
      setExpanded(previous => new Set([...previous, ...incoming.map(order => order.id)]));
      setFilter('all');
    }
  }, [orders]);
  const visible = orders.filter(order => filter === 'all' || swapOutcome(order) === filter);
  return <section className={`${history.card} ${styles.history}`} aria-label="Swap activity">
    <div className={history.cardHeader}><div><h3 className={history.cardTitle}>Your swaps</h3>
      <p className={history.noHash}>Newest first · Connected wallet · Tracked by the solver</p></div>
      <div className={history.headerRight}><span className={history.count}>{orders.length} {orders.length === 1 ? 'swap' : 'swaps'}</span>
        <button className="btn btn-sm btn-ghost" disabled={checking} onClick={onRefresh}>{checking ? 'Checking history…' : 'Refresh history'}</button></div></div>
    {!!orders.length && <div className={`${treasury.fields} ${layout.historyFilter}`}><label htmlFor="cow-history-filter">Filter history</label>
      <select id="cow-history-filter" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">All outcomes ({orders.length})</option>
        {(Object.keys(labels) as (keyof typeof labels)[]).map(key => <option key={key} value={key}>{labels[key]} ({orders.filter(o => swapOutcome(o) === key).length})</option>)}
      </select></div>}
    {error && <p className={history.lookupError} role="alert">Activity could not refresh: {error}. Showing the last observed results.</p>}
    {!visible.length && <p className={history.emptyState}>{!connected ? 'Connect your wallet to see its swaps.' : orders.length ? 'No swaps match this filter.' : 'Your swap orders will appear here.'}</p>}
    {!!visible.length && <div className={`${history.columns} ${layout.paymentColumns}`} aria-hidden="true"><span>Swap</span><span>Route</span><span>Transactions</span><span>Blocks</span><span>Status</span><span>Time</span><span /></div>}
    <ol className={`${history.list} ${layout.paymentList}`}>{visible.map(order => {
      const debug = order.solverDebug, outcome = swapOutcome(order), state = debug?.state || order.status;
      const tx = debug?.settlement || debug?.txHash;
      const token = order.quote?.tokenSymbol || 'Token', amount = displayAmount(order.order.sellAmount);
      const minimum = displayAmount(order.order.buyAmount, order.quote?.tokenDecimals ?? 18);
      const open = expanded.has(order.id), id = `cow-order-${order.id}`;
      const badge = outcome === 'settled' ? history.confirmed : outcome === 'pending' ? history.pending : history.failed;
      const failure = detailError(debug?.error);
      const transactions = [tx && { chain: 'l2' as const, hash: tx, name: L2_CHAIN.chainName, block: debug?.settlementBlock },
        debug?.l1Tx && { chain: 'l1' as const, hash: debug.l1Tx, name: `${L1_CHAIN.chainName} · settlement`, block: debug.l1Block }].filter(item => !!item);
      return <li key={order.id} className={layout.paymentEntry} data-testid="swap-history-entry" data-status={outcome}>
        <div className={`${history.row} ${layout.paymentRow}`}>
          <div className={history.actionCol}><strong className={history.typeLabel}>{amount} {sellSymbol} → {token}</strong>
            <span className={`${history.detail} ${styles.wrap}`}>Minimum {minimum} {token}</span>
            {failure && <span className={`${history.lookupError} ${styles.failure}`}>{failure}</span>}</div>
          <div className={`${history.routeCol} ${layout.paymentRoute}`}><NetworkIcon chain="l2" decorative /><span>{L2_CHAIN.chainName}<br />via {L1_CHAIN.chainName}</span></div>
          <div className={history.transactionCol} role="group" aria-label="Transaction links">
            {transactions.length ? transactions.map(item => <div key={item.chain} className={layout.paymentTransaction}>
              <span className={treasury.chainLabel} data-chain={item.chain}>{item.name}</span>
              <ExplorerLink chain={item.chain} value={item.hash} type="tx" /></div>) : <span className={history.noHash}>Not submitted on-chain</span>}
          </div>
          <div className={`${history.blockCol} ${styles.blocks}`} role="group" aria-label="Blocks">
            {transactions.some(item => item.block != null) ? transactions.filter(item => item.block != null).map(item =>
              <ExplorerLink key={item.chain} chain={item.chain} value={String(item.block)} type="block" label={`${item.chain === 'l1' ? L1_CHAIN.chainName : L2_CHAIN.chainName} #${item.block!.toLocaleString()}`} />) : <span className={history.noHash}>—</span>}
          </div>
          <div className={history.statusCol}><span className={`${history.badge} ${badge} ${layout.paymentBadge}`}>{labels[outcome]}</span></div>
          <time className={history.timeCol} dateTime={new Date(order.receivedAt * 1000).toISOString()} title={new Date(order.receivedAt * 1000).toLocaleString()}>
            {new Date(order.receivedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <div className={history.actionsCol}><button className={`${history.inspectBtn} ${styles.toggle}`} aria-label={open ? 'Hide swap details' : 'Show swap details'} aria-expanded={open} aria-controls={id}
            onClick={() => setExpanded(previous => { const next = new Set(previous); if (open) next.delete(order.id); else next.add(order.id); return next; })}>{open ? '−' : '+'}</button></div>
        </div>
        {open && <div id={id} className={`${treasury.historyDetails} ${styles.details}`}>
          <figure className={treasury.paymentFlow}><figcaption>{outcome === 'settled' ? 'Swap settlement' : 'Swap route and progress'}</figcaption>
            <div className={treasury.transferFlow}>
              <div className={treasury.flowNode}><span className={treasury.chainLabel} data-chain="l2">{L2_CHAIN.chainName}</span>
                <strong>Sell {amount} {sellSymbol}</strong><p>Signed sell amount</p>
                {tx ? <ExplorerLink value={tx} type="tx" label="Order execution" /> : <p>Awaiting execution</p>}
                {debug?.settlementBlock != null && <ExplorerLink value={String(debug.settlementBlock)} type="block" label={`Block #${debug.settlementBlock.toLocaleString()}`} />}</div>
              <span aria-hidden="true">→</span>
              <div className={treasury.flowNode}><span className={treasury.chainLabel} data-chain="l1">{L1_CHAIN.chainName}</span><strong>Liquidity pool swap</strong>
                {debug?.l1Tx ? <ExplorerLink chain="l1" value={debug.l1Tx} type="tx" label="Settlement transaction" /> : <p>Awaiting settlement evidence</p>}
                {debug?.l1Block != null && <ExplorerLink chain="l1" value={String(debug.l1Block)} type="block" label={`Block #${debug.l1Block.toLocaleString()}`} />}</div>
              <span aria-hidden="true">→</span>
              <div className={treasury.flowNode}><span className={treasury.chainLabel} data-chain="l2">{L2_CHAIN.chainName}</span><strong>Minimum {minimum} {token}</strong>
                <p>Signed minimum, not the measured output</p>
                <ExplorerLink value={order.order.receiver || order.signer} label="Recipient" />
                <p>{outcome === 'settled' ? 'Canonical settlement confirmed' : 'Delivery not confirmed'}</p></div>
            </div></figure>
          <p className={history.noHash}>{debug?.message || (outcome === 'settled' ? 'Canonical settlement confirmed; consensus finality is not asserted.' : `Solver: ${state.replace(/_/g, ' ')}.`)}</p>
          <div className={styles.detailFooter}>{tx && <a className="btn btn-sm btn-outline" href={`#/visualizer?mode=trace&chain=l2&tx=${encodeURIComponent(tx)}`}>Inspect execution</a>}
            <span className={history.noHash}>Order <code>{order.id}</code></span></div>
        </div>}
      </li>;
    })}</ol>
  </section>;
}
