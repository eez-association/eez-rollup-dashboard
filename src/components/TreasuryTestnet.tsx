import { useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { loadMainnetManifest, setupIdentity } from '../lib/treasury/mainnetSetup';
import type { MainnetTarget, SetupNetwork } from '../lib/treasury/mainnetSetup';
import { readAssetJournal, TestnetAsset, testnetAssetKey } from '../lib/treasury/testnetAsset';
import type { AssetJournal, AssetPending } from '../lib/treasury/testnetAsset';
import { retainSourceRequests } from '../lib/treasury/sourceVerification';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { TreasuryConnected } from './TreasuryConnected';
import type { TreasuryWallet } from './TreasuryConnected';
import styles from './TreasuryDemo.module.css';

export function TreasuryTestnet({ wallet, target, bridgeL1, bridgeL2 }: { wallet: TreasuryWallet; target: MainnetTarget; bridgeL1: string; bridgeL2: string }) {
  const key = testnetAssetKey(bridgeL1, bridgeL2), profileKey = `${key}:network`;
  const [network, setNetwork] = useState<SetupNetwork | null>(null), [revision, setRevision] = useState(0), [faucet, setFaucet] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const journal = readAssetJournal(localStorage.getItem(key));
      if (journal.pending) return;
      const raw = localStorage.getItem(profileKey); if (!raw) return;
      const saved = JSON.parse(raw) as SetupNetwork;
      const asset = new TestnetAsset(target, await loadTreasuryArtifacts(), getAddress(bridgeL1), getAddress(bridgeL2));
      const current = await asset.network(getAddress(saved.contracts.usdcProxy.address));
      if (setupIdentity(current) !== setupIdentity(saved)) throw new Error('The saved testnet asset or bridge bindings changed');
      if (alive) setNetwork(current);
    })().catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [key, target]);
  const loaded = useMemo(() => {
    try { return { deployment: network ? loadMainnetManifest(localStorage, network) : null, error: '' }; }
    catch (e) { return { deployment: null, error: (e as Error).message }; }
  }, [network, revision]);
  const deployment = loaded.deployment;
  if (error || loaded.error) return <p role="alert">{error || loaded.error}</p>;
  if (!network || faucet) return <PairedTestnetAsset wallet={wallet} target={target} bridgeL1={bridgeL1} bridgeL2={bridgeL2}
    onReady={selected => { localStorage.setItem(profileKey, JSON.stringify(selected)); setNetwork(selected); setFaucet(false); }}
    onBack={network ? () => setFaucet(false) : undefined} />;
  if (!deployment) return <TreasuryMainnetSetup wallet={wallet} target={target} network={network} onComplete={() => setRevision(x => x + 1)} />;
  const setupKey = `eez:treasury:paired-setup:${setupIdentity(network)}`;
  return <div className={styles.treasury}>
    <button className="btn btn-outline" onClick={() => setFaucet(true)}>Get Test USDC</button>
    <TreasuryConnected deployment={deployment} wallet={wallet} payments guardAction={async action => {
      await navigator.locks.request(setupKey, { ifAvailable: true }, async lock => {
        if (!lock || loadMainnetManifest(localStorage, network)?.instance !== deployment.instance) throw new Error('The selected treasury changed or another action is running');
        await action();
      });
    }} />
  </div>;
}

