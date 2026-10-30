import { useEffect, useRef, useState } from 'react';
import { BaseError, formatUnits, keccak256, toHex, type Address, type Hex } from 'viem';
import type { Notice, useFalcon } from '../../hooks/useFalcon.ts';
import { WalletConnectionError, type FalconWallet } from '../../hooks/useFalconWallet.ts';
import { eezClient } from '../../lib/falcon/eez.ts';
import { config } from '../../config';
import { useFalconRecovery } from '../../hooks/useFalconRecovery';
import { matchesRecoveryTransaction, recoveryKey, type RecoveryAttempt } from '../../lib/falcon/recoveryJournal';
import { checkNoObservedSubmission, checkRecoveryOutcome, findRecoveryByNonce } from '../../lib/falcon/recoveryChecks';
import { falconReadProvider, confirmationDelay } from '../../lib/falcon/readOnly.ts';
import { loadRemoteSafe, prepareSafeTransfer, safeCallResult, safeOperationCall, verifySafeL1Execution, parseSafeTransfer, parseSafeTransaction, type RemoteSafe, type SafeOperation } from '../../lib/falcon/safe.ts';
import type { CrossChainDeployment } from '../../lib/falcon/crossChainDeployment.ts';
import { l1ActionDigest, l1ControllerAbi, type SignedL1Action } from '../../lib/falcon/l1Action.ts';
import { canonicalReceipt, checkChain, checkL1Authorization, controllerClient, createL1ControllerData, executeL1Data, FalconTransactionReverted, l1CallResult, loadL1Controller, parseSettlement, sameAddress, type ControllerState } from '../../lib/falcon/l1Controller.ts';
import { type SafeCostEvidence } from '../../lib/falcon/safeCosts.ts';
import { SafeCostComparison } from './SafeCostComparison.tsx';
import { SafeFeeQuote } from './SafeFeeQuote.tsx';
import { fetchFeeQuote, feeErrorMessage, recoverFeeTransaction, StaleFeeQuote, submitFeeQuote, UnknownFeeSubmission, type FeeConfig, type FeeIntent, type FeeTransaction, type QuotedFee } from '../../lib/falcon/l2Fees.ts';
import styles from './FalconPanel.module.css';

type Signer = Pick<ReturnType<typeof useFalcon>, 'publicKeyHex' | 'busy' | 'captureKeyGuard' | 'signActionDigest'>;
type Prepared = { signed: SignedL1Action; operation: SafeOperation; isCurrent: () => boolean };
type Submitted = { hash: Hex; account: Address; publicKey: Hex } & ({ kind: 'controller' } | { kind: 'call'; prepared: Prepared });
type Funding = { hash: Hex; account: Address; safe: Address; controller: Address; value: bigint; publicKey: string; nonce: bigint; journalId: string };
const initial: Notice = { kind: 'neutral', text: 'Unlock your Falcon key and connect your wallet to find your controller and Safe.' };

