import { useEffect, useRef, useState } from 'react';
import { getAddress, isAddress, toHex, type Hex } from 'viem';
import type { FalconWallet } from '../../hooks/useFalconWallet';
import { useFalconRecovery } from '../../hooks/useFalconRecovery';
import { config } from '../../config';
import type { CrossChainDeployment } from '../../lib/falcon/crossChainDeployment';
import { eezClient } from '../../lib/falcon/eez';
import { falconReadProvider, confirmationDelay } from '../../lib/falcon/readOnly';
import { checkChain, FalconTransactionReverted, sameAddress, type ControllerState } from '../../lib/falcon/l1Controller';
import { attachmentKey, prepareOwnerAddition, treasurySafeSuggestion, verifyOwnerAddition } from '../../lib/falcon/existingSafe';
import { recoveryKey, type RecoveryAttempt } from '../../lib/falcon/recoveryJournal';
import { findRecoveryByNonce } from '../../lib/falcon/recoveryChecks';
import { encodeSafeExecution, packEOAApprovals, safeTransactionHash, safeTypedDataJSON } from '../../lib/treasury/safeTransactions';
import { UnknownFeeSubmission } from '../../lib/falcon/l2Fees';
import type { SafeAttachment } from '../../lib/falcon/safe';
import styles from './FalconPanel.module.css';

type Props = { wallet: FalconWallet; deployment: CrossChainDeployment; controller: ControllerState; publicKey: Hex;
  disabled: boolean; visible: boolean; isCurrent: () => boolean; onAttached: (safe: SafeAttachment) => void; onPending: (pending: boolean) => void; onBack: () => void };
/** L1 owner administration only; the L2 mirror is never a transaction target. */
export function ExistingFalconSafe({ wallet, deployment, controller, publicKey, disabled, visible, isCurrent, onAttached, onPending, onBack }: Props) {
  const journal = useFalconRecovery(recoveryKey(deployment, 'owner'), wallet.address ? { account: wallet.address, publicKey } : null);
  const [address, setAddress] = useState(() => treasurySafeSuggestion(localStorage, deployment));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), currentAddress = useRef(address); currentAddress.current = address;
  const abortRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ onAttached, isCurrent }); callbacks.current = { onAttached, isCurrent };
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => { onPending(busy || !!journal.attempt || !!journal.error); }, [busy, journal.attempt, journal.error, onPending]);
  const clientFor = (signal: AbortSignal) => eezClient(falconReadProvider(config.l1Rpc, signal, deployment.l1.chainName));
  function assertAttempt(attempt: RecoveryAttempt) {
    if (attempt.kind !== 'owner' || attempt.chainId !== deployment.l1.chainId || !sameAddress(attempt.controller ?? '', controller.controller)) throw new Error('Saved owner request belongs to another controller or network.');
  }
  useEffect(() => {
    const attempt = journal.attempt;
    if (!attempt || busy) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          assertAttempt(attempt);
          const provider = falconReadProvider(config.l1Rpc, abort.signal, deployment.l1.chainName), client = eezClient(provider);
          await checkChain(client, deployment.l1);
          if (!attempt.hash) {
            const found = await findRecoveryByNonce(client, provider, attempt, abort.signal);
            if (found) {
              if (found.outcome === 'matching') await journal.selectHash(attempt, found.hash);
              else { await journal.resolve(attempt); setMessage('The owner transaction was replaced or cancelled. You can review a new request.'); }
              return;
            }
            setMessage('Waiting for the wallet transaction. Checking automatically…');
          } else {
            const attachment = await verifyOwnerAddition(client, deployment, attempt, abort.signal);
            abort.signal.throwIfAborted();
            // Store before clearing recovery, so a storage failure never loses the confirmed Safe.
            localStorage.setItem(attachmentKey(deployment, publicKey), JSON.stringify(attachment));
            await journal.finish(attempt.id);
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
  }, [journal.attempt, deployment, controller.controller, busy, publicKey]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true);
    const abort = new AbortController(); abortRef.current = abort;
    try { await action(abort.signal); }
    catch (error) { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message.split('\n')[0]! : 'Owner addition failed.'); }
    finally { active.current = false; if (!abort.signal.aborted) setBusy(false); }
  }
  function addOwner() {
    return run(async signal => {
      if (disabled || journal.attempt || journal.error || !wallet.address) return;
      if (!isAddress(address.trim()) || BigInt(address.trim()) <= 1n) throw new Error('Enter a valid L1 Safe address.');
      const target = getAddress(address.trim()), input = address;
      const current = () => !signal.aborted && callbacks.current.isCurrent() && currentAddress.current === input;
      const session = await wallet.getSession(signal, deployment.l1);
      const client = clientFor(signal), walletClient = eezClient(session.provider);
      setMessage('Checking L1 Safe ownership…');
      const review = await prepareOwnerAddition(client, deployment, controller.controller, target, session.account, signal);
      // Validate the wallet's own chain and Safe view before its signature prompt.
      const walletReview = await prepareOwnerAddition(walletClient, deployment, controller.controller, target, session.account, signal);
      if (safeTransactionHash(walletReview.transaction) !== safeTransactionHash(review.transaction)) throw new Error('Wallet and dashboard disagree about this Safe.');
      if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
      setMessage('Sign the Safe transaction to add your Falcon controller. The threshold stays at 1.');
      const signature = await session.provider.request({ method: 'eth_signTypedData_v4', params: [session.account, safeTypedDataJSON(review.transaction)] }) as Hex;
      const signatures = await packEOAApprovals(review.transaction, [session.account], 1, [{ owner: session.account, signature }]);
      const fresh = await prepareOwnerAddition(client, deployment, controller.controller, target, session.account, signal);
      if (safeTransactionHash(fresh.transaction) !== safeTransactionHash(review.transaction)) throw new Error('Safe owners or nonce changed. Review and sign again.');
      const data = encodeSafeExecution(review.transaction, signatures);
      const gas = await client.estimateGas({ account: session.account, to: target, data });
      const nonce = await walletClient.getTransactionCount({ address: session.account, blockTag: 'pending' });
      session.assertCurrent();
      if (!current()) throw new Error('Wallet, key or Safe changed. Review again.');
      const attempt: RecoveryAttempt = { version: 1, kind: 'owner', id: crypto.randomUUID(), chainId: deployment.l1.chainId,
        account: session.account, to: target, nonce: String(nonce), value: '0', data, publicKey, controller: controller.controller, safeNonce: String(review.transaction.message.nonce) };
      await journal.begin(attempt);
      try {
        setMessage('Confirm the owner addition transaction on L1.');
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
    <p className={styles.hint}>Your connected wallet must be the only owner, with threshold 1. Adding Falcon keeps your wallet and changes the Safe to 1 of 2 owners.</p>
    <div className={styles.safeChoices}>
      <button className={`btn btn-outline ${styles.action}`} disabled={disabled || busy || !!journal.attempt || !!journal.error} onClick={onBack}>Go back</button>
      <button className={`btn btn-solid ${styles.action}`} disabled={disabled || busy || !!journal.attempt || !!journal.error || !wallet.address} onClick={() => void addOwner()}>Add Falcon controller</button>
    </div>
    {(message || journal.error) && <p role="status" className={styles.status}>{journal.error || message}</p>}
    {journal.attempt?.hash && <a href={`${deployment.l1.explorer}/tx/${journal.attempt.hash}`} target="_blank" rel="noreferrer">L1 owner transaction</a>}
  </div>;
}
