import { verifiesL1Initiation } from "../lib/treasury/savedPayments";
import { parseTransferAmount, transferRollup, verifyTransferHelper, transferFunds, transferFunding } from "../lib/treasury/transfers";
import { WalletFeeRates } from "./WalletFeeRates";
import { checkCancelledSubmission, walletRejected } from "../lib/treasury/submissionRecovery";
import { treasuryExplorer } from "../lib/treasury/mainnet";
import type { TreasuryActionGuard } from "../lib/treasury/setupState";
import { TreasuryOwners } from "./TreasuryOwners";
import { attemptId } from "../lib/treasury/history";
import { useTreasuryHistory } from "../hooks/useTreasuryHistory";
import { TreasuryPaymentHistory } from "./TreasuryPaymentHistory";
import { TreasuryOutcomeDetails } from "./TreasuryOutcomeDetails";
import { TreasuryChainLink } from "./TreasuryPaymentFlow";
import { invoiceControl } from "../lib/treasury/invoices";
import { checkedPayment, parseUSDC, formatUSDC, paymentTransaction, paymentState, fundingPreview, defaultSplit, remaining } from "../lib/treasury/payments";
import type { Payment, PaymentState } from "../lib/treasury/payments";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { useWallet } from "../hooks/useWallet";
import { actionTransaction, readIntent, TreasuryClient, unchanged } from "../lib/treasury/client";
import type { Approval, Intent, Outcome, Snapshot, TreasuryConfig } from "../lib/treasury/client";
import { safeTransactionHash } from "../lib/treasury/safeTransactions";
import type { ReviewedSafeTransaction } from "../lib/treasury/safeTransactions";
import { TreasuryFundingSplit } from "./TreasuryFundingSplit";
import { useTreasuryFaucet } from "../hooks/useTreasuryFaucet";
import { TreasurySafeFaucet } from "./TreasurySafeFaucet";
import { guardWalletRequests } from "../lib/treasury/walletRequestScope";
import { config } from "../config";
import styles from "./TreasuryDemo.module.css";

export type TreasuryWallet = Pick<ReturnType<typeof useWallet>, "provider" | "address" | "chainId" | "walletOptions" | "connect" | "switchToL1" | "switchToL2">;
type Review = { transaction: ReviewedSafeTransaction; snapshot: Snapshot; value: string; payment?: Payment; funding?: { fromL1: bigint; fromL2: bigint } };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const terminal = (outcome: Outcome | null) => outcome?.kind === "settled" || outcome?.kind === "rejected";

