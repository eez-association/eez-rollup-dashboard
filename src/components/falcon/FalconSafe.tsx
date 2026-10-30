import { useEffect, useRef, useState } from 'react';
import { BaseError, formatUnits, keccak256, toHex, type Address, type Hex } from 'viem';
import type { Notice, useFalcon } from '../../hooks/useFalcon.ts';
import { WalletConnectionError, type FalconWallet } from '../../hooks/useFalconWallet.ts';
import { eezClient } from '../../lib/falcon/eez.ts';
import { invalidNonce } from '../../lib/falcon/l1Controller.ts';
import { loadRemoteSafe, prepareSafeTransfer, safeCallResult, safeOperationCall, verifySafeL1Execution, parseSafeTransfer, type RemoteSafe, type SafeOperation } from '../../lib/falcon/safe.ts';
import type { CrossChainDeployment } from '../../lib/falcon/crossChainDeployment.ts';
import { l1ActionDigest, l1ControllerAbi, type SignedL1Action } from '../../lib/falcon/l1Action.ts';
import { canonicalReceipt, checkL1Authorization, controllerClient, createL1ControllerData, executeL1Data, l1CallResult, loadL1Controller, parseSettlement, sameAddress, type ControllerState } from '../../lib/falcon/l1Controller.ts';
import { observeSettlementCost, observeSourceCost, type SafeCostEvidence, type SourceCost } from '../../lib/falcon/safeCosts.ts';
import { SafeCostComparison } from './SafeCostComparison.tsx';
import { SafeFeeQuote } from './SafeFeeQuote.tsx';
import { fetchFeeQuote, feeErrorMessage, recoverFeeTransaction, StaleFeeQuote, submitFeeQuote, UnknownFeeSubmission, type FeeConfig, type FeeIntent, type FeeTransaction, type QuotedFee } from '../../lib/falcon/l2Fees.ts';
import styles from './FalconPanel.module.css';

type Signer = Pick<ReturnType<typeof useFalcon>, 'publicKeyHex' | 'busy' | 'captureKeyGuard' | 'signActionDigest'>;
type Prepared = { signed: SignedL1Action; operation: SafeOperation; isCurrent: () => boolean };
type Submitted = { hash: Hex; account: Address; publicKey: Hex } & ({ kind: 'controller' } | { kind: 'call'; prepared: Prepared });
const initial: Notice = { kind: 'neutral', text: 'Unlock your Falcon key and connect your wallet to find your controller and Safe.' };

