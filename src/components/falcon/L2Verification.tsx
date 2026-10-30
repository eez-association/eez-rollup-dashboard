import { useEffect, useRef, useState } from 'react';
import { BaseError, toHex, type Address, type Hex } from 'viem';
import { fromHex, MESSAGE_BYTES, PUBLIC_KEY_BYTES, SIGNATURE_BYTES } from '../../lib/falcon/falcon.ts';
import { EEZ, eezClient, recordData, simulateL2, waitForVerification, type EezClient, type PublicSample } from '../../lib/falcon/eez.ts';
import { WalletConnectionError, type FalconWallet } from '../../hooks/useFalconWallet.ts';
import type { Notice } from '../../hooks/useFalcon.ts';
import styles from './FalconPanel.module.css';

type Submitted = { hash: Hex; sample: PublicSample; account: Address };
const initial: Notice = { kind: 'neutral', text: 'Sign a message to verify it on EEZ-X Devnet.' };

/** Public inputs and an injected wallet interface keep this panel portable to the dashboard. */
export function L2Verification({ message, signature, publicKey, disabled, wallet }: {
  message: string; signature: string; publicKey: string; disabled: boolean; wallet: FalconWallet;
}) {
  const [notice, setNotice] = useState<Notice>(initial);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [details, setDetails] = useState('');
  const mounted = useRef(false);
  const running = useRef(false);
  const request = useRef<AbortController | null>(null);
  const identity = `${message}:${signature}:${publicKey}`;
  const currentInput = useRef(identity);
  const enabled = useRef(!disabled);
  currentInput.current = identity;
  enabled.current = !disabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!running.current) { setNotice(initial); setDetails(''); }
  }, [identity]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    try { await action(controller.signal); }
    catch (error) {
      if (mounted.current) {
        const connectionError = error instanceof BaseError ? error.walk(cause => cause instanceof WalletConnectionError) : error;
        const code = (error as { code?: number }).code;
        const text = code === 4001 ? 'Request rejected in the wallet. No transaction hash was returned.'
          : connectionError instanceof WalletConnectionError ? connectionError.message
          : error instanceof Error ? error.message.split('\n')[0]! : 'Verification failed. Check your wallet activity before retrying.';
        setNotice({ kind: 'error', text });
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }

  async function checkReceipt(tx: Submitted, signal: AbortSignal, existingClient?: EezClient) {
    setNotice({ kind: 'pending', text: 'Submitted to L2. Waiting for the verification receipt…' });
    const client = existingClient ?? eezClient((await wallet.getSession(signal)).provider);
    const receipt = await waitForVerification(client, tx.hash, tx.sample, tx.account, signal);
    if (!mounted.current) return;
    setNotice({ kind: 'valid', text: `Submitted sample verified on L2 · ${receipt.gasUsed.toLocaleString()} gas used.` });
    setDetails(`Block ${receipt.blockNumber} · matching SignatureVerified event. L1 settlement has not been checked.`);
  }

  function verify(send: boolean) {
    return run(async signal => {
      const snapshot = currentInput.current;
      const sample: PublicSample = {
        message: toHex(fromHex(message, MESSAGE_BYTES)),
        signature: toHex(fromHex(signature, SIGNATURE_BYTES)),
        publicKey: toHex(fromHex(publicKey, PUBLIC_KEY_BYTES)),
      };
      setSubmitted(null); setDetails('');
      setNotice({ kind: 'pending', text: 'Checking the signature on EEZ-X Devnet…' });
      const session = await wallet.getSession(signal);
      const client = eezClient(session.provider);
      const account = session.account;
      const result = await simulateL2(client, sample, signal, account);
      signal.throwIfAborted();
      const isCurrent = () => mounted.current && !signal.aborted && enabled.current && currentInput.current === snapshot;
      if (!isCurrent()) throw new Error('Signature or key changed. Review and try again.');
      if (!result.valid || result.gas === null) {
        setNotice({ kind: 'invalid', text: 'Invalid signature · rejected by the L2 verifier. No transaction sent.' });
        return;
      }
      if (!send) {
        setNotice({ kind: 'valid', text: `Simulation passed · ${result.gas.toLocaleString()} gas estimated. No transaction sent.` });
        setDetails(`L2 block ${result.blockNumber}`);
        return;
      }
      setNotice({ kind: 'pending', text: `Review the transaction in ${wallet.name ?? 'your wallet'}. Locking the Falcon key does not dismiss a wallet request.` });
      const hash = await session.sendTransaction({ to: EEZ.address, data: recordData(sample), gas: toHex((result.gas * 120n + 99n) / 100n) }, isCurrent);
      if (!mounted.current) return;
      const tx = { hash, sample, account };
      setSubmitted(tx);
      await checkReceipt(tx, signal, client);
    });
  }

  return <div className={styles.section}>
    <div className={styles.titleRow}><h3>Verify on EEZ-X Devnet</h3><span className={styles.badge}>L2 · {EEZ.chainId}</span></div>
    <p className={styles.hint}>Your Falcon key signs the message. Verification uses the devnet connection configured in your selected wallet.</p>
    <a className={`${styles.hint} ${styles.contractDetails}`} href={`${EEZ.explorer}/address/${EEZ.address}`} target="_blank" rel="noreferrer">Verifier · {EEZ.address}</a>
    <div className={styles.actions}>
      <button id="simulate-l2" className={`btn btn-outline ${styles.action}`} disabled={disabled || busy || !wallet.address} onClick={() => void verify(false)}>Simulate on L2</button>
      <button id="send-l2" className={`btn btn-solid ${styles.action}`} disabled={disabled || busy || !wallet.address} onClick={() => void verify(true)}>Verify on L2 <span aria-hidden="true">→</span></button>
    </div>
    <p id="l2-status" className={styles.status} data-result={notice.kind} role="status" aria-live="polite">{notice.text}</p>
    {submitted && <div className={styles.transaction}>
      <a id="l2-transaction" className={styles.contractDetails} href={`${EEZ.explorer}/tx/${submitted.hash}`} target="_blank" rel="noreferrer">Transaction · {submitted.hash}</a>
      <button id="check-l2-receipt" className={`btn btn-outline ${styles.action}`} disabled={busy || !wallet.address} onClick={() => void run(signal => checkReceipt(submitted, signal))}>Check receipt</button>
    </div>}
    {details && <p className={`${styles.hint} ${styles.contractDetails}`}>{details}</p>}
  </div>;
}
