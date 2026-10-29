import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import type { MainnetTarget, SetupNetwork } from '../lib/treasury/mainnetSetup';
import { pairedSetupKey, pairedSetupTransactions } from '../lib/treasury/pairedSetupState';
import { DeploymentIO } from '../lib/treasury/deploymentIO';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { observeSetupTransaction } from '../lib/treasury/setupTransactions';
import type { SetupTransaction, SetupObservation } from '../lib/treasury/setupTransactions';
import { NetworkIcon } from './NetworkIcon';
import styles from './TxHistoryPanel.module.css';
import layout from './TreasuryTransactionHistory.module.css';

type Row = SetupTransaction & { observation?: SetupObservation; finalized?: boolean };
const labels = { pending: 'Pending', included: 'Included', failed: 'Failed', rechecking: 'Rechecking', unavailable: 'Unavailable' };
export function TreasuryPairedHistory({ target, network }: { target: MainnetTarget; network: SetupNetwork }) {
  const [rows, setRows] = useState<Row[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const key = pairedSetupKey(network);
    const refresh = async () => {
      try {
        const identity = localStorage.getItem(key), records = pairedSetupTransactions(localStorage, network);
        const current = () => alive && localStorage.getItem(key) === identity;
        if (alive) setRows(previous => records.map(record => ({ ...previous.find(row => row.id === record.id && row.hash === record.hash), ...record })));
        if (!records.length) { if (alive) setError(''); return; }
        const io = new DeploymentIO(target, await loadTreasuryArtifacts());
        const observed: Row[] = [];
        for (let offset = 0; alive && offset < records.length; offset += 4)
          observed.push(...await Promise.all(records.slice(offset, offset + 4).map(async record => ({ ...record, observation: await observeSetupTransaction(io, record) }))));
        if (!current()) return;
        setRows(observed); setError('');
        const finalized: Partial<Record<'l1' | 'l2', bigint>> = {};
        await Promise.allSettled([...new Set(records.map(record => record.chain))].map(async chain => {
          const block = await io.rpc<{ number: Hex } | null>(chain, 'eth_getBlockByNumber', ['finalized', false]);
          if (block?.number) finalized[chain] = BigInt(block.number);
        }));
        if (current()) setRows(observed.map(row => ({ ...row, finalized: row.observation?.status === 'included' && finalized[row.chain] !== undefined
          && BigInt(row.observation.blockNumber!) <= finalized[row.chain]! })));
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { if (alive) timer = setTimeout(refresh, 4000); }
    };
    void refresh(); return () => { alive = false; clearTimeout(timer); };
  }, [target, network]);
  if (!rows.length && !error) return null;
  const link = (row: Row, type: 'tx' | 'block', value: string, label: string) => target[row.chain].explorer
    ? <a className={styles.hash} href={`${target[row.chain].explorer.replace(/\/$/, '')}/${type}/${value}`} title={value} target="_blank" rel="noopener noreferrer">{label} ↗</a> : <code>{label}</code>;
  return <section className={styles.card} aria-label="Setup transaction history">
    <div className={styles.cardHeader}><div><h2 className={styles.cardTitle}>Transaction History</h2><p className={styles.noHash}>Setup transactions · oldest first</p></div><span className={styles.count}>{rows.length} tx</span></div>
    {error && <p className={styles.lookupError} role="alert">{error}</p>}
    <div className={`${styles.columns} ${layout.columns}`} aria-hidden="true"><span>Action</span><span>Network</span><span>Transaction</span><span>Block</span><span>Status</span><span>Time</span></div>
    <ol className={styles.list}>{rows.map((row, index) => {
      const o = row.observation, label = row.finalized ? 'Finalized' : o ? labels[o.status] : 'Checking';
      const status = o?.status === 'included' ? 'confirmed' : o?.status === 'failed' ? 'failed' : 'pending';
      return <li key={row.id} className={`${styles.row} ${layout.row}`} data-tx-hash={row.hash} data-status={label.toLowerCase()}>
        <div className={styles.actionCol}><span className={styles.typeLabel}>Step {index + 1}</span><span className={`${styles.detail} ${layout.detail}`}>{row.label}</span></div>
        <div className={styles.routeCol}><NetworkIcon chain={row.chain} decorative /><span>{row.chain === 'l1' ? network.testnet ? 'Chiado' : 'Ethereum' : 'EEZ-X'}</span></div>
        <div className={styles.transactionCol}>{row.hash ? link(row, 'tx', row.hash, `${row.hash.slice(0, 10)}…${row.hash.slice(-6)}`) : <span className={styles.noHash}>Awaiting wallet</span>}</div>
        <div className={styles.blockCol}>{o?.blockNumber ? link(row, 'block', String(BigInt(o.blockNumber)), `#${BigInt(o.blockNumber).toLocaleString()}`) : '—'}</div>
        <div className={styles.statusCol}><span className={`${styles.badge} ${styles[status]}`} title={o?.detail}>{label}</span></div>
        {o?.timestamp !== undefined ? <time className={styles.timeCol} dateTime={new Date(o.timestamp).toISOString()} title={new Date(o.timestamp).toLocaleString()}>{new Date(o.timestamp).toLocaleTimeString()}</time> : <span className={styles.timeCol}>—</span>}
      </li>;
    })}</ol>
  </section>;
}
