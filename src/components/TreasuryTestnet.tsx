import { useEffect, useMemo, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { loadMainnetManifest, setupIdentity } from '../lib/treasury/mainnetSetup';
import type { MainnetTarget, SetupNetwork } from '../lib/treasury/mainnetSetup';
import { TestnetAsset } from '../lib/treasury/testnetAsset';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';

/** Network asset provisioning is separate from a user's six Safe setup steps. */
export function TreasuryTestnet({ wallet, target, bridgeL1, bridgeL2, token }: {
  wallet: TreasuryWallet; target: MainnetTarget; bridgeL1: string; bridgeL2: string; token: string;
}) {
  const [network, setNetwork] = useState<SetupNetwork | null>(null), [revision, setRevision] = useState(0), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setNetwork(null); setError('');
    if (!isAddress(token)) return;
    void (async () => {
      const asset = new TestnetAsset(target, await loadTreasuryArtifacts(), getAddress(bridgeL1), getAddress(bridgeL2));
      const selected = await asset.network(getAddress(token));
      if (alive) setNetwork(selected);
    })().catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [target, bridgeL1, bridgeL2, token]);
  const loaded = useMemo(() => {
    try { return { deployment: network ? loadMainnetManifest(localStorage, network) : null, error: '' }; }
    catch (e) { return { deployment: null, error: (e as Error).message }; }
  }, [network, revision]);
  if (!isAddress(token)) return <p role="status">Configure the treasury token before setting up your Safes.</p>;
  if (error || loaded.error) return <p role="alert">{error || loaded.error}</p>;
  if (!network) return <p role="status">Checking the configured treasury token…</p>;
  if (!loaded.deployment) return <TreasuryMainnetSetup wallet={wallet} target={target} network={network} onComplete={() => setRevision(x => x + 1)} />;
  const setupKey = `eez:treasury:paired-setup:${setupIdentity(network)}`;
  return <TreasuryConnected deployment={loaded.deployment} wallet={wallet} payments guardAction={async action => {
    await navigator.locks.request(setupKey, { ifAvailable: true }, async lock => {
      if (!lock || loadMainnetManifest(localStorage, network)?.instance !== loaded.deployment!.instance) throw new Error('The selected treasury changed or another action is running');
      await action();
    });
  }} />;
}
