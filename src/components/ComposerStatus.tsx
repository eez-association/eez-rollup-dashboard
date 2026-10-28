import { useEffect, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import type { ComposerDetection } from "../lib/composerDiscovery";
import styles from "./ComposerStatus.module.css";

interface Props {
  connection: ComposerDetection;
  checking: boolean;
  onRecheck: () => void;
  walletName?: string | null;
  onConnectNetwork?: () => Promise<void>;
  connectingNetwork?: boolean;
  setupMessage?: string;
  variant?: "menu" | "notice";
}

const labels: Record<ComposerDetection["status"], string> = {
  idle: "Checking Composer…",
  detected: "Composer detected",
  "not-detected": "Composer not detected",
  mismatch: "Composer network mismatch",
  unavailable: "Unable to verify RPC",
  "unsupported-network": "Select a dashboard network",
};

export function ComposerStatus({ connection, checking, onRecheck, walletName, onConnectNetwork, connectingNetwork = false, setupMessage, variant = "menu" }: Props) {
  const [copy, setCopy] = useState("");
  const isChain = (id: string) => {
    try { return connection.chainId !== null && BigInt(id) === BigInt(connection.chainId); }
    catch { return false; }
  };
  const l1 = isChain(L1_CHAIN.chainId);
  const supported = l1 || isChain(L2_CHAIN.chainId);
  const rpcUrl = supported ? (l1 ? config.l1ProxyRpc : config.l2ProxyRpc) : "";
  const network = supported ? (l1 ? config.l1NetworkName : config.rollupName) : "";
  const chainId = supported ? BigInt(connection.chainId!).toString() : "";
  const ethereumMainnet = l1 && chainId === "1";
  const rabby = /rabby/i.test(walletName ?? "");
  const metamask = /metamask/i.test(walletName ?? "");
  const warning = ["not-detected", "mismatch", "unavailable"].includes(connection.status);
  const failed = connection.status === "unavailable";

  useEffect(() => { setCopy(""); }, [rpcUrl]);

  if (variant === "notice" && !warning) return null;
  const instructions = <>
    {warning && <p className={styles.detail}>{connection.detail}</p>}
    {connection.status === "unsupported-network" && <p className={styles.detail}>
      Switch to {config.l1NetworkName} or {config.rollupName} to check the wallet RPC.
    </p>}
    {warning && rpcUrl && (rabby ? <ol className={styles.instructions}>
      <li>Open Rabby → <strong>Settings</strong> → <strong>Modify RPC URL</strong>.</li>
      <li>{ethereumMainnet ? <>
        Edit the <strong>Ethereum</strong> entry (chain ID 1) using its pencil icon. If there is no entry, click <strong>Modify RPC URL</strong>, select <strong>Integrated Network</strong>, then <strong>Ethereum</strong>.
      </> : <>
        Edit the RPC entry for <strong>{network}</strong> (chain ID {chainId}) using its pencil icon. If there is no entry, click <strong>Modify RPC URL</strong> and select that network. Check the <strong>Custom Network</strong> tab if it is not under <strong>Integrated Network</strong>.
      </>}</li>
      <li>Copy the URL below, paste it into <strong>RPC URL</strong>, and click <strong>Save</strong>. Make sure the entry’s toggle is on.</li>
      <li>Return to this dashboard and click <strong>Recheck</strong>.</li>
    </ol> : metamask ? <ol className={styles.instructions}>
      <li>Click <strong>Connect network</strong> and approve adding the Composer RPC in MetaMask. The dashboard checks the connection again automatically.</li>
      <li>If the warning remains, MetaMask may have saved Composer without making it the default RPC. Open MetaMask’s top-right menu → <strong>Networks</strong>. On mobile, open the network dropdown on the <strong>Tokens</strong> tab.</li>
      <li>Find <strong>{ethereumMainnet ? "Ethereum Mainnet" : network}</strong> (chain ID {chainId}), open its three-dot menu, and choose <strong>Edit</strong>.</li>
      <li>Open <strong>Default RPC URL</strong> (<strong>RPC URL</strong> on mobile). If the Composer URL below is missing, choose <strong>Add RPC URL</strong>, paste it, give it the nickname <strong>EEZ Composer</strong>, and click <strong>Save</strong>.</li>
      <li>Select the saved Composer URL as this network’s <strong>default RPC</strong> and save the network. Keep the existing chain ID and currency symbol.</li>
      <li>Return to this dashboard and click <strong>Recheck</strong>. The warning disappears when the wallet’s active RPC responds as Composer.</li>
    </ol> : <p className={styles.detail}>
      Set this URL for {network} in your wallet’s network/RPC settings, save, then recheck.
    </p>)}
    {warning && rpcUrl && <div className={styles.rpc}>
      <code>{rpcUrl}</code>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => {
        if (!navigator.clipboard) { setCopy("Select the URL to copy"); return; }
        void navigator.clipboard.writeText(rpcUrl).then(() => setCopy("Copied"), () => setCopy("Select the URL to copy"));
      }}>{copy || "Copy RPC URL"}</button>
    </div>}
  </>;
  return <section className={`${styles.panel} ${variant === "notice" ? styles.notice : ""} ${warning ? styles.warning : ""} ${failed ? styles.failed : ""}`}
    aria-label="Wallet Composer connection">
    <div className={styles.heading} role="status">
      <span className={connection.status === "detected" ? styles.detected : ""}>{labels[connection.status]}</span>
      {network && <span className={`${styles.network} ${l1 ? styles.l1 : styles.l2}`}>{network}</span>}
    </div>
    {variant === "notice" ? <details className={styles.settings}>
      <summary>{rabby ? "Rabby RPC setup" : metamask ? "MetaMask RPC setup" : "Wallet RPC settings"}</summary>{instructions}
    </details> : instructions}
    <div className={styles.actions}>
      {warning && rpcUrl && onConnectNetwork && <button type="button" className="btn btn-primary btn-sm"
        onClick={() => { void onConnectNetwork(); }} disabled={connectingNetwork || checking}>
        {connectingNetwork ? "Check your wallet…" : "Connect network"}
      </button>}
      <button type="button" className="btn btn-outline btn-sm" onClick={onRecheck} disabled={checking || connectingNetwork}
        aria-label="Recheck wallet Composer connection">{checking ? "Checking…" : "Recheck"}</button>
    </div>
    {warning && setupMessage && <p className={styles.detail} role="status">{setupMessage}</p>}
    {variant === "menu" && warning && <p className={styles.detail}>Checks wallet reads. Wallet simulation and submission may use another route.</p>}
  </section>;
}
