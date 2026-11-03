import { useEffect, useRef, useState } from 'react';
import { getAddress, isAddress, toHex, type Hex } from 'viem';
import type { FalconWallet } from '../../hooks/useFalconWallet';
import { useFalconRecovery } from '../../hooks/useFalconRecovery';
import { config } from '../../config';
import type { CrossChainDeployment } from '../../lib/falcon/crossChainDeployment';
import { eezClient } from '../../lib/falcon/eez';
import { falconReadProvider, confirmationDelay } from '../../lib/falcon/readOnly';
import { checkChain, FalconTransactionReverted, sameAddress, type ControllerState } from '../../lib/falcon/l1Controller';
import { attachmentKey, findOwnerRecovery, inspectSafeSelection, prepareOwnerAddition, saveAttachment, selectFactorySafe, SafeSelectionConflict, treasurySafeSuggestion, verifyOwnerAddition } from '../../lib/falcon/existingSafe';
import { recoveryKey, type RecoveryAttempt } from '../../lib/falcon/recoveryJournal';
import { encodeSafeExecution, packEOAApprovals, safeTransactionHash, safeTypedDataJSON } from '../../lib/treasury/safeTransactions';
import { UnknownFeeSubmission } from '../../lib/falcon/l2Fees';
import type { SafeAttachment } from '../../lib/falcon/safe';
import styles from './FalconPanel.module.css';

type Props = { wallet: FalconWallet; deployment: CrossChainDeployment; controller: ControllerState; publicKey: Hex;
  disabled: boolean; visible: boolean; isCurrent: () => boolean; onAttached: (safe: SafeAttachment) => void; onPending: (pending: boolean) => void; onBack: () => void };
