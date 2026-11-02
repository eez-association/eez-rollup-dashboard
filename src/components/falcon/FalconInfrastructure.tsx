import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toHex, type Hex } from 'viem';
import { config } from '../../config';
import type { FalconWallet } from '../../hooks/useFalconWallet';
import { useFalconRecovery } from '../../hooks/useFalconRecovery';
import type { CrossChainDeployment } from '../../lib/falcon/crossChainDeployment';
import { eezClient } from '../../lib/falcon/eez';
import { checkComposer } from '../../lib/falcon/l1Controller';
import { errorCode, UnknownFeeSubmission } from '../../lib/falcon/l2Fees';
import { falconReadProvider } from '../../lib/falcon/readOnly';
import { recoveryKey, type RecoveryAttempt } from '../../lib/falcon/recoveryJournal';
import { checkNoObservedSubmission, checkRecoveryOutcome } from '../../lib/falcon/recoveryChecks';
import { confirmSharedSetup, inspectSetupChain, setupAttemptContract, type SetupStatus } from '../../lib/falcon/sharedSetup';
import { matchingDeployer } from '../../lib/treasury/matchingSafes';
import styles from './FalconPanel.module.css';

/** L2 infrastructure is required for either Safe path; L1 creation setup is
 * requested explicitly. Both retain the same journal, including older L1 requests.
 * This gate never sends on mount or retries an ambiguous wallet submission.
 */
