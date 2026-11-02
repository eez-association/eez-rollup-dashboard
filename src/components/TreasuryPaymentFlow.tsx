import { treasuryExplorer } from "../lib/treasury/mainnet";
import { useId, useEffect, useRef, useState } from "react";
import type { Intent, Outcome, TreasuryConfig } from "../lib/treasury/client";
import type { TreasurySettlement } from "../lib/treasury/settlement";
import { formatPercentage, formatUSDC } from "../lib/treasury/payments";
import { config } from "../config";
import styles from "./TreasuryDemo.module.css";

export function TreasuryChainLink({ deployment, chain, value, type = "tx", children, testId }: {
  deployment: TreasuryConfig; chain: "l1" | "l2"; value: string; type?: "tx" | "block" | "address"; children: React.ReactNode; testId?: string;
}) {
  const explorer = treasuryExplorer(deployment, chain, chain === "l1" ? config.l1Explorer : config.l2Explorer);
  return explorer ? <a href={`${explorer.replace(/\/$/, "")}/${type}/${value}`} target="_blank" rel="noopener noreferrer" title={value} data-testid={testId} data-hash={value}>{children}</a>
    : <span title={value} data-testid={testId} data-hash={value}>{children}</span>;
}

/** Connect actual node edges so branches stay joined when text wraps or the
 * layout switches direction. The HTML remains the accessible reading order. */
