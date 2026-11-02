import { useEffect, useRef, useState } from 'react';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import type { TreasuryConfig } from '../lib/treasury/client';
import type { AssetJournal, TestnetAsset } from '../lib/treasury/testnetAsset';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import { readSafeFaucet, readSafeFaucetClaim, safeFaucetKey, saveReconciledFaucet, verifiedSafeFaucet } from '../lib/treasury/safeFaucet';
import type { TreasuryWallet } from '../components/TreasuryConnected';
import type { TreasuryActionGuard } from '../lib/treasury/setupState';

type Chain = 'l1' | 'l2';
export function useTreasuryFaucet(deployment: TreasuryConfig, wallet: TreasuryWallet, onConfirmed: () => Promise<unknown>, guardAction?: TreasuryActionGuard) {
  const key = safeFaucetKey(deployment);
  // Parents may reparse the same saved manifest when wallet balances/chain change.
  // Only a changed configuration invalidates a pending claim, not object identity.
  const deploymentIdentity = JSON.stringify(deployment);
  const [asset, setAsset] = useState<TestnetAsset | null>(null);
  const [claims, setClaims] = useState<Record<Chain, AssetJournal>>({ l1: {}, l2: {} });
  const [busy, setBusy] = useState({ l1: false, l2: false }), [error, setError] = useState('');
  const [detectionError, setDetectionError] = useState(''), [trackingError, setTrackingError] = useState('');
  const generation = useRef(0);
  const active = useRef({ l1: false, l2: false }), selected = useRef(wallet), confirmed = useRef(onConfirmed);
  selected.current = wallet; confirmed.current = onConfirmed;
  const persist = (chain: Chain, next: AssetJournal, updateUI = true) => {
    readSafeFaucet(deployment, JSON.stringify(next));
    localStorage.setItem(safeFaucetKey(deployment, chain), JSON.stringify(next));
    if (updateUI) setClaims(previous => ({ ...previous, [chain]: next }));
  };
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    generation.current++;
    active.current = { l1: false, l2: false }; setBusy({ l1: false, l2: false });
    setAsset(null); setClaims({ l1: {}, l2: {} }); setError(''); setDetectionError(''); setTrackingError('');
    const detect = async () => {
      try {
        if (deployment.environment !== 'dashboard-testnet' && deployment.network?.discovered?.kind !== 'demo') return;
        const verified = await verifiedSafeFaucet(deployment, await loadTreasuryArtifacts());
        if (!alive) return;
        if (verified) {
          setClaims({ l1: readSafeFaucetClaim(deployment, localStorage, 'l1'), l2: readSafeFaucetClaim(deployment, localStorage, 'l2') });
          setAsset(verified);
        }
        setDetectionError('');
      } catch (e) {
        if (alive) {
          setDetectionError(`Test-token funding check unavailable: ${(e as Error).message}. Retrying automatically.`);
          timer = setTimeout(detect, 5000);
        }
      }
    };
    void detect();
    return () => { alive = false; generation.current++; clearTimeout(timer); };
  }, [deploymentIdentity, key]);
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const poll = async () => {
      try { await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock || !alive) return;
        const failures: string[] = [];
        let didConfirm = false;
        for (const chain of ['l1', 'l2'] as const) {
          if (active.current[chain]) continue;
          try {
            const saved = readSafeFaucetClaim(deployment, localStorage, chain), next = await asset.reconcile(saved);
            if (!alive) return;
            saveReconciledFaucet(deployment, localStorage, chain, saved, next);
            setClaims(previous => ({ ...previous, [chain]: next }));
            if (saved.pending && !next.pending) { setError(''); didConfirm = true; }
          } catch (e) { failures.push(`${chain === 'l1' ? 'L1' : 'EEZ-X'} faucet: ${(e as Error).message}`); }
        }
        if (alive && didConfirm) await confirmed.current();
        if (alive) setTrackingError(failures.join(' '));
      }); } catch (e) { if (alive) setTrackingError((e as Error).message); }
    };
    void poll(); const timer = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [asset, deploymentIdentity, key]);
  const claim = async (chain: Chain) => {
    if (active.current[chain] || !asset) return;
    const scope = generation.current;
    const assertActive = () => { if (generation.current !== scope) throw new Error('The treasury screen changed; the unsent faucet request was cancelled.'); };
    active.current[chain] = true; setBusy(previous => ({ ...previous, [chain]: true })); setError('');
    try {
      // Both claims submit on L1. Queue wallet prompts, not their confirmations;
      // each destination keeps its own pending journal and recovery state.
      await navigator.locks.request(key, async () => {
        const action = async () => {
          assertActive();
          const saved = readSafeFaucetClaim(deployment, localStorage, chain);
          if (saved.pending) throw new Error('This Safe already has a recorded faucet request');
          const current = selected.current;
          if (!current.provider || !current.address) throw new Error('Connect your wallet');
          if (!await current.switchToL1()) throw new Error('Wallet switch cancelled');
          assertActive();
          const other = readSafeFaucetClaim(deployment, localStorage, chain === 'l1' ? 'l2' : 'l1').pending;
          if (other && other.sender.toLowerCase() === current.address.toLowerCase()) {
            let ready = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              assertActive();
              if (BigInt(await asset.rpc<Hex>('l1', 'eth_getTransactionCount', [current.address, 'pending'])) > BigInt(other.nonce)) { ready = true; break; }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (!ready) throw new Error('The previous wallet request is not yet visible in the transaction queue. Retry this Safe’s claim shortly.');
          }
          const recipient = chain === 'l1' ? deployment.safeL1 : deployment.safeL2;
          const prepared = await asset.prepare(chain, deployment.payments!.tokenL1, recipient, current.provider);
          assertActive();
          if (other && other.sender.toLowerCase() === prepared.pending.sender.toLowerCase() && BigInt(prepared.pending.nonce) <= BigInt(other.nonce))
            throw new Error('The wallet nonce has not advanced. Retry this Safe’s claim shortly.');
          if (selected.current.address !== current.address || selected.current.provider !== current.provider) throw new Error('Wallet changed during preparation');
          await asset.wallet(current.provider, getAddress(current.address));
          assertActive();
          if (prepared.expiresAt && BigInt(prepared.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('Fee quote expired');
          persist(chain, { ...saved, pending: prepared.pending });
          try {
            const hash = await current.provider.request({ method: 'eth_sendTransaction', params: [prepared.request] });
            if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Wallet response missing; tracking will continue');
            persist(chain, { ...saved, pending: { ...prepared.pending, hash: hash as Hex } }, generation.current === scope);
          } catch (e) { if ((e as { code?: number }).code === 4001) persist(chain, saved, generation.current === scope); throw e; }
        };
        await (guardAction ? guardAction(action) : action());
      });
    } catch (e) { if (generation.current === scope) setError((e as Error).message); }
    finally { if (generation.current === scope) { active.current[chain] = false; setBusy(previous => ({ ...previous, [chain]: false })); } }
  };
  return { available: !!asset, busy, claims, error: [error, detectionError, trackingError].filter(Boolean).join(' '), claim };
}
