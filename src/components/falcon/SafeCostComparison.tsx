import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { gasToken, nativeFeeCents, simpleGasCosts, type SafeCostEvidence } from '../../lib/falcon/safeCosts.ts';
import { fetchEthUsdPrice, type EthUsdPrice } from '../../lib/falcon/ethPrice.ts';
import shared from './FalconPanel.module.css';
import styles from './SafeCostComparison.module.css';

export function SafeCostComparison({ evidence, l1ChainId, l1Name, l1Symbol, l2Symbol }: {
  evidence: SafeCostEvidence; l1ChainId: number; l1Name: string; l1Symbol: string; l2Symbol: string; checking?: boolean;
}) {
  const l1Token = gasToken(l1Symbol, l1ChainId), l2Token = gasToken(l2Symbol, l1ChainId);
  const needsEthPrice = l1Token === 'ETH' || l2Token === 'ETH';
  const [price, setPrice] = useState<EthUsdPrice | null>(null);
  const [priceError, setPriceError] = useState(false);
  useEffect(() => {
    if (!needsEthPrice) { setPrice(null); setPriceError(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false, updated = 0;
    const refresh = async () => {
      if (pending || controller.signal.aborted || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const next = await fetchEthUsdPrice(controller.signal);
        if (!controller.signal.aborted) { setPrice(next); setPriceError(false); updated = Date.now(); }
      } catch { if (!controller.signal.aborted) setPriceError(true); }
      finally {
        pending = false;
        clearTimeout(timer);
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 60_000);
      }
    };
    const visible = () => { if (document.visibilityState === 'visible' && Date.now() - updated >= 60_000) void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [needsEthPrice]);
  const fee = evidence.receiptFee;
  if (!fee) return null;
  const costs = simpleGasCosts(fee.gasUsed, fee.gasPrice, fee.l1GasPrice);
  const native = (wei: bigint, token: 'ETH' | 'xDAI') => `${formatUnits(wei, 18)} ${token}`;
  const cents = (wei: bigint, token: 'ETH' | 'xDAI') => token === 'xDAI' ? nativeFeeCents(wei, 100_000_000n)
    : price ? nativeFeeCents(wei, price.usdPerEthE8) : native(wei, token);
  const batch = evidence.settlementFee;
  return <section id="safe-cost-comparison" className={styles.comparison} aria-label="Transaction cost" data-source-hash={evidence.sourceHash}>
    <div className={styles.heading}><h3>Transaction costs</h3></div>
    <div className={styles.totals}>
      <div className={`${styles.total} ${styles.actual}`}>
        <span className={shared.label}>Actual cost</span>
        <strong data-testid="cost-actual">{cents(costs.actualWei, l2Token)}</strong>
        <p className={shared.hint}>{native(costs.actualWei, l2Token)}.<br />Total L2 transaction fee, including EEZ settlement.</p>
      </div>
      <div className={styles.total}>
        <span className={shared.label}>Cost without EEZ</span>
        <strong data-testid="cost-without-eez">{costs.withoutEezWei === null ? 'Awaiting L1 receipt' : cents(costs.withoutEezWei, l1Token)}</strong>
        <p className={shared.hint}>{costs.withoutEezWei !== null && <>{native(costs.withoutEezWei, l1Token)}.<br /></>}Same L2 gas used × L1 gas price.</p>
      </div>
    </div>
    <details className={shared.details}>
      <summary>How this is calculated</summary>
      <p className={shared.hint}>Actual cost is the gas your L2 transaction used multiplied by the gas price you paid.</p>
      <p className={shared.hint}>Without EEZ uses that same amount of gas at the price paid on {l1Name}. It estimates doing the work directly on L1.</p>
      <p className={shared.hint}>Your L2 fee includes EEZ’s charge for posting and settling on L1. We do not add that charge again.</p>
      {needsEthPrice && priceError && <p className={shared.hint}>{price ? 'Dollar amounts use the last available price.' : 'Dollar estimates are temporarily unavailable; native fees are shown.'}</p>}
      {batch && <>
        <p className={shared.hint}>Recorded L1 batch costs: {native(batch.gasUsed * batch.gasPrice, l1Token)} for execution, plus {batch.blobGasUsed !== undefined && batch.blobGasPrice !== undefined ? native(batch.blobGasUsed * batch.blobGasPrice, l1Token) : 'an unavailable data fee'} for posting data. These cover the whole batch, which can include other transactions.</p>
      </>}
    </details>
  </section>;
}
