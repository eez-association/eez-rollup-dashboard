import type { TreasuryActionGuard } from "../lib/treasury/setupState";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { Approval, TreasuryClient } from "../lib/treasury/client";
import { approveOwnerAddition, l1OwnerState, ownerAddition, ownerAdditionOutcome, prepareOwnerAddition, readOwnerSubmission } from "../lib/treasury/owners";
import type { OwnerReview, OwnerSubmission } from "../lib/treasury/owners";
import type { TreasuryWallet } from "./TreasuryConnected";
import styles from "./TreasuryDemo.module.css";
import { guardWalletRequests } from "../lib/treasury/walletRequestScope";

/** Existing L1 owners authorize adding an address entered in the form. */
export function TreasuryOwners({ client, wallet, currentThreshold, paymentPending, onPendingChange, onOwnersChanged, guardAction }: { client: TreasuryClient; wallet: TreasuryWallet; currentThreshold?: number; paymentPending: boolean; onPendingChange: (pending: boolean) => void; onOwnersChanged?: () => void; guardAction?: TreasuryActionGuard }) {
  const key = `eez:treasury:owners:${client.config.instance}`;
  const [restored] = useState(() => {
    try { return { pending: readOwnerSubmission(client, localStorage.getItem(key)), error: "" }; }
    catch (e) { return { pending: null, error: String(e) }; }
  });
  const [candidate, setCandidate] = useState(restored.pending?.candidate ?? "");
  const [selectedThreshold, setThreshold] = useState<number | undefined>(restored.pending?.threshold);
  const [review, setReview] = useState<OwnerReview | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [pending, setPending] = useState(restored.pending);
  const [complete, setComplete] = useState(false);
  const [success, setSuccess] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(restored.error);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onPendingChange(!!pending && !complete || !!restored.error); }, [pending, complete, restored.error, onPendingChange]);
  const active = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [client]);
  const requestScope = () => {
    const scope = generation.current;
    return () => { if (generation.current !== scope) throw new Error("The owner-management screen changed. Review this action again."); };
  };
  const currentWallet = useRef(wallet); currentWallet.current = wallet;
  const save = (next: OwnerSubmission | null) => {
    if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key);
    setPending(next);
  };
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    let included = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await ownerAdditionOutcome(client, pending);
        if (!alive) return;
        setStatus(result.detail); setComplete(result.complete); setSuccess(result.success === true);
        const observed = result.complete && result.success === true;
        if (observed !== included) { included = observed; onOwnersChanged?.(); }
      } catch (e) {
        if (alive) {
          setComplete(false); setStatus(`Owner change remains unresolved: ${String(e)}`);
          if (included) { included = false; onOwnersChanged?.(); }
        }
      }
      if (alive) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [client, pending, onOwnersChanged]);
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    const assertActive = requestScope();
    active.current = true; setBusy(true); setError("");
    const scoped = async () => { assertActive(); await fn(); };
    try { await (guardAction ? guardAction(scoped) : scoped()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { active.current = false; setBusy(false); }
  };
  const onL1 = wallet.chainId && BigInt(wallet.chainId) === BigInt(client.config.l1.chainId);
  const owner = review?.before.owners.some(a => a.toLowerCase() === wallet.address?.toLowerCase());
  const signed = approvals.some(a => a.owner.toLowerCase() === wallet.address?.toLowerCase());
  const blocked = busy || !!pending || paymentPending || !!restored.error;
  const threshold = review?.threshold ?? selectedThreshold ?? currentThreshold;
  const l1Name = client.config.l1.chainId === 10200 ? "Chiado" : "Ethereum";
  return <section className={styles.ownerManagement} aria-labelledby="treasury-owner-title">
    <h4 id="treasury-owner-title">{pending ? complete ? success ? "Owner change included" : "Owner change reverted" : "Owner change in progress" : "Add an owner"}</h4>
    <p>Existing owners approve the change on {l1Name}. EEZ-X uses the updated owners automatically.</p>
    <div className={styles.ownerFields}>
      <div className={styles.fields}><label htmlFor="treasury-owner-address">New owner address</label>
        <input id="treasury-owner-address" type="text" autoComplete="off" spellCheck={false} placeholder="0x…" value={candidate}
          disabled={blocked || !!review} onChange={e => setCandidate(e.target.value)} /></div>
      <div className={styles.fields}><label htmlFor="treasury-owner-threshold">Required approvals</label>
        <input id="treasury-owner-threshold" type="number" min="1" step="1" value={threshold ?? ""}
          disabled={blocked || !!review} onChange={e => setThreshold(Number(e.target.value))} /></div>
    </div>
    {!review && !pending && <button className="btn btn-solid" disabled={blocked || !candidate.trim() || threshold === undefined} onClick={() => void run(async () => {
      await client.validate();
      if (threshold === undefined) throw new Error("Wait for the current owner approval requirement.");
      const next = ownerAddition(client, candidate.trim() as Address, threshold, await l1OwnerState(client));
      setReview(next); setApprovals([]); setStatus("");
    })}>Review owner addition</button>}
    {review && !pending && <>
      <p>Add <code>{review.candidate}</code> on L1; threshold {review.before.threshold} → {review.threshold}, owners {review.before.owners.length} → {review.before.owners.length + 1}. Safe nonce {String(review.before.nonce)}.</p>
      <p>{approvals.length} of {review.before.threshold} current-owner approvals collected.</p>
      {!onL1 && <button className="btn btn-outline" disabled={busy} onClick={() => void run(async () => { if (!await wallet.switchToL1()) throw new Error("Wallet network switch was cancelled"); })}>Switch to L1 for owner management</button>}
      <button className={`btn ${approvals.length >= review.before.threshold ? "btn-outline" : "btn-solid"}`} disabled={blocked || !onL1 || !owner || signed} onClick={() => void run(async () => {
        const assertActive = requestScope();
        const selected = currentWallet.current;
        if (!selected.provider) throw new Error("Connect an L1 owner wallet");
        const approval = await approveOwnerAddition(client, guardWalletRequests(selected.provider, assertActive), review);
        assertActive();
        if (currentWallet.current.provider !== selected.provider || currentWallet.current.address?.toLowerCase() !== approval.owner.toLowerCase()) throw new Error("Wallet changed while signing");
        setApprovals(previous => [...previous, approval]);
      })}>Approve owner addition</button>
      <button className={`btn ${approvals.length >= review.before.threshold ? "btn-solid" : "btn-outline"}`} disabled={blocked || !onL1 || approvals.length < review.before.threshold} onClick={() => void run(async () => {
        const assertActive = requestScope();
        const selected = currentWallet.current;
        if (!selected.provider) throw new Error("Connect a wallet to submit");
        const prepared = await prepareOwnerAddition(client, guardWalletRequests(selected.provider, assertActive), review, approvals);
        assertActive();
        if (currentWallet.current.provider !== selected.provider || currentWallet.current.address?.toLowerCase() !== prepared.pending.sender.toLowerCase()) throw new Error("Wallet changed before submission");
        save(prepared.pending); setStatus("Waiting for the wallet submission response.");
        try {
          const hash = await selected.provider.request({ method: "eth_sendTransaction", params: [prepared.request] });
          if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("No transaction hash returned");
          save({ ...prepared.pending, hash: hash as Hex });
        } catch (e) {
          if ((e as { code?: number }).code === 4001) { save(null); setStatus("Wallet cancelled the owner change."); }
          else throw new Error(`Submission response uncertain: ${String(e)}. Tracking the saved request.`);
        }
      })}>Submit L1 owner change</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => { setReview(null); setApprovals([]); }}>Edit owner addition</button>
    </>}
    {pending && <p>Saved L1 owner change: <code>{pending.hash ?? pending.safeHash}</code></p>}
    {status && <p role="status">{status}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {complete && <button className="btn btn-outline" disabled={busy} onClick={() => { save(null); setComplete(false); setReview(null); setApprovals([]); setCandidate(""); setThreshold(undefined); }}>Done</button>}
  </section>;
}
