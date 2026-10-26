import type { useTreasuryFaucet } from '../hooks/useTreasuryFaucet';
import styles from './TreasuryDemo.module.css';

export function TreasurySafeFaucet({ faucet, chain, l1Name, disabled }: {
  faucet: ReturnType<typeof useTreasuryFaucet>; chain: 'l1' | 'l2'; l1Name: string; disabled: boolean;
}) {
  if (!faucet.available) return null;
  return <div>
    <button type="button" className="btn btn-sm btn-outline" disabled={disabled || faucet.busy || !!faucet.state.pending}
      onClick={() => void faucet.claim(chain)}>Get USDC from faucet</button>
    <p className={styles.hint}>1,000 test USDC to this Safe. Confirm in your wallet; gas is paid on {l1Name}.</p>
    {faucet.state.pending?.kind === chain && <p role="status">Waiting for faucet confirmation…</p>}
    {!faucet.state.pending && faucet.state.last?.destination === chain && <p role="status">1,000 test USDC received.</p>}
  </div>;
}