function SafeIdentity({ address, name, explorer, safeAppUrl }: { address: Address; name: string; explorer: string; safeAppUrl?: string }) {
  const [copy, setCopy] = useState<"" | "copied" | "unavailable">("");
  useEffect(() => {
    if (!copy) return;
    const timer = setTimeout(() => setCopy(""), 2500);
    return () => clearTimeout(timer);
  }, [copy]);
  return <div className={styles.safeIdentity}>
    <div className={styles.safeLinks}>
      {explorer ? <a className={styles.safeAddress} href={`${explorer.replace(/\/$/, "")}/address/${address}`} target="_blank" rel="noopener noreferrer" title={address} aria-label={`${name} Safe ${address}`}>{address.slice(0, 8)}…{address.slice(-6)}</a>
        : <code className={styles.safeAddress} title={address}>{address.slice(0, 8)}…{address.slice(-6)}</code>}
      <button type="button" className={styles.copyIcon} title={copy === "copied" ? "Copied" : "Copy address"} aria-label={`Copy ${name} Safe address`} onClick={async () => {
        try { await navigator.clipboard.writeText(address); setCopy("copied"); }
        catch { setCopy("unavailable"); }
      }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{copy === "copied" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>}</svg></button>
      {safeAppUrl && <a href={safeAppUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name} Safe app`}>Safe app ↗</a>}
    </div>
    <span className={styles.copyStatus} role="status">{copy === "copied" ? `${name} Safe address copied` : ""}</span>
    {copy === "unavailable" && <p className={styles.hint} role="status">Copy this address: {address}</p>}
  </div>;
}

function PairedTreasuryConnected({ deployment, wallet, payments = false, networkReady = true, guardAction }: { deployment: TreasuryConfig; wallet: TreasuryWallet; payments?: boolean; networkReady?: boolean; guardAction?: TreasuryActionGuard }) {
  const [client] = useState(() => new TreasuryClient(deployment));
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [client]);
  const requestScope = () => {
    const current = generation.current;
    return () => { if (generation.current !== current) throw new Error("The treasury screen changed. Review this action again before opening the wallet."); };
  };
  const storageKey = `eez:treasury:submission:${deployment.instance}`;
  const [restored] = useState(() => {
    try { return { intent: readIntent(deployment, localStorage.getItem(storageKey)), error: "" }; }
    catch (error) { return { intent: null, error: message(error) }; }
  });
  const history = useTreasuryHistory(client, restored.intent, payments);
  const { remember, observe, cancel, reject } = history;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [healthy, setHealthy] = useState(false);
  const ready = healthy && networkReady;
  const [ownerRead, setOwnerRead] = useState<"loading" | "current" | "unavailable">("loading");
  const [ownerRevision, setOwnerRevision] = useState(0);
  // A reloaded submission remains locked; display its signed fields while the
  // client reconciles it instead of showing the next payment's defaults.
  const savedPayment = payments ? restored.intent?.payment : undefined;
  const [value, setValue] = useState(savedPayment ? formatUSDC(BigInt(savedPayment.amount)) : payments ? "40" : restored.intent?.value ?? "42");
  const [kind, setKind] = useState<"fixed" | "invoice" | "transfer">(savedPayment?.kind ?? "fixed");
  const [invoiceId] = useState<Hex | undefined>(savedPayment?.kind === "invoice" ? savedPayment.invoiceId : undefined);
  const [recipient, setRecipient] = useState<string>(savedPayment?.recipient ?? deployment.payments?.recipient ?? "");
  const walletSource: "l1" | "l2" | undefined = payments && wallet.address && wallet.chainId
    ? BigInt(wallet.chainId) === BigInt(deployment.l1.chainId) && (deployment.payments && verifiesL1Initiation(deployment.payments)) ? "l1"
      : BigInt(wallet.chainId) === BigInt(deployment.l2.chainId) ? "l2" : undefined
    : undefined;
  const [source, setSource] = useState<"l1" | "l2">(savedPayment?.source ?? (restored.intent ? "l2" : walletSource ?? "l2"));
  const sourceChosen = useRef(!!restored.intent || !!walletSource);
  const [destination, setDestination] = useState<"l1" | "l2">(savedPayment?.destination ?? "l2");
  const [allocation, setAllocation] = useState<{ amount: bigint; fromL1: bigint } | null>(savedPayment && "fromL1" in savedPayment
    ? { amount: BigInt(savedPayment.amount), fromL1: BigInt(savedPayment.fromL1!) } : null);
  const [balances, setBalances] = useState<PaymentState | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [intent, setIntent] = useState<Intent | null>(restored.intent);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(restored.error);
  const [notice, setNotice] = useState("");
  const [fee, setFee] = useState<{ price: string; priority?: string } | null>(null);
  const [ownerChangePending, setOwnerChangePending] = useState(false);
  const refs = useRef({ review, intent, busy: false, wallet, outcome });
  refs.current.wallet = wallet;
  refs.current.outcome = outcome;
  // A wallet restored after mount may supply the initial default, but never
  // rewrite an explicit selection, reviewed signing domain or saved request.
  useEffect(() => {
    if (sourceChosen.current || !walletSource || refs.current.review || refs.current.intent) return;
    sourceChosen.current = true;
    setSource(walletSource);
  }, [walletSource]);
  const selectSource = (next: "l1" | "l2") => { sourceChosen.current = true; setSource(next); };
  const clearReview = useCallback(() => { refs.current.review = null; setReview(null); setApprovals([]); }, []);
  const saveIntent = useCallback((next: Intent | null) => {
    // Storage failure must prevent the send, not silently lose recovery identity.
    if (next) { if (next.payment) remember(next); localStorage.setItem(storageKey, JSON.stringify(next)); }
    else localStorage.removeItem(storageKey);
    refs.current.intent = next;
    setIntent(next);
  }, [storageKey, remember]);
  const acceptSnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setOwnerRead("current");
    if (refs.current.review && !refs.current.intent && !unchanged(refs.current.review.snapshot, next)) {
      clearReview();
      setNotice("Owners or Safe nonce changed. Review the action again; previous approvals were cleared.");
    }
  }, [clearReview]);
  const acceptPayments = useCallback((next: PaymentState) => {
    setBalances(next);
    if (!refs.current.intent && refs.current.review?.payment && refs.current.review.payment.kind !== "transfer" && refs.current.review.payment.deadline === undefined && BigInt(refs.current.review.payment.epoch) !== next.epoch) {
      clearReview(); setNotice("The budget period changed. Review again; previous approvals were cleared.");
    }
  }, [clearReview]);
  const ownersChanged = useCallback(() => {
    // Restart polling so an older in-flight snapshot cannot replace the owner
    // set read after inclusion (or after that inclusion becomes uncertain).
    setOwnerRead("loading");
    setHealthy(false);
    setOwnerRevision(revision => revision + 1);
  }, []);
  const backgroundValidationAt = useRef(0);
  const refresh = useCallback(async (includePayments = true) => {
    let ownersRead = false;
    try {
      const [, next] = await Promise.all([client.validate(), client.snapshot(payments ? source : "l2")]);
      backgroundValidationAt.current = Date.now();
      acceptSnapshot(next);
      ownersRead = true;
      if (payments && includePayments) acceptPayments(await paymentState(client, "latest"));
      setHealthy(true);
      return next;
    } catch (failure) {
      if (!ownersRead) setOwnerRead("unavailable");
      setHealthy(false);
      throw failure;
    }
  }, [client, acceptSnapshot, acceptPayments, payments, source]);
  const faucet = useTreasuryFaucet(deployment, wallet, refresh, guardAction);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>, failures = 0;
    const poll = async () => {
      // Foreground review/signing owns its fresh reads; avoid a competing sweep.
      if (refs.current.busy) { if (active) timer = setTimeout(poll, 5000); return; }
      let ownersRead = false;
      try {
        const initial = backgroundValidationAt.current === 0;
        if (!initial && Date.now() - backgroundValidationAt.current >= 30_000) {
          await client.validate(); backgroundValidationAt.current = Date.now();
        }
        // Read display data first on reload. These are fresh chain observations,
        // not cached balances or permission to act: healthy stays false until
        // the full binding validation completes. Both display reads can overlap.
        const [ownersResult, amountsResult] = await Promise.allSettled([client.snapshot(payments ? source : "l2"), payments ? paymentState(client, "latest") : null]);
        if (!active) return;
        if (ownersResult.status === "fulfilled") { acceptSnapshot(ownersResult.value); ownersRead = true; }
        if (amountsResult.status === "fulfilled" && amountsResult.value) acceptPayments(amountsResult.value);
        if (ownersResult.status === "rejected") throw ownersResult.reason;
        if (amountsResult.status === "rejected") throw amountsResult.reason;
        if (initial) {
          setHealthy(false);
          await client.validate();
          if (!active) return;
          backgroundValidationAt.current = Date.now();
        }
        const current = refs.current.intent;
        const result = current ? await client.outcome(current) : null;
        if (!active) return;
        setHealthy(true); failures = 0;
        setError(previous => (previous.startsWith("Connection check failed:") || previous.startsWith("Network busy:") || (terminal(result) && previous.startsWith("Submission response uncertain:"))) ? "" : previous);
        if (current === refs.current.intent) {
          if (current && result) {
            const tracked = result.hash && current.hash !== result.hash ? { ...current, hash: result.hash } : current;
            const saved = readIntent(deployment, localStorage.getItem(storageKey));
            if (saved && (attemptId(saved) !== attemptId(tracked) || saved.data !== tracked.data))
              throw new Error("Another payment is being tracked in this browser. Reload to verify it.");
            if (terminal(result)) {
              // Keep the request identity in history before releasing the pending
              // slot. Continue observing it until the next review, so a changed
              // canonical result restores the lock without an automatic send.
              if (tracked.payment) remember(tracked);
              localStorage.removeItem(storageKey);
              refs.current.intent = tracked; setIntent(tracked);
              clearReview();
            } else saveIntent(tracked);
            observe(tracked, result);
          }
          setOutcome(result);
        }
      } catch (failure) {
        if (!active) return;
        failures++; backgroundValidationAt.current = 0;
        if (!ownersRead) setOwnerRead("unavailable");
        setHealthy(false);
        if (refs.current.intent) {
          try {
            const saved = readIntent(deployment, localStorage.getItem(storageKey));
            if (!saved || attemptId(saved) === attemptId(refs.current.intent) && saved.data === refs.current.intent.data) saveIntent(refs.current.intent);
          } catch { /* Preserve a corrupt or conflicting journal for recovery. */ }
          const unresolved: Outcome = { kind: "unknown", detail: "Payment verification is temporarily unavailable. Retrying automatically." };
          setOutcome(unresolved); observe(refs.current.intent, unresolved);
        }
        setError(/429|rate limit/i.test(message(failure))
          ? "Network busy: the RPC is limiting requests. Retrying after a pause; your saved payment will not be sent again."
          : `Connection check failed: ${message(failure)}. Submitted work remains unresolved until verified.`);
      } finally { if (active) timer = setTimeout(poll, failures ? Math.min(30_000, 2500 * 2 ** failures) : 5000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [client, acceptSnapshot, acceptPayments, payments, source, saveIntent, observe, remember, clearReview, deployment, storageKey, ownerRevision]);

  const run = async (label: string, action: () => Promise<void>) => {
    if (refs.current.busy) return;
    const assertActive = requestScope();
    refs.current.busy = true; setBusy(label); setError(""); setNotice("");
    const scoped = async () => { assertActive(); await action(); };
    try { await (guardAction ? guardAction(scoped) : scoped()); } catch (failure) { setError(message(failure)); }
    finally { refs.current.busy = false; setBusy(""); }
  };
  const contribution = (state: PaymentState, amount: bigint) => allocation
    ? allocation.fromL1 * amount / allocation.amount : defaultSplit(state, amount, destination);
  const reviewing = async () => {
    if (refs.current.intent && !terminal(refs.current.outcome)) return;
    if (refs.current.intent) { saveIntent(null); setOutcome(null); setFee(null); }
    sourceChosen.current = true;
    let next: Review;
    if (payments && kind === "transfer") {
      const amount = parseTransferAmount(value);
      const [latest, funds, rollupId] = await Promise.all([
        refresh(false), transferFunds(client), transferRollup(client), verifyTransferHelper(client),
      ]);
      const payment = checkedPayment({ kind: "transfer", source: "l1", destination: "l2", recipient: deployment.safeL2,
        amount: String(amount), epoch: String(funds.epoch), rollupId });
      let funding;
      try { funding = transferFunding(funds.balance, amount); }
      catch (failure) { reject(payment, message(failure)); throw failure; }
      next = { transaction: paymentTransaction(deployment, payment, latest.nonce), snapshot: latest, value, payment, funding };
    } else if (payments) {
      const [latest, amounts] = await Promise.all([refresh(false), paymentState(client, "latest")]);
      acceptPayments(amounts);
      const identity = { source, recipient: recipient as Address, destination, epoch: String(amounts.epoch) };
      const payment = checkedPayment(kind === "invoice"
        ? { ...identity, kind: "invoice", invoiceId: invoiceId!, destination: "l1", amount: String(parseUSDC(value)) }
        : { ...identity, ...(deployment.payments?.pair?.version === 2 ? { deadline: "0" } : {}), amount: String(parseUSDC(value)), fromL1: String(contribution(amounts, parseUSDC(value))) });
      let contributions;
      try { contributions = fundingPreview(amounts, payment); }
      catch (failure) {
        reject(payment, message(failure));
        throw failure;
      }
      if ("fromL1" in payment) setAllocation({ amount: BigInt(payment.amount), fromL1: BigInt(payment.fromL1!) });
      next = { transaction: paymentTransaction(deployment, payment, latest.nonce), snapshot: latest, value, payment, funding: contributions };
    } else {
      const latest = await refresh(false);
      next = { transaction: actionTransaction(deployment, value, latest.nonce), snapshot: latest, value };
    }
    refs.current.review = next; setReview(next); setApprovals([]);
  };
  const ensureReviewedNetwork = async (current: Review, selected: TreasuryWallet, nextStatus: string, assertActive: () => void, submitting = false) => {
    assertActive();
    if (!selected.provider || !selected.address) throw new Error("Connect a wallet first");
    const chain = submitting ? client.submissionSource(current.transaction) : client.transactionSource(current.transaction);
    const chainId = BigInt(deployment[chain].chainId);
    const network = chain === "l1" ? deployment.l1.chainId === 10200 ? "Chiado" : "Ethereum" : "EEZ-X";
    if (BigInt(await selected.provider.request({ method: "eth_chainId" }) as string) !== chainId) {
      assertActive();
      setBusy(`Switching wallet to ${network}…`);
      if (!await (chain === "l1" ? selected.switchToL1() : selected.switchToL2()))
        throw new Error("Wallet network change cancelled. You can try again.");
      if (BigInt(await selected.provider.request({ method: "eth_chainId" }) as string) !== chainId)
        throw new Error(`Wallet is still on another network. Select ${network} and try again.`);
    }
    assertActive();
    if (refs.current.review !== current || refs.current.intent || refs.current.wallet.provider !== selected.provider
      || refs.current.wallet.address?.toLowerCase() !== selected.address.toLowerCase())
      throw new Error("The wallet or reviewed action changed while switching networks. Try again.");
    setBusy(nextStatus);
  };
  const signing = async () => {
    const assertActive = requestScope();
    const selected = refs.current.wallet;
    const current = refs.current.review;
    if (!current || !selected.provider || !selected.address) throw new Error("Connect an owner wallet first");
    if (approvals.some(a => a.owner.toLowerCase() === selected.address!.toLowerCase())) throw new Error("This owner has already approved");
    await ensureReviewedNetwork(current, selected, "Checking approval…", assertActive);
    const approval = await client.approve(guardWalletRequests(selected.provider, assertActive), current.transaction, current.snapshot, selected.address as Address,
      () => { assertActive(); setBusy("Waiting for owner signature…"); });
    assertActive();
    if (refs.current.review !== current
      || refs.current.wallet.provider !== selected.provider || refs.current.wallet.address?.toLowerCase() !== selected.address.toLowerCase())
      throw new Error("The wallet or reviewed action changed while signing. Try again.");
    setApprovals(existing => [...existing, approval]);
  };
  const submitting = async () => {
    const assertActive = requestScope();
    const current = refs.current.review;
    const selected = refs.current.wallet;
    if (!current || !selected.provider || refs.current.intent) return;
    await ensureReviewedNetwork(current, selected, "Checking transaction and network…", assertActive, true);
    const funding = async () => {
      if (current.payment?.kind === "transfer") transferFunding((await transferFunds(client)).balance, BigInt(current.payment.amount));
      else if (current.payment) fundingPreview(await paymentState(client, "latest"), current.payment);
    };
    const [next] = await Promise.all([
      client.prepare(guardWalletRequests(selected.provider, assertActive), current.transaction, current.snapshot, approvals, current.payment),
      funding(),
    ]);
    assertActive();
    if (refs.current.review !== current || refs.current.wallet.provider !== selected.provider
      || refs.current.wallet.address?.toLowerCase() !== next.intent.sender.toLowerCase()) throw new Error("The wallet or review changed. Review again.");
    if (next.expiresAt) {
      const price = next.request.gasPrice ?? next.request.maxFeePerGas!;
      setFee({ price, priority: next.request.maxPriorityFeePerGas });
    }
    if (current.payment?.kind === "invoice") await invoiceControl(deployment, "arm", next.intent);
    assertActive();
    if (next.expiresAt && BigInt(next.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error("Fee quote expired. Submit again to request fresh fees.");
    saveIntent(next.intent);
    setBusy("Waiting for wallet confirmation…");
    setOutcome({ kind: "unknown", detail: "Awaiting the wallet submission response. Keep this tab open until the wallet finishes." });
    try {
      const hash = await selected.provider.request({ method: "eth_sendTransaction", params: [next.request] });
      if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Wallet did not return a transaction hash");
      saveIntent({ ...next.intent, hash: hash as Hex });
      setOutcome({ kind: "pending", hash: hash as Hex, detail: "Submitted to Composer. Waiting for canonical settlement." });
    } catch (failure) {
      if (walletRejected(failure)) {
        if (current.payment?.kind === "invoice") await invoiceControl(deployment, "cancel", { invoiceId: current.payment.invoiceId });
        if (next.intent.payment) cancel(next.intent);
        saveIntent(null); setOutcome(null); setFee(null);
        setNotice("Wallet submission cancelled. You can submit again or edit the action.");
        return;
      }
      throw new Error(`Submission response uncertain: ${message(failure)}. Tracking the saved action; do not resubmit it.`);
    }
  };
  const recoverCancellation = async () => {
    const current = refs.current.intent;
    if (!current || current.hash) throw new Error("This transaction must remain tracked.");
    await checkCancelledSubmission(client, current);
    const saved = readIntent(deployment, localStorage.getItem(storageKey));
    if (refs.current.intent !== current || !saved || saved.hash || attemptId(saved) !== attemptId(current) || saved.data !== current.data)
      throw new Error("The saved transaction changed. Reload to check its status.");
    if (current.payment) cancel(current);
    saveIntent(null); setOutcome(null); setFee(null); clearReview();
    setNotice("Cancelled wallet request cleared. Review your action again before sending.");
  };
  const currentOwner = snapshot?.owners.some(owner => owner.toLowerCase() === wallet.address?.toLowerCase());
  const alreadySigned = approvals.some(a => a.owner.toLowerCase() === wallet.address?.toLowerCase());
  const nextChain = review && approvals.length >= review.snapshot.threshold ? client.submissionSource(review.transaction) : payments ? source : "l2";
  const correctChain = wallet.chainId && BigInt(wallet.chainId) === BigInt(deployment[nextChain].chainId);
  const locked = !!busy || !!intent && !terminal(outcome) || !!restored.error || ownerChangePending;
  const displayStatus = busy || outcome?.detail || (review ? "Collect owner approvals, then submit once." : "Review an action to collect owner approvals.");
  const l1Name = deployment.l1.chainId === 10200 ? "Chiado" : "Ethereum";
  let split: { amount: bigint; fromL1: bigint; fromL2: bigint; error: string } | undefined;
  if (payments && balances && kind === "fixed") {
    try {
      const amount = parseUSDC(value);
      const fromL1 = contribution(balances, amount);
      let capacityError = "";
      try { fundingPreview(balances, { amount: String(amount), recipient: recipient as Address, destination,
        epoch: String(balances.epoch), fromL1: String(fromL1) }); }
      catch (e) { capacityError = message(e); }
      split = { amount, fromL1, fromL2: amount - fromL1, error: capacityError };
    } catch { /* Amount validation is shown when reviewing the draft. */ }
  }
  return <section className={styles.treasury} aria-label="Connected treasury demo">
    <div className={styles.heading}>
      <div><p className="eez-eyebrow">[ {l1Name} + EEZ-X · {payments ? "TREASURY PAYMENTS" : "OWNER VERIFICATION"} ]</p><h2>{payments ? "One treasury, two Safes" : "One owner set, two Safes"}</h2>
        <p>{payments && (deployment.payments && verifiesL1Initiation(deployment.payments)) ? "Start from either Safe and pay on either chain, using one owner set and one shared budget." : `Approve on EEZ-X. The Safe verifies your authority against the current ${l1Name} owners.`}</p></div>
      <div className={styles.owners}>
        <span className={styles.badge}>{deployment.environment === "isolated-devnet" ? "Isolated devnet" : deployment.environment === "ethereum-mainnet" ? "Ethereum + EEZ-X" : "Chiado + EEZ-X testnet"}</span></div>
    </div>
    <div className={payments ? styles.balanceSummary : styles.overview}>
      {payments && <section className={styles.card} aria-label="Live shared budget"><h3>Shared budget remaining</h3>
        <strong className={styles.amount}>{balances ? formatUSDC(balances.globalLimit - balances.spent) : "—"} <span>USDC</span></strong>
        {balances ? <><p><span data-testid="global-spent">{formatUSDC(balances.spent)}</span> / 150 spent · resets at {new Date(balances.resetsAt * 1000).toLocaleTimeString()}</p>
          <progress aria-label="Shared budget used" value={Number(balances.spent)} max={Number(balances.globalLimit)} /></> : <p className={styles.hint}>Reading the shared budget…</p>}
      </section>}
      {(["l1", "l2"] as const).map(chain => {
        const name = chain === "l1" ? l1Name : "EEZ-X";
        const allowance = balances && (chain === "l1" ? balances.allowanceL1 : balances.allowanceL2);
        const explorer = treasuryExplorer(deployment, chain, chain === "l1" ? config.l1Explorer : config.l2Explorer);
        return <section className={styles.card} key={chain} aria-label={`${chain === "l1" ? l1Name : "EEZ-X"} Safe funds`}>
          <h3 className={styles.chainLabel} data-chain={chain}>{name} Safe</h3>
          <SafeIdentity address={chain === "l1" ? deployment.safeL1 : deployment.safeL2} name={name} explorer={explorer} safeAppUrl={chain === "l1" ? deployment.safeAppUrl : undefined} />
          {payments && <><div className={styles.safeBalanceRow}><strong className={styles.amount}>{balances ? formatUSDC(chain === "l1" ? balances.balanceL1 : balances.balanceL2) : "—"} <span>USDC</span></strong>
            <TreasurySafeFaucet faucet={faucet} chain={chain} l1Name={l1Name} disabled={!networkReady || !!busy || !!review || !wallet.address} /></div>
            {allowance ? <><p>{formatUSDC(remaining(allowance))} available under this Safe’s limit</p>
              <p className={styles.hint}><span data-testid={`${chain}-spent`}>{formatUSDC(allowance[1]!)}</span> / {formatUSDC(allowance[0]!)} spent this period</p></> : <p className={styles.hint}>Reading this Safe’s balance…</p>}</>}
        </section>;
      })}
    </div>
    {faucet.error && <p className={styles.error} role="alert">{faucet.error}</p>}
    {!payments && <section className={styles.card} aria-label="Current Safe action"><h3>Settled demonstration value</h3>
      <strong className={styles.amount} data-testid="action-value">{snapshot?.value.toString() ?? "—"}</strong>
    </section>}
    <div className={styles.workflow}>
      <section className={styles.card} aria-label="Review Safe action"><h3>{payments ? kind === "transfer" ? "Move funds between Safes" : "Review a payment" : "Review an action"}</h3>
        <fieldset className={styles.fields} disabled={locked || !!review}>
          {payments && <><label htmlFor="treasury-source">Start from</label>
            <select id="treasury-source" value={source} disabled={kind === "invoice" || kind === "transfer"} onChange={e => selectSource(e.target.value as "l1" | "l2")}>
              <option value="l2">EEZ-X Safe</option><option value="l1" disabled={!(deployment.payments && verifiesL1Initiation(deployment.payments))}>{l1Name} Safe</option>
            </select></>}
          {payments && <><label htmlFor="treasury-kind">Payment type</label>
            <select id="treasury-kind" value={kind} onChange={e => { const next = e.target.value as "fixed" | "invoice" | "transfer"; setKind(next); if (next === "transfer") { selectSource("l1"); setDestination("l2"); setRecipient(deployment.safeL2); setAllocation(null); } else if (kind === "transfer") { setRecipient(deployment.payments!.recipient); setValue("40"); } if (next === "invoice") { selectSource("l2"); setValue("110"); setDestination("l1"); setRecipient(deployment.payments!.recipient); } }}>
              <option value="fixed">Fixed amount</option>{deployment.l1.front && (!deployment.fees || deployment.fees.l1MaxTotalWei) && <option value="transfer">Move to EEZ-X Safe</option>}{invoiceId && <option value="invoice">Invoice with required acceptance</option>}
            </select></>}
          <label htmlFor="treasury-value">{payments ? "Amount (USDC)" : "New demonstration value"}</label>
          <input id="treasury-value" readOnly={kind === "invoice"} inputMode={payments ? "decimal" : "numeric"} autoComplete="off" value={value} maxLength={78} onChange={e => setValue(e.target.value)} />
          {payments && <>
            <label htmlFor="treasury-recipient">Recipient address</label><input id="treasury-recipient" readOnly={kind === "invoice" || kind === "transfer"} value={recipient} onChange={e => setRecipient(e.target.value)} />
            <label htmlFor="treasury-destination">Recipient chain</label><select id="treasury-destination" disabled={kind === "invoice" || kind === "transfer"} value={destination} onChange={e => { const chain = e.target.value as "l1" | "l2"; setDestination(chain); setAllocation(null); }}><option value="l2">EEZ-X</option><option value="l1">{l1Name}</option></select>
            {kind === "transfer" && <p className={styles.hint}>Move USDC from your {l1Name} Safe to your EEZ-X Safe through the shared bridge. Owners approve this internal transfer directly; it does not use the payment budget.</p>}
            {kind === "fixed" && <TreasuryFundingSplit l1Name={l1Name} split={split} loading={!balances}
              onChange={fromL1 => { if (split) setAllocation({ amount: split.amount, fromL1 }); }}
              onReset={() => setAllocation(null)} />}
            {kind === "invoice" && <div className={styles.notice} aria-label="Invoice scenario">
              <p>Invoice <code>{invoiceId}</code> · 110 USDC to {l1Name}.</p>
              <p>After you approve, the isolated fixture closes this invoice immediately before the proved payment executes. The payment bridges 10 from EEZ-X, transfers 100 from {l1Name}, then requires the merchant's acceptance.</p>
              <p>The result is verified from the execution trace and canonical balances. The invoice closure remains committed; network fees are separate.</p>
            </div>}
          </>}
        </fieldset>
        {!payments && <p className={styles.hint}>Updates the demonstration value on EEZ-X.</p>}
        {review && <div className={styles.route} aria-label="Reviewed Safe transaction"><p>Initiating Safe: {review.payment?.source === "l1" ? l1Name : "EEZ-X"}</p><h4>{review.payment ? `${formatUSDC(BigInt(review.payment.amount))} USDC → ${review.payment.destination === "l1" ? l1Name : "EEZ-X"}` : `Set value to ${review.value}`}</h4>
          {review.payment && review.funding && <><p>Recipient: <code>{review.payment.recipient}</code></p><p data-testid="funding-preview">{formatUSDC(review.funding.fromL1)} from {l1Name} + {formatUSDC(review.funding.fromL2)} from EEZ-X</p>
            {review.payment.kind === "transfer" ? <p>Internal transfer: the payment budget and spending allowances stay unchanged. The batch approves exactly this amount for the bridge and clears the approval.</p> : <details className={styles.disclosure}><summary>How this payment is funded</summary>
              <p>Contributions execute in this order:</p>
              <ol>{(review.payment.source === "l1" ? ["l1", "l2"] as const : ["l2", "l1"] as const)
                .filter(chain => (chain === "l1" ? review.funding!.fromL1 : review.funding!.fromL2) > 0n).map(chain => <li key={chain}>
                  <strong className={styles.chainLabel} data-chain={chain}>{chain === "l1" ? l1Name : "EEZ-X"} Safe:</strong>{" "}
                  {formatUSDC(chain === "l1" ? review.funding!.fromL1 : review.funding!.fromL2)} USDC{" "}
                  {review.payment!.destination === chain ? `go directly to the recipient on ${chain === "l1" ? l1Name : "EEZ-X"}.`
                    : chain === "l1" ? "pass through the local policy and normal bridge; matching wrapped tokens are minted to the recipient on EEZ-X."
                    : `pass through the local policy and normal bridge; wrapped tokens are burned and canonical tokens are released to the recipient on ${l1Name}.`}
                </li>)}</ol>
            </details>}</>}

          <details className={styles.disclosure}><summary>Transaction details</summary><p>{review.payment?.source === "l1" ? l1Name : "EEZ-X"} Safe nonce {review.transaction.message.nonce.toString()} · chain {review.transaction.domain.chainId.toString()}</p><p>Target: <code>{review.transaction.message.to}</code></p>
            <p>Safe transaction hash: <code data-testid="safe-hash">{safeTransactionHash(review.transaction)}</code></p><p>{review.payment?.kind === "transfer" ? "Verified call-only batch" : "Call"} · native value 0 · Safe gas refund 0</p></details>
        </div>}
        {!review && (!intent || terminal(outcome)) && <button className="btn btn-solid" disabled={locked || !ready} onClick={() => void run("Reading owners and Safe nonce…", reviewing)}>{payments ? kind === "transfer" ? "Review transfer" : "Review payment" : "Review action"}</button>}
        {review && !intent && <button className="btn btn-outline" disabled={!!busy} onClick={() => { clearReview(); setNotice("Action unlocked. Review again to collect fresh approvals."); }}>{payments ? kind === "transfer" ? "Edit transfer" : "Edit payment" : "Edit action"}</button>}

        {!terminal(outcome) && <div className={styles.approvalStep}>
          <h4>{payments ? kind === "transfer" ? "Transfer approvals" : "Payment approvals" : "Action approvals"}</h4>
          <strong className={styles.quorum} data-testid="quorum">{intent ? "Owner approvals collected" : `${approvals.length} of ${snapshot?.threshold ?? "—"} approvals`}</strong>
          {review?.payment?.deadline === "0" && <p className={styles.hint}>No time expiry. Balances and spending limits are checked when this payment executes.</p>}
          {review && <p>Approve this {payments ? kind === "transfer" ? "transfer" : "payment" : "action"} with the shared owners.</p>}
          {!wallet.address ? <div className={styles.owners}>{wallet.walletOptions.map(option => <button className="btn btn-outline" key={option.id} onClick={() => void wallet.connect(option.id)}>Connect {option.name}</button>)}
            {!wallet.walletOptions.length && <p>Connect a browser wallet to sign.</p>}</div> : <>
            {review && !currentOwner && <p className={styles.notice}>Select one of this Safe’s owners in your wallet to approve.</p>}
            <button className={`btn ${review && approvals.length < review.snapshot.threshold ? "btn-solid" : "btn-outline"}`} disabled={locked || !ready || !review || !currentOwner || alreadySigned || approvals.length >= (snapshot?.threshold ?? Infinity)}
              onClick={() => void run("Waiting for owner signature…", signing)}>{alreadySigned ? "Owner approved" : "Sign approval"}</button>
            {review && alreadySigned && approvals.length < review.snapshot.threshold && <p className={styles.hint}>Switch accounts in your wallet to collect another owner’s approval.</p>}
          </>}
          {review && !intent && !correctChain && wallet.address && (approvals.length >= review.snapshot.threshold || currentOwner && !alreadySigned)
            && <p className={styles.hint}>Your wallet will ask to switch to {nextChain === "l1" ? l1Name : "EEZ-X"} before {approvals.length >= review.snapshot.threshold ? "submission" : "signing"}.</p>}
          {review && deployment.payments?.bridgeKind === "standard" && source === "l2" && <p className={styles.hint}>Approve for your EEZ-X Safe, then submit on {l1Name}. EEZ verifies the current shared owners and completes the payment across both chains.</p>}
          {fee && !terminal(outcome) && <WalletFeeRates fee={fee} description="Fees sent to your wallet for this Safe transaction. The submitting wallet pays gas separately from the Safe’s USDC payment." />}
          {review && !intent && <button className={`btn ${approvals.length >= review.snapshot.threshold ? "btn-solid" : "btn-outline"}`} disabled={locked || !ready || !wallet.address || approvals.length < review.snapshot.threshold}
            onClick={() => void run("Waiting for wallet submission…", submitting)}>Submit Safe transaction</button>}
        </div>}
      </section>
      <section className={styles.card} aria-labelledby="treasury-shared-owners-title">
        <div className={styles.heading}><h3 id="treasury-shared-owners-title">Shared owners</h3><button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void run("Refreshing owners…", async () => { await refresh(); })}>Refresh owners</button></div>
        <p className={styles.safeExplanation}>Manage owners and the approval threshold on {l1Name}. EEZ-X reads them through EEZ when verifying each transaction, so <strong>both Safes stay in sync automatically.</strong></p>
        <dl className={styles.limitSummary} aria-live="polite"><div><dt>Approval threshold</dt><dd data-testid="shared-threshold">{snapshot ? `${snapshot.threshold} of ${snapshot.owners.length} ${snapshot.owners.length === 1 ? "owner" : "owners"}` : "—"}</dd></div></dl>
        {ownerRead !== "current" && <p className={styles.hint} role="status">{ownerRead === "loading" ? `Reading owners from ${l1Name}…` : snapshot ? "Couldn’t refresh owners. Showing the last verified list; retrying automatically." : "Couldn’t read the shared owners. Retrying automatically."}</p>}
        <ul className={styles.ownerList}>{snapshot?.owners.map(owner => {
          const label = deployment.ownerLabels?.[owner.toLowerCase()];
          const connected = wallet.address?.toLowerCase() === owner.toLowerCase();
          return <li key={owner} data-owner={owner.toLowerCase()}>
            <span><strong>{label && label !== "Deployment wallet" ? label : "Owner"}</strong>{connected && <> · <span className={styles.hint}>Connected wallet</span></>} <code>{owner}</code></span>
            {approvals.some(a => a.owner.toLowerCase() === owner.toLowerCase()) && <span className={styles.badge} data-positive="true">Approved</span>}
          </li>;
        })}</ul>
        <TreasuryOwners guardAction={guardAction} client={client} wallet={wallet} currentThreshold={snapshot?.threshold} paymentPending={!!intent && !terminal(outcome)} onPendingChange={setOwnerChangePending} onOwnersChanged={ownersChanged} />

      </section>
    </div>
    {notice && <p className={styles.notice}>{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {payments && busy && <p className={styles.notice} role="status">{busy}</p>}
    {intent && !intent.hash && !terminal(outcome) && <div className={styles.notice}>
      <button type="button" className="btn btn-outline" disabled={!!busy || !ready} onClick={() => void run("Checking the cancelled wallet request…", recoverCancellation)}>I cancelled this request in my wallet</button>
    </div>}
    {!payments && (busy || intent || outcome) && <section className={styles.card} aria-label="Safe transaction status"><h3 aria-live="polite">{outcome?.rollback ? "Rollback verified" : outcome?.kind === "settled" ? `Settled on ${l1Name}` : "Transaction status"}</h3>
      {(!terminal(outcome) || (outcome?.kind === "rejected" && !outcome.rollback)) && <p role="status" aria-live="polite">{displayStatus}</p>}
      {intent?.payment && outcome?.kind !== "settled" && <p>{formatUSDC(BigInt(intent.payment.amount))} USDC to <code>{intent.payment.recipient}</code> on {intent.payment.destination === "l1" ? l1Name : "EEZ-X"}</p>}
      <TreasuryOutcomeDetails outcome={outcome} deployment={deployment} intent={intent ?? undefined} settlement={history.settlementFor(outcome)} />
      {intent && <>
        {(intent.hash || outcome?.hash) && (!intent.payment || outcome?.kind !== "settled") && <div className={styles.hint}><TreasuryChainLink deployment={deployment} chain={intent.submissionChain ?? intent.payment?.source ?? "l2"} value={(intent.hash || outcome?.hash)!} testId="submitted-hash">Submitted {(intent.submissionChain ?? intent.payment?.source) === "l1" ? l1Name : "EEZ-X"} transaction</TreasuryChainLink></div>}
        {!terminal(outcome) && <p>You can reload this page. The saved request will be checked again before another action is enabled.</p>}</>}
    </section>}
    {payments && <TreasuryPaymentHistory history={history} deployment={deployment} />}
  </section>;
}

/** Reject retired manifests before mounting any signing or payment hooks. */
export function TreasuryConnected(props: Parameters<typeof PairedTreasuryConnected>[0]) {
  if (!props.deployment.payments?.pair || props.deployment.payments.bridgeKind !== "standard")
    return <p role="alert">This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.</p>;
  return <PairedTreasuryConnected {...props} />;
}
