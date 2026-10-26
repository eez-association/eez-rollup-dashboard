import { formatUSDC, formatPercentage } from "../lib/treasury/payments";
import styles from "./TreasuryDemo.module.css";

type Split = { amount: bigint; fromL1: bigint; fromL2: bigint; error: string };
export function TreasuryFundingSplit({ l1Name, split, loading = false, onChange, onReset }: {
  l1Name: string; split?: Split; loading?: boolean; onChange: (fromL1: bigint) => void; onReset: () => void;
}) {
  const bps = split ? (split.fromL1 * 10_000n + split.amount / 2n) / split.amount : 0n;
  const placeholder = loading ? 'Reading Safe balances…' : 'Enter an amount';
  return <div className={styles.fundingSplit} aria-label="Safe contributions">
    <div className={styles.splitHeading}><label htmlFor="treasury-split">Payment split</label>
      <button type="button" className={styles.splitReset} onClick={onReset}>Use available funds</button>
    </div>
    <div className={styles.splitAmounts}>
      {(["l1", "l2"] as const).map(chain => <div key={chain}>
        <span className={styles.chainLabel} data-chain={chain}>{chain === "l1" ? l1Name : "EEZ-X"} Safe</span>
        <strong>{split ? `${formatPercentage(chain === "l1" ? bps : 10_000n - bps)}%` : "—"}</strong>
        <span>{split ? `${formatUSDC(chain === "l1" ? split.fromL1 : split.fromL2)} USDC` : placeholder}</span>
      </div>)}
    </div>
    <input id="treasury-split" className={styles.splitSlider} type="range" min="0" max="10000" step="1"
      value={Number(10_000n - bps)} disabled={!split} aria-label="EEZ-X share of payment"
      aria-valuetext={split ? `${l1Name} ${formatPercentage(bps)} percent, ${formatUSDC(split.fromL1)} USDC; EEZ-X ${formatPercentage(10_000n - bps)} percent, ${formatUSDC(split.fromL2)} USDC` : placeholder}
      onChange={event => { if (split) onChange(split.amount * (10_000n - BigInt(event.target.value)) / 10_000n); }} />
    <div className={styles.splitPresets} role="group" aria-label="EEZ-X share presets">
      {[25, 50, 75].map(percent => <button key={percent} type="button" disabled={!split}
        aria-pressed={!!split && split.fromL1 === split.amount * BigInt(100 - percent) / 100n}
        onClick={() => { if (split) onChange(split.amount * BigInt(100 - percent) / 100n); }}>{percent}%</button>)}
    </div>
    {split?.error && <p className={styles.splitError} role="status">{split.error}</p>}
  </div>;
}
