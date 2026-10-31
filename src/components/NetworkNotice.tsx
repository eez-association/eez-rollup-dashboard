import { config } from "../config";
import styles from "./NetworkNotice.module.css";

/** Shown on every view when the L1 is Ethereum mainnet: real funds, resettable devnet. */
export function NetworkNotice() {
  if (!config.l1IsEthereumMainnet) return null;
  return (
    <p className={styles.notice} role="note">
      <strong>Devnet on Ethereum mainnet.</strong> We may reset or change it without notice. Please start with small amounts.
    </p>
  );
}
