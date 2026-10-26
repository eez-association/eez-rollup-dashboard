import { useEffect, useMemo, useState } from 'react';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import { TreasurySourceVerification } from './TreasurySourceVerification';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryTestnet } from './TreasuryTestnet';
import { isMainnetSetupTarget, loadMainnetManifest, mainnetSetupKey } from '../lib/treasury/mainnetSetup';
import { parseTreasuryConfig, requireDashboardTreasury } from '../lib/treasury/client';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';
import profile from '../lib/treasury/paired-testnet-network.json';
import network from '../lib/treasury/mainnet-network.json';
import { TreasuryPairedHistory } from './TreasuryPairedHistory';
import { TreasuryPairedRestart } from './TreasuryPairedRestart';
import styles from './TreasuryDemo.module.css';

function TreasuryDemoView({ wallet, ready }: { wallet: TreasuryWallet; ready: boolean }) {
  const [revision, setRevision] = useState(0);
  const [resetVersion, setResetVersion] = useState(0);
  const restart = () => { setResetVersion(x => x + 1); setRevision(x => x + 1); };
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || [mainnetSetupKey, `${mainnetSetupKey}:manifest`].includes(event.key)) setRevision(value => value + 1); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const target = useMemo(() => ({ l1: { rpc: config.l1Rpc, front: config.l1ProxyRpc, explorer: config.l1Explorer },
    l2: { rpc: config.l2Rpc, front: config.l2ProxyRpc, explorer: config.l2Explorer }, fees: { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei } }), [ready]);
  const mainnet = ready && isMainnetSetupTarget(L1_CHAIN.chainId, L2_CHAIN.chainId, config.rollupsAddress, config.ccmL2Address, config.l1Bridge, config.l2Bridge);
  const shared = ready && BigInt(L1_CHAIN.chainId) === BigInt(profile.chains.l1.chainId) && BigInt(L2_CHAIN.chainId) === BigInt(profile.chains.l2.chainId)
    && config.rollupsAddress.toLowerCase() === profile.registry.toLowerCase() && config.ccmL2Address.toLowerCase() === profile.manager.toLowerCase();
  const parsed = useMemo(() => {
    if (!ready) return { deployment: null, error: '' };
    try {
      const value = config.treasury ?? (mainnet ? loadMainnetManifest(localStorage) : null);
      if (!value) return { deployment: null, error: '' };
      const deployment = parseTreasuryConfig(value);
      if (!deployment.payments?.pair || deployment.payments.bridgeKind !== 'standard') throw new Error('This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.');
      requireDashboardTreasury(deployment, { l1ChainId: L1_CHAIN.chainId, l2ChainId: L2_CHAIN.chainId,
        l1Rpc: config.l1Rpc, l2Rpc: config.l2Rpc, l2Front: config.l2ProxyRpc, l1Front: config.l1ProxyRpc,
        registry: config.rollupsAddress, manager: config.ccmL2Address, feesEnabled: config.l2FeesEnabled, maxTotalWei: config.l2FeeMaxTotalWei, l1FeesEnabled: config.l1FeesEnabled, l1MaxTotalWei: config.l1FeeMaxTotalWei });
      return { deployment, error: '' };
    } catch (e) { return { deployment: null, error: (e as Error).message }; }
  }, [ready, mainnet, revision]);
  if (!ready) return <p role="status">Loading treasury configuration…</p>;
  if (parsed.error) return <p role="alert">{parsed.error}</p>;
  if (!parsed.deployment && !config.treasury) {
    if (mainnet) return <div className={styles.treasury}><TreasuryMainnetSetup key={resetVersion} wallet={wallet} target={target} onComplete={() => setRevision(x => x + 1)} />
      <TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} /></div>;
    if (shared && config.l1FeesEnabled && config.l2FeesEnabled) return <TreasuryTestnet wallet={wallet} target={target} bridgeL1={config.l1Bridge} bridgeL2={config.l2Bridge} token={config.treasuryTokenAddress} />;
  }
  if (!parsed.deployment) return <p role="status">Connect a configured paired treasury for this network.</p>;
  const deployment = parsed.deployment;
  return <div className={styles.treasury}><TreasuryConnected key={deployment.instance} deployment={deployment} wallet={wallet} payments guardAction={mainnet && !config.treasury ? async action => {
    await navigator.locks.request(mainnetSetupKey, { ifAvailable: true }, async lock => {
      if (!lock || loadMainnetManifest(localStorage)?.instance !== deployment.instance) throw new Error('The selected treasury changed or another action is running');
      await action();
    });
  } : undefined} />{mainnet && !config.treasury && <><TreasuryPairedHistory target={target} network={network} />
    <TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} /></>}</div>;
}
export function TreasuryDemo(props: { wallet: TreasuryWallet; ready: boolean }) {
  return <><TreasuryDemoView {...props} />{props.ready && <TreasurySourceVerification />}</>;
}