export function FalconInfrastructure({ wallet, deployment, children }: {
  wallet: FalconWallet; deployment: CrossChainDeployment; children: (requestSafeFactory: () => void) => ReactNode;
}) {
  const journal = useFalconRecovery(recoveryKey(deployment, 'infrastructure'), wallet.address ? { account: wallet.address, publicKey: '0x' } : null);
  const [status, setStatus] = useState<SetupStatus[] | null>(null);
  const [selection, setSelection] = useState<{ chain: 'l1' | 'l2' }>({ chain: 'l2' });
  const [notice, setNotice] = useState('Checking shared contracts…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const scope = useRef(journal.key); scope.current = journal.key;
  const mounted = useRef(false);
  const reads = (signal: AbortSignal) => ({
    l1: eezClient(falconReadProvider(config.l1Rpc, signal, deployment.l1.chainName)),
    l2: eezClient(falconReadProvider(config.l2ProxyRpc, signal, deployment.l2.chainName)),
  });

  async function refresh(signal: AbortSignal) {
    const next = await inspectSetupChain(reads(signal)[selection.chain], deployment, selection.chain, signal);
    signal.throwIfAborted();
    setStatus(next); setNotice('');
    return next;
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void refresh(abort.signal).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => { mounted.current = false; abort.abort(); operation.current?.abort(); };
  }, [deployment, selection]);
  useEffect(() => {
    operation.current?.abort(); operation.current = null;
    setBusy(false); setRecoveryHash(''); setAcknowledged(false);
    return () => { operation.current?.abort(); };
  }, [journal.key]);

  function selectSetup(chain: 'l1' | 'l2') {
    setStatus(null); setError(''); setNotice('Checking shared contracts…');
    setSelection({ chain });
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const abort = new AbortController(); operation.current = abort;
    setBusy(true); setError('');
    try { await action(abort.signal); }
    catch (cause) {
      if (mounted.current && !abort.signal.aborted) {
        setNotice('');
        setError(errorCode(cause) === 4001 ? 'Setup cancelled in your wallet.' : cause instanceof Error ? cause.message : 'Setup could not be confirmed.');
      }
    } finally {
      if (mounted.current && operation.current === abort) { operation.current = null; setBusy(false); }
    }
  }
  async function confirm(attempt: RecoveryAttempt, hash: Hex, signal: AbortSignal) {
    const step = setupAttemptContract(deployment, attempt);
    setNotice(`Confirming ${step.label.toLowerCase()} on ${deployment[step.chain].chainName}…`);
    const outcome = await confirmSharedSetup(reads(signal)[step.chain], deployment, attempt, hash, signal);
    signal.throwIfAborted();
    await journal.resolve(attempt);
    await refresh(signal);
    setRecoveryHash(''); setAcknowledged(false);
    if (outcome !== 'deployed') setError(outcome === 'replaced'
      ? 'This setup transaction was replaced or cancelled. Review the remaining setup below.'
      : 'This setup transaction reverted. Check wallet activity before trying again.');
  }
  // A reload resumes observation only. The saved hash never authorizes another send.
  useEffect(() => {
    const attempt = journal.attempt;
    if (attempt?.hash && !operation.current) void run(signal => confirm(attempt, attempt.hash!, signal));
  }, [journal.key, journal.attempt?.id, journal.attempt?.hash]);

  function deploy(step: SetupStatus) {
    void run(async signal => {
      if (journal.attempt || journal.error) throw new Error('Resolve the previous setup request before sending again.');
      const originalScope = journal.key;
      const latest = await refresh(signal);
      if (latest.find(item => item.id === step.id)?.deployed) return;
      if (latest.find(item => !item.deployed)?.id !== step.id) throw new Error('Setup changed. Review the next contract below.');
      const session = await wallet.getSession(signal, deployment[step.chain]);
      const client = eezClient(session.provider);
      if (step.chain === 'l2') await checkComposer(session.provider, deployment, signal);
      const walletStatus = await inspectSetupChain(client, deployment, step.chain, signal);
      if (walletStatus.find(item => item.id === step.id)?.deployed) { await refresh(signal); return; }
      const [gas, nonce] = await Promise.all([
        client.estimateGas({ account: session.account, to: matchingDeployer, data: step.data }),
        client.getTransactionCount({ address: session.account, blockTag: 'pending' }),
      ]);
      const isCurrent = () => mounted.current && !signal.aborted && scope.current === originalScope;
      session.assertCurrent(); signal.throwIfAborted();
      const attempt: RecoveryAttempt = { version: 1, id: crypto.randomUUID(), kind: 'infrastructure',
        chainId: deployment[step.chain].chainId, account: session.account, to: matchingDeployer,
        nonce: String(nonce), value: '0', data: step.data, publicKey: '0x' };
      await journal.begin(attempt);
      setNotice(`Confirm ${step.label.toLowerCase()} deployment in your wallet.`);
      let hash: Hex;
      try { hash = await session.sendTransaction({ to: matchingDeployer, data: step.data, gas: toHex(gas), nonce: toHex(nonce) }, isCurrent); }
      catch (cause) {
        if (!(cause instanceof UnknownFeeSubmission)) await journal.reject(attempt);
        throw cause;
      }
      // Record a late wallet reply under the original account, even after unmount.
      const tracked = await journal.recordHash(attempt, hash);
      signal.throwIfAborted();
      if (!tracked?.hash) throw new Error('Setup recovery changed in another tab. Check the current request.');
      await confirm(tracked, tracked.hash, signal);
    });
  }

  const pending = journal.attempt;
  const next = status?.find(step => !step.deployed);
  if (status && !next && !pending && !journal.error && !error && !busy) return <>{children(() => selectSetup('l1'))}</>;
  return <section className={styles.card} id="falcon-infrastructure" aria-label="Falcon network setup">
    <h2>{selection.chain === 'l1' ? 'Set up Safe creation' : 'Set up Falcon on this network'}</h2>
    <p className={styles.hint}>{selection.chain === 'l1'
      ? 'The Safe factory is needed once to create new Safes. Your connected wallet pays the deployment fee. Existing Safes do not need it.'
      : 'Your connected wallet deploys the missing shared contracts on L2 and pays the network fees. This is needed once per network.'}</p>
    {status && <ul>{status.map(step => <li key={step.id}>
      {step.label} · {deployment[step.chain].chainName} · {step.deployed ? 'Ready' : 'Not deployed'}
    </li>)}</ul>}
    {notice && <p role="status" className={styles.hint}>{notice}</p>}
    {(error || journal.error) && <p role="alert" className={styles.hint}>{error || journal.error}</p>}
    {!pending && <div className={styles.actions}>
      {next && <button id="falcon-deploy-shared" className={`btn btn-solid ${styles.action}`}
        disabled={busy || !wallet.address || !!journal.error} onClick={() => deploy(next)}>
        Deploy {next.id === 'verifier' ? next.label : next.label.toLowerCase()} on {deployment[next.chain].chainName}
      </button>}
      <button className="btn btn-outline" disabled={busy} onClick={() => void run(async signal => { await refresh(signal); })}>Check setup</button>
      {selection.chain === 'l1' && <button className="btn btn-outline" disabled={busy || !!journal.error} onClick={() => selectSetup('l2')}>Back to Safe options</button>}
    </div>}
    {!wallet.address && <p className={styles.hint}>Connect your wallet in the header to continue.</p>}
    {pending && <fieldset className={styles.fields} disabled={busy}>
      <p className={styles.hint}>A setup request is saved for this wallet. Confirm its result before continuing.</p>
      {pending.hash && <>
        <a href={`${pending.chainId === deployment.l1.chainId ? deployment.l1.explorer : deployment.l2.explorer}/tx/${pending.hash}`} target="_blank" rel="noreferrer">View deployment transaction</a>
        <button className="btn btn-outline" onClick={() => void run(signal => confirm(pending, pending.hash!, signal))}>Check deployment</button>
      </>}
        <label className={styles.label}>Transaction hash from wallet activity
          <input className={styles.input} value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} />
        </label>
        <button className="btn btn-outline" disabled={!/^0x[\da-f]{64}$/i.test(recoveryHash.trim())} onClick={() => void run(async signal => {
          const hash = recoveryHash.trim().toLowerCase() as Hex;
          const step = setupAttemptContract(deployment, pending);
          const outcome = await checkRecoveryOutcome(reads(signal)[step.chain], pending, hash, signal);
          if (outcome === 'matching') {
            await journal.selectHash(pending, hash);
            await confirm({ ...pending, hash }, hash, signal);
          } else await confirm(pending, hash, signal);
        })}>Recover deployment</button>
      {!pending.hash && <>
        <label className={styles.hint}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{' '}
          I cancelled all wallet prompts and checked that no transaction was sent.</label>
        <button className="btn btn-outline" disabled={!acknowledged} onClick={() => void run(async signal => {
          const step = setupAttemptContract(deployment, pending);
          await checkNoObservedSubmission(reads(signal)[step.chain], pending, signal);
          await journal.resolve(pending); await refresh(signal);
        })}>Check and clear unsent request</button>
      </>}
    </fieldset>}
  </section>;
}
