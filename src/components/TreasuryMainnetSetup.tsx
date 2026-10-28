import { retainSourceRequests } from "../lib/treasury/sourceVerification";
import { loadTreasuryArtifacts } from "../lib/treasury/release";
import { useEffect, useRef, useState } from "react";
import { formatEther, getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import type { TreasuryWallet } from "./TreasuryConnected";
import type { TreasuryConfig } from "../lib/treasury/client";
import { MainnetSetup, setupIdentity, mainnetSetupStepsFor, pairedSetupAvailable, readMainnetSetup } from "../lib/treasury/mainnetSetup";
import type { MainnetSetupState, MainnetTarget, SetupNetwork } from "../lib/treasury/mainnetSetup";
import defaultNetwork from "../lib/treasury/mainnet-network.json";
import styles from "./TreasuryDemo.module.css";
import { TreasuryPairedHistory } from "./TreasuryPairedHistory";
import { guardWalletRequests } from "../lib/treasury/walletRequestScope";

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function TreasuryMainnetSetup({ wallet, target, onComplete, network = defaultNetwork }: { wallet: TreasuryWallet; target: MainnetTarget; network?: SetupNetwork; onComplete: (c: TreasuryConfig) => void }) {
  const mainnetSetupKey = `eez:treasury:paired-setup:${setupIdentity(network)}`, mainnetManifestKey = `${mainnetSetupKey}:manifest`;
  const l1Name = network.testnet ? "Chiado" : "Ethereum";
  const [state, setState] = useState<MainnetSetupState | null>(null), [engine, setEngine] = useState<MainnetSetup | null>(null);
  const [safeL1, setSafeL1] = useState(""), [safeL2, setSafeL2] = useState(""), [existingMirror, setExistingMirror] = useState(false);
  const [createBoth, setCreateBoth] = useState(true);
  const steps = mainnetSetupStepsFor(state).map(step => ({ ...step, label: step.label.split("Ethereum").join(l1Name), details: step.details.map(text => text.split("Ethereum").join(l1Name)) }));
  const pairedReady = !!engine && pairedSetupAvailable(engine.artifacts);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [status, setStatus] = useState("Loading setup…");
  const [elapsed, setElapsed] = useState(0);
  const [confirmationElapsed, setConfirmationElapsed] = useState(0);
  const confirmationKey = state?.pending?.hash ? `${state.salt}:${state.pending.hash}` : null;
  useEffect(() => {
    setConfirmationElapsed(0);
    if (!confirmationKey) return;
    const start = Date.now(), timer = setInterval(() => setConfirmationElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [confirmationKey]);
  const [balances, setBalances] = useState<{ address: Address; l1: bigint; l2: bigint } | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedWallet = useRef(wallet); selectedWallet.current = wallet;
  useEffect(() => {
    setElapsed(0); if (!busy) return;
    const start = Date.now(), timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { heading.current?.focus(); }, []);
  const [verificationError, setVerificationError] = useState(""), [verificationAttempt, setVerificationAttempt] = useState(0);
  const active = useRef(false), done = useRef(onComplete); done.current = onComplete;
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [mainnetSetupKey, target]);
  const persist = (s: MainnetSetupState) => { readMainnetSetup(JSON.stringify(s), network); retainSourceRequests(localStorage, s.sourceRequests); localStorage.setItem(mainnetSetupKey, JSON.stringify(s)); setState(s); };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = readMainnetSetup(localStorage.getItem(mainnetSetupKey), network);
      const artifacts = await loadTreasuryArtifacts(saved);
      if (cancelled) return;
      setState(saved); setEngine(new MainnetSetup(target, artifacts, network)); setStatus("");
    })().catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [target, network]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (active.current || event.key !== null && event.key !== mainnetSetupKey) return;
      try { setState(readMainnetSetup(localStorage.getItem(mainnetSetupKey), network)); setError(""); }
      catch (e) { setError((e as Error).message); }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [mainnetSetupKey, network]);
  useEffect(() => {
    if (!engine || !wallet.address || state?.completed.length === steps.length) { setBalances(null); return; }
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const address = getAddress(wallet.address);
    const poll = async () => {
      try {
        const [l1, l2] = await Promise.all((["l1", "l2"] as const).map(chain => engine.io.rpc<Hex>(chain, "eth_getBalance", [address, "latest"])));
        if (alive) { setBalances({ address, l1: BigInt(l1!), l2: BigInt(l2!) }); setBalanceError(""); }
      } catch { if (alive) { setBalances(null); setBalanceError("Wallet gas balances are unavailable. Retrying automatically."); } }
      finally { if (alive) timer = setTimeout(poll, 5000); }
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [engine, wallet.address, state?.completed.length, steps.length]);
  const run = async (fn: (s: MainnetSetupState | null, assertActive: () => void) => Promise<void>, background = false) => {
    if (active.current) return; active.current = true;
    const scope = generation.current;
    const assertActive = () => { if (generation.current !== scope) throw new Error("The setup screen changed; the unsent wallet request was cancelled."); };
    if (!background) { setBusy(true); setError(""); }
    try {
      if (!navigator.locks) throw new Error("Setup requires browser Web Locks support");
      await navigator.locks.request(mainnetSetupKey, { ifAvailable: true }, async lock => {
        assertActive();
        if (!lock) { if (background) return; throw new Error("Another tab is updating this treasury"); }
        const current = readMainnetSetup(localStorage.getItem(mainnetSetupKey), network);
        if (state?.salt !== current?.salt) { setState(current); if (!background) throw new Error("Setup changed in another tab. Review it before continuing"); return; }
        await fn(current, assertActive);
      });
    } catch (e) { if (generation.current === scope) setError((e as Error).message); }
    finally { active.current = false; if (!background && generation.current === scope) setBusy(false); }
  };
  useEffect(() => {
    if (!engine || !state?.pending) return;
    const poll = () => void run(async s => { if (!s?.pending) return; const next = await engine.reconcile(s); if (JSON.stringify(next) !== JSON.stringify(s)) { persist(next); setError(""); setStatus(""); } }, true);
    poll(); const timer = window.setInterval(poll, 3000); return () => clearInterval(timer);
  }, [engine, state]);
  useEffect(() => {
    if (!engine || state?.completed.length !== steps.length || state.pending) return;
    let alive = true;
    setVerificationError("");
    void navigator.locks.request(mainnetSetupKey, async () => {
      if (!alive) return;
      const saved = readMainnetSetup(localStorage.getItem(mainnetSetupKey), network);
      if (!saved || saved.salt !== state.salt) throw new Error("Setup changed during verification");
      const c = await engine.manifest(saved);
      if (!alive) return;
      if (localStorage.getItem(mainnetSetupKey) !== JSON.stringify(saved)) throw new Error("Setup changed during verification");
      localStorage.setItem(mainnetManifestKey, JSON.stringify(c)); done.current(c);
    }).catch(e => { if (alive) setVerificationError(e.message); });
    return () => { alive = false; };
  }, [engine, state, verificationAttempt]);
  const step = state ? steps[state.completed.length] : undefined;
  const review = state?.review;
  const signed = review?.approvals.some(a => a.owner.toLowerCase() === wallet.address?.toLowerCase());
  const owner = review?.owners.some(a => a.toLowerCase() === wallet.address?.toLowerCase());
  const needsOwners = !!state && state.completed.length >= 4;
  const quorum = !!review && review.approvals.length >= review.threshold;
  const wrongDeployer = !!state && !needsOwners && !same(wallet.address, state.deployer);
  const gasKnown = !!balances && same(balances.address, wallet.address);
  const noGas = !!step && gasKnown && balances![step.chain] === 0n;
  const symbol = network.testnet ? "test xDAI" : "ETH";
  const assetName = network.testnet ? "Test USDC" : "USDC";
  const descriptions = [
    state?.matching ? `Create your ${l1Name} Safe at the address reserved for both chains, with your wallet as sole owner (1 of 1).` : state?.creation === "create-both" ? `Create your ${l1Name} Safe with your selected wallet as its only owner (threshold 1), then prepare its local policy.` : `Prepare the local policy for your existing ${l1Name} Safe. Spending is authorized by the Safe’s owners later.`,
    state?.creation === "create-both" ? `Create the EEZ-X Safe with the same wallet owner. Its first Safe transaction will hand ownership to L1Owners during final setup.` : `Connect the EEZ-X mirror directly to your ${l1Name} Safe’s live owners and approval threshold.`,
    "Create the matching local policy on EEZ-X. The shared budget is counted once on this chain, whichever Safe starts a payment.",
    state?.matching ? `Deploy the ${l1Name} policy and allowance module, and connect the EEZ-X Safe, owner verifier and policy.` : `Prepare the ${l1Name} addresses used to reach the mirror Safe, its owner verifier and its policy.`,
    `Your ${l1Name} Safe’s owners authorize its local policy and spending allowance in one Safe batch.`,
    state?.creation === "create-both" ? `Replace the EEZ-X wallet owner with L1Owners, authorize the local allowance and activate both policies in one Safe transaction. The ${l1Name} Safe remains controlled by your wallet.` : `Authorize the EEZ-X Safe’s local allowance and activate both policies after their peer connections have been checked.`,
  ];
  const switchTo = async (chain: "l1" | "l2", assertActive: () => void) => {
    assertActive();
    const selected = selectedWallet.current;
    if (!selected.provider) throw new Error("Connect your wallet");
    if ((!selected.chainId || BigInt(selected.chainId) !== BigInt(network.chains[chain].chainId))
      && !await (chain === "l1" ? selected.switchToL1() : selected.switchToL2())) throw new Error("Wallet network switch cancelled");
    assertActive();
    if (selectedWallet.current.provider !== selected.provider || !same(selectedWallet.current.address, selected.address)) throw new Error("Wallet changed while switching networks");
    return selected.provider;
  };
  const signSafeStep = () => void run(async (s, assertActive) => {
    if (!s || s.pending || s.completed.length < 4) throw new Error("Deployment progress changed");
    const progress = (message: string) => { assertActive(); setStatus(message); };
    const provider = await switchTo(s.completed.length === 4 ? "l1" : "l2", assertActive);
    const reviewed = s.review ? s : { ...s, review: await engine!.review(s, progress) };
    assertActive();
    if (!s.review) persist(reviewed);
    try {
      const approval = await engine!.approve(reviewed, guardWalletRequests(provider, assertActive), progress);
      assertActive();
      if (selectedWallet.current.provider !== provider || !same(selectedWallet.current.address, approval.owner)) throw new Error("Wallet changed while signing");
      persist({ ...reviewed, review: { ...reviewed.review!, approvals: [...reviewed.review!.approvals, approval] } });
      setStatus("Owner approval saved.");
    } catch (error) {
      assertActive();
      if ((error as { code?: number }).code !== 4001) throw error;
      setStatus("Signature cancelled. Your setup is saved; you can sign again.");
    }
  });
  const connect = <div className={styles.owners}>{wallet.walletOptions.map((option, index) => <button className={`btn ${index === 0 ? "btn-solid" : "btn-outline"}`} key={option.id}
    onClick={() => void run(async () => { await selectedWallet.current.connect(option.id); })}>Connect {option.name}</button>)}
    {!wallet.walletOptions.length && <p>Open this dashboard in a browser with your wallet extension.</p>}</div>;
  return <section className={styles.treasury} aria-label={`${l1Name} treasury setup`}>
    <div className={styles.heading}><div><p className="eez-eyebrow">[ {l1Name.toUpperCase()} + EEZ-X ]</p>
      <h2 ref={heading} tabIndex={-1}>{state?.completed.length === steps.length ? "Verify your treasury" : "Set up your shared treasury"}</h2>
      <p>Create two new Safes, or connect your existing {l1Name} Safe and its EEZ-X mirror.</p>
    </div><span className={styles.badge}>{network.testnet ? "Shared testnet" : "Ethereum + EEZ-X"}</span></div>
    {!state ? <section className={styles.card}><h3>Choose your Safes</h3>
      <p className={styles.safeExplanation}>EEZ-X verifies each transaction against your {l1Name} Safe’s current owners and approval threshold. Manage owners on {l1Name}, and <strong>both Safes stay in sync automatically.</strong></p>
      <div className={styles.setupOptions} role="group" aria-label="Safe setup options">
        <button type="button" className={`btn ${createBoth ? "btn-solid" : "btn-outline"}`} aria-pressed={createBoth} disabled={busy} onClick={() => setCreateBoth(true)}>Create new Safes</button>
        <button type="button" className={`btn ${!createBoth ? "btn-solid" : "btn-outline"}`} aria-pressed={!createBoth} disabled={busy} onClick={() => setCreateBoth(false)}>Use an existing Safe</button>
      </div>
      {createBoth ? <div className={styles.stepContext} aria-label="New Safe ownership">
        <p>Both Safes start with your connected wallet as their only owner (1 of 1).</p>
        {wallet.address && <p>Owner: <code>{wallet.address}</code></p>}
        <p>The first EEZ-X Safe transaction replaces that wallet owner with <strong>L1Owners</strong>, together with its spending setup. Afterward, manage both Safes’ owners from {l1Name}.</p>
        <p className={styles.hint}>Both Safes will have the same address, with independent balances and transactions on each chain. You can resume setup after closing the dashboard.</p>
      </div> : <div className={styles.safeChoices}>
        <div className={styles.fields}><label className={styles.chainLabel} data-chain="l1" htmlFor="mainnet-safe">{l1Name} Safe address</label>
          <input id="mainnet-safe" aria-describedby="mainnet-safe-hint" value={safeL1} onChange={e => setSafeL1(e.target.value)} placeholder="0x…" disabled={busy}/>
          <p id="mainnet-safe-hint" className={styles.hint}>Keeps its current owners and approval threshold.</p></div>
        <div className={styles.fields}><label className={styles.chainLabel} data-chain="l2" htmlFor="mainnet-mirror-choice">EEZ-X Safe</label>
          <select id="mainnet-mirror-choice" value={existingMirror ? "existing" : "new"} disabled={busy} onChange={e => setExistingMirror(e.target.value === "existing")}><option value="new">Deploy a mirror Safe</option><option value="existing">Connect an existing mirror</option></select>
          {existingMirror && <><label htmlFor="mainnet-mirror">Mirror Safe address</label><input id="mainnet-mirror" aria-describedby="mainnet-mirror-hint" value={safeL2} onChange={e => setSafeL2(e.target.value)} placeholder="0x…" disabled={busy}/></>}
          <p id="mainnet-mirror-hint" className={styles.hint}>{existingMirror ? `Choose a mirror already connected to this ${l1Name} Safe.` : `The new mirror uses your ${l1Name} Safe’s live owners through its owner adapter.`}</p>
        </div>
      </div>}
      {wallet.address ? <button className={`btn btn-solid btn-lg ${styles.startSetup}`} disabled={!pairedReady || busy || !createBoth && (!isAddress(safeL1.trim()) || existingMirror && !isAddress(safeL2.trim()))} onClick={() => void run(async (saved, assertActive) => {
        if (saved) throw new Error("A treasury setup is already in progress");
        if (!pairedReady) throw new Error("Treasury setup is awaiting an updated contract release");
        const selected = selectedWallet.current;
        if (!selected.address) throw new Error("Connect your deployment wallet");
        const next = await engine!.configure(getAddress(selected.address), createBoth ? undefined : getAddress(safeL1.trim()), !createBoth && existingMirror ? getAddress(safeL2.trim()) : undefined,
          message => { assertActive(); setStatus(message); }, { matching: createBoth });
        assertActive();
        if (selectedWallet.current.provider !== selected.provider || !same(selectedWallet.current.address, selected.address)) throw new Error("Wallet changed during setup. Review your selection again.");
        persist(next); setStatus("Setup reviewed. Approve each named transaction when ready.");
      })}>{busy ? "Checking your Safes…" : "Start setup"}</button> : connect}
      {engine && !pairedReady && <p role="status">Treasury setup is awaiting an updated contract release.</p>}
    </section> : step ? <section className={styles.card} aria-busy={busy}>
      <div className={styles.setupProgress}><h3 className={styles.stepCount}>Deployment {state.completed.length} / {steps.length}</h3>
        <progress aria-label="Setup progress" value={state.completed.length} max={steps.length} /></div>
      <div className={styles.heading}><h3>{step.label}</h3><span className={styles.chainLabel} data-chain={step.chain}>{step.chain === "l1" ? l1Name : "EEZ-X"}</span></div>
      <div className={styles.stepContext} role="region" aria-label="About this step">
        <p>{descriptions[state.completed.length]}</p>
        {state.matching && <p>Safe address on both chains: <code>{state.matching.safe}</code></p>}
        {state.addresses.safeL1 ? <p>{l1Name} Safe: <code>{state.addresses.safeL1}</code></p> : <p>Initial owner: <code>{state.deployer}</code> (1 of 1)</p>}
        {state.addresses.safeL2 && <p>EEZ-X Safe: <code>{state.addresses.safeL2}</code></p>}
        {state.completed.length >= 2 && <><dl className={styles.limitSummary}>
          <div><dt>Each Safe’s limit</dt><dd>100 {assetName}</dd></div><div><dt>Shared budget</dt><dd>150 {assetName}</dd></div>
        </dl><p>Limits reset every ten minutes. Funding your Safes is separate from setup.</p></>}
        {state.completed.length === 5 && <p className={styles.notice}>Sign for your <strong>EEZ-X Safe</strong>, then submit on <strong>{l1Name}</strong>. The final batch activates both policies.</p>}
      </div>
      <section className={styles.stepDetails} aria-label="Transaction actions"><h4>What this transaction does</h4><ul>{step.details.map(text => <li key={text}>{text}</li>)}</ul></section>
      {!wallet.address && connect}
      {wrongDeployer && wallet.address && <p className={styles.notice}>Reconnect the recorded deployment wallet <code>{state.deployer}</code> to continue this transaction.</p>}
      {wallet.address && <details className={styles.disclosure}><summary>Wallet gas balances</summary>
        {gasKnown ? <><p>{l1Name}: {formatEther(balances!.l1)} {symbol}</p><p>EEZ-X: {formatEther(balances!.l2)} {symbol}</p></> : <p>{balanceError || "Reading wallet gas balances…"}</p>}
      </details>}
      {noGas && !state.pending && <p className={styles.notice}>Add {symbol} to your wallet on {step.chain === "l1" ? l1Name : "EEZ-X"} before submitting.{needsOwners && " You can still sign an approval; a funded wallet can submit once the quorum is collected."}</p>}
      {state.pending ? <div className={styles.notice} role="status">
        <p>{state.pending.hash ? "Waiting for confirmation…" : "Waiting for the wallet transaction…"} Keep this recorded request; it will be checked automatically after reload.</p>
        {state.pending.hash && <p>{confirmationElapsed}s checking confirmation on this screen. Network confirmation time varies.</p>}
        {state.pending.hash && <a href={`${target[state.pending.chain].explorer.replace(/\/$/, "")}/tx/${state.pending.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
      </div> : <>
        {needsOwners && <div className={styles.approvalStep}>
          <p>Approve with {review ? `${review.threshold} current owner${review.threshold === 1 ? "" : "s"}` : "this Safe’s current owners"}, then submit the transaction.</p>
          {review ? <button className="btn btn-ghost" disabled={!engine || busy} onClick={() => void run(async s => {
            if (!s || s.pending) throw new Error("Deployment progress changed");
            persist({ ...s, review: await engine!.review(s, setStatus) }); setStatus("");
          })}>Refresh Safe details</button> : <button className="btn btn-solid" disabled={!engine || busy || !wallet.address || !wallet.provider}
            onClick={signSafeStep}>{busy ? "Reading Safe details…" : "Review and sign"}</button>}
          {review && <>
            <strong className={styles.quorum} data-testid="setup-quorum">{review.approvals.length} of {review.threshold} owner approvals</strong>
            <p>Signing Safe: {review.chain === "l1" ? l1Name : "EEZ-X"} · Safe nonce {review.nonce}</p>
            <details className={styles.disclosure}><summary>Current owners</summary><ul className={styles.ownerList}>{review.owners.map(address => <li key={address}>
              <span><code>{address}</code>{same(address, wallet.address) && <span className={styles.hint}>Connected wallet</span>}</span>
              {review.approvals.some(a => same(a.owner, address)) && <span className={styles.badge} data-positive="true">Approved</span>}
            </li>)}</ul></details>
            <button className={`btn ${quorum ? "btn-outline" : "btn-solid"}`} disabled={busy || !owner || signed || quorum} onClick={signSafeStep}>{signed ? "Owner approved" : busy && status.startsWith("Signature received") ? "Signature received — checking…"
              : busy && status.startsWith("Waiting for the owner signature") ? "Waiting for your signature…" : "Sign Safe approval"}</button>
            {!owner && !quorum && <p className={styles.hint}>Select one of these current owners in your wallet to approve.</p>}
            {signed && !quorum && <p className={styles.hint}>Switch accounts in your wallet to collect another owner’s approval.</p>}
            {quorum && <p className={styles.hint}>Required approvals collected. Any funded connected wallet can submit this Safe batch.</p>}
          </>}
        </div>}
        <button className={`btn ${needsOwners && !quorum ? "btn-outline" : "btn-solid"}`} disabled={busy || !engine || !wallet.provider || !wallet.address || wrongDeployer || noGas || needsOwners && !quorum} onClick={() => void run(async (s, assertActive) => {
          if (!s || s.pending || s.completed.length !== state.completed.length) throw new Error("Deployment progress changed. Review the current step.");
          const provider = await switchTo(step.chain, assertActive); setStatus(`Preparing: ${step.label}`);
          const prepared = await engine!.prepare(s, guardWalletRequests(provider, assertActive), setStatus);
          assertActive();
          if (selectedWallet.current.provider !== provider || !same(selectedWallet.current.address, prepared.pending.sender)) throw new Error("Wallet changed during preparation");
          if (prepared.expiresAt && BigInt(prepared.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Fee quote expired. Prepare this step again");
          const next = { ...s, pending: prepared.pending }; persist(next); setStatus("Confirm the transaction in your wallet.");
          try {
            const hash = await provider.request({ method: "eth_sendTransaction", params: [prepared.request] });
            if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("No transaction hash returned");
            persist({ ...next, pending: { ...prepared.pending, hash: hash as Hex } }); setStatus("");
          } catch (e) {
            if ((e as { code?: number }).code === 4001) { persist(s); setStatus("Wallet cancelled. No transaction was authorized."); }
            else throw new Error(`Wallet response uncertain: ${(e as Error).message}. We’ll keep checking the recorded request automatically.`);
          }
        })}>{busy ? status.startsWith("Confirm") || status.startsWith("Waiting for the owner signature") ? "Waiting for wallet…" : "Preparing transaction…" : needsOwners ? "Submit approved Safe step" : "Approve next deployment step"}</button>
        {!state.completed.length && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(async saved => {
          if (!saved || saved.pending || saved.completed.length) throw new Error("Setup has started; keep its recorded wallet and Safes");
          localStorage.setItem(mainnetSetupKey, ""); setState(null); setStatus(""); heading.current?.focus();
        })}>Change setup</button>}
      </>}
    </section> : <section className={styles.card} aria-busy={!verificationError}>
      {verificationError ? <><h3>Couldn’t verify your treasury</h3><p className={styles.error} role="alert">{verificationError}</p><button className="btn btn-solid" onClick={() => setVerificationAttempt(x => x + 1)}>Retry verification</button></> : <p role="status">Verifying your treasury…</p>}
    </section>}
    {status && <p className={styles.hint} role="status">{status}</p>}
    {busy && <p className={styles.hint}>{elapsed}s elapsed.{status.startsWith("Quoting") && " Composer is simulating the cross-chain call. MetaMask opens after this finishes."}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <TreasuryPairedHistory target={target} network={network} />
  </section>;
}
