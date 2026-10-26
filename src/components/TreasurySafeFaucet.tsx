import type { useTreasuryFaucet } from '../hooks/useTreasuryFaucet';
import styles from './TreasuryDemo.module.css';

export function TreasurySafeFaucet({ faucet, chain, l1Name, disabled }: {
  faucet: ReturnType<typeof useTreasuryFaucet>; chain: 'l1' | 'l2'; l1Name: string; disabled: boolean;
}) {
  if (!faucet.available) return null;
  const state = faucet.claims[chain];
  return <div className={styles.safeFaucetAction}>
    <button type="button" className="btn btn-sm btn-outline" title={`Claim 1,000 test USDC directly to this Safe. Gas is paid on ${l1Name}.`} disabled={disabled || faucet.busy[chain] || !!state.pending}
      onClick={() => void faucet.claim(chain)}>Get USDC from faucet</button>
    {faucet.busy[chain] && !state.pending && <p role="status">Preparing wallet request…</p>}
    {state.pending && <p role="status">Waiting for faucet confirmation…</p>}
    {!state.pending && state.last?.destination === chain && <p role="status">1,000 test USDC received.</p>}
  </div>;
}
