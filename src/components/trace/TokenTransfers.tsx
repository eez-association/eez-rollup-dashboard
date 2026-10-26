import type { TraceChain, TraceModel, TraceTokenTransfer } from "../../../trace-decoder/service/types";
import styles from "./TokenTransfers.module.css";

// Experimental ERC20 notes, ported from the standalone viewer. Only Transfer events seen in both
// the trace and the committed receipt reach the model; amounts describe events, not net balance changes.
const short = (value: string) => value.slice(0, 6) + "…" + value.slice(-4);
const action = { mint: "Minted", burn: "Burned", transfer: "Sent" } as const;

/** Exact decimal formatting from the raw integer; never assumes 18 decimals. */
export function tokenAmount(transfer: TraceTokenTransfer): string {
  if (transfer.decimals == null) return transfer.amount + " raw units";
  const digits = transfer.amount.padStart(transfer.decimals + 1, "0");
  const whole = transfer.decimals ? digits.slice(0, -transfer.decimals) : digits;
  const fraction = transfer.decimals ? digits.slice(-transfer.decimals).replace(/0+$/, "") : "";
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
}

/** A decoded contract name or the transaction sender for an address on one chain, if known. */
function partyName(model: TraceModel, chain: TraceChain, address: string): string | null {
  const same = (value: string | null | undefined) => (value || "").toLowerCase() === address.toLowerCase();
  const node = model.nodes.find(node => node.chain === chain && same(node.address) && node.kind !== "ghost" && node.contract !== "Unknown contract");
  if (node) return node.contract;
  return model.transactions.some(tx => tx.chain === chain && same(tx.from)) ? "Transaction sender" : null;
}

/** Height a card needs for its notes (two shown, then a "+N more" line). */
export const tokenNotesHeight = (count: number) => count ? Math.min(2, count) * 64 + (count > 2 ? 20 : 0) : 0;

export function TokenNotes({ model, chain, transfers, compact = false }: {
  model: TraceModel; chain: TraceChain; transfers: TraceTokenTransfer[]; compact?: boolean;
}) {
  if (!transfers.length) return null;
  if (compact) {
    const label = transfers.length + (transfers.length === 1 ? " token transfer" : " token transfers");
    return <span className={styles.chip} data-kind={transfers.length === 1 ? transfers[0]!.kind : "transfer"} role="img" aria-label={label} title={label}>◉ {transfers.length}</span>;
  }
  return <span className={styles.notes}>
    {transfers.slice(0, 2).map(transfer => <span key={transfer.eventId} className={styles.note} data-kind={transfer.kind}>
      <span className={styles.title}>◉ {action[transfer.kind]} · {transfer.symbol || partyName(model, chain, transfer.token) || short(transfer.token)}</span>
      <span className={styles.amount}>{tokenAmount(transfer)}</span>
      <span className={styles.route}>{short(transfer.from)} → {short(transfer.to)}</span>
    </span>)}
    {transfers.length > 2 && <span className={styles.more}>+{transfers.length - 2} more · select the call</span>}
  </span>;
}

export function TokenDetails({ model, chain, transfers }: { model: TraceModel; chain: TraceChain; transfers: TraceTokenTransfer[] }) {
  if (!transfers.length) return null;
  const party = (label: string, address: string, extra: string | null) => {
    const name = [extra, partyName(model, chain, address)].filter((value, index, all) => value && all.indexOf(value) === index).join(" · ");
    return <div className={styles.field}><small>{label}</small>{name && <strong>{name}</strong>}<code>{address}</code></div>;
  };
  return <>
    <h3>Token transfers · experimental</h3>
    {transfers.map(transfer => <div key={transfer.eventId} className={styles.detail} data-kind={transfer.kind}>
      <strong className={styles.detailTitle}>◉ {action[transfer.kind]} · {chain}</strong>
      {party("Token", transfer.token, transfer.symbol)}
      {party("From", transfer.from, transfer.kind === "mint" ? "Mint origin" : null)}
      {party("To", transfer.to, transfer.kind === "burn" ? "Burn address" : null)}
      <div className={styles.field}><small>Amount</small>
        <span className={styles.detailAmount}>{tokenAmount(transfer)}{transfer.symbol && transfer.decimals != null ? " " + transfer.symbol : ""}</span></div>
    </div>)}
    <p className={styles.caveat}>Transfer events confirmed in the transaction receipt. Amounts describe events, not net balance changes.</p>
  </>;
}