/** Shared factories and network bindings come from the host; user addresses are discovered on chain. */
export function FalconSafe({ signer, wallet, deployment, fees }: { signer: Signer; wallet: FalconWallet; deployment: CrossChainDeployment; fees: FeeConfig }) {
  const [controller, setController] = useState<ControllerState | null>(null);
  const [remote, setRemote] = useState<RemoteSafe | null>(null);
  const [lookedUp, setLookedUp] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('0.000001');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [fee, setFee] = useState<QuotedFee | null>(null);
  const feeType = wallet.transactionType;
  const [uncertain, setUncertain] = useState<{ intent: FeeTransaction; prepared: Prepared } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const currentFees = useRef({ fees, feeType }); currentFees.current = { fees, feeType };
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [l1Hash, setL1Hash] = useState<Hex | null>(null);
  const [costs, setCosts] = useState<SafeCostEvidence | null>(null);
  const [checkingCosts, setCheckingCosts] = useState(false);
  const [notice, setNotice] = useState<Notice>(initial);
  const [observation, setObservation] = useState('L1 read');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), running = useRef(false);
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(signer.publicKeyHex), currentInput = useRef({ amount, recipient });
  const currentDeployment = useRef(deployment);
  currentDeployment.current = deployment;
  currentKey.current = signer.publicKeyHex; currentInput.current = { amount, recipient };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    setController(null); setRemote(null); setLookedUp(false); setPrepared(null); setObservation('L1 read');
    if (!running.current) setNotice(initial);
    // Retain submitted hashes: the extension owns any pending transaction prompt.
  }, [signer.publicKeyHex, deployment]);
  useEffect(() => { setCosts(null); }, [deployment]);
  useEffect(() => { setFee(null); }, [signer.publicKeyHex, deployment, fees, feeType, wallet.address, wallet.chainId, amount, recipient]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true);
    const abort = new AbortController(); request.current = abort;
    try { await action(abort.signal); }
    catch (error) {
      if (mounted.current) {
        const cause = error instanceof BaseError ? error.walk(e => e instanceof WalletConnectionError) : error;
        setNotice({ kind: 'error', text: (error as { code?: number }).code === 4001 ? 'Request rejected in the wallet. Check wallet activity before retrying.'
          : feeErrorMessage(error) ?? (cause instanceof WalletConnectionError ? cause.message : error instanceof Error ? error.message.split('\n')[0]! : 'Cross-chain request failed.') });
      }
    } finally {
      running.current = false;
      if (mounted.current) { setBusy(false); setCheckingCosts(false); }
      if (request.current === abort) request.current = null;
    }
  }
  function keySnapshot() {
    if (!signer.publicKeyHex) throw new Error('Unlock your Falcon key first.');
    const publicKey = `0x${signer.publicKeyHex}` as Hex, guard = signer.captureKeyGuard();
    const isCurrent = () => mounted.current && guard() && currentKey.current === publicKey.slice(2);
    return { publicKey, isCurrent, assertCurrent: () => { if (!isCurrent()) throw new Error('Falcon key changed. Review and try again.'); } };
  }
  const sameKey = (publicKey: Hex) => mounted.current && currentKey.current === publicKey.slice(2);
  async function sourceSession(signal: AbortSignal) {
    const session = await wallet.getSession(signal, deployment.l2);
    return { session, client: await controllerClient(session.provider, deployment, signal) };
  }
  async function readRemote(address: Address, signal: AbortSignal) {
    const session = await wallet.getSession(signal, deployment.l1);
    return loadRemoteSafe(eezClient(session.provider), deployment, address, signal);
  }

  function load(create = false) {
    return run(async signal => {
      const key = keySnapshot();
      setNotice({ kind: 'pending', text: 'Checking your controller on L2…' });
      const { session, client } = await sourceSession(signal);
      let state = await loadL1Controller(client, deployment, key.publicKey, signal);
      if (!state && create) {
        const data = createL1ControllerData(key.publicKey);
        const gas = await client.estimateGas({ account: session.account, to: deployment.l2.factory.address, data });
        key.assertCurrent();
        const hash = await session.sendTransaction({ to: deployment.l2.factory.address, data, gas: toHex(gas) }, key.isCurrent);
        if (!mounted.current) return;
        const tx: Submitted = { kind: 'controller', hash, account: session.account, publicKey: key.publicKey };
        setSubmitted(tx); setL1Hash(null); setCosts(null);
        const receipt = await canonicalReceipt(client, hash, signal);
        if (!sameAddress(receipt.to ?? '', deployment.l2.factory.address)) throw new Error('Unexpected controller creation receipt.');
        state = await loadL1Controller(client, deployment, key.publicKey, signal);
        if (!state) throw new Error('No controller exists after the creation receipt.');
      }
      key.assertCurrent();
      setController(state); setLookedUp(true); setPrepared(null);
      if (!state) { setRemote(null); setNotice({ kind: 'neutral', text: 'No controller exists for this Falcon key. Create one on L2.' }); return; }
      setNotice({ kind: 'pending', text: `Reading your Safe on ${deployment.l1.chainName}. Your wallet may request a network switch…` });
      const target = await readRemote(state.controller, signal);
      key.assertCurrent(); setRemote(target); setObservation('L1 read');
      setNotice({ kind: target.target ? 'valid' : 'neutral', text: target.target ? 'Safe loaded. Sign a transfer from L2.' : 'Controller ready. Sign Safe creation with Falcon to create your Safe.' });
    });
  }

  function sign() {
    return run(async signal => {
      const key = keySnapshot(), input = currentInput.current;
      if (!controller || !remote) throw new Error('Load your controller and Safe first.');
      setPrepared(null); setFee(null); setNotice({ kind: 'pending', text: 'Checking your Safe and preparing the Falcon authorization…' });
      let operation: SafeOperation = { kind: 'create' };
      if (remote.target) {
        const transfer = parseSafeTransfer(input.recipient, input.amount);
        const session = await wallet.getSession(signal, deployment.l1);
        operation = await prepareSafeTransfer(eezClient(session.provider), deployment, controller.controller, transfer.recipient, transfer.value, signal);
      }
      const { client } = await sourceSession(signal);
      const state = await loadL1Controller(client, deployment, key.publicKey, signal);
      if (!state || !sameAddress(controller.controller, state.controller)) throw new Error('Controller changed. Load it again.');
      const action = { ...safeOperationCall(deployment, operation), sourceChainId: BigInt(deployment.l2.chainId), destinationChainId: BigInt(deployment.l1.chainId), controller: state.controller, eezL2: deployment.l2.manager, nonce: state.nonce, deadline: state.timestamp + 600n };
      const digest = l1ActionDigest(action);
      const contractDigest = await client.readContract({ address: state.controller, abi: l1ControllerAbi, functionName: 'actionDigest', args: [action.target, action.data, action.nonce, action.deadline] });
      if (digest !== contractDigest) throw new Error('Browser and controller authorization digests disagree.');
      const isCurrent = () => key.isCurrent() && (operation.kind === 'create' || (currentInput.current.amount === input.amount && currentInput.current.recipient === input.recipient));
      const signature = await signer.signActionDigest(digest, isCurrent);
      await client.getChainId();
      if (!isCurrent()) throw new Error('Key or transfer changed. Sign the action again.');
      setController(state); setPrepared({ signed: { action, publicKey: key.publicKey, signature }, operation, isCurrent });
      setNotice({ kind: 'neutral', text: `Falcon signature ready for ${operation.kind === 'create' ? 'Safe creation' : 'Safe transfer'} · L2 nonce ${state.nonce}.` });
    });
  }

  async function sourceReceipt(tx: Submitted, signal: AbortSignal) {
    setCheckingCosts(tx.kind === 'call' && tx.prepared.operation.kind === 'transfer');
    // Rechecking canonical evidence invalidates the previous cost result, including its L1 total.
    setCosts(before => before?.sourceHash === tx.hash ? { sourceHash: tx.hash, source: null, settlement: null } : null);
    const { session, client } = await sourceSession(signal);
    const receipt = await canonicalReceipt(client, tx.hash, signal);
    const state = await loadL1Controller(client, deployment, tx.publicKey, signal);
    if (!state) throw new Error('Receipt has no matching controller.');
    if (tx.kind === 'controller') {
      if (!sameAddress(receipt.to ?? '', deployment.l2.factory.address)) throw new Error('Unexpected controller creation receipt.');
      setNotice({ kind: 'valid', text: 'Controller creation confirmed on L2. Load your Safe to continue.' });
      return null;
    }
    const result = l1CallResult(receipt, tx.prepared.signed, tx.account);
    if (result === null || state.nonce <= tx.prepared.signed.action.nonce) throw new Error('Receipt does not contain the expected Falcon call result and consumed nonce.');
    const decoded = safeCallResult(tx.prepared.operation, result);
    if (sameKey(tx.publicKey)) {
      setController(state); setObservation('Result reported by L2');
      setRemote(before => before && (tx.prepared.operation.kind === 'create' ? { ...before, target: decoded as Address, nonce: null, balance: null } : { ...before, nonce: tx.prepared.operation.safeNonce + 1n, balance: null }));
    }
    let costSource: SourceCost | null = null;
    if (tx.prepared.operation.kind === 'transfer') {
      let problem: string | undefined;
      try { costSource = await observeSourceCost(client, receipt, deployment.l2.chainId, executeL1Data(tx.prepared.signed), tx.prepared.signed.action.data, signal); }
      catch { problem = 'L2 cost data is unavailable. Use Check L2 receipt to retry.'; }
      if (mounted.current && !signal.aborted && currentDeployment.current === deployment) setCosts({ sourceHash: tx.hash, source: costSource, settlement: null, problem });
    }
    signal.throwIfAborted();
    setNotice({ kind: 'valid', text: 'L2 call confirmed. Check L1 execution to verify the Safe result and canonical settlement.' });
    return { session, receipt, result, controller: state.controller, costSource };
  }

  function send(preview = false) {
    return run(async signal => {
      if (uncertain) throw new Error('Recover the previous wallet transaction before sending again.');
      if (!prepared || !prepared.isCurrent()) throw new Error('Sign the current action first.');
      const options = currentFees.current;
      const isCurrent = () => prepared.isCurrent() && currentDeployment.current === deployment && currentFees.current.fees === options.fees && currentFees.current.feeType === options.feeType;
      setFee(null);
      setNotice({ kind: 'pending', text: 'Checking the Safe and Falcon authorization, then estimating the cross-chain call…' });
      if (prepared.operation.kind === 'transfer') {
        const op = prepared.operation;
        const l1 = await wallet.getSession(signal, deployment.l1);
        const current = await prepareSafeTransfer(eezClient(l1.provider), deployment, prepared.signed.action.controller, op.recipient, op.value, signal);
        if (current.kind !== 'transfer' || !sameAddress(current.target, op.target) || current.safeNonce !== op.safeNonce || current.safeTxHash !== op.safeTxHash) throw new Error('Safe changed. Reload and sign the transfer again.');
      }
      const { session, client } = await sourceSession(signal);
      await checkL1Authorization(client, deployment, prepared.signed, signal);
      const intent: FeeIntent = { from: session.account, to: prepared.signed.action.controller, data: executeL1Data(prepared.signed), value: '0x0' };
      let hash: Hex | undefined;
      // Refresh only before the first wallet prompt. A submitted attempt is never automatically retried.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!isCurrent()) throw new Error('Signature, key or fee options changed. Review and try again.');
        setNotice({ kind: 'pending', text: 'Requesting the L2 execution and L1 settlement fee…' });
        const quoted = await fetchFeeQuote(intent, fees, { chainId: deployment.l2.chainId, type: feeType }, signal);
        session.assertCurrent();
        if (!isCurrent()) throw new Error('Signature, key or fee options changed. Review and try again.');
        setFee(quoted);
        if (preview) { setNotice({ kind: 'neutral', text: 'Fee estimated. Refreshed before sending.' }); return; }
        try {
          hash = await submitFeeQuote({ quoted, config: fees, wallet: session.provider, isCurrent,
            send: (tx, validate) => session.sendExactTransaction(tx, isCurrent, validate) });
          break;
        } catch (error) {
          setFee(null);
          if (error instanceof UnknownFeeSubmission) { setUncertain({ intent: quoted.transaction, prepared }); setPrepared(null); }
          if (error instanceof StaleFeeQuote && attempt === 0) continue;
          throw error;
        }
      }
      if (!hash) throw new Error('Could not obtain a current fee quote. Try estimating again.');
      if (!mounted.current) return;
      const tx: Submitted = { kind: 'call', hash, account: session.account, publicKey: prepared.signed.publicKey, prepared };
      setSubmitted(tx); setPrepared(null); setL1Hash(null); setCosts(null);
      setNotice({ kind: 'pending', text: 'Submitted through EEZ. Waiting for the L2 call result…' });
      await sourceReceipt(tx, signal);
    });
  }

  function recover() {
    return run(async signal => {
      if (!uncertain) return;
      const { session } = await sourceSession(signal);
      const hash = await recoverFeeTransaction(session.provider, recoveryHash.trim(), uncertain.intent);
      const tx: Submitted = { kind: 'call', hash, account: uncertain.intent.from, publicKey: uncertain.prepared.signed.publicKey, prepared: uncertain.prepared };
      setSubmitted(tx); setL1Hash(null); setCosts(null); setUncertain(null); setRecoveryHash('');
      await sourceReceipt(tx, signal);
    });
  }

  function checkL1() {
    return run(async signal => {
      if (submitted?.kind !== 'call') return;
      setL1Hash(null);
      const source = await sourceReceipt(submitted, signal);
      if (!source) return;
      const value = await source.session.provider.request({ method: 'eez_getSettlementByL2Block', params: [source.receipt.blockHash] });
      const settlement = parseSettlement(value, source.receipt);
      setNotice({ kind: 'pending', text: `Checking canonical execution on ${deployment.l1.chainName}…` });
      const session = await wallet.getSession(signal, deployment.l1);
      const client = eezClient(session.provider);
      const { remote: target, receipt } = await verifySafeL1Execution(client, deployment, source.controller, submitted.prepared.operation, source.result, settlement, signal);
      if (!mounted.current) return;
      setL1Hash(settlement.l1TransactionHash);
      if (sameKey(submitted.publicKey)) { setRemote(target); setObservation('Canonical L1 execution'); }
      if (!signal.aborted && currentDeployment.current === deployment) setCosts(before => before?.sourceHash === submitted.hash ? { ...before, l1Verified: true } : before);
      if (submitted.prepared.operation.kind === 'transfer' && source.costSource) {
        try {
          const costSettlement = await observeSettlementCost(client, receipt, deployment.l1.chainId, signal);
          if (mounted.current && !signal.aborted && currentDeployment.current === deployment) setCosts({ sourceHash: submitted.hash, source: source.costSource, settlement: costSettlement, l1Verified: true });
        } catch {
          if (mounted.current && !signal.aborted && currentDeployment.current === deployment) setCosts({ sourceHash: submitted.hash, source: source.costSource, settlement: null, l1Verified: true,
            problem: 'L1 execution is verified, but settlement cost data is unavailable. Use Check L1 execution to retry.' });
        }
      }
      signal.throwIfAborted();
      setNotice({ kind: 'valid', text: `L1 Safe execution verified · Safe nonce ${target.nonce}. Matching settlement, owner and Safe result checked. Finality has not been checked.` });
    });
  }
  function replay() {
    return run(async signal => {
      if (submitted?.kind !== 'call') return;
      const { client } = await sourceSession(signal);
      const signed = submitted.prepared.signed;
      try { await checkL1Authorization(client, deployment, signed, signal); }
      catch (error) {
        const nonce = invalidNonce(error, signed.action.nonce);
        if (nonce === null) throw error;
        setNotice({ kind: 'valid', text: `Replay rejected by L2 · nonce ${signed.action.nonce} is consumed; current nonce ${nonce}. No transaction sent.` }); return;
      }
      throw new Error('Replay authorization unexpectedly passed. Do not submit it.');
    });
  }

  const publicKeyHash = signer.publicKeyHex ? keccak256(`0x${signer.publicKeyHex}` as Hex) : null;
  const symbol = deployment.l1.safe?.nativeSymbol ?? 'native token';
  const unavailable = busy || !!uncertain || signer.busy || !signer.publicKeyHex || !wallet.address || !deployment.l1.safe;
  return <section className={styles.card} aria-labelledby="safe-heading">
    <header className={styles.header}>
      <p className={styles.eyebrow}>[ SAFE / CONTROL L1 FROM L2 ]</p>
      <div className={styles.titleRow}><h2 id="safe-heading">Your Falcon Safe</h2><span className={styles.badge}>{deployment.l1.chainName}</span></div>
      <p>Sign with Falcon in your browser. Your L2 controller verifies the signature and calls your Safe on L1.</p>
      <p className={styles.hint}>Each Falcon key has its own L2 controller and nonce.</p>
    </header>
    <div className={styles.actions}>
      <button id="safe-load" className={`btn btn-outline ${styles.action}`} disabled={unavailable} onClick={() => void load()}>Load my Safe</button>
      {lookedUp && !controller && <button id="safe-create-controller" className={`btn btn-solid ${styles.action}`} disabled={unavailable} onClick={() => void load(true)}>Create my L2 controller</button>}
    </div>
    {deployment.l1.safe && <details id="safe-manual-instructions" className={styles.details}>
      <summary>Manual instructions</summary>
      <ol className={`${styles.manualSteps} ${styles.hint}`}>
        <li>Copy your public key from Key manager and compute <code>keccak256</code> of its raw bytes.
          {publicKeyHash && <p className={styles.contractDetails}>Your public key hash: <code id="safe-key-hash">{publicKeyHash}</code></p>}
        </li>
        <li>On {deployment.l2.chainName}, open the <a href={`${deployment.l2.explorer}/address/${deployment.l2.factory.address}`} target="_blank" rel="noreferrer">controller factory</a> and read <code>controllers(publicKeyHash)</code> to find your L2 controller.</li>
        <li>On {deployment.l1.chainName}, open the <a href={`${deployment.l1.explorer}/address/${deployment.l1.registry}`} target="_blank" rel="noreferrer">EEZ registry</a> and read <code>computeCrossChainProxyAddress(controller, {deployment.l2.rollupId.toString()})</code> to find its L1 owner proxy.</li>
        <li>Open the <a href={`${deployment.l1.explorer}/address/${deployment.l1.safe.factory.address}`} target="_blank" rel="noreferrer">Safe factory on {deployment.l1.chainName}</a> and read <code>safes(ownerProxy)</code> to find your Safe.</li>
      </ol>
      <p className={styles.hint}>These calls are read-only. A zero address from either factory means that contract has not been created yet.</p>
    </details>}
    {!deployment.l1.safe && <p className={styles.hint}>Safe deployment has not been configured for this network.</p>}
    {controller && remote && <>
      <div className={styles.safeStats}>
        <div><span className={styles.label}>Safe balance · {symbol}</span><strong id="safe-balance">{remote.balance === null ? '—' : formatUnits(remote.balance, 18)}</strong></div>
        <div><span className={styles.label}>Next Safe nonce</span><strong id="safe-nonce">{remote.nonce?.toString() ?? '—'}</strong></div>
      </div>
      <p className={styles.hint}>{observation} · Next L2 controller nonce <span id="safe-controller-nonce">{controller.nonce.toString()}</span>.</p>
      {remote.target && <>
        <p className={styles.contractDetails}><a id="safe-address" href={`${deployment.l1.explorer}/address/${remote.target}`} target="_blank" rel="noreferrer">Safe · {remote.target}</a></p>
        <p className={styles.hint}>Fund this address on {deployment.l1.chainName} to send {symbol}. Your connected L2 wallet pays the quoted execution and settlement fee.</p>
        <label className={styles.label} htmlFor="safe-recipient">Recipient on {deployment.l1.chainName}</label>
        <input id="safe-recipient" className={styles.input} value={recipient} disabled={busy} spellCheck={false} autoCapitalize="off" placeholder="0x…" onChange={e => { setRecipient(e.target.value); setPrepared(null); }} />
        <label className={styles.label} htmlFor="safe-amount">Amount · {symbol}</label>
        <input id="safe-amount" className={styles.input} inputMode="decimal" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setPrepared(null); }} />
      </>}
      <div className={styles.actions}>
        <button id="safe-sign" className={`btn btn-outline ${styles.action}`} disabled={unavailable} onClick={() => void sign()}>{remote.target ? 'Sign Safe transfer with Falcon' : 'Sign Safe creation'}</button>
        <button id="safe-estimate-fee" className={`btn btn-outline ${styles.action}`} disabled={unavailable || !prepared} onClick={() => void send(true)}>Estimate fee</button>
        <button id="safe-send" className={`btn btn-solid ${styles.action}`} disabled={unavailable || !prepared} onClick={() => void send()}>Send from L2 <span aria-hidden="true">→</span></button>
      </div>
      <SafeFeeQuote fee={fee} config={fees} />
      {prepared && <p className={styles.hint}>{prepared.operation.kind === 'create' ? 'Signed Safe creation' : `Signed ${formatUnits(prepared.operation.value, 18)} ${symbol} to ${prepared.operation.recipient}`} · L2 nonce {prepared.signed.action.nonce.toString()} · expires {new Date(Number(prepared.signed.action.deadline) * 1000).toLocaleTimeString()}</p>}
      <details className={styles.details}><summary>Contracts &amp; authority</summary>
        <p className={styles.hint}>The controller’s L1 proxy is the Safe’s sole owner. No recovery owner or module is installed. Keep your encrypted Falcon backup.</p>
        <p className={styles.contractDetails}><a id="safe-controller" href={`${deployment.l2.explorer}/address/${controller.controller}`} target="_blank" rel="noreferrer">L2 controller · {controller.controller}</a></p>
        <p className={styles.contractDetails}><a href={`${deployment.l1.explorer}/address/${remote.owner}`} target="_blank" rel="noreferrer">L1 owner proxy · {remote.owner}</a></p>
      </details>
    </>}
    <p id="safe-status" className={styles.status} data-result={notice.kind} role="status" aria-live="polite">{notice.text}</p>
    {uncertain && <div className={styles.transaction}>
      <label className={styles.label}>Transaction hash from wallet activity<input id="safe-recovery-hash" className={styles.input} value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} /></label>
      <button id="safe-recover" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void recover()}>Recover transaction</button>
    </div>}
    {submitted && <div className={styles.transaction}>
      <a id="safe-source-tx" className={styles.contractDetails} href={`${deployment.l2.explorer}/tx/${submitted.hash}`} target="_blank" rel="noreferrer">L2 transaction · {submitted.hash}</a>
      {l1Hash && <a id="safe-settlement-tx" className={styles.contractDetails} href={`${deployment.l1.explorer}/tx/${l1Hash}`} target="_blank" rel="noreferrer">L1 settlement · {l1Hash}</a>}
      <div className={styles.actions}>
        <button id="safe-check-source" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void run(signal => sourceReceipt(submitted, signal).then(() => {}))}>Check L2 receipt</button>
        {submitted.kind === 'call' && <>
          <button id="safe-check-l1" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void checkL1()}>Check L1 execution</button>
          <button id="safe-replay" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void replay()}>Check replay rejection</button>
        </>}
      </div>
    </div>}
    {costs && submitted?.hash === costs.sourceHash && <SafeCostComparison evidence={costs} l1Name={deployment.l1.chainName} l1Symbol={symbol} l2Symbol={fees.nativeSymbol}
      checking={checkingCosts} checkDisabled={busy || !wallet.address} onCheckL1={() => void checkL1()} />}
  </section>;
}
