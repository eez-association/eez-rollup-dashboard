import { useEffect, useMemo, useState } from 'react';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import { TreasurySourceVerification } from './TreasurySourceVerification';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryMainnetNetwork } from './TreasuryMainnetNetwork';
import { TreasuryTestnet } from './TreasuryTestnet';
import { selectMainnetSetupNetwork, loadMainnetManifest, setupIdentity } from '../lib/treasury/mainnetSetup';
import { parseTreasuryConfig, requireDashboardTreasury } from '../lib/treasury/client';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';
import profile from '../lib/treasury/paired-testnet-network.json';
import { TreasuryPairedRestart } from './TreasuryPairedRestart';
import styles from './TreasuryDemo.module.css';
import { TreasuryNetworkSetup } from './TreasuryNetworkSetup';
import { savedNetworkKey } from '../lib/treasury/savedNetwork';

type TreasuryDemoProps = { wallet: TreasuryWallet; ready: boolean; onBridgeGas?: (destination: 'l1' | 'l2') => void };

function TreasuryDemoView({ wallet, ready, onBridgeGas }: TreasuryDemoProps) {
  const [revision, setRevision] = useState(0);
  const [resetVersion, setResetVersion] = useState(0);
  const network = ready ? selectMainnetSetupNetwork(L1_CHAIN.chainId, L2_CHAIN.chainId, config.rollupsAddress, config.ccmL2Address, config.l1Bridge, config.l2Bridge) : null;
  const mainnetSetupKey = network ? `eez:treasury:paired-setup:${setupIdentity(network)}` : '';
  const restart = () => { setResetVersion(x => x + 1); setRevision(x => x + 1); };
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || [mainnetSetupKey, `${mainnetSetupKey}:manifest`].includes(event.key)) setRevision(value => value + 1); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [mainnetSetupKey]);
  const target = useMemo(() => ({ l1: { rpc: config.l1Rpc, front: config.l1ProxyRpc, explorer: config.l1Explorer },
    l2: { rpc: config.l2Rpc, front: config.l2ProxyRpc, explorer: config.l2Explorer }, fees: { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei } }), [ready]);
  const shared = ready && BigInt(L1_CHAIN.chainId) === BigInt(profile.chains.l1.chainId) && BigInt(L2_CHAIN.chainId) === BigInt(profile.chains.l2.chainId)
    && config.rollupsAddress.toLowerCase() === profile.registry.toLowerCase() && config.ccmL2Address.toLowerCase() === profile.manager.toLowerCase();
  const parsed = useMemo(() => {
    if (!ready) return { deployment: null, error: '' };
    try {
      const value = config.treasury ?? (network ? loadMainnetManifest(localStorage, network) : null);
      if (!value) return { deployment: null, error: '' };
      const deployment = parseTreasuryConfig(value);
      if (!deployment.payments?.pair || deployment.payments.bridgeKind !== 'standard') throw new Error('This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.');
      requireDashboardTreasury(deployment, { l1ChainId: L1_CHAIN.chainId, l2ChainId: L2_CHAIN.chainId,
        l1Rpc: config.l1Rpc, l2Rpc: config.l2Rpc, l2Front: config.l2ProxyRpc, l1Front: config.l1ProxyRpc,
        registry: config.rollupsAddress, manager: config.ccmL2Address, feesEnabled: config.l2FeesEnabled, maxTotalWei: config.l2FeeMaxTotalWei, l1FeesEnabled: config.l1FeesEnabled, l1MaxTotalWei: config.l1FeeMaxTotalWei });
      return { deployment, error: '' };
    } catch (e) { return { deployment: null, error: (e as Error).message }; }
  }, [ready, network, revision]);
  if (!ready) return <p role="status">Loading treasury configuration…</p>;
  if (parsed.error) return <p role="alert">{parsed.error}</p>;
  if (!parsed.deployment && !config.treasury) {
    // Resume journals with their original immutable network identity. New setups
    // discover the selected dashboard deployment instead of using a chain list.
    if (network && localStorage.getItem(mainnetSetupKey)) return <div className={styles.treasury}>{network.assetProvisioning
      ? <TreasuryMainnetNetwork key={resetVersion} wallet={wallet} target={target} network={network} onComplete={() => setRevision(x => x + 1)} onBridgeGas={onBridgeGas} />
      : <TreasuryMainnetSetup key={resetVersion} wallet={wallet} target={target} network={network} onComplete={() => setRevision(x => x + 1)} onBridgeGas={onBridgeGas} />}
      <TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} /></div>;
    if (shared && config.l1FeesEnabled && config.l2FeesEnabled && localStorage.getItem(savedNetworkKey(target, config.l1Bridge, config.l2Bridge, config.treasuryTokenAddress)))
      return <TreasuryTestnet wallet={wallet} target={target} bridgeL1={config.l1Bridge} bridgeL2={config.l2Bridge} token={config.treasuryTokenAddress} onBridgeGas={onBridgeGas} />;
    return <TreasuryNetworkSetup dashboard={{ l1ChainId: L1_CHAIN.chainId, l2ChainId: L2_CHAIN.chainId, registry: config.rollupsAddress,
      manager: config.ccmL2Address, bridgeL1: config.l1Bridge, bridgeL2: config.l2Bridge }} target={target} wallet={wallet}
      token={config.treasuryTokenAddress} feesEnabled={config.l1FeesEnabled && config.l2FeesEnabled} onBridgeGas={onBridgeGas} />;
  }
  if (!parsed.deployment) return <p role="status">Connect a configured paired treasury for this network.</p>;
  const deployment = parsed.deployment;
  return <div className={styles.treasury}><TreasuryConnected key={deployment.instance} deployment={deployment} wallet={wallet} payments guardAction={network && !config.treasury ? async action => {
    await navigator.locks.request(mainnetSetupKey, { ifAvailable: true }, async lock => {
      if (!lock || loadMainnetManifest(localStorage, network)?.instance !== deployment.instance) throw new Error('The selected treasury changed or another action is running');
      await action();
    });
  } : undefined} />{network && !config.treasury && <TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} />}</div>;
}
export function TreasuryDemo(props: TreasuryDemoProps) {
  return <><TreasuryDemoView {...props} />{props.ready && <TreasurySourceVerification />}</>;
}