/** L1 owner administration only; the L2 mirror is never a transaction target. */
export function ExistingFalconSafe({ wallet, deployment, controller, publicKey, disabled, visible, isCurrent, onAttached, onPending, onBack }: Props) {
  const journal = useFalconRecovery(recoveryKey(deployment, 'owner'), wallet.address ? { account: wallet.address, publicKey } : null);
  const [address, setAddress] = useState(() => {
    try { return treasurySafeSuggestion(localStorage, deployment); } catch { return ''; }
  });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [selectionConflict, setSelectionConflict] = useState<{ attempt: RecoveryAttempt; attachment: SafeAttachment } | null>(null);
  const conflict = selectionConflict?.attempt.id === journal.attempt?.id
    && selectionConflict?.attempt.hash === journal.attempt?.hash ? selectionConflict : null;
  const active = useRef(false), currentAddress = useRef(address); currentAddress.current = address;
  const abortRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ onAttached, isCurrent }); callbacks.current = { onAttached, isCurrent };
  const selectionBefore = useRef<string | null>(null);
  useEffect(() => {
    if (visible) {
      try { selectionBefore.current = localStorage.getItem(attachmentKey(deployment, publicKey)); }
      catch { setMessage('Cannot read the selected Safe. Check browser storage before continuing.'); }
    }
  }, [visible, deployment, publicKey]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => { onPending(busy || !!journal.attempt || !!journal.error); }, [busy, journal.attempt, journal.error, onPending]);
  const clientFor = (signal: AbortSignal) => eezClient(falconReadProvider(config.l1Rpc, signal, deployment.l1.chainName));
  function assertAttempt(attempt: RecoveryAttempt) {
    if (attempt.kind !== 'owner' || attempt.chainId !== deployment.l1.chainId || !sameAddress(attempt.controller ?? '', controller.controller)
      || !wallet.address || !sameAddress(attempt.account, wallet.address) || attempt.publicKey.toLowerCase() !== publicKey.toLowerCase()) {
      throw new Error('Saved owner request belongs to another wallet, Falcon key, controller or network.');
    }
  }
  useEffect(() => {
    const attempt = journal.attempt;
    if (!attempt || busy || conflict) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          assertAttempt(attempt);
          const provider = falconReadProvider(config.l1Rpc, abort.signal, deployment.l1.chainName), client = eezClient(provider);
          await checkChain(client, deployment.l1);
          let receiptKnown = false;
          if (attempt.hash) {
            try { receiptKnown = !!await client.getTransactionReceipt({ hash: attempt.hash }); }
            catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
          }
          if (!receiptKnown) {
            const found = await findOwnerRecovery(client, provider, attempt, abort.signal);
            if (found && (found.outcome === 'replaced' || found.hash !== attempt.hash)) {
              if (found.outcome === 'matching') await journal.selectHash(attempt, found.hash);
              else { await journal.resolve(attempt); setMessage('The owner transaction was replaced or cancelled. You can review a new request.'); }
              return;
            }
            setMessage('Waiting for the wallet transaction. Checking automatically…');
          } else {
            const attachment = await verifyOwnerAddition(client, deployment, attempt, abort.signal);
            abort.signal.throwIfAborted();
            // Store before clearing recovery, so a storage failure never loses the confirmed Safe.
            const key = attachmentKey(deployment, publicKey);
            try {
              await navigator.locks.request(key, () => {
                abort.signal.throwIfAborted();
                saveAttachment(localStorage, key, attachment, attempt.attachmentBefore);
              });
            } catch (error) {
              if (!(error instanceof SafeSelectionConflict)) throw error;
              if (abort.signal.aborted) return;
              setSelectionConflict({ attempt, attachment });
              setMessage('The owner addition is confirmed, but another Safe was selected. Choose which selection to keep. No transaction will be sent.');
              return;
            }
            await journal.finish(attempt.id);
            // This panel stays mounted while hidden; do not keep a finished status for the next visit.
            setMessage('');
            if (!abort.signal.aborted && callbacks.current.isCurrent()) callbacks.current.onAttached(attachment);
            return;
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof FalconTransactionReverted) { await journal.finish(attempt.id); setMessage('Owner transaction reverted. Review the Safe before retrying.'); return; }
          setMessage(error instanceof Error ? error.message.split('\n')[0]! : 'Checking L1 owner confirmation…');
        }
        await confirmationDelay(abort.signal);
      }
    })().catch(() => {});
    return () => abort.abort();
  }, [journal.attempt, deployment, controller.controller, busy, publicKey, conflict]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true);
    const abort = new AbortController(); abortRef.current = abort;
    try { await action(abort.signal); }
    catch (error) { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message.split('\n')[0]! : 'Owner addition failed.'); }
    finally {
      active.current = false; if (!abort.signal.aborted) setBusy(false);
      // A failed parallel inspection must not leave its other reads running.
      abort.abort();
    }
  }
  function resolveSelection(useConfirmed: boolean) {
    return run(async signal => {
      if (!conflict) return;
      const { attempt } = conflict;
      assertAttempt(attempt);
      const key = attachmentKey(deployment, publicKey);
      const expected = localStorage.getItem(key);
      const client = clientFor(signal);
      const attachment = await verifyOwnerAddition(client, deployment, attempt, signal);
      const selected = useConfirmed
        ? await inspectSafeSelection(client, deployment, controller.controller, attachment.target, signal) : null;
      if (useConfirmed && !selected?.target) throw new Error('The confirmed Safe no longer authorizes this Falcon controller.');
      if (!callbacks.current.isCurrent()) throw new Error('Wallet or key changed. Review again.');
      if (useConfirmed) await navigator.locks.request(key, () => {
        signal.throwIfAborted();
        if (!callbacks.current.isCurrent()) throw new Error('Wallet or key changed. Review again.');
        if (selected!.attachment) saveAttachment(localStorage, key, selected!.attachment, expected);
        else selectFactorySafe(localStorage, key, expected);
      });
      // Explicitly acknowledge the verified request, comparing its hash and ID.
      await journal.resolve(attempt);
      setSelectionConflict(null);
      setMessage(useConfirmed ? '' : `Owner addition confirmed for ${attachment.target}. Your current Safe selection was kept.`);
      if (useConfirmed && callbacks.current.isCurrent()) callbacks.current.onAttached(attachment);
    });
  }
  function addOwner() {
    return run(async signal => {
      if (disabled || journal.attempt || journal.error || !wallet.address) return;
      if (!isAddress(address.trim()) || BigInt(address.trim()) <= 1n) throw new Error('Enter a valid L1 Safe address.');
      const target = getAddress(address.trim()), input = address;
      const attachmentBefore = selectionBefore.current;
      const current = () => !signal.aborted && callbacks.current.isCurrent() && currentAddress.current === input;
      const client = clientFor(signal);
      setMessage('Checking the Safe and Falcon controller…');
      const selected = await inspectSafeSelection(client, deployment, controller.controller, target, signal);
      if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
      if (selected?.target) {
        // No `attachment` means this is the factory Safe: clear the external selection.
        const attachment = selected.attachment;
        const key = attachmentKey(deployment, publicKey);
        await navigator.locks.request(key, () => {
          if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
          if (attachment) saveAttachment(localStorage, key, attachment, attachmentBefore);
          else selectFactorySafe(localStorage, key, attachmentBefore);
        });
        setMessage('');
        if (current()) callbacks.current.onAttached(attachment ?? { target: selected.target });
        return;
      }
      const session = await wallet.getSession(signal, deployment.l1);
      const walletClient = eezClient(session.provider);
      setMessage('Checking L1 Safe ownership…');
      // Both independent providers must agree before opening the signature prompt.
      const [review, walletReview] = await Promise.all([
        prepareOwnerAddition(client, deployment, controller.controller, target, session.account, signal),
        prepareOwnerAddition(walletClient, deployment, controller.controller, target, session.account, signal),
      ]);
      if (safeTransactionHash(walletReview.transaction) !== safeTransactionHash(review.transaction)
        || walletReview.ownerFingerprint !== review.ownerFingerprint) throw new Error('Wallet and dashboard disagree about this Safe.');
      if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
      setMessage(`Sign the Safe approval in your wallet. Next, confirm the ${deployment.l1.chainName} transaction.`);
      const signature = await session.provider.request({ method: 'eth_signTypedData_v4', params: [session.account, safeTypedDataJSON(review.transaction)] }) as Hex;
      const signatures = await packEOAApprovals(review.transaction, [session.account], 1, [{ owner: session.account, signature }]);
      setMessage('Rechecking Safe before sending…');
      const fresh = await prepareOwnerAddition(client, deployment, controller.controller, target, session.account, signal);
      if (safeTransactionHash(fresh.transaction) !== safeTransactionHash(review.transaction)
        || fresh.ownerFingerprint !== review.ownerFingerprint) throw new Error('Safe owners or nonce changed. Review and sign again.');
      const data = encodeSafeExecution(review.transaction, signatures);
      const gas = await client.estimateGas({ account: session.account, to: target, data });
      const nonce = await walletClient.getTransactionCount({ address: session.account, blockTag: 'pending' });
      const startBlock = await client.getBlockNumber();
      session.assertCurrent();
      if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
      const attempt: RecoveryAttempt = { version: 1, kind: 'owner', id: crypto.randomUUID(), chainId: deployment.l1.chainId,
        account: session.account, to: target, nonce: String(nonce), value: '0', data, publicKey, controller: controller.controller, safeNonce: String(review.transaction.message.nonce), startBlock: String(startBlock), attachmentBefore };
      await journal.begin(attempt);
      try {
        setMessage(`Confirm the ${deployment.l1.chainName} transaction and network fee in your wallet.`);
        const hash = await session.sendTransaction({ to: target, data, gas: toHex(gas * 120n / 100n), nonce: toHex(nonce) }, current);
        await journal.recordHash(attempt, hash);
      } catch (error) { if (!(error instanceof UnknownFeeSubmission)) await journal.reject(attempt); throw error; }
    });
  }
  if (!visible && !journal.attempt && !journal.error) return null;
  return <div className={styles.fields} aria-label="Add Falcon to an existing Safe">
    <label className={styles.label} htmlFor="falcon-existing-safe">L1 Safe address</label>
    <input id="falcon-existing-safe" className={styles.input} value={journal.attempt?.to ?? address} disabled={busy || !!journal.attempt || disabled}
      placeholder="0x…" spellCheck={false} onChange={event => { setAddress(event.target.value); setMessage(''); }} />
    <p className={styles.hint}>If this Safe already has your Falcon controller as an owner, select it without another owner transaction. Otherwise, connect an existing owner wallet to add Falcon. Threshold must be 1; existing owners and modules are preserved.</p>
    <div className={styles.safeChoices}>
      <button className={`btn btn-outline ${styles.action}`} disabled={disabled || busy || !!journal.attempt || !!journal.error} onClick={onBack}>Go back</button>
      <button className={`btn btn-solid ${styles.action}`} disabled={disabled || busy || !!journal.attempt || !!journal.error || !wallet.address} onClick={() => void addOwner()}>{busy ? 'Checking Safe…' : 'Use this Safe'}</button>
    </div>
    {(message || journal.error) && <p role="status" className={styles.status}>{journal.error || message}</p>}
    {conflict && <div className={styles.safeChoices} role="group" aria-label="Resolve confirmed Safe selection">
      <button className="btn btn-outline" disabled={busy || !!journal.error} onClick={() => void resolveSelection(false)}>Keep current selection</button>
      <button className="btn btn-solid" disabled={busy || !!journal.error} onClick={() => void resolveSelection(true)}>Use confirmed Safe</button>
    </div>}
    {journal.attempt?.hash && <a href={`${deployment.l1.explorer}/tx/${journal.attempt.hash}`} target="_blank" rel="noreferrer">L1 owner transaction</a>}
  </div>;
}
