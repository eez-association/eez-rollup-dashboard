import { useId } from 'react';
import { formatUnits } from 'viem';
import styles from './BridgeFeeQuote.module.css';

export function WalletFeeRates({ fee, description, onRefresh, disabled = false }: {
  fee: { price: string; priority?: string } | null;
  description: string; onRefresh?: () => void; disabled?: boolean;
}) {
  const id = useId();
  return <section className={styles.panel} aria-label="Wallet gas fees">
    <div className={styles.heading}><strong>Wallet gas fees</strong>
      {onRefresh && <button type="button" className={styles.refresh} disabled={disabled} onClick={onRefresh}>Refresh fees</button>}</div>
    <div className={styles.field}><label htmlFor={`${id}-max`}>{fee?.priority === undefined && fee ? 'Gas price' : 'Max gas price'} (gwei)</label>
      <input id={`${id}-max`} readOnly value={fee ? formatUnits(BigInt(fee.price), 9) : ''} placeholder="—" onFocus={event => event.currentTarget.select()} /></div>
    <div className={styles.field}><label htmlFor={`${id}-tip`}>Max priority fee (gwei)</label>
      <input id={`${id}-tip`} readOnly value={fee?.priority !== undefined ? formatUnits(BigInt(fee.priority), 9) : ''}
        placeholder={fee ? 'Not applicable' : '—'} onFocus={event => event.currentTarget.select()} /></div>
    <p className={styles.hint} role="status">{description}</p>
    {fee && <p className={styles.hint}>If Rabby changes these values, copy them into its gas settings. These are per-gas rates, not the total transaction cost.</p>}
  </section>;
}