export function PairedTestnetAsset({ wallet, target, bridgeL1, bridgeL2, onReady, onBack }: { wallet: TreasuryWallet; target: MainnetTarget; bridgeL1: string; bridgeL2: string; onReady: (network: SetupNetwork) => void; onBack?: () => void }) {
  const key = testnetAssetKey(bridgeL1, bridgeL2);
  const [asset, setAsset] = useState<TestnetAsset | null>(null), [state, setState] = useState<AssetJournal>({});
  const [token, setToken] = useState(''), [recipient, setRecipient] = useState(wallet.address ?? ''), [destination, setDestination] = useState<'l1' | 'l2'>('l2');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef(false), selected = useRef(wallet); selected.current = wallet;
  const persist = (next: AssetJournal) => { readAssetJournal(JSON.stringify(next)); localStorage.setItem(key, JSON.stringify(next)); setState(next); };
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = new TestnetAsset(target, await loadTreasuryArtifacts(), getAddress(bridgeL1), getAddress(bridgeL2));
      await next.validate();
      const saved = readAssetJournal(localStorage.getItem(key));
      if (alive) { setAsset(next); setState(saved); setToken(saved.token ?? ''); if (saved.pending) { setRecipient(saved.pending.recipient); if (saved.pending.kind !== 'deploy') setDestination(saved.pending.kind); } }
    })().catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [target, key]);
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const poll = async () => {
      if (active.current) return;
      try { await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock || !alive || active.current) return;
        const saved = readAssetJournal(localStorage.getItem(key));
        const next = await asset.reconcile(saved);
        if (!alive) return;
        if (saved.pending?.hash && !next.pending) retainSourceRequests(localStorage, [{ build: saved.pending.build, chainId: 10200, transactionHash: saved.pending.hash }]);
        persist(next); if (next.token) setToken(next.token);
      }); } catch (e) { if (alive) setError((e as Error).message); }
    };
    void poll(); const timer = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [asset, key]);
  const run = async (action: (saved: AssetJournal) => Promise<void>) => {
    if (active.current) return; active.current = true; setBusy(true); setError('');
    try { await navigator.locks.request(key, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is updating this token request');
      const saved = readAssetJournal(localStorage.getItem(key));
      if (saved.pending) throw new Error('Wait for the recorded wallet request');
      await action(saved);
    }); } catch (e) { setError((e as Error).message); } finally { active.current = false; setBusy(false); }
  };
  const submit = (kind: AssetPending['kind']) => run(async saved => {
    const current = selected.current;
    if (!current.provider || !current.address || !asset) throw new Error('Connect your wallet');
    if (!await current.switchToL1()) throw new Error('Wallet switch cancelled');
    const chosenRecipient = kind === 'deploy' ? getAddress(current.address) : getAddress(recipient);
    const prepared = await asset.prepare(kind, saved.token, chosenRecipient, current.provider);
    if (selected.current.address !== current.address || selected.current.provider !== current.provider) throw new Error('Wallet changed during preparation');
    await asset.wallet(current.provider, getAddress(current.address));
    if (prepared.expiresAt && BigInt(prepared.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('Fee quote expired');
    persist({ ...saved, pending: prepared.pending });
    try {
      const hash = await current.provider.request({ method: 'eth_sendTransaction', params: [prepared.request] });
      if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Wallet response missing; tracking will continue');
      persist({ ...saved, pending: { ...prepared.pending, hash: hash as Hex } });
    } catch (e) { if ((e as { code?: number }).code === 4001) persist(saved); throw e; }
  });
  const locked = busy || !!state.pending;
  return <section className={styles.treasury} aria-label="Paired test-token setup"><h2>Test USDC</h2>
    <p>Each claim sends exactly 1,000 test tokens. The configured normal bridges deliver claims to EEZ-X.</p>
    {!state.token && <section className={styles.card}>
      <button className="btn btn-solid" disabled={locked || !asset || !wallet.address} onClick={() => void submit('deploy')}>Deploy Test USDC</button>
      <label htmlFor="paired-test-token">Existing Test USDC address</label><input id="paired-test-token" value={token} disabled={locked} onChange={e => setToken(e.target.value)} />
      <button disabled={locked || !asset || !isAddress(token)} onClick={() => void run(async saved => { await asset!.validateToken(getAddress(token)); persist({ ...saved, token: getAddress(token) }); })}>Use this token</button>
    </section>}
    {state.token && <section className={styles.card}>
      <p>Test USDC: {state.token}</p><p>Amount: 1,000 Test USDC</p>
      <label htmlFor="paired-claim-recipient">Recipient address</label><input id="paired-claim-recipient" value={recipient} disabled={locked} onChange={e => setRecipient(e.target.value)} />
      <label htmlFor="paired-claim-destination">Destination network</label><select id="paired-claim-destination" value={destination} disabled={locked} onChange={e => setDestination(e.target.value as 'l1' | 'l2')}><option value="l1">Chiado</option><option value="l2">EEZ-X</option></select>
      <button className="btn btn-solid" disabled={locked || !asset || !wallet.address || !isAddress(recipient)} onClick={() => void submit(destination)}>Claim 1,000 Test USDC</button>
      {!onBack && <><p>Make one claim on EEZ-X before continuing to create its wrapped token. You can claim directly to a wallet or Safe.</p>
        <button disabled={locked || !asset} onClick={() => void run(async saved => onReady(await asset!.network(saved.token as Address)))}>Continue to Safe setup</button></>}
    </section>}
    {state.pending && <p role="status">Waiting for the recorded transaction and canonical confirmation. Do not submit it again.</p>}
    {state.last && !state.pending && <p role="status">1,000 Test USDC delivered on {state.last.destination === 'l1' ? 'Chiado' : 'EEZ-X'}.</p>}
    {error && <p role="alert">{error}</p>}
    {onBack && <button onClick={onBack}>Back to treasury</button>}
  </section>;
}
