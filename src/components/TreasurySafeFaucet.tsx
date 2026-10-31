import type { useTreasuryFaucet } from '../hooks/useTreasuryFaucet';
import styles from './TreasuryDemo.module.css';

export function TreasurySafeFaucet({ faucet, chain, l1Name, disabled, assetLabel = 'Test USDC' }: {
  faucet: ReturnType<typeof useTreasuryFaucet>; chain: 'l1' | 'l2'; l1Name: string; disabled: boolean; assetLabel?: string;
}) {
  if (!faucet.available) return null;
  const state = faucet.claims[chain];
  const hash = state.pending ? state.pending.hash : state.last?.hash;
  return <div className={styles.safeFaucetAction}>
    <button type="button" className="btn btn-sm btn-solid" title={`Claim 1,000 ${assetLabel} directly to this Safe. Gas is paid on ${l1Name}.`} disabled={disabled || faucet.busy[chain] || !!state.pending}
      onClick={() => void faucet.claim(chain)}>Get {assetLabel === 'Test USDC' || assetLabel === 'USDC' ? 'USDC' : assetLabel}</button>
    {faucet.busy[chain] && !state.pending && <p role="status">Preparing wallet request…</p>}
    {state.pending && <p role="status">Waiting for faucet confirmation…</p>}
    {!state.pending && state.last && <p role="status">1,000 {assetLabel} received.</p>}
    {hash && <a className={styles.hint}
      href={`#/visualizer?mode=trace&chain=l1&tx=${hash}`} target="_blank" rel="noreferrer">View faucet transaction</a>}
  </div>;
}
