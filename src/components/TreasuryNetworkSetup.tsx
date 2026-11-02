import { useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { DeploymentIO } from '../lib/treasury/deploymentIO';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { assertSameInfrastructure, dashboardNetworkKey, discoverInfrastructure, discoverToken, matchesDashboard, matchingDeployerChecks, validateDiscoveredToken } from '../lib/treasury/networkDiscovery';
import type { DashboardNetwork, DiscoveredAsset, NetworkCheck } from '../lib/treasury/networkDiscovery';
import { loadMainnetManifest, readMainnetSetup, setupIdentity } from '../lib/treasury/mainnetSetup';
import type { SetupNetwork, MainnetTarget } from '../lib/treasury/mainnetSetup';
import { TestnetAsset, readAssetJournal } from '../lib/treasury/testnetAsset';
import type { AssetJournal } from '../lib/treasury/testnetAsset';
import { guardWalletRequests } from '../lib/treasury/walletRequestScope';
import { requireDashboardTreasury } from '../lib/treasury/client';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';
import { TreasuryPairedRestart } from './TreasuryPairedRestart';
import styles from './TreasuryDemo.module.css';

type Props = { dashboard: DashboardNetwork; target: MainnetTarget; wallet: TreasuryWallet; token: string; feesEnabled: boolean; onBridgeGas?: (chain: 'l1' | 'l2') => void };
/** Network selection is local to this dashboard. Every send uses a journal and
 * a lock; discovery itself never asks the wallet to sign or deploy anything. */
export function TreasuryNetworkSetup(props: Props) {
  const key = dashboardNetworkKey(props.dashboard);
  return <NetworkSetup key={key} {...props} storageKey={key} />;
}
function NetworkSetup({ dashboard, target, wallet, token, feesEnabled, onBridgeGas, storageKey }: Props & { storageKey: string }) {
  const [checks, setChecks] = useState<NetworkCheck[]>([]), [checking, setChecking] = useState(true);
  const [base, setBase] = useState<SetupNetwork | null>(null), [network, setNetwork] = useState<SetupNetwork | null>(null);
  const [candidate, setCandidate] = useState(token), [assetInfo, setAssetInfo] = useState<SetupNetwork | null>(null);
  const [tokenChecking, setTokenChecking] = useState(false), [tokenError, setTokenError] = useState('');
  const [tokenAttempt, setTokenAttempt] = useState(0);
  const assetSymbols = useRef(new Map<string, DiscoveredAsset>());
  const [journal, setJournal] = useState<AssetJournal>({});
  const [engine, setEngine] = useState<TestnetAsset | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [attempt, setAttempt] = useState(0);
  const selected = useRef(wallet); selected.current = wallet;
  const active = useRef(false), alive = useRef(true), generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [target]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const baseKey = `${storageKey}:base`, networkKey = `${storageKey}:network`, journalKey = `${storageKey}:asset`;
  const setupKey = network ? `eez:treasury:paired-setup:${setupIdentity(network)}` : '';
  const persist = (next: AssetJournal) => { readAssetJournal(JSON.stringify(next)); localStorage.setItem(journalKey, JSON.stringify(next)); if (alive.current) setJournal(next); };
  useEffect(() => {
    let current = true;
    setChecking(true); setError(''); setNetwork(null); setEngine(null);
    void (async () => {
      const savedJournal = readAssetJournal(localStorage.getItem(journalKey));
      const recorded = savedJournal.pending ?? savedJournal.failed?.request;
      const artifacts = await loadTreasuryArtifacts(recorded ? { build: recorded.build } : undefined);
      const io = new DeploymentIO(target, artifacts);
      const saved = JSON.parse(localStorage.getItem(baseKey) ?? 'null') as SetupNetwork | null;
      if (saved && (!saved.discovered || !matchesDashboard(saved, dashboard))) throw new Error('Saved network belongs to a different dashboard. Preserve it for recovery.');
      const [result, deployers] = await Promise.all([discoverInfrastructure(io, dashboard, saved ?? undefined), matchingDeployerChecks(io)]);
      if (!current) return;
      setChecks([...result.checks, ...deployers]); setJournal(savedJournal);
      if (!result.network) { setBase(null); return; }
      const n = result.network;
      // Serialize first discovery across tabs; never replace another tab's anchors.
      await navigator.locks.request(storageKey, async () => {
        if (!current) return;
        const stored = localStorage.getItem(baseKey);
        if (stored && JSON.stringify(JSON.parse(stored)) !== JSON.stringify(n)) throw new Error('Network selection changed in another tab. Check again.');
        localStorage.setItem(baseKey, JSON.stringify(n));
      });
      const d = new TestnetAsset(target, artifacts, getAddress(dashboard.bridgeL1), getAddress(dashboard.bridgeL2), n);
      let complete = JSON.parse(localStorage.getItem(networkKey) ?? 'null') as SetupNetwork | null;
      if (complete) {
        if (!complete.discovered || !matchesDashboard(complete, dashboard)) throw new Error('Saved token selection belongs to a different network.');
        assertSameInfrastructure(complete, n);
        await validateDiscoveredToken(io, complete);
      }
      let inspected: SetupNetwork | null = null;
      if (!complete && !savedJournal.pending && (savedJournal.token || token)) {
        try {
          const chosen = savedJournal.token ?? token;
          if (!isAddress(chosen)) throw new Error('The configured treasury token is not a valid L1 address.');
          inspected = await discoverToken(io, n, getAddress(chosen), false);
          assetSymbols.current.set(chosen.toLowerCase(), inspected.discovered!);
          if (token && !savedJournal.token && inspected.contracts.wrappedUSDC.address !== zeroAddress) {
            await navigator.locks.request(storageKey, async () => {
              if (!current) return;
              if (localStorage.getItem(networkKey) || readAssetJournal(localStorage.getItem(journalKey)).pending) throw new Error('Token selection changed in another tab. Check again.');
              localStorage.setItem(networkKey, JSON.stringify(inspected)); complete = inspected;
            });
          }
        } catch (e) { if (current) setError((e as Error).message); }
      }
      if (!current) return;
      setBase(n); setEngine(d); setNetwork(complete); setAssetInfo(inspected); setCandidate(complete?.contracts.usdcProxy.address ?? savedJournal.token ?? token);
    })().catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [storageKey, target, token, attempt]);
  useEffect(() => {
    if (!base || !engine || network || journal.pending || !isAddress(candidate)) {
      setTokenChecking(false); setTokenError('');
      return;
    }
    if (assetInfo?.contracts.usdcProxy.address.toLowerCase() === candidate.toLowerCase() && assetInfo.contracts.wrappedUSDC.address !== zeroAddress) {
      setTokenChecking(false); setTokenError('');
      return;
    }
    let current = true, timer: ReturnType<typeof setTimeout>;
    setTokenChecking(true); setTokenError('');
    const inspect = async () => {
      try {
        const result = await discoverToken(engine, base, getAddress(candidate), false, assetSymbols.current.get(candidate.toLowerCase()));
        if (!current) return;
        assetSymbols.current.set(candidate.toLowerCase(), result.discovered!);
        setAssetInfo(result); setTokenError('');
        // Also notice initialization performed elsewhere, without another click.
        if (result.contracts.wrappedUSDC.address === zeroAddress) timer = setTimeout(inspect, 3000);
      } catch (e) {
        if (current) { setAssetInfo(null); setTokenError((e as Error).message); }
      } finally { if (current) setTokenChecking(false); }
    };
    timer = setTimeout(() => void inspect(), 200);
    return () => { current = false; clearTimeout(timer); };
  }, [base, engine, candidate, network, journal.pending, tokenAttempt]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (active.current) return;
      if (event.key === null || event.key === baseKey || event.key === networkKey) setAttempt(x => x + 1);
      else if (event.key === setupKey || event.key === `${setupKey}:manifest`) setRevision(x => x + 1);
      else if (event.key === journalKey) {
        try { setJournal(readAssetJournal(localStorage.getItem(journalKey))); } catch (e) { setError((e as Error).message); }
      }
    };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, [storageKey, setupKey]);
  useEffect(() => {
    if (!engine || !journal.pending) return;
    let current = true;
    const poll = async () => {
      try { await navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
        if (!lock || !current || active.current) return;
        const saved = readAssetJournal(localStorage.getItem(journalKey)), next = await engine.reconcile(saved, { recordFailure: true });
        if (!current) return;
        if (JSON.stringify(saved) !== JSON.stringify(next)) {
          persist(next);
          if (saved.pending && !next.pending) {
            setCandidate(next.token ?? ''); setError('');
          }
        }
      }); } catch (e) { if (current) setError((e as Error).message); }
    };
    void poll(); const timer = setInterval(poll, 3000);
    return () => { current = false; clearInterval(timer); };
  }, [engine, journal.pending]);
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try { await navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is updating this treasury setup.');
      if (!alive.current) return;
      await fn();
    }); } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  };
  const inspectToken = () => void run(async () => {
    if (!base || !engine || !isAddress(candidate)) throw new Error('Enter the L1 token contract address.');
    if (readAssetJournal(localStorage.getItem(journalKey)).pending) throw new Error('Wait for the recorded token transaction to finish.');
    if (localStorage.getItem(networkKey)) throw new Error('Token selection changed in another tab. Check again.');
    await engine.validate();
    const n = await discoverToken(engine, base, getAddress(candidate), true, assetSymbols.current.get(candidate.toLowerCase()));
    if (!alive.current) return;
    setAssetInfo(n);
    if (n.contracts.wrappedUSDC.address === zeroAddress) return;
    localStorage.setItem(networkKey, JSON.stringify(n)); setNetwork(n);
  });
  const send = (kind: 'deploy' | 'l2', retry = false) => void run(async () => {
    if (!engine || !base || !feesEnabled) throw new Error('Finish network checks before deploying a demo token.');
    const current = selected.current;
    const scope = generation.current;
    const assertActive = () => {
      if (!alive.current || generation.current !== scope || selected.current.address !== current.address || selected.current.provider !== current.provider) throw new Error('Wallet or setup screen changed; the unsent request was cancelled.');
    };
    if (!current.address || !current.provider) throw new Error('Connect your wallet to continue.');
    if (!await current.switchToL1()) throw new Error('Wallet network switch cancelled.');
    assertActive();
    const saved = readAssetJournal(localStorage.getItem(journalKey));
    if (saved.pending || localStorage.getItem(networkKey)) throw new Error('Setup changed in another tab. Check again.');
    if (retry) {
      if (saved.failed?.request.kind !== kind) throw new Error('The failed token transaction changed. Check again.');
      await engine.confirmFailure(saved); assertActive();
    } else if (saved.failed) throw new Error('Use the retry button for the recorded failed transaction.');
    const chosen = kind === 'l2' ? getAddress(retry ? saved.failed!.request.token! : candidate) : undefined;
    const prepared = await engine.prepare(kind, chosen, getAddress(current.address), guardWalletRequests(current.provider, assertActive));
    await engine.wallet(current.provider, getAddress(current.address)); assertActive();
    if (prepared.expiresAt && BigInt(prepared.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error('Fee quote expired. Try again.');
    // Keep each failed request before replacing it with a new, explicitly approved attempt.
    if (saved.failed) localStorage.setItem(`${journalKey}:failed:${saved.failed.request.hash}`, JSON.stringify(saved.failed));
    const next = { ...saved, failed: undefined, ...(chosen ? { token: chosen } : {}), pending: prepared.pending };
    persist(next);
    try {
      const hash = await current.provider.request({ method: 'eth_sendTransaction', params: [prepared.request] });
      if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Wallet response missing. Automatic tracking will continue.');
      persist({ ...next, pending: { ...prepared.pending, hash: hash as Hex } });
    } catch (e) { if ((e as { code?: number }).code === 4001) persist(saved); throw e; }
  });
  const unusedSelection = () => {
    const saved = readAssetJournal(localStorage.getItem(journalKey));
    if (saved.pending || saved.failed || saved.token || saved.last) throw new Error('A token transaction is recorded. Keep this network selection for recovery.');
    const raw = localStorage.getItem(networkKey);
    const selectedNetwork = raw ? JSON.parse(raw) as SetupNetwork : null;
    const selectedKey = selectedNetwork ? `eez:treasury:paired-setup:${setupIdentity(selectedNetwork)}` : baseKey;
    if (localStorage.getItem(selectedKey) && selectedNetwork || localStorage.getItem(`${selectedKey}:manifest`))
      throw new Error('Treasury setup has started. Keep its saved network selection for recovery.');
    return selectedKey;
  };
  let canRefreshUnused = false;
  try { unusedSelection(); canRefreshUnused = !!localStorage.getItem(baseKey); } catch { /* Never discard a transaction or setup journal. */ }
  const refreshUnused = () => void run(async () => {
    const selectedKey = unusedSelection();
    await navigator.locks.request(selectedKey, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is starting this treasury. Wait for it to finish.');
      if (unusedSelection() !== selectedKey) throw new Error('The selected treasury changed. Check again.');
      localStorage.removeItem(networkKey); localStorage.removeItem(baseKey);
      setNetwork(null); setBase(null); setAssetInfo(null); setAttempt(x => x + 1);
    });
  });
  let savedManifestText: string | null = null, savedSetupText: string | null = null, savedStorageError = '';
  try {
    if (network) { savedManifestText = localStorage.getItem(`${setupKey}:manifest`); savedSetupText = localStorage.getItem(setupKey); }
  } catch (e) { savedStorageError = (e as Error).message; }
  const { deployment, setupStarted, savedError } = useMemo(() => {
    try {
      if (savedStorageError) throw new Error(savedStorageError);
      const deployment = network ? loadMainnetManifest(localStorage, network) : null;
      const setupStarted = !!network && !!readMainnetSetup(savedSetupText, network);
      if (deployment) requireDashboardTreasury(deployment, { ...dashboard, l1Rpc: target.l1.rpc, l2Rpc: target.l2.rpc,
        l1Front: target.l1.front, l2Front: target.l2.front, feesEnabled, l1FeesEnabled: feesEnabled, maxTotalWei: target.fees.l2, l1MaxTotalWei: target.fees.l1 });
      return { deployment, setupStarted, savedError: '' };
    } catch (e) { return { deployment: null, setupStarted: false, savedError: (e as Error).message }; }
  }, [network, setupKey, target, feesEnabled, storageKey, revision, savedManifestText, savedSetupText, savedStorageError]);
  const locked = checking || busy || !!journal.pending;
  const canSetup = !!network && feesEnabled && !checking && !error && !savedError;
  const failedChecks = checks.filter(check => check.error);
  const showReadiness = checking || failedChecks.length > 0 || !feesEnabled || !!error || !!savedError;
  const showToken = base && !network && !checking || journal.failed || journal.pending || network;
  const selectedAsset = assetInfo?.contracts.usdcProxy.address.toLowerCase() === candidate.toLowerCase() ? assetInfo : null;
  const tokenReady = !!selectedAsset && selectedAsset.contracts.wrappedUSDC.address !== zeroAddress;
  const needsInitialization = selectedAsset?.discovered?.kind === 'demo' && !tokenReady;
  const hasToken = !!token || !!journal.token || !!selectedAsset;
  return <div className={styles.treasury}>
    {showReadiness && <section className={styles.card} aria-label="Treasury network readiness">
      {checking ? <p role="status">Checking network contracts and Composer…</p> : <>
      <h3>Treasury setup needs attention</h3>
      {(failedChecks.length > 0 || !feesEnabled) && <ul>{failedChecks.map(c => <li key={c.label}>{c.label}: {c.error}</li>)}
        {!feesEnabled && <li>Missing: enable settlement fee quotes for both chains in the dashboard configuration.</li>}</ul>}
      {(error || savedError) && <p role="alert">{error || savedError}</p>}
      <button type="button" className="btn btn-outline" disabled={checking || busy} onClick={() => setAttempt(x => x + 1)}>Check again</button>
      {canRefreshUnused && (error || checks.slice(0, 2).some(c => c.error)) && <button type="button" className="btn btn-outline" disabled={checking || busy} onClick={refreshUnused}>Refresh unused network setup</button>}
      </>}
    </section>}
    {showToken && <section className={styles.card} aria-label="Treasury token">
      {base && !network && !checking && <div className={styles.fields}>
        <label htmlFor="treasury-token">L1 token address</label>
        <input id="treasury-token" value={candidate} disabled={locked} placeholder="0x…" onChange={e => { setCandidate(e.target.value); setAssetInfo(null); setTokenError(''); }} />
        <p className={styles.hint}>Choose a standard ERC-20 with 6 decimals, or create a demo token. The L2 token is found through the bridge.</p>
        {tokenChecking && <p role="status">Checking token availability…</p>}
        {tokenError && <>
          <p role="alert">{tokenError}</p>
          <button type="button" className="btn btn-outline" disabled={locked || tokenChecking || !engine || !isAddress(candidate)} onClick={() => setTokenAttempt(value => value + 1)}>Retry token check</button>
        </>}
        {selectedAsset && !tokenReady && <p role="status">{selectedAsset.discovered?.symbol} is not available on L2 yet. {needsInitialization ? 'Initialize it on L2 to continue.' : 'Bridge this token once using the dashboard; availability updates automatically.'}</p>}
        {needsInitialization && !journal.failed && <button type="button" className="btn btn-solid" disabled={locked || tokenChecking || !wallet.address || !feesEnabled} onClick={() => send('l2')}>Initialize on L2</button>}
        <button type="button" className={`btn btn-solid ${styles.useToken}`} disabled={locked || tokenChecking || !engine || !tokenReady} onClick={inspectToken}>Use this token</button>
        {!journal.pending && !journal.failed && <>
          <button type="button" className="btn btn-outline" disabled={locked || !engine || !wallet.address || !feesEnabled} onClick={() => send('deploy')}>{hasToken ? 'Deploy a new demo token' : 'Deploy demo token'}</button>
        </>}
        <p className={styles.hint}>The demo token has no monetary value. Deployment and L2 initialization each require a wallet confirmation and gas; initialization sends 1,000 demo tokens to your wallet on L2.</p>
        {!wallet.address && <div>{wallet.walletOptions.map(option => <button type="button" key={option.id} className="btn btn-outline" onClick={() => void wallet.connect(option.id)}>Connect {option.name}</button>)}</div>}
      </div>}
      {journal.failed && <div role="status">
        <p>{journal.failed.request.kind === 'deploy' ? 'Demo token deployment' : 'Demo token initialization'} failed on-chain. Its transaction record is saved. Nothing will be sent again automatically.</p>
        <code>{journal.failed.request.hash}</code>
        {journal.failed.request.kind !== 'l1' && <button type="button" className="btn btn-outline" disabled={locked || !engine || !wallet.address || !feesEnabled || !!network}
          onClick={() => send(journal.failed!.request.kind as 'deploy' | 'l2', true)}>{journal.failed.request.kind === 'deploy' ? 'Retry demo token deployment' : 'Retry demo token initialization'}</button>}
      </div>}
      {journal.pending && <p role="status">{journal.pending.kind === 'deploy' ? 'Demo token deployment' : 'Demo token initialization'} pending. {journal.pending.hash ? <code>{journal.pending.hash}</code> : 'Waiting for the wallet transaction; tracking continues automatically.'}</p>}
      {network && <p>Token: <strong>{network.discovered?.symbol}</strong> · <code>{network.contracts.usdcProxy.address}</code></p>}
      {network && !setupStarted && !journal.pending && <button type="button" className="btn btn-outline" disabled={locked} onClick={() => void run(async () => {
        if (readMainnetSetup(localStorage.getItem(setupKey), network)) throw new Error('Treasury setup has already started in another tab.');
        setCandidate(network.contracts.usdcProxy.address);
        localStorage.removeItem(networkKey); setNetwork(null); setAssetInfo(null);
      })}>Choose another token</button>}
    </section>}
    {canSetup && (deployment ? <TreasuryConnected key={deployment.instance} deployment={deployment} wallet={wallet} payments guardAction={async action => {
      await navigator.locks.request(setupKey, { ifAvailable: true }, async lock => {
        if (!lock || loadMainnetManifest(localStorage, network!)?.instance !== deployment.instance) throw new Error('Treasury changed or another action is running.');
        await action();
      });
    }} /> : <TreasuryMainnetSetup key={`${setupKey}:${revision}`} network={network!} target={target} wallet={wallet} onComplete={() => setRevision(x => x + 1)} onBridgeGas={onBridgeGas} />)}
    {canSetup && <TreasuryPairedRestart network={network!} wallet={wallet} onRestart={() => setRevision(x => x + 1)} />}
  </div>;
}
