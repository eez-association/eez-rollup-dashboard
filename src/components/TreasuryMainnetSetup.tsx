import { retainSourceRequests } from "../lib/treasury/sourceVerification";
import { loadTreasuryArtifacts } from "../lib/treasury/release";
import { useEffect, useRef, useState } from "react";
import { getAddress, isAddress } from "viem";
import type { Hex } from "viem";
import type { TreasuryWallet } from "./TreasuryConnected";
import type { TreasuryConfig } from "../lib/treasury/client";
import { MainnetSetup, mainnetManifestKey, mainnetSetupKey, mainnetSetupStepsFor, pairedSetupAvailable, readMainnetSetup } from "../lib/treasury/mainnetSetup";
import type { MainnetSetupState, MainnetTarget } from "../lib/treasury/mainnetSetup";
import styles from "./TreasuryDemo.module.css";

export function TreasuryMainnetSetup({ wallet, target, onComplete }: { wallet: TreasuryWallet; target: MainnetTarget; onComplete: (c: TreasuryConfig) => void }) {
  const [state, setState] = useState<MainnetSetupState | null>(null), [engine, setEngine] = useState<MainnetSetup | null>(null);
  const [safeL1, setSafeL1] = useState(""), [safeL2, setSafeL2] = useState(""), [existingMirror, setExistingMirror] = useState(false);
  const steps = mainnetSetupStepsFor(state);
  const pairedReady = !!engine && pairedSetupAvailable(engine.artifacts);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(false), done = useRef(onComplete); done.current = onComplete;
  const persist = (s: MainnetSetupState) => { readMainnetSetup(JSON.stringify(s)); retainSourceRequests(localStorage, s.sourceRequests); localStorage.setItem(mainnetSetupKey, JSON.stringify(s)); setState(s); };
  useEffect(() => {
    let cancelled = false;
    const saved = readMainnetSetup(localStorage.getItem(mainnetSetupKey));
    void loadTreasuryArtifacts(saved, true).then(artifacts => {
      if (cancelled) return;
      setState(saved); setEngine(new MainnetSetup(target, artifacts));
    }).catch(e => setError(e.message));
    return () => { cancelled = true; };
  }, [target]);
  const run = async (fn: (s: MainnetSetupState | null) => Promise<void>, background = false) => {
    if (active.current) return; active.current = true;
    if (!background) { setBusy(true); setError(""); }
    try {
      if (!navigator.locks) throw new Error("Setup requires browser Web Locks support");
      await navigator.locks.request(mainnetSetupKey, { ifAvailable: true }, async lock => {
        if (!lock) { if (background) return; throw new Error("Another tab is updating this treasury"); }
        const current = readMainnetSetup(localStorage.getItem(mainnetSetupKey));
        if (state?.salt !== current?.salt) { setState(current); if (!background) throw new Error("Setup changed in another tab. Review it before continuing"); return; }
        await fn(current);
      });
    } catch (e) { setError((e as Error).message); }
    finally { active.current = false; if (!background) setBusy(false); }
  };
  useEffect(() => {
    if (!engine || !state?.pending) return;
    const poll = () => void run(async s => { if (!s?.pending) return; const next = await engine.reconcile(s); if (JSON.stringify(next) !== JSON.stringify(s)) persist(next); }, true);
    poll(); const timer = window.setInterval(poll, 3000); return () => clearInterval(timer);
  }, [engine, state]);
  useEffect(() => {
    if (!engine || state?.completed.length !== steps.length || state.pending) return;
    void run(async s => { if (!s) return; const c = await engine.manifest(s); localStorage.setItem(mainnetManifestKey, JSON.stringify(c)); done.current(c); });
  }, [engine, state]);
  const step = state ? steps[state.completed.length] : undefined;
  const review = state?.review;
  const signed = review?.approvals.some(a => a.owner.toLowerCase() === wallet.address?.toLowerCase());
  const owner = review?.owners.some(a => a.toLowerCase() === wallet.address?.toLowerCase());
  const switchTo = async (chain: "l1" | "l2") => {
    if (!wallet.provider) throw new Error("Connect your wallet");
    if (!await (chain === "l1" ? wallet.switchToL1() : wallet.switchToL2())) throw new Error("Wallet network switch cancelled");
    return wallet.provider;
  };
  return <section className={styles.treasury} aria-label="Ethereum treasury setup">
    <div className={styles.heading}><div><p className="eez-eyebrow">[ ETHEREUM + EEZ-X ]</p><h2>Set up your shared treasury</h2></div></div>
    {!state ? <section className={styles.card}><h3>Choose your Safes</h3>
      <p className={styles.safeExplanation}>EEZ-X verifies each transaction against your Ethereum Safe’s current owners and approval threshold. Manage owners on Ethereum, and <strong>both Safes stay in sync automatically.</strong></p>
      <div className={styles.safeChoices}>
        <div className={styles.fields}><label htmlFor="mainnet-safe">Ethereum Safe address</label><input id="mainnet-safe" value={safeL1} onChange={e => setSafeL1(e.target.value)} placeholder="0x…" disabled={busy}/><p className={styles.hint}>Keeps its current owners and approval threshold.</p></div>
        <div className={styles.fields}><label htmlFor="mainnet-mirror-choice">EEZ-X Safe</label><select id="mainnet-mirror-choice" value={existingMirror ? "existing" : "new"} disabled={busy} onChange={e => setExistingMirror(e.target.value === "existing")}><option value="new">Deploy a mirror Safe</option><option value="existing">Connect an existing mirror</option></select>
          {existingMirror && <><label htmlFor="mainnet-mirror">Mirror Safe address</label><input id="mainnet-mirror" value={safeL2} onChange={e => setSafeL2(e.target.value)} placeholder="0x…" disabled={busy}/></>}
        </div>
      </div>
      <button className="btn btn-solid" disabled={!pairedReady || busy || !wallet.address || !isAddress(safeL1.trim()) || existingMirror && !isAddress(safeL2.trim())} onClick={() => void run(async saved => {
        if (saved) throw new Error("A treasury setup is already in progress");
        if (!pairedReady) throw new Error("Treasury setup is awaiting an updated contract release");
        persist(await engine!.configure(getAddress(wallet.address!), getAddress(safeL1.trim()), existingMirror ? getAddress(safeL2.trim()) : undefined));
      })}>{busy ? "Checking your Safes…" : "Start setup"}</button>
      {engine && !pairedReady && <p role="status">Treasury setup is awaiting an updated contract release.</p>}
    </section> : step ? <section className={styles.card} aria-busy={busy}>
      <p className={styles.hint}>Step {state.completed.length + 1} of {steps.length} · {step.chain === "l1" ? "Ethereum" : "EEZ-X"}</p>
      <h3>{step.label}</h3><ul>{step.details.map(text => <li key={text}>{text}</li>)}</ul>
      {state.completed.length === 2 && <p>100 USDC per Safe and 150 shared per ten minutes. Fund your Safes separately with the existing USDC asset.</p>}
      {state.pending ? <p role="status">Waiting for confirmation…{state.pending.hash && <> <a href={`${target[state.pending.chain].explorer.replace(/\/$/, "")}/tx/${state.pending.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a></>}</p>
        : state.completed.length >= 4 ? <>
          {review && <p>{review.approvals.length} of {review.threshold} owner approvals</p>}
          <div className={styles.modeNav}>
            <button className="btn btn-outline" disabled={!engine || busy} onClick={() => void run(async s => { persist({ ...s!, review: await engine!.review(s!) }); })}>{review ? "Review again" : "Review allowance"}</button>
            {review && <button className="btn btn-outline" disabled={busy || !owner || signed} onClick={() => void run(async s => {
              const provider = await switchTo(s!.review!.chain), approval = await engine!.approve(s!, provider);
              persist({ ...s!, review: { ...s!.review!, approvals: [...s!.review!.approvals, approval] } });
            })}>Sign approval</button>}
          </div>
        </> : null}
      {!state.pending && <button className="btn btn-solid" disabled={busy || !engine || !wallet.provider || state.completed.length >= 4 && (!review || review.approvals.length < review.threshold)} onClick={() => void run(async s => {
        const provider = await switchTo(step.chain), prepared = await engine!.prepare(s!, provider);
        if (prepared.expiresAt && BigInt(prepared.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Fee quote expired. Prepare this step again");
        const next = { ...s!, pending: prepared.pending }; persist(next);
        try { const hash = await provider.request({ method: "eth_sendTransaction", params: [prepared.request] }) as Hex; persist({ ...next, pending: { ...next.pending, hash } }); }
        catch (e) { if ((e as { code?: number }).code === 4001) persist({ ...s!, pending: undefined }); throw e; }
      })}>{busy ? "Preparing transaction…" : "Confirm in wallet"}</button>}
    </section> : <p role="status">Verifying your treasury…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {state && state.completed.length > 0 && <section className={styles.card}><h3>Transaction history</h3><ol>{state.completed.map((tx, i) => <li key={tx.hash}><a href={`${target[tx.chain].explorer.replace(/\/$/, "")}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{steps[i]!.label} ↗</a> · Confirmed</li>)}</ol></section>}
  </section>;
}
