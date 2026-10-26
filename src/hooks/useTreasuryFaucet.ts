import { useEffect, useRef, useState } from 'react';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import type { TreasuryConfig } from '../lib/treasury/client';
import type { AssetJournal, TestnetAsset } from '../lib/treasury/testnetAsset';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { readSafeFaucet, safeFaucetKey, verifiedSafeFaucet } from '../lib/treasury/safeFaucet';
import type { TreasuryWallet } from '../components/TreasuryConnected';

export function useTreasuryFaucet(deployment: TreasuryConfig, wallet: TreasuryWallet, onConfirmed: () => Promise<unknown>) {
  const key = safeFaucetKey(deployment);
  const [asset, setAsset] = useState<TestnetAsset | null>(null), [state, setState] = useState<AssetJournal>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false), selected = useRef(wallet), confirmed = useRef(onConfirmed);
  selected.current = wallet; confirmed.current = onConfirmed;
  const persist = (next: AssetJournal) => { readSafeFaucet(deployment, JSON.stringify(next)); localStorage.setItem(key, JSON.stringify(next)); setState(next); };
  useEffect(() => {
    let alive = true;
    setAsset(null); setState({}); setError('');
    void (async () => {
      if (deployment.environment !== 'dashboard-testnet') return;
      const verified = await verifiedSafeFaucet(deployment, await loadTreasuryArtifacts());
      if (alive && verified) { setState(readSafeFaucet(deployment, localStorage.getItem(key))); setAsset(verified); }
    })().catch(() => { /* An unverified token must never expose a mint button. */ });
    return () => { alive = false; };
  }, [deployment, key]);
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const poll = async () => {
      if (active.current) return;
      try { await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock || !alive || active.current) return;
        const saved = readSafeFaucet(deployment, localStorage.getItem(key));
        const next = await asset.reconcile(saved);
        if (!alive) return;
        persist(next);
        if (saved.pending && !next.pending) { setError(''); await confirmed.current(); }
      }); } catch (e) { if (alive) setError((e as Error).message); }
    };
    void poll(); const timer = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [asset, deployment, key]);
  const claim = async (chain: 'l1' | 'l2') => {
    if (active.current || !asset) return;
    active.current = true; setBusy(true); setError('');
    try { await navigator.locks.request(key, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is updating this faucet request');
      const saved = readSafeFaucet(deployment, localStorage.getItem(key));
      if (saved.pending) throw new Error('Wait for the recorded faucet transaction');
      const current = selected.current;
      if (!current.provider || !current.address) throw new Error('Connect your wallet');
      if (!await current.switchToL1()) throw new Error('Wallet switch cancelled');
      const recipient = chain === 'l1' ? deployment.safeL1 : deployment.safeL2;
      const prepared = await asset.prepare(chain, deployment.payments!.tokenL1, recipient, current.provider);
      if (selected.current.address !== current.address || selected.current.provider !== current.provider) throw new Error('Wallet changed during preparation');
      await asset.wallet(current.provider, getAddress(current.address));
      if (prepared.expiresAt && BigInt(prepared.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('Fee quote expired');
      persist({ ...saved, pending: prepared.pending });
      try {
        const hash = await current.provider.request({ method: 'eth_sendTransaction', params: [prepared.request] });
        if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Wallet response missing; tracking will continue');
        persist({ ...saved, pending: { ...prepared.pending, hash: hash as Hex } });
      } catch (e) { if ((e as { code?: number }).code === 4001) persist(saved); throw e; }
    }); } catch (e) { setError((e as Error).message); }
    finally { active.current = false; setBusy(false); }
  };
  return { available: !!asset, busy, state, error, claim };
}
