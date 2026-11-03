import { useEffect, useRef, useState } from "react";
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
  requiredChainId?: string;
  /** The wallet's selected chain. The switch action uses it, so the label must too. */
  walletChainId?: string | null;
  attentionRequest?: number;
}

const labels: Record<ComposerDetection["status"], string> = {
  idle: "Checking Composer…",
  detected: "Composer detected",
  "not-detected": "Composer not detected",
  mismatch: "Composer network mismatch",
  unavailable: "Unable to verify RPC",
  "unsupported-network": "Select a dashboard network",
};

export function ComposerStatus({ connection, checking, onRecheck, walletName, onConnectNetwork, connectingNetwork = false, setupMessage, variant = "menu", requiredChainId, walletChainId, attentionRequest = 0 }: Props) {
  const [copy, setCopy] = useState("");
  const panel = useRef<HTMLElement>(null);
  const isChain = (id: string) => {
    try { return connection.chainId !== null && BigInt(id) === BigInt(connection.chainId); }
    catch { return false; }
  };
  // "idle" means no result yet: not a failure, so it must not raise the red notice.
  const known = connection.status !== "idle";
  const requiredMismatch = !!requiredChainId && known && !isChain(requiredChainId);
  // The wallet itself is on another network (not just its RPC answering for one).
  const walletOnRequired = () => {
    try { return !!walletChainId && !!requiredChainId && BigInt(walletChainId) === BigInt(requiredChainId); }
    catch { return false; }
  };
  // The wallet's chain is known before the first Composer result, so this need not wait.
  const switchNeeded = walletChainId === undefined ? requiredMismatch : !!requiredChainId && !walletOnRequired();
  const l1 = requiredChainId ? BigInt(requiredChainId) === BigInt(L1_CHAIN.chainId) : isChain(L1_CHAIN.chainId);
  const supported = !!requiredChainId || l1 || isChain(L2_CHAIN.chainId);
  const rpcUrl = supported ? (l1 ? config.l1ProxyRpc : config.l2ProxyRpc) : "";
  const network = supported ? (l1 ? config.l1NetworkName : config.rollupName) : "";
  const chainId = supported ? BigInt(requiredChainId ?? connection.chainId!).toString() : "";
  const ethereumMainnet = l1 && chainId === "1";
  const rabby = /rabby/i.test(walletName ?? "");
  const metamask = /metamask/i.test(walletName ?? "");
  // Background rechecks keep the last result on screen; only a known problem warns.
  const warning = requiredMismatch || switchNeeded || connectingNetwork || (known && connection.status !== "detected");
  const failed = connection.status === "unavailable";

  useEffect(() => { setCopy(""); }, [rpcUrl]);
  useEffect(() => {
    if (!attentionRequest || !panel.current) return;
    const details = panel.current.querySelector("details");
    if (details) details.open = true;
    panel.current.focus({ preventScroll: true });
    panel.current.scrollIntoView({ behavior: "auto", block: "center" });
  }, [attentionRequest]);

  if (variant === "notice" && !warning) return null;
  const steps = <>
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
  </>;
  // Rabby cannot be configured by the dashboard, so copying the URL is its main action.
  const copyFirst = rabby && !switchNeeded;
  const rpcBlock = warning && rpcUrl && <div className={styles.rpc}>
    <span className={styles.rpcLabel}>Composer RPC URL for {network}</span>
    <code>{rpcUrl}</code>
    <button type="button" className={`btn ${copyFirst ? "btn-primary" : "btn-outline"} btn-sm`} onClick={() => {
      if (!navigator.clipboard) { setCopy("Select the URL to copy"); return; }
      void navigator.clipboard.writeText(rpcUrl).then(() => setCopy("Copied"), () => setCopy("Select the URL to copy"));
    }}>{copy || "Copy RPC URL"}</button>
  </div>;
  const lead = requiredChainId
    ? "Bridging is blocked. Your wallet must send bridge transactions through the EEZ Composer RPC."
    : "Your wallet is not using the EEZ Composer RPC.";
  return <section className={`${styles.panel} ${variant === "notice" ? styles.notice : ""} ${warning ? styles.warning : ""} ${failed ? styles.failed : ""}`}
    ref={panel} tabIndex={-1} aria-label="Wallet Composer connection">
    <div className={styles.heading} role="status">
      <span className={!warning ? styles.detected : ""}>{connectingNetwork ? "Waiting for your wallet…" : switchNeeded ? "Select the bridge source network" : labels[connection.status]}</span>
      {network && <span className={`${styles.network} ${l1 ? styles.l1 : styles.l2}`}>{network}</span>}
    </div>
    {variant === "notice" && warning && <div className={styles.required}>
      <p>{lead}{!switchNeeded && rpcUrl && <> Set the RPC for {network} in your wallet to the URL below, then click Recheck.</>}</p>
      {switchNeeded && <ol className={styles.requiredSteps}>
        <li>Switch your wallet to <strong>{network}</strong>.</li>
        <li>Set that network’s RPC to the Composer URL below, then click <strong>Recheck</strong>.</li>
      </ol>}
    </div>}
    {variant === "notice" ? <>
      {rpcBlock}
      <details className={styles.settings}>
        <summary>{rabby ? "Rabby RPC setup" : metamask ? "MetaMask RPC setup" : "Wallet RPC settings"}</summary>{steps}
      </details>
    </> : <>{steps}{rpcBlock}</>}
    <div className={styles.actions}>
      {warning && rpcUrl && onConnectNetwork && <button type="button" className={`btn ${copyFirst ? "btn-outline" : "btn-primary"} btn-sm`}
        onClick={() => { void onConnectNetwork(); }} disabled={connectingNetwork || checking}>
        {connectingNetwork ? "Check your wallet…" : switchNeeded ? "Switch to source network" : "Connect network"}
      </button>}
      <button type="button" className="btn btn-outline btn-sm" onClick={onRecheck} disabled={checking || connectingNetwork}
        aria-label="Recheck wallet Composer connection">{checking ? "Checking…" : "Recheck"}</button>
    </div>
    {warning && setupMessage && <p className={styles.detail} role="status">{setupMessage}</p>}
    {variant === "menu" && warning && <p className={styles.detail}>Checks wallet reads. Wallet simulation and submission may use another route.</p>}
  </section>;
}
