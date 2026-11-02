import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { feeAmounts, feeQuoteExpired, type FeeConfig, type QuotedFee } from '../../lib/falcon/l2Fees.ts';
import styles from './FalconPanel.module.css';

export function SafeFeeQuote({ fee, config }: {
  fee: QuotedFee | null; config: FeeConfig;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!fee) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [fee]);
  const amounts = fee ? feeAmounts(fee) : null;
  const money = (value: bigint) => `${formatUnits(value, 18)} ${config.nativeSymbol}`;
  return <div id="safe-fee-quote" className={styles.transaction}>
    {amounts
      ? <p className={styles.hint}><strong>Estimated execution fee: <span id="safe-fee-total">{money(amounts.estimated)}</span></strong><br />Maximum reservation: {money(amounts.maximum)}</p>
      : <p className={styles.hint}>Fees include L2 execution and L1 settlement.</p>}
    <details className={styles.details}>
      <summary>Fee details</summary>
      <p className={styles.hint}>Includes settlement; transfer amount is separate.<br />Fee limit: {money(config.maxTotalFee)}.<br />{fee && feeQuoteExpired(fee.quote, now) && 'Estimate expired. '}Refreshed before sending.</p>
    </details>
  </div>;
}
