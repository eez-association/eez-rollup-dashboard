import { useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { loadMainnetManifest, setupIdentity } from '../lib/treasury/mainnetSetup';
import type { MainnetTarget, SetupNetwork } from '../lib/treasury/mainnetSetup';
import { TestnetAsset } from '../lib/treasury/testnetAsset';
import { savedNetwork, savedNetworkKey } from '../lib/treasury/savedNetwork';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';
import { TreasuryPairedHistory } from './TreasuryPairedHistory';
import { TreasuryPairedRestart } from './TreasuryPairedRestart';
import styles from './TreasuryDemo.module.css';

/** Network asset provisioning is separate from a user's six Safe setup steps. */
export function TreasuryTestnet({ wallet, target, bridgeL1, bridgeL2, token, onBridgeGas }: {
  wallet: TreasuryWallet; target: MainnetTarget; bridgeL1: string; bridgeL2: string; token: string; onBridgeGas?: (destination: 'l1' | 'l2') => void;
}) {
  const cacheKey = savedNetworkKey(target, bridgeL1, bridgeL2, token);
  const [selection, setSelection] = useState<{ key: string; network: SetupNetwork | null; verified?: boolean }>(() => ({ key: cacheKey, network: savedNetwork(localStorage, cacheKey, bridgeL1, bridgeL2, token, target) }));
  const network = selection.key === cacheKey ? selection.network : null;
  const [revision, setRevision] = useState(0), [error, setError] = useState('');
  const validation = useRef<Promise<SetupNetwork> | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const restart = () => { setResetVersion(x => x + 1); setRevision(x => x + 1); };
  useEffect(() => {
    let alive = true;
    setSelection(previous => previous.key === cacheKey ? (previous.verified ? { ...previous, verified: false } : previous) : { key: cacheKey, network: savedNetwork(localStorage, cacheKey, bridgeL1, bridgeL2, token, target) }); setError('');
    if (!isAddress(token)) return;
    const pending = (async () => {
      const asset = new TestnetAsset(target, await loadTreasuryArtifacts(), getAddress(bridgeL1), getAddress(bridgeL2));
      const selected = await asset.network(getAddress(token));
      return selected;
    })();
    validation.current = pending;
    void pending.then(selected => {
      if (!alive) return;
      try { localStorage.setItem(cacheKey, JSON.stringify(selected)); } catch { /* Storage is optional for faster display. */ }
      setSelection(previous => previous.key === cacheKey && previous.network && setupIdentity(previous.network) === setupIdentity(selected)
        ? { ...previous, verified: true } : { key: cacheKey, network: selected, verified: true });
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; if (validation.current === pending) validation.current = null; };
  }, [target, bridgeL1, bridgeL2, token, cacheKey]);
  const loaded = useMemo(() => {
    try { return { deployment: network ? loadMainnetManifest(localStorage, network) : null, error: '' }; }
    catch (e) { return { deployment: null, error: (e as Error).message }; }
  }, [network, revision]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || network && [ `eez:treasury:paired-setup:${setupIdentity(network)}`, `eez:treasury:paired-setup:${setupIdentity(network)}:manifest` ].includes(event.key)) setRevision(x => x + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [network]);
  if (!isAddress(token)) return <p role="status">Test USDC is not configured for this deployment. Provision the token and its EEZ-X bridge representation before setting up your Safes.</p>;
  if (error || loaded.error) return <p role="alert">{error || loaded.error}</p>;
  if (!network) return <p role="status">Checking the configured treasury token…</p>;
  if (!loaded.deployment) return <div className={styles.treasury}><TreasuryMainnetSetup key={resetVersion} wallet={wallet} target={target} network={network} onComplete={() => setRevision(x => x + 1)} onBridgeGas={onBridgeGas} />
    <TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} /></div>;
  const setupKey = `eez:treasury:paired-setup:${setupIdentity(network)}`;
  return <div className={styles.treasury}><TreasuryConnected key={loaded.deployment.instance} deployment={loaded.deployment} wallet={wallet} payments networkReady={selection.key === cacheKey && selection.verified === true} guardAction={async action => {
    const pending = validation.current;
    if (!pending || setupIdentity(await pending) !== setupIdentity(network) || validation.current !== pending) throw new Error('The treasury network changed; wait for its current validation before continuing.');
    await navigator.locks.request(setupKey, { ifAvailable: true }, async lock => {
      const current = loadMainnetManifest(localStorage, network);
      if (!lock || validation.current !== pending || !current || JSON.stringify(current) !== JSON.stringify(loaded.deployment)) throw new Error('The selected treasury changed or another action is running');
      await action();
    });
  }} /><TreasuryPairedHistory target={target} network={network} /><TreasuryPairedRestart network={network} wallet={wallet} onRestart={restart} /></div>;
}
