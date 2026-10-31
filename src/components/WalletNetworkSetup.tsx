import type { NetworkSetup, WalletNetwork } from '../hooks/useWalletNetworkSetup';
import styles from './WalletNetworkSetup.module.css';

export function WalletNetworkSetup({ address, chainId, network, setup, onConnect, disabled = false, knownNetwork = false }: {
  address: string | null; chainId: string | null; network: WalletNetwork; setup: NetworkSetup | null;
  onConnect: () => void; disabled?: boolean; knownNetwork?: boolean;
}) {
  if (!address) return null;
  const state = setup?.network.chainId === network.chainId ? setup : null;
  let connected = false;
  try { connected = chainId !== null && BigInt(chainId) === BigInt(network.chainId); } catch { /* Show setup for unknown network state. */ }
  if ((connected || knownNetwork) && state?.status !== 'connecting' && state?.status !== 'missing') return null;
  const busy = state?.status === 'connecting';
  return <div className={styles.setup} role="group" aria-label={`${network.chainName} wallet connection`}>
    <p role="status">{state && state.status !== 'ready' ? state.message
      : `Switch your wallet to ${network.chainName} to use this demo.`}</p>
    <button type="button" className="btn btn-solid" disabled={disabled || busy} onClick={onConnect}>
      {busy ? 'Check your wallet…' : `${state?.needsAdd ? 'Add' : 'Switch to'} ${network.chainName}`}
    </button>
  </div>;
}
