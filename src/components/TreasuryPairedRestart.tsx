import { useEffect, useRef, useState } from 'react';
import { pairedSetupSnapshot, restartPairedSetup } from '../lib/treasury/pairedSetupState';
import type { PairedSetupSnapshot } from '../lib/treasury/pairedSetupState';
import type { SetupNetwork } from '../lib/treasury/mainnetSetup';
import type { TreasuryWallet } from './TreasuryConnected';
import styles from './TreasuryDemo.module.css';

export function TreasuryPairedRestart({ network, wallet, onRestart }: { network: SetupNetwork; wallet: TreasuryWallet; onRestart: () => void }) {
  const [snapshot, setSnapshot] = useState<PairedSetupSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    const refresh = () => {
      if (active.current) return;
      try { setSnapshot(pairedSetupSnapshot(localStorage, network)); }
      catch (e) { setSnapshot(null); setError((e as Error).message); }
    };
    refresh(); const timer = setInterval(refresh, 1000); window.addEventListener('storage', refresh);
    return () => { clearInterval(timer); window.removeEventListener('storage', refresh); };
  }, [network]);
  if (!snapshot?.state?.completed.length && !snapshot?.manifest && !error) return null;
  return <section className={styles.setupActions} aria-label="Treasury setup management">
    <button className="btn btn-outline" disabled={busy || !snapshot || !wallet.address || !wallet.provider || !!snapshot.blocked} onClick={() => {
      if (active.current || !snapshot) return;
      active.current = true; setBusy(true); setError('');
      void (async () => {
        if (!navigator.locks) throw new Error('Starting a new treasury requires browser Web Locks support');
        await navigator.locks.request(snapshot.key, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('Another treasury action is running. Wait for it to finish.');
          restartPairedSetup(localStorage, network, snapshot); onRestart();
        });
      })().catch(e => setError(e.message)).finally(() => { active.current = false; setBusy(false); });
    }}>{busy ? 'Starting new treasury…' : 'Start new treasury'}</button>
    <p>Start a new local setup. Your existing Safes remain on-chain, and their setup records are archived.</p>
    {!wallet.address && <p>Connect a wallet to start a new treasury.</p>}
    {snapshot?.blocked && <p role="status">{snapshot.blocked}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
