import { useMemo } from 'react';
import { config, DISCOVERED_CHAIN_IDS, L2_CHAIN } from '../config';
import type { useWallet } from '../hooks/useWallet';
import { useFalconWallet } from '../hooks/useFalconWallet';
import { falconDashboardConfig } from '../lib/falcon/dashboardConfig.ts';
import { FalconPanel } from './falcon/FalconPanel';
import styles from './FalconDemo.module.css';

/** Mounted only when the shared hidden-demo preference and active tab both allow it. */
export function FalconDemo({ ready, wallet }: { ready: boolean; wallet: ReturnType<typeof useWallet> }) {
  const falconWallet = useFalconWallet(wallet);
  const binding = useMemo(() => ready ? falconDashboardConfig({
    l1ChainId: DISCOVERED_CHAIN_IDS.l1, l2ChainId: DISCOVERED_CHAIN_IDS.l2,
    registry: config.rollupsAddress, manager: config.ccmL2Address, rollupId: config.rollupId,
    feesEnabled: config.l2FeesEnabled, quoteUrl: config.l2ProxyRpc,
    maxTotalWei: config.l2FeeMaxTotalWei, nativeSymbol: L2_CHAIN.nativeCurrency.symbol,
  }) : null, [ready]);

  return <section className={styles.demo} aria-label="Falcon Safe demo">
    <header className={styles.heading}>
      <div><span className={styles.eyebrow}>[ POST-QUANTUM SIGNATURES ]</span>
        <h2>Falcon Safe</h2><p>Sign in your browser. Verify on L2. Control a Safe on L1.</p></div>
      <span className={styles.badge}>Falcon-512 · Demo</span>
    </header>
    {!binding ? <p role="status">Checking network configuration…</p> : <>
      {binding.message && <p className={styles.notice} role="status">{binding.message}</p>}
      <FalconPanel wallet={falconWallet} crossChain={binding.deployment} fees={binding.fees} />
    </>}
  </section>;
}