/** Shared factories and network bindings come from the host; user addresses are discovered on chain. */
export function FalconSafe({ signer, wallet, deployment, fees }: { signer: Signer; wallet: FalconWallet; deployment: CrossChainDeployment; fees: FeeConfig }) {
  const fundingJournal = useFalconRecovery(recoveryKey(deployment, 'funding'));
  const controllerJournal = useFalconRecovery(recoveryKey(deployment, 'controller'));
  const [controller, setController] = useState<ControllerState | null>(null);
  const [remote, setRemote] = useState<RemoteSafe | null>(null);
  const [lookedUp, setLookedUp] = useState(false);
  const [loadingSafe, setLoadingSafe] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('0.000001');
  const [data, setData] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const [fundAmount, setFundAmount] = useState('0.01');
  const [funding, setFunding] = useState<Funding | null>(null);
  const completedFunding = useRef<string | null>(null);
  const [fundedHash, setFundedHash] = useState<Hex | null>(null);
  const [fundingNotice, setFundingNotice] = useState<Notice | null>(null);
  const uncertainFunding = fundingJournal.attempt && !fundingJournal.attempt.hash ? fundingJournal.attempt : null;
  const [fundingRecoveryHash, setFundingRecoveryHash] = useState('');
  const [controllerRecoveryHash, setControllerRecoveryHash] = useState('');
  const [unsentAcknowledgement, setUnsentAcknowledgement] = useState<string | null>(null);
  const fundingPending = !!fundingJournal.attempt || !!funding && funding.hash !== fundedHash;
  const currentFunding = useRef(fundAmount); currentFunding.current = fundAmount;
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [fee, setFee] = useState<QuotedFee | null>(null);
  const feeType = wallet.transactionType;
  const [uncertain, setUncertain] = useState<{ intent: FeeTransaction; prepared: Prepared } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const currentFees = useRef({ fees, feeType }); currentFees.current = { fees, feeType };
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null);
  const [revertedSourceHash, setRevertedSourceHash] = useState<Hex | null>(null);
  const confirming = submitted?.kind === 'call' && submitted.hash !== confirmedHash;
  const [l1Hash, setL1Hash] = useState<Hex | null>(null);
  const [costs, setCosts] = useState<SafeCostEvidence | null>(null);
  const [checkingCosts, setCheckingCosts] = useState(false);
  const [notice, setNotice] = useState<Notice>(initial);
  const [observation, setObservation] = useState('L1 read');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), running = useRef(false);
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(signer.publicKeyHex), currentInput = useRef({ amount, recipient, data });
  const currentDeployment = useRef(deployment);
  currentDeployment.current = deployment;
  currentKey.current = signer.publicKeyHex; currentInput.current = { amount, recipient, data };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    setController(null); setRemote(null); setLookedUp(false); setPrepared(null); setObservation('L1 read');
    setCopyNotice('');
    if (!running.current) setNotice(initial);
    // Retain submitted hashes: the extension owns any pending transaction prompt.
  }, [signer.publicKeyHex, deployment]);
  useEffect(() => {
    if (!signer.publicKeyHex) { setLoadingSafe(false); return; }
    const publicKey = `0x${signer.publicKeyHex}` as Hex;
    const abort = new AbortController();
    setLoadingSafe(true);
    setNotice({ kind: 'pending', text: 'Finding your Safe account…' });
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          try {
            const client = await controllerClient(falconReadProvider(config.l2ProxyRpc, abort.signal, deployment.l2.chainName), deployment, abort.signal);
            const state = await loadL1Controller(client, deployment, publicKey, abort.signal);
            const target = state ? await readRemote(state.controller, abort.signal) : null;
            abort.signal.throwIfAborted();
            if (!sameKey(publicKey) || currentDeployment.current !== deployment) return;
            setController(state); setRemote(target); setLookedUp(true); setLoadingSafe(false);
            if (!running.current) setNotice({ kind: target?.target ? 'valid' : 'neutral', text: target?.target
              ? 'Safe loaded. Ready to send a transaction.'
              : state ? `Controller ready. Create your Safe on ${deployment.l1.chainName} to continue.`
                : 'No Safe exists for this Falcon key yet. Click Create Safe to set it up.' });
            return;
          } catch (error) {
            if (abort.signal.aborted) return;
            if (!running.current) setNotice({ kind: 'pending', text: 'Could not load your Safe yet. Retrying automatically…' });
          }
          await confirmationDelay(abort.signal);
        }
      } catch { /* Key changes and unmount cancel read-only discovery. */ }
    })();
    return () => abort.abort();
  }, [signer.publicKeyHex, deployment]);
  useEffect(() => {
    completedFunding.current = null;
    setCosts(null); setFunding(null); setFundedHash(null); setFundingNotice(null);
    setFundingRecoveryHash(''); setControllerRecoveryHash('');
    setUnsentAcknowledgement(null);
  }, [deployment]);
  useEffect(() => {
    const attempt = fundingJournal.attempt;
    if (attempt?.hash && attempt.kind === 'funding' && attempt.chainId === deployment.l1.chainId) {
      setFunding({ hash: attempt.hash, account: attempt.account, safe: attempt.to, controller: attempt.controller!,
        value: BigInt(attempt.value), publicKey: attempt.publicKey.slice(2), nonce: BigInt(attempt.nonce), journalId: attempt.id });
    } else if (!attempt && !fundingJournal.error) {
      // Another tab may resolve a cancellation/replacement. Stop observing its
      // old hash and release the local lock, retaining only our verified result.
      setFunding(current => current?.journalId === completedFunding.current ? current : null);
      setFundingNotice(current => current?.kind === 'pending' ? null : current);
    }
  }, [fundingJournal.attempt, fundingJournal.error, deployment]);
  useEffect(() => {
    const attempt = controllerJournal.attempt;
    if (!attempt || attempt.hash || busy) return;
    const abort = new AbortController();
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          try {
            assertRecoveryDeployment(attempt);
            const provider = falconReadProvider(config.l2ProxyRpc, abort.signal, deployment.l2.chainName);
            const client = await controllerClient(provider, deployment, abort.signal);
            const found = await findRecoveryByNonce(client, provider, attempt, abort.signal);
            abort.signal.throwIfAborted();
            if (found) {
              if (found.outcome === 'matching') await controllerJournal.selectHash(attempt, found.hash);
              else {
                await controllerJournal.resolve(attempt);
                if (mounted.current) setNotice({ kind: 'neutral', text: 'The earlier setup was replaced or cancelled. Its saved request is now closed.' });
              }
              return;
            }
          } catch { if (abort.signal.aborted) return; /* Keep the journal when lookup cannot establish an outcome. */ }
          await confirmationDelay(abort.signal, 10_000);
        }
      } catch { /* Navigation cancels observation, never the transaction. */ }
    })();
    return () => abort.abort();
  }, [controllerJournal.attempt, deployment, busy]);
  useEffect(() => {
    const attempt = controllerJournal.attempt;
    if (!attempt?.hash || busy) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const client = await controllerClient(falconReadProvider(config.l2ProxyRpc, abort.signal, deployment.l2.chainName), deployment, abort.signal);
          await checkRecoveryTransaction(client, attempt, attempt.hash!);
          await canonicalReceipt(client, attempt.hash!, abort.signal);
          const state = await loadL1Controller(client, deployment, attempt.publicKey, abort.signal);
          if (!state) throw new Error('The confirmed setup has no matching controller.');
          const safe = await readRemote(state.controller, abort.signal);
          abort.signal.throwIfAborted();
          await controllerJournal.finish(attempt.id);
          if (!mounted.current || currentDeployment.current !== deployment) return;
          setSubmitted({ kind: 'controller', hash: attempt.hash!, account: attempt.account, publicKey: attempt.publicKey });
          if (sameKey(attempt.publicKey)) { setController(state); setRemote(safe); setLookedUp(true); }
          setNotice({ kind: 'valid', text: 'Safe setup confirmed. Continue creating your Safe.' });
          return;
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof FalconTransactionReverted) {
            await controllerJournal.finish(attempt.id);
            if (mounted.current && currentDeployment.current === deployment) {
              setSubmitted({ kind: 'controller', hash: attempt.hash!, account: attempt.account, publicKey: attempt.publicKey });
              setNotice({ kind: 'error', text: error.message });
            }
            return;
          }
          setNotice({ kind: 'pending', text: 'Waiting for controller setup confirmation. No new setup transaction will be sent.' });
        }
        await confirmationDelay(abort.signal);
      }
    })().catch(() => { /* Unmount stops observation; the recovery record remains. */ });
    return () => abort.abort();
  }, [controllerJournal.attempt, deployment, busy]);
  useEffect(() => { setFee(null); }, [signer.publicKeyHex, deployment, fees, feeType, wallet.address, wallet.chainId, amount, recipient, data]);
  useEffect(() => {
    if (submitted?.kind !== 'call') return;
    const tx = submitted, abort = new AbortController();
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          try {
            const source = await sourceReceipt(tx, abort.signal);
            if (!source) return;
            await confirmL1(tx, source, abort.signal);
            abort.signal.throwIfAborted();
            setConfirmedHash(tx.hash);
            return;
          } catch (error) {
            if (abort.signal.aborted) return;
            if (error instanceof FalconTransactionReverted) {
              // A failed L1 settlement does not establish that the L2 call reverted.
              if (error.transactionHash === tx.hash) setRevertedSourceHash(tx.hash);
              setCosts(null);
              setConfirmedHash(tx.hash); setNotice({ kind: 'error', text: error.message }); return;
            }
            setNotice({ kind: 'pending', text: `Confirmation is taking longer. Checking automatically… ${error instanceof Error ? error.message.split('\n')[0] : ''}` });
          }
          await confirmationDelay(abort.signal);
        }
      } catch { /* Abort ends background observation without changing the transaction. */ }
      finally { if (!abort.signal.aborted) setCheckingCosts(false); }
    })();
    return () => abort.abort();
  }, [submitted, deployment]);
  useEffect(() => {
    if (!funding) return;
    const tx = funding, abort = new AbortController();
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          try {
            const client = l1ReadClient(abort.signal);
            await checkChain(client, deployment.l1);
            let transaction = await client.getTransaction({ hash: tx.hash });
            if (transaction.hash.toLowerCase() !== tx.hash.toLowerCase() || !matchesRecoveryTransaction(transaction, {
              version: 1, id: tx.journalId, kind: 'funding', chainId: deployment.l1.chainId, account: tx.account,
              to: tx.safe, controller: tx.controller, value: String(tx.value), nonce: String(tx.nonce), data: '0x', publicKey: `0x${tx.publicKey}`,
            })) throw new Error('Funding transaction does not match the recorded attempt.');
            const receipt = await canonicalReceipt(client, tx.hash, abort.signal);
            // The first read may have been pending; read its inclusion fields again.
            transaction = await client.getTransaction({ hash: tx.hash });
            abort.signal.throwIfAborted();
            if (receipt.transactionHash !== tx.hash || transaction.hash !== tx.hash
              || !sameAddress(receipt.to ?? '', tx.safe) || !sameAddress(transaction.to ?? '', tx.safe)
              || !sameAddress(receipt.from, tx.account) || !sameAddress(transaction.from, tx.account)
              || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber
              || (transaction.chainId !== undefined && transaction.chainId !== deployment.l1.chainId) || transaction.value !== tx.value || transaction.input !== '0x') {
              setFundingNotice({ kind: 'error', text: 'The funding transaction differs from the requested transfer. Inspect its trace.' });
              setFundedHash(tx.hash); return;
            }
            const safe = await readRemote(tx.controller, abort.signal);
            abort.signal.throwIfAborted();
            completedFunding.current = tx.journalId;
            await fundingJournal.finish(tx.journalId);
            if (abort.signal.aborted) return;
            if (currentKey.current === tx.publicKey) {
              setRemote(safe);
              setNotice({ kind: 'neutral', text: 'Safe balance updated. You can now sign a transfer.' });
            }
            setFundingNotice({ kind: 'valid', text: `Safe funded with ${formatUnits(tx.value, 18)} ${deployment.l1.safe?.nativeSymbol ?? 'native token'} on ${deployment.l1.chainName}.` });
            setFundedHash(tx.hash);
            void wallet.refreshBalances();
            return;
          } catch (error) {
            if (abort.signal.aborted) return;
            if (error instanceof FalconTransactionReverted) {
              completedFunding.current = tx.journalId;
              await fundingJournal.finish(tx.journalId);
              if (abort.signal.aborted) return;
              setFundingNotice({ kind: 'error', text: 'Funding transaction reverted. Inspect its trace.' }); setFundedHash(tx.hash); return;
            }
            setFundingNotice({ kind: 'pending', text: 'Waiting for funding confirmation. Checking automatically…' });
          }
          await confirmationDelay(abort.signal);
        }
      } catch { /* Unmount cancels reads only, never the funding transaction. */ }
    })();
    return () => abort.abort();
  }, [funding, deployment]);

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
    return loadRemoteSafe(l1ReadClient(signal), deployment, address, signal);
  }
  const l1ReadClient = (signal: AbortSignal) => eezClient(falconReadProvider(config.l1Rpc, signal, deployment.l1.chainName));

  function assertRecoveryDeployment(attempt: RecoveryAttempt) {
    const expectedChain = attempt.kind === 'funding' ? deployment.l1.chainId : deployment.l2.chainId;
    if (attempt.chainId !== expectedChain || attempt.kind === 'controller'
      && (!sameAddress(attempt.to, deployment.l2.factory.address) || attempt.data !== createL1ControllerData(attempt.publicKey))) {
      throw new Error('Recovery details belong to a different deployment.');
    }
  }
  async function checkRecoveryTransaction(client: ReturnType<typeof eezClient>, attempt: RecoveryAttempt, hash: Hex) {
    assertRecoveryDeployment(attempt);
    const transaction = await client.getTransaction({ hash });
    if (transaction.hash.toLowerCase() !== hash.toLowerCase() || !matchesRecoveryTransaction(transaction, attempt)) {
      throw new Error('This transaction does not match the recorded sender, nonce, destination, amount and data.');
    }
    return transaction;
  }

  async function findController(key: ReturnType<typeof keySnapshot>, signal: AbortSignal, create = false) {
    const { session, client } = await sourceSession(signal);
    let state = await loadL1Controller(client, deployment, key.publicKey, signal);
    if (!state && create) {
      if (controllerJournal.attempt || controllerJournal.error) throw new Error('Recover the previous controller setup before submitting another.');
      setNotice({ kind: 'pending', text: 'First setup step: approve preparation of your Safe. A second wallet confirmation will create the account.' });
      const data = createL1ControllerData(key.publicKey);
      const gas = await client.estimateGas({ account: session.account, to: deployment.l2.factory.address, data });
      const nonce = await client.getTransactionCount({ address: session.account, blockTag: 'pending' });
      key.assertCurrent();
      const attempt: RecoveryAttempt = { version: 1, id: crypto.randomUUID(), kind: 'controller', chainId: deployment.l2.chainId,
        account: session.account, to: deployment.l2.factory.address, nonce: String(nonce), value: '0', data, publicKey: key.publicKey };
      await controllerJournal.begin(attempt);
      let hash: Hex;
      try {
        hash = await session.sendTransaction({ to: deployment.l2.factory.address, data, gas: toHex(gas), nonce: toHex(nonce) }, key.isCurrent);
      } catch (error) {
        if (!(error instanceof UnknownFeeSubmission)) await controllerJournal.reject(attempt);
        throw error;
      }
      const tracked = await controllerJournal.recordHash(attempt, hash);
      if (!tracked?.hash) throw new Error('Controller setup was resolved in another tab. Load your Safe to continue.');
      hash = tracked.hash;
      if (!mounted.current) throw new Error('Safe setup was closed.');
      setSubmitted({ kind: 'controller', hash, account: session.account, publicKey: key.publicKey });
      setL1Hash(null); setCosts(null);
      const reads = await controllerClient(falconReadProvider(config.l2ProxyRpc, signal, deployment.l2.chainName), deployment, signal);
      await checkRecoveryTransaction(reads, attempt, hash);
      const receipt = await canonicalReceipt(reads, hash, signal);
      if (!sameAddress(receipt.to ?? '', deployment.l2.factory.address)) throw new Error('Unexpected controller creation receipt.');
      state = await loadL1Controller(reads, deployment, key.publicKey, signal);
      if (!state) throw new Error('No controller exists after the creation receipt.');
      await controllerJournal.finish(attempt.id);
    }
    key.assertCurrent();
    return state;
  }

  async function prepareAction(signal: AbortSignal, controllerState = controller, safeState = remote): Promise<Prepared> {
    const controller = controllerState, remote = safeState;
    const key = keySnapshot(), input = currentInput.current;
    if (!controller || !remote) throw new Error('Load your controller and Safe first.');
    setPrepared(null); setFee(null); setNotice({ kind: 'pending', text: 'Checking your Safe and preparing the Falcon authorization…' });
    let operation: SafeOperation = { kind: 'create' };
    if (remote.target) {
      const transfer = parseSafeTransaction(input.recipient, input.amount, input.data);
      operation = await prepareSafeTransfer(l1ReadClient(signal), deployment, controller.controller, transfer.recipient, transfer.value, signal, transfer.data);
    }
    const { client } = await sourceSession(signal);
    const state = await loadL1Controller(client, deployment, key.publicKey, signal);
    if (!state || !sameAddress(controller.controller, state.controller)) throw new Error('Controller changed. Load it again.');
    const action = { ...safeOperationCall(deployment, operation), sourceChainId: BigInt(deployment.l2.chainId), destinationChainId: BigInt(deployment.l1.chainId), controller: state.controller, eezL2: deployment.l2.manager, nonce: state.nonce, deadline: state.timestamp + 600n };
    const digest = l1ActionDigest(action);
    const contractDigest = await client.readContract({ address: state.controller, abi: l1ControllerAbi, functionName: 'actionDigest', args: [action.target, action.data, action.nonce, action.deadline] });
    if (digest !== contractDigest) throw new Error('Browser and controller authorization digests disagree.');
    const isCurrent = () => key.isCurrent() && (operation.kind === 'create' || (currentInput.current.amount === input.amount && currentInput.current.recipient === input.recipient && currentInput.current.data === input.data));
    const signature = await signer.signActionDigest(digest, isCurrent);
    await client.getChainId();
    if (!isCurrent()) throw new Error('Key or transfer changed. Sign the action again.');
    setController(state);
    return { signed: { action, publicKey: key.publicKey, signature }, operation, isCurrent };
  }

  function sign() {
    return run(async signal => {
      const next = await prepareAction(signal);
      setPrepared(next);
      await sendPrepared(next, signal, true);
    });
  }

  async function sourceReceipt(tx: Submitted, signal: AbortSignal) {
    setCheckingCosts(true);
    // Keep the last verified paid fee visible while the L1 settlement is retried.
    setCosts(before => before?.sourceHash === tx.hash ? before : null);
    const provider = falconReadProvider(config.l2ProxyRpc, signal, deployment.l2.chainName);
    const client = await controllerClient(provider, deployment, signal);
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
    signal.throwIfAborted();
    setCosts({ sourceHash: tx.hash, source: null, settlement: null,
      receiptFee: { gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, l1GasPrice: null } });
    signal.throwIfAborted();
    setNotice({ kind: 'pending', text: `L2 call confirmed. Waiting for execution on ${deployment.l1.chainName}…` });
    return { provider, receipt, result, controller: state.controller };
  }

  function send(preview = false) {
    return run(async signal => {
      if (uncertain) throw new Error('Recover the previous wallet transaction before sending again.');
      if (!prepared || !prepared.isCurrent()) throw new Error('Sign the current action first.');
      await sendPrepared(prepared, signal, preview);
    });
  }

  function createSafe() {
    return run(async signal => {
      if (uncertain) throw new Error('Recover the previous wallet transaction before sending again.');
      const key = keySnapshot();
      setNotice({ kind: 'pending', text: `Preparing your Safe on ${deployment.l1.chainName}…` });
      // Only a canonical L2 revert permits retrying a known creation attempt.
      if (submitted?.kind === 'call' && submitted.prepared.operation.kind === 'create'
        && sameKey(submitted.publicKey) && submitted.hash !== revertedSourceHash) {
        return;
      }
      const state = controller ?? await findController(key, signal, true);
      if (!state) throw new Error('Safe setup is not ready. Try loading your Safe again.');
      setController(state); setLookedUp(true);
      const current = await readRemote(state.controller, signal);
      key.assertCurrent();
      if (currentDeployment.current !== deployment) throw new Error('Network changed. Load your Safe again.');
      if (current.target) {
        setRemote(current); setNotice({ kind: 'valid', text: 'Your Safe already exists. It is ready to load and use.' }); return;
      }
      setRemote(current);
      const next = await prepareAction(signal, state, current);
      if (next.operation.kind !== 'create') throw new Error('A Safe already exists. Load it before continuing.');
      await sendPrepared(next, signal);
    });
  }

  function fundSafe() {
    return run(async signal => {
      let attempted: RecoveryAttempt | null = null, hashReturned = false, journalStarted = false;
      try {
      if (fundingPending || uncertainFunding || !controller || !remote?.target || !wallet.address) return;
      const key = keySnapshot(), snapshot = currentFunding.current, sender = wallet.address;
      const { value } = parseSafeTransfer(remote.target, snapshot);
      setFundingNotice({ kind: 'pending', text: `Preparing funding on ${deployment.l1.chainName}…` });
      const safe = await readRemote(controller.controller, signal);
      key.assertCurrent();
      if (!safe.target || !sameAddress(safe.target, remote.target)) throw new Error('Safe changed. Load it again before funding.');
      const client = l1ReadClient(signal);
      const estimatedGas = await client.estimateGas({ account: sender, to: safe.target, value, data: '0x' });
      const gas = (estimatedGas * 120n + 99n) / 100n;
      const [balance, gasPrice] = await Promise.all([client.getBalance({ address: sender }), client.getGasPrice()]);
      if (balance < value + gas * gasPrice * 2n) throw new Error(`Your gas wallet needs more ${deployment.l1.safe?.nativeSymbol ?? 'native token'} on ${deployment.l1.chainName} for this amount and gas.`);
      const isCurrent = () => key.isCurrent() && currentFunding.current === snapshot && currentDeployment.current === deployment;
      if (!isCurrent()) throw new Error('Funding amount or key changed. Review and try again.');
      const session = await wallet.getSession(signal, deployment.l1);
      if (!sameAddress(session.account, sender)) throw new Error('Gas wallet changed. Review the funding transfer again.');
      const nonce = await eezClient(session.provider).getTransactionCount({ address: sender, blockTag: 'pending' });
      attempted = { version: 1, id: crypto.randomUUID(), kind: 'funding', chainId: deployment.l1.chainId,
        account: sender, to: safe.target, controller: controller.controller, value: String(value), nonce: String(nonce), data: '0x', publicKey: key.publicKey };
      await fundingJournal.begin(attempted);
      journalStarted = true;
      const hash = await session.sendTransaction({ to: safe.target, data: '0x', value: toHex(value), gas: toHex(gas), nonce: toHex(nonce) }, isCurrent);
      hashReturned = true;
      const tracked = await fundingJournal.recordHash(attempted, hash);
      if (!mounted.current || !tracked) return;
      setFundingNotice({ kind: 'pending', text: `Funding submitted on ${deployment.l1.chainName}. Waiting for confirmation…` });
      } catch (error) {
        if (attempted && journalStarted && !hashReturned && !(error instanceof UnknownFeeSubmission)) await fundingJournal.reject(attempted);
        if (mounted.current) setFundingNotice({ kind: 'error', text: (error as { code?: number }).code === 4001
          ? 'Funding cancelled in your wallet.'
          : error instanceof Error ? error.message.split('\n')[0]! : 'Funding did not return a transaction hash. Check wallet activity before retrying.' });
        throw error;
      }
    });
  }

  function recoverFunding() {
    return run(async signal => {
      const attempt = fundingJournal.attempt;
      if (!attempt) return;
      const hash = fundingRecoveryHash.trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Enter the funding transaction hash from your wallet activity.');
      const client = l1ReadClient(signal);
      await checkChain(client, deployment.l1);
      assertRecoveryDeployment(attempt);
      const outcome = await checkRecoveryOutcome(client, attempt, hash as Hex, signal);
      signal.throwIfAborted();
      if (outcome === 'replaced') {
        await fundingJournal.resolve(attempt);
        setFunding(null); setFundedHash(null);
        setFundingNotice({ kind: 'neutral', text: `A confirmed replacement or cancellation consumed this nonce. The original funding request is closed; it was not marked as funded. Transaction: ${hash}` });
      } else {
        await fundingJournal.selectHash(attempt, hash as Hex);
        setFundingNotice({ kind: 'pending', text: 'Funding transaction found. Checking confirmation automatically…' });
      }
      setFundingRecoveryHash(''); setUnsentAcknowledgement(null);
    });
  }

  function recoverController() {
    return run(async signal => {
      const attempt = controllerJournal.attempt;
      if (!attempt) return;
      const hash = controllerRecoveryHash.trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Enter the setup transaction hash from your wallet activity.');
      const client = await controllerClient(falconReadProvider(config.l2ProxyRpc, signal, deployment.l2.chainName), deployment, signal);
      assertRecoveryDeployment(attempt);
      const outcome = await checkRecoveryOutcome(client, attempt, hash as Hex, signal);
      signal.throwIfAborted();
      if (outcome === 'replaced') {
        await controllerJournal.resolve(attempt);
        setNotice({ kind: 'neutral', text: `A confirmed replacement or cancellation consumed this nonce. The original setup request is closed. Load your Safe before starting again. Transaction: ${hash}` });
      } else await controllerJournal.selectHash(attempt, hash as Hex);
      setControllerRecoveryHash(''); setUnsentAcknowledgement(null);
    });
  }

  function clearUnsentRequest(kind: RecoveryAttempt['kind']) {
    return run(async signal => {
      const journal = kind === 'funding' ? fundingJournal : controllerJournal;
      const attempt = journal.attempt;
      if (!attempt || attempt.hash || unsentAcknowledgement !== attempt.id) throw new Error('Confirm that all wallet prompts were cancelled and no transaction was sent.');
      assertRecoveryDeployment(attempt);
      const network = kind === 'funding' ? deployment.l1 : deployment.l2;
      const endpoints = kind === 'funding' ? [config.l1Rpc, config.l1ProxyRpc] : [config.l2Rpc, config.l2ProxyRpc];
      await Promise.all([...new Set(endpoints)].map(async url => {
        const client = eezClient(falconReadProvider(url, signal, network.chainName));
        await checkChain(client, network);
        await checkNoObservedSubmission(client, attempt, signal);
      }));
      signal.throwIfAborted();
      // Compare the hash inside the journal lock: a late reply during the reads blocks this clear.
      await journal.resolve(attempt);
      setUnsentAcknowledgement(null);
      const message: Notice = { kind: 'neutral', text: 'Saved unsent request cleared after your confirmation and nonce checks. No transaction was sent or cancelled by this action.' };
      if (kind === 'funding') { setFunding(null); setFundedHash(null); setFundingNotice(message); }
      else setNotice(message);
    });
  }

  async function sendPrepared(prepared: Prepared, signal: AbortSignal, preview = false) {
    const options = currentFees.current;
    const isCurrent = () => prepared.isCurrent() && currentDeployment.current === deployment && currentFees.current.fees === options.fees && currentFees.current.feeType === options.feeType;
    setFee(null);
    setNotice({ kind: 'pending', text: 'Checking the Safe and Falcon authorization, then estimating the cross-chain call…' });
    if (prepared.operation.kind === 'transfer') {
      const op = prepared.operation;
      const current = await prepareSafeTransfer(l1ReadClient(signal), deployment, prepared.signed.action.controller, op.recipient, op.value, signal, op.data ?? '0x');
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
      if (preview) { setNotice({ kind: 'neutral', text: 'Falcon signature ready. Fee estimated automatically; refreshed before sending.' }); return; }
      if (prepared.operation.kind === 'create') setNotice({ kind: 'pending', text: `Approve creation of your Safe on ${deployment.l1.chainName} in your wallet. Only the transaction fee is paid.` });
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
  }

  function recover() {
    return run(async signal => {
      if (!uncertain) return;
      const { session } = await sourceSession(signal);
      const hash = await recoverFeeTransaction(session.provider, recoveryHash.trim(), uncertain.intent);
      const tx: Submitted = { kind: 'call', hash, account: uncertain.intent.from, publicKey: uncertain.prepared.signed.publicKey, prepared: uncertain.prepared };
      setSubmitted(tx); setL1Hash(null); setCosts(null); setUncertain(null); setRecoveryHash('');
    });
  }

  async function confirmL1(tx: Extract<Submitted, { kind: 'call' }>, source: NonNullable<Awaited<ReturnType<typeof sourceReceipt>>>, signal: AbortSignal) {
    const value = await source.provider.request({ method: 'eez_getSettlementByL2Block', params: [source.receipt.blockHash] });
    const settlement = parseSettlement(value, source.receipt);
    setNotice({ kind: 'pending', text: `Checking canonical execution on ${deployment.l1.chainName}…` });
    const client = l1ReadClient(signal);
    const { remote: target, receipt } = await verifySafeL1Execution(client, deployment, source.controller, tx.prepared.operation, source.result, settlement, signal);
    if (!mounted.current) return;
    setL1Hash(settlement.l1TransactionHash);
    if (sameKey(tx.publicKey)) { setRemote(target); setObservation('Canonical L1 execution'); }
    if (!signal.aborted && currentDeployment.current === deployment) setCosts(before => before?.sourceHash === tx.hash && before.receiptFee ? {
      ...before, l1Verified: true, receiptFee: { ...before.receiptFee, l1GasPrice: receipt.effectiveGasPrice },
      settlementFee: { gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, blobGasUsed: receipt.blobGasUsed, blobGasPrice: receipt.blobGasPrice },
    } : before);
    signal.throwIfAborted();
    setNotice({ kind: 'valid', text: tx.prepared.operation.kind === 'create' ? `Safe created on ${deployment.l1.chainName}.` : `Transfer confirmed on ${deployment.l1.chainName}.` });
  }

  async function copyAddress() {
    const address = remote?.target, key = currentKey.current;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      if (mounted.current && currentKey.current === key) setCopyNotice('Address copied');
    } catch {
      if (mounted.current && currentKey.current === key) setCopyNotice(`Copy this address: ${address}`);
    }
  }

  function clearAuthorization() {
    setPrepared(null); setFee(null);
    setNotice({ kind: 'neutral', text: 'Review the transaction details, then sign with Falcon.' });
  }

  const unsentControls = (attempt: RecoveryAttempt) => !attempt.hash && <fieldset className={styles.fields} disabled={busy}>
    <label className={styles.hint}>
      <input type="checkbox" checked={unsentAcknowledgement === attempt.id}
        onChange={event => setUnsentAcknowledgement(event.target.checked ? attempt.id : null)} />{' '}
      I cancelled all wallet prompts for this request and checked that no transaction was sent.
    </label>
    <p className={styles.hint}>Clearing the saved request does not cancel a signed transaction. If wallet activity shows a transaction, recover its hash instead.</p>
    <button className="btn btn-outline" disabled={unsentAcknowledgement !== attempt.id}
      onClick={() => void clearUnsentRequest(attempt.kind)}>Check and clear unsent request</button>
  </fieldset>;

  const publicKeyHash = signer.publicKeyHex ? keccak256(`0x${signer.publicKeyHex}` as Hex) : null;
  const symbol = deployment.l1.safe?.nativeSymbol ?? 'native token';
  const unavailable = loadingSafe || busy || confirming || fundingPending || !!controllerJournal.attempt || !!fundingJournal.error || !!controllerJournal.error
    || wallet.networkSetup?.status === 'connecting' || !!uncertain || signer.busy || !signer.publicKeyHex || !wallet.address || !deployment.l1.safe;
  const safeReady = !!remote?.target && remote.balance !== null && remote.nonce !== null && !confirming;
  return <section className={styles.card} aria-labelledby="safe-heading">
    <header className={styles.header}>
      <div className={styles.titleRow}><h2 id="safe-heading">{remote?.target ? 'Your Safe account' : 'Your Falcon Safe'}</h2><span className={styles.badge}>{deployment.l1.chainName} · L1</span></div>
      {remote?.target ? <>
        <div className={styles.accountIdentity}>
          <a id="safe-address" className={styles.accountAddress} href={`${deployment.l1.explorer}/address/${remote.target}`} title={remote.target}
            aria-label={`Safe address ${remote.target}`} target="_blank" rel="noreferrer">{remote.target.slice(0, 12)}…{remote.target.slice(-10)}</a>
          <button className="btn btn-sm btn-outline" onClick={() => void copyAddress()} aria-label="Copy Safe address">Copy address</button>
        </div>
        {copyNotice && <p role="status" className={styles.copyNotice}>{copyNotice}</p>}
      </> : <p>Create a Safe account on {deployment.l1.chainName} controlled by your Falcon key.</p>}
    </header>
    {!signer.publicKeyHex && <p role="status" className={`${styles.status} ${styles.unlockNotice}`}><strong>Unlock your Falcon key</strong><br />Your Safe account will load automatically.</p>}
    {(fundingJournal.error || controllerJournal.error) && <p role="alert">{fundingJournal.error || controllerJournal.error}</p>}
    {fundingNotice && <p role="status" className={styles.status} data-result={fundingNotice.kind}>{fundingNotice.text}</p>}
    {fundingJournal.attempt && !fundingJournal.attempt.hash && !busy && <div className={styles.transaction} role="group" aria-label="Recover funding transaction">
      <p className={styles.hint}>{fundingJournal.attempt.hash ? 'Funding is being checked automatically.' : 'A funding request is unresolved. Check wallet activity before sending again.'} Recovery also works with a locked Falcon key.</p>
      <p className={styles.hint}>From {fundingJournal.attempt.account} · To {fundingJournal.attempt.to} · {formatUnits(BigInt(fundingJournal.attempt.value), 18)} {symbol}.</p>
      <label className={styles.label}>Funding transaction hash<input id="funding-recovery-hash" className={styles.input} value={fundingRecoveryHash} onChange={event => setFundingRecoveryHash(event.target.value)} /></label>
      <p className={styles.hint}>Use the original hash, a speed-up replacement, or a mined cancellation from your wallet activity.</p>
      <button className={`btn btn-outline ${styles.action}`} disabled={busy} onClick={() => void recoverFunding()}>Recover funding</button>
      {unsentControls(fundingJournal.attempt)}
    </div>}
    {controllerJournal.attempt && !controllerJournal.attempt.hash && !busy && !signer.busy && <details className={styles.details}>
      <summary>Earlier setup needs attention</summary>
      <div className={styles.transaction} role="group" aria-label="Recover controller setup">
      <p className={styles.hint}>We are checking the earlier setup automatically. If it was interrupted and cannot be found, you can recover it from wallet activity here.</p>
      <p className={styles.hint}>Sender: {controllerJournal.attempt.account}</p>
      {controllerJournal.attempt.hash && <a href={`${deployment.l2.explorer}/tx/${controllerJournal.attempt.hash}`} target="_blank" rel="noreferrer">Controller setup transaction</a>}
      <label className={styles.label}>Controller setup transaction hash<input id="controller-recovery-hash" className={styles.input} value={controllerRecoveryHash} onChange={event => setControllerRecoveryHash(event.target.value)} /></label>
      <p className={styles.hint}>A mined replacement or cancellation can close the original request without treating it as a successful setup.</p>
      <button className={`btn btn-outline ${styles.action}`} disabled={busy} onClick={() => void recoverController()}>Recover controller setup</button>
      {unsentControls(controllerJournal.attempt)}
      </div>
    </details>}
    {funding && <div className={styles.fundingLinks}>
      <a className={styles.contractDetails} href={`${deployment.l1.explorer}/tx/${funding.hash}`} title={funding.hash}
        target="_blank" rel="noreferrer">Funding tx · {funding.hash.slice(0, 10)}…{funding.hash.slice(-8)}</a>
      <a className="btn btn-sm btn-outline" href={`#/visualizer?mode=trace&chain=l1&tx=${funding.hash}`}
        aria-label="See funding transaction in trace decoder" target="_blank" rel="noreferrer">See trace</a>
    </div>}
    {lookedUp && !controller && <>
      <p className={styles.hint}>Create a Safe on {deployment.l1.chainName} controlled by your Falcon key. First-time setup may need two wallet confirmations.</p>
      <button id="safe-create" className={`btn btn-solid ${styles.action}`} disabled={unavailable} onClick={() => void createSafe()}>
        {busy ? 'Creating Safe…' : 'Create Safe'}
      </button>
    </>}
    {deployment.l1.safe && !remote?.target && <details id="safe-manual-instructions" className={styles.details}>
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
      {remote.target && remote.balance !== null && <div className={styles.safeStats}>
        <div><span className={styles.label}>Safe balance · {symbol}</span><strong id="safe-balance">{remote.balance === null ? '—' : formatUnits(remote.balance, 18)}</strong></div>
        <div role="group" aria-label="Fund Safe on L1">
          <label className={styles.label} htmlFor="safe-fund-amount">Amount to fund · {symbol} on {deployment.l1.chainName}</label>
          <div className={styles.safeFundingControls}>
            <input id="safe-fund-amount" className={styles.input} inputMode="decimal" value={fundAmount} disabled={unavailable}
              onChange={event => setFundAmount(event.target.value)} />
            <button id="safe-fund" className={`btn btn-outline ${styles.action}`} disabled={unavailable} onClick={() => void fundSafe()}>
              {fundingPending ? 'Funding Safe…' : 'Fund Safe'}
            </button>
          </div>
        </div>
      </div>}
      {!remote.target ? <>
        <p className={styles.hint}>Create a Safe on {deployment.l1.chainName} controlled by your Falcon key. Your gas wallet will ask you to approve the transaction.</p>
        <button id="safe-create" className={`btn btn-solid ${styles.action}`} disabled={unavailable} onClick={() => void createSafe()}>
          {busy || confirming ? 'Creating Safe…' : 'Create Safe'}
        </button>
        <SafeFeeQuote fee={fee} config={fees} />
      </> : safeReady ? <section className={styles.sendBox} aria-labelledby="safe-send-heading">
        <h3 id="safe-send-heading">Send transaction</h3>
        <p className={styles.hint}>Send from your Safe on {deployment.l1.chainName}.</p>
        <div className={styles.fields}>
          <label className={styles.label} htmlFor="safe-recipient">To</label>
          <input id="safe-recipient" className={styles.input} value={recipient} disabled={busy || confirming} spellCheck={false} autoCapitalize="off" placeholder="0x…" onChange={e => { setRecipient(e.target.value); clearAuthorization(); }} />
          <label className={styles.label} htmlFor="safe-amount">Amount · {symbol}</label>
          <input id="safe-amount" className={styles.input} inputMode="decimal" value={amount} disabled={busy || confirming} onChange={e => { setAmount(e.target.value); clearAuthorization(); }} />
        </div>
        <details id="safe-data-options" className={styles.details}>
          <summary>Data (optional)</summary>
          <label className={styles.label} htmlFor="safe-data">Transaction data (hex)</label>
          <textarea id="safe-data" className={styles.input} rows={4} value={data} disabled={busy || confirming}
            spellCheck={false} autoCapitalize="off" placeholder="0x" maxLength={2 + 60 * 1024 * 2}
            onChange={e => { setData(e.target.value); clearAuthorization(); }} />
          <p className={styles.hint}>For contract calls. Leave empty for a normal transfer. Calls with data can send zero {symbol}.</p>
        </details>
        <p className={styles.hint}>{prepared ? 'Falcon signature ready. Send the transaction to continue.' : 'First sign with Falcon, then send the transaction.'}</p>
        <div className={styles.actions}>
          <button id="safe-sign" className={`btn ${prepared ? `btn-outline ${styles.signedAction}` : 'btn-solid'} ${styles.action}`} disabled={unavailable} onClick={() => void sign()}>
            {prepared ? 'Signed with Falcon · Sign again' : 'Sign with Falcon'}
          </button>
          <button id="safe-send" className={`btn ${prepared ? 'btn-solid' : 'btn-outline'} ${styles.action}`} disabled={unavailable || !prepared} onClick={() => void send()}>Send transaction <span aria-hidden="true">→</span></button>
        </div>
        <SafeFeeQuote fee={fee} config={fees} />
        {prepared?.operation.kind === 'transfer' && <p className={styles.hint}>Signed {formatUnits(prepared.operation.value, 18)} {symbol} to {prepared.operation.recipient}{prepared.operation.data && prepared.operation.data !== '0x' ? ` · ${(prepared.operation.data.length - 2) / 2} data bytes` : ''}.</p>}
      </section> : null}
      <details className={styles.details}><summary>Contracts &amp; authority</summary>
        <p className={styles.hint}>{observation} · Controller nonce {controller.nonce.toString()}.</p>
        <p className={styles.hint}>The controller’s L1 proxy is the Safe’s sole owner. No recovery owner or module is installed. Keep your encrypted Falcon backup.</p>
        <p className={styles.contractDetails}><a id="safe-controller" href={`${deployment.l2.explorer}/address/${controller.controller}`} target="_blank" rel="noreferrer">L2 controller · {controller.controller}</a></p>
        <p className={styles.contractDetails}><a href={`${deployment.l1.explorer}/address/${remote.owner}`} target="_blank" rel="noreferrer">L1 owner proxy · {remote.owner}</a></p>
      </details>
    </>}
    <p id="safe-status" className={styles.status} data-result={notice.kind} role="status" aria-live="polite" hidden={!signer.publicKeyHex && notice.text === initial.text}>{notice.text}</p>
    {uncertain && <div className={styles.transaction}>
      <label className={styles.label}>Transaction hash from wallet activity<input id="safe-recovery-hash" className={styles.input} value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} /></label>
      <button id="safe-recover" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void recover()}>Recover transaction</button>
    </div>}
    {submitted && <div className={styles.transaction}>
      <div className={styles.transactionHashes}>
        <a id="safe-source-tx" className={styles.contractDetails} href={`${deployment.l2.explorer}/tx/${submitted.hash}`} title={submitted.hash} target="_blank" rel="noreferrer">L2 · {submitted.hash.slice(0, 10)}…{submitted.hash.slice(-8)}</a>
        {l1Hash && <a id="safe-settlement-tx" className={styles.contractDetails} href={`${deployment.l1.explorer}/tx/${l1Hash}`} title={l1Hash} target="_blank" rel="noreferrer">L1 · {l1Hash.slice(0, 10)}…{l1Hash.slice(-8)}</a>}
      </div>
      <a id="safe-trace" className={`btn btn-outline ${styles.action} ${styles.traceAction}`} href={`#/visualizer?mode=trace&chain=l2&tx=${submitted.hash}`} target="_blank" rel="noreferrer">See in trace decoder</a>
    </div>}
    {costs && submitted?.hash === costs.sourceHash && <SafeCostComparison evidence={costs} l1ChainId={deployment.l1.chainId} l1Name={deployment.l1.chainName} l1Symbol={symbol} l2Symbol={fees.nativeSymbol}
      checking={checkingCosts} />}
  </section>;
}