function FlowConnections({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const marker = useId();
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-flow-node]")];
    const draw = () => {
      const bounds = root.getBoundingClientRect();
      const [start, policy, first, second, end] = nodes.map(node => {
        const b = node.getBoundingClientRect();
        return { left: b.left - bounds.left, right: b.right - bounds.left, top: b.top - bounds.top, bottom: b.bottom - bounds.top,
          x: b.left - bounds.left + b.width / 2, y: b.top - bounds.top + b.height / 2 };
      });
      if (!start || !policy || !first || !second || !end) return;
      if (policy.left >= start.right) {
        const fork = (policy.right + first.left) / 2, join = (first.right + end.left) / 2;
        setPaths([
          `M ${start.right} ${start.y} H ${policy.left}`,
          ...[first, second].map(leg => `M ${policy.right} ${policy.y} H ${fork} V ${leg.y} H ${leg.left}`),
          ...[first, second].map(leg => `M ${leg.right} ${leg.y} H ${join} V ${end.y} H ${end.left}`),
        ]);
      } else {
        const fork = (policy.bottom + first.top) / 2, join = (Math.max(first.bottom, second.bottom) + end.top) / 2;
        const stacked = second.top >= first.bottom;
        setPaths([
          `M ${start.x} ${start.bottom} V ${policy.top}`,
          ...[first, second].map(leg => stacked
            ? `M ${policy.x} ${policy.bottom} V ${fork} H 8 V ${leg.y} H ${leg.left}`
            : `M ${policy.x} ${policy.bottom} V ${fork} H ${leg.x} V ${leg.top}`),
          ...[first, second].map(leg => stacked
            ? `M ${leg.right} ${leg.y} H ${bounds.width - 8} V ${join} H ${end.x} V ${end.top}`
            : `M ${leg.x} ${leg.bottom} V ${join} H ${end.x} V ${end.top}`),
        ]);
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(root); nodes.forEach(node => observer.observe(node)); draw();
    return () => observer.disconnect();
  }, [container]);
  return <svg className={styles.flowConnections} aria-hidden="true">
    <defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="currentColor" strokeWidth="1.5" /></marker></defs>
    {paths.map((path, index) => <path key={index} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" markerEnd={`url(#${marker})`} />)}
  </svg>;
}

export function TreasuryPaymentFlow({ deployment, intent, outcome, settlement, sourceTestId }: {
  deployment: TreasuryConfig; intent: Intent; outcome: Outcome; settlement?: TreasurySettlement | null; sourceTestId?: string;
}) {
  const diagram = useRef<HTMLDivElement>(null);
  const payment = intent.payment!, amounts = outcome.contributions!;
  const assetLabel = deployment.network?.discovered?.symbol ?? "USDC";
  const names = { l1: deployment.l1.chainId === 10200 ? "Chiado" : deployment.l1.chainId === 1 ? "Ethereum" : "L1", l2: "EEZ-X" };
  const source = payment.source ?? "l2", destination = payment.destination;
  const transport = intent.submissionChain ?? source;
  const relayHash = transport === "l1" && source === "l2" ? outcome.execution?.l1 ?? outcome.hash ?? intent.hash : undefined;
  const sourceHash = outcome.execution?.[source] ?? outcome.hash ?? intent.hash;
  const executionL2 = outcome.execution?.l2 ?? (source === "l2" ? sourceHash : undefined);
  const total = BigInt(amounts.fromL1) + BigInt(amounts.fromL2);
  if (payment.kind === "transfer") return <figure className={styles.paymentFlow} aria-label="Transfer flow">
    <figcaption>How this transfer completed</figcaption>
    <div className={styles.transferFlow}>
      <div className={styles.flowNode}><span className={styles.chainLabel} data-chain="l1">{names.l1} Safe</span><strong>{formatUSDC(total)} {assetLabel} sent</strong>
        <TreasuryChainLink deployment={deployment} chain="l1" type="address" value={deployment.safeL1}>{deployment.safeL1.slice(0, 8)}…{deployment.safeL1.slice(-6)}</TreasuryChainLink>
        {sourceHash && <TreasuryChainLink deployment={deployment} chain="l1" value={sourceHash} testId={sourceTestId}>Safe transaction</TreasuryChainLink>}
        {outcome.sourceBlock && <TreasuryChainLink deployment={deployment} chain="l1" type="block" value={outcome.sourceBlock}>{names.l1} #{BigInt(outcome.sourceBlock).toLocaleString()}</TreasuryChainLink>}</div>
      <span aria-hidden="true">→</span><div className={styles.flowNode}><strong>Shared bridge</strong><p>Locked on {names.l1} and minted on EEZ-X.</p>
        {executionL2 && <TreasuryChainLink deployment={deployment} chain="l2" value={executionL2}>EEZ-X delivery transaction</TreasuryChainLink>}</div>
      <span aria-hidden="true">→</span><div className={styles.flowNode}><span className={styles.chainLabel} data-chain="l2">EEZ-X Safe</span><strong>Received {formatUSDC(total)} {assetLabel}</strong>
        <TreasuryChainLink deployment={deployment} chain="l2" type="address" value={deployment.safeL2}>{deployment.safeL2.slice(0, 8)}…{deployment.safeL2.slice(-6)}</TreasuryChainLink>
        {outcome.block && <TreasuryChainLink deployment={deployment} chain="l2" type="block" value={outcome.block}>EEZ-X #{BigInt(outcome.block).toLocaleString()}</TreasuryChainLink>}</div>
    </div><p className={styles.hint}>Funds stayed within your treasury. Payment budgets and allowances were unchanged.</p>
  </figure>;
  return <figure className={styles.paymentFlow} aria-label="Payment flow">
    <figcaption>How this payment completed</figcaption>
    <div className={styles.flowDiagram} ref={diagram}>
      <FlowConnections container={diagram} />
      <div className={styles.flowNode} data-flow-node="authorization">
        <span className={styles.chainLabel} data-chain={source}>Start · {names[source]} Safe</span>
        <strong>Owners verified</strong>
        <p>{source === "l2" ? `EEZ-X read the current ${names.l1} owners and approval threshold.` : `Your ${names.l1} Safe checked its owners’ signatures.`}</p>
        <div className={styles.flowLinks}>
          {sourceHash && <TreasuryChainLink deployment={deployment} chain={source} value={sourceHash} testId={sourceTestId}>{names[source]} Safe transaction</TreasuryChainLink>}
          {relayHash && <TreasuryChainLink deployment={deployment} chain="l1" value={relayHash}>{names.l1} submission</TreasuryChainLink>}
          {source === "l2" && (relayHash || settlement) && <TreasuryChainLink deployment={deployment} chain="l1" value={relayHash ?? settlement!.l1Transaction}>{names.l1} owner verification</TreasuryChainLink>}
        </div>
      </div>
      <div className={styles.flowNode} data-flow-node="policy">
        <span className={styles.chainLabel} data-chain="l2">EEZ-X · Treasury policy</span>
        <strong>Shared budget checked</strong>
        <p>{formatUSDC(total)} {assetLabel} counted against the shared limit.</p>
        <div className={styles.flowLinks}>
          {executionL2 && <TreasuryChainLink deployment={deployment} chain="l2" value={executionL2}>EEZ-X policy transaction</TreasuryChainLink>}
          {outcome.block && <TreasuryChainLink deployment={deployment} chain="l2" type="block" value={outcome.block}>EEZ-X #{BigInt(outcome.block).toLocaleString()}</TreasuryChainLink>}
        </div>
      </div>
      <div className={styles.flowBranches} aria-label="Funding split">{(["l1", "l2"] as const).map(chain => {
        const amount = BigInt(chain === "l1" ? amounts.fromL1 : amounts.fromL2);
        // Relayed mirrors also execute Ethereum token calls inside the source
        // transaction; posting the queued entry is a separate transaction.
        const hash = chain === "l1" ? outcome.execution?.l1 ?? (transport === "l1" ? relayHash ?? sourceHash : settlement?.l1Transaction) : executionL2;
        return <div key={chain} className={`${styles.flowNode} ${styles.flowContribution}`} data-flow-node={chain} data-chain={chain}>
          <span className={styles.chainLabel} data-chain={chain}><TreasuryChainLink deployment={deployment} chain={chain} type="address" value={chain === "l1" ? deployment.safeL1 : deployment.safeL2}>{names[chain]} Safe</TreasuryChainLink></span>
          <strong>{formatUSDC(amount)} {assetLabel}</strong>
          <span className={styles.flowShare}>{total ? formatPercentage(amount * 10000n / total) : "0"}% of payment</span>
          <p>{amount === 0n ? "Not used for this payment" : chain === destination ? `Direct to ${names[destination]} recipient` : `Bridge to ${names[destination]} recipient`}</p>
          {amount > 0n && hash && <div className={styles.flowLinks}><TreasuryChainLink deployment={deployment} chain={chain} value={hash}>{names[chain]} payment transaction</TreasuryChainLink></div>}
        </div>;
      })}</div>
      <div className={`${styles.flowNode} ${styles.flowRecipient}`} data-flow-node="recipient">
        <span className={styles.chainLabel} data-chain={destination}>{names[destination]} recipient</span>
        <strong>Received {formatUSDC(total)} {assetLabel}</strong>
        <TreasuryChainLink deployment={deployment} chain={destination} type="address" value={payment.recipient}>{payment.recipient.slice(0, 8)}…{payment.recipient.slice(-6)}</TreasuryChainLink>
        <div className={styles.flowLinks}>
          {settlement ? <>
            <TreasuryChainLink deployment={deployment} chain="l1" value={settlement.l1Transaction}>{names.l1} settlement transaction</TreasuryChainLink>
            <TreasuryChainLink deployment={deployment} chain="l1" type="block" value={settlement.l1Block}>{names.l1} #{BigInt(settlement.l1Block).toLocaleString()}</TreasuryChainLink>
          </> : <span className={styles.hint}>{names.l1} settlement link {settlement === null ? "unavailable" : "loading…"}</span>}
        </div>
      </div>
    </div>
  </figure>;
}
