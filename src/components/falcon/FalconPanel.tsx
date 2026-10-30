import { useId, useRef, useState, type FormEvent } from 'react';
import { keccak256, type Hex } from 'viem';
import { useFalcon, type Notice } from '../../hooks/useFalcon.ts';
import styles from './FalconPanel.module.css';
import { L2Verification } from './L2Verification.tsx';
import type { FalconWallet } from '../../hooks/useFalconWallet.ts';
import { FalconSafe } from './FalconSafe.tsx';
import type { FeeConfig } from '../../lib/falcon/l2Fees.ts';
import { WalletIcon } from '../WalletIcon';
import { WalletNetworkSetup } from '../WalletNetworkSetup';
import { type CrossChainDeployment } from '../../lib/falcon/crossChainDeployment.ts';

function Status({ notice, id }: { notice: Notice; id: string }) {
  return <p id={id} className={styles.status} data-result={notice.kind} role="status" aria-live="polite">{notice.text}</p>;
}

/** The dashboard owns the wallet and shell; private Falcon keys stay inside useFalcon. */
export function FalconPanel({ wallet, crossChain, fees }: { wallet: FalconWallet; crossChain: CrossChainDeployment | null; fees: FeeConfig | null }) {
  const falcon = useFalcon();
  const prefix = useId();
  const id = (name: string) => `${prefix}-${name}`;
  const backupForm = useRef<HTMLFormElement>(null);
  const restoreForm = useRef<HTMLFormElement>(null);
  const unlockForm = useRef<HTMLFormElement>(null);
  const [removal, setRemoval] = useState<string | null>(null);
  const hasKey = falcon.publicKeyHex !== '';
  const hasSavedKey = falcon.savedKey.kind === 'saved' || falcon.savedKey.kind === 'invalid';
  const activeSaved = falcon.savedKey.kind === 'saved' && falcon.savedKey.publicKeyHex === falcon.publicKeyHex;
  const canVerify = hasKey && falcon.signature.trim() !== '' && !falcon.busy;
  const setupNetwork = wallet.networkSetup && wallet.networkSetup.status !== 'ready' ? wallet.networkSetup.network : crossChain?.l2;

  function backup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = String(fields.get('password') ?? '');
    const confirmation = String(fields.get('confirmation') ?? '');
    const remember = (event.nativeEvent as SubmitEvent).submitter?.id === 'remember';
    form.reset();
    void falcon.backup(password, confirmation, remember);
  }

  function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const file = fields.get('keystore');
    const password = String(fields.get('password') ?? '');
    // Retain the encrypted file for retry; clear the password after every attempt.
    const passwordInput = event.currentTarget.elements.namedItem('password');
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
    void falcon.restore(file instanceof File && file.size > 0 ? file : undefined, password, fields.get('remember') === 'on');
  }

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    event.currentTarget.reset();
    void falcon.unlockSaved(password);
  }

  function lock() {
    backupForm.current?.reset();
    restoreForm.current?.reset();
    unlockForm.current?.reset();
    setRemoval(null);
    falcon.lock();
  }

  return <div className={styles.grid}>
    <section className={styles.card} aria-labelledby={id('key-heading')}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>[ 01 / YOUR KEY ]</p>
        <div className={styles.titleRow}>
          <h2 id={id('key-heading')}>Key manager</h2>
          <span className={styles.badge} data-unlocked={hasKey}>{hasKey ? 'Unlocked' : hasSavedKey ? 'Saved · locked' : 'No key loaded'}</span>
        </div>
        <p>Create a Falcon key, unlock a saved key, or import an encrypted backup.</p>
      </header>

      <div className={styles.actions}>
        <button id="generate" className={`btn btn-solid ${styles.action}`} disabled={hasKey || hasSavedKey || falcon.busy} onClick={() => void falcon.generate()}>Generate key</button>
        <button id="lock" className={`btn btn-outline ${styles.action}`} disabled={!hasKey && !falcon.busy} aria-describedby={hasKey ? id('switch-help') : undefined} onClick={lock}>{falcon.busy && !hasKey ? 'Cancel unlock' : 'Switch key'}</button>
      </div>

      {hasKey && <>
        <p id={id('switch-help')} className={styles.hint}>{activeSaved
          ? 'Switch keys for this session. Your encrypted key stays saved.'
          : hasSavedKey ? 'This key is only unlocked for this session. Keep its backup before switching.'
            : 'Save this key or download a backup before switching.'}</p>
        <details className={styles.details}>
          <summary>Public key · 897 bytes</summary>
          <label className={styles.label} htmlFor={id('public-key')}>Full public key</label>
          <textarea id={id('public-key')} data-testid="public-key" className={styles.input} value={falcon.publicKeyHex} readOnly rows={4} spellCheck={false} />
        </details>
        <div className={styles.fields}>
          <span className={styles.label}>Key hash · Keccak-256</span>
          <code data-testid="public-key-hash" className={styles.contractDetails}>{keccak256(`0x${falcon.publicKeyHex}` as Hex)}</code>
        </div>
        <details id="backup-options" key={hasSavedKey ? 'saved' : 'unsaved'} className={styles.details} open={!hasSavedKey}>
          <summary id={id('backup-heading')}>{hasSavedKey ? 'Download a backup' : 'Save this key'}</summary>
          <form ref={backupForm} onSubmit={backup} className={styles.backupForm} aria-labelledby={id('backup-heading')}>
            <p className={styles.hint}>{activeSaved
              ? 'This key is saved in this browser. Keep a file backup too; downloading with a new password does not change the saved copy.'
              : hasSavedKey ? 'This session key is not saved in this browser. Download an encrypted backup to keep it.'
                : 'Save an encrypted copy in this browser or download a backup. After reloading, unlock a saved key with your password.'}</p>
            <fieldset className={styles.fields} disabled={falcon.busy}>
              <label className={styles.label} htmlFor={id('backup-password')}>Backup password</label>
              <input id={id('backup-password')} name="password" type="password" className={styles.input} autoComplete="new-password" minLength={12} maxLength={1024} required aria-describedby={id('password-help')} />
              <p id={id('password-help')} className={styles.hint}>Use a unique password of at least 12 characters.</p>
              <label className={styles.label} htmlFor={id('confirm-password')}>Confirm password</label>
              <input id={id('confirm-password')} name="confirmation" type="password" className={styles.input} autoComplete="new-password" minLength={12} maxLength={1024} required />
              <div className={styles.actions}>
                {!hasSavedKey && <button id="remember" className={`btn btn-solid ${styles.action}`} type="submit" disabled={falcon.savedKey.kind === 'unavailable'}>Save in this browser</button>}
                <button id="backup" className={`btn ${hasSavedKey ? 'btn-solid' : 'btn-outline'} ${styles.action}`} type="submit">Download encrypted backup</button>
              </div>
            </fieldset>
          </form>
        </details>
      </>}

      {!hasKey && falcon.savedKey.kind === 'saved' && <form key={falcon.savedKey.publicKeyHex} ref={unlockForm} onSubmit={unlock} className={styles.section} aria-labelledby={id('saved-heading')}>
        <h3 id={id('saved-heading')}>Unlock saved key</h3>
        <p className={styles.hint}>Your encrypted key is saved on this device. Enter your password to use it in this tab.</p>
        <fieldset className={styles.fields} disabled={falcon.busy}>
          <label className={styles.label} htmlFor={id('saved-password')}>Saved key password</label>
          <input id={id('saved-password')} name="password" type="password" className={styles.input} autoComplete="current-password" maxLength={1024} required />
          <button id="unlock-saved" className={`btn btn-solid ${styles.action}`} type="submit">Unlock saved key</button>
        </fieldset>
      </form>}

      {!hasKey && <details id="import-options" className={styles.details} open={!hasSavedKey}>
        <summary id={id('restore-heading')}>{hasSavedKey ? 'Import another key' : 'Restore a key'}</summary>
        <form ref={restoreForm} onSubmit={restore} className={styles.backupForm} aria-labelledby={id('restore-heading')}>
          {hasSavedKey && <p className={styles.hint}>Import a backup for this session. Your saved key stays in this browser.</p>}
          <fieldset className={styles.fields} disabled={falcon.busy}>
            <label className={styles.label} htmlFor={id('key-file')}>Encrypted key file</label>
            <input id={id('key-file')} name="keystore" type="file" className={`${styles.input} ${styles.file}`} accept=".json,application/json" required aria-describedby={id('file-help')} />
            <p id={id('file-help')} className={styles.hint}>Choose your .keystore.json backup. The file is read in this browser.</p>
            <label className={styles.label} htmlFor={id('unlock-password')}>Backup password</label>
            <input id={id('unlock-password')} name="password" type="password" className={styles.input} autoComplete="current-password" maxLength={1024} required />
            {!hasSavedKey && <label className={styles.checkbox}>
              <input type="checkbox" name="remember" defaultChecked={falcon.savedKey.kind !== 'unavailable'} disabled={falcon.savedKey.kind === 'unavailable'} />
              Remember this key in this browser
            </label>}
            <button id="restore" className={`btn btn-outline ${styles.action}`} type="submit">Import &amp; unlock</button>
          </fieldset>
        </form>
      </details>}

      {hasSavedKey && <div className={styles.section}>
        <p className={styles.hint}>{hasKey && !activeSaved
          ? 'The saved copy below is separate from the key in this session.'
          : 'Saved on this browser and site. Keep a downloaded backup for another device or if browser data is cleared.'}</p>
        <div className={styles.actions}>
          {falcon.savedKey.kind === 'saved' && <button id="download-saved" className={`btn btn-outline ${styles.action}`} disabled={falcon.busy} onClick={() => void falcon.downloadSaved()}>Download saved backup</button>}
          <button id="remove-saved" className={`btn btn-outline ${styles.action}`} disabled={falcon.busy} onClick={() => setRemoval(falcon.removalSnapshot())}>Remove saved key</button>
        </div>
        {removal !== null && <div className={styles.removal} role="group" aria-label="Confirm saved key removal">
          <p>This removes the saved copy and locks this tab. Keep a backup file if you want to use this key again.</p>
          <div className={styles.actions}>
            <button className={`btn btn-outline ${styles.action}`} disabled={falcon.busy} onClick={() => setRemoval(null)}>Cancel</button>
            <button id="confirm-remove" className={`btn btn-red btn-outline ${styles.action}`} disabled={falcon.busy} onClick={() => {
              const expected = removal;
              backupForm.current?.reset();
              unlockForm.current?.reset();
              setRemoval(null);
              void falcon.removeSaved(expected);
            }}>Remove from browser</button>
          </div>
        </div>}
      </div>}
      <Status id="key-status" notice={falcon.keyNotice} />
    </section>

    <div className={styles.workflow}>
    <div className={styles.card}>
      {wallet.address ? <span className={styles.walletAccount}><WalletIcon name={wallet.name} className={styles.walletIcon} />Gas wallet · {wallet.name} · {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</span>
        : <p className={styles.hint}>Connect your wallet in the dashboard header to use the on-chain demo.</p>}
      {wallet.address && crossChain && <div className={styles.safeStats} aria-label="Gas wallet balances">
        <div><span className={styles.label}>{crossChain.l1.chainName} · L1</span>
          <strong data-testid="falcon-wallet-l1-balance">{wallet.l1Balance ?? 'Loading…'} {crossChain.l1.safe?.nativeSymbol}</strong></div>
        <div><span className={styles.label}>{crossChain.l2.chainName} · L2</span>
          <strong data-testid="falcon-wallet-l2-balance">{wallet.l2Balance ?? 'Loading…'} {fees?.nativeSymbol}</strong></div>
      </div>}
      {setupNetwork && <WalletNetworkSetup address={wallet.address} chainId={wallet.chainId}
        network={setupNetwork} setup={wallet.networkSetup} knownNetwork={wallet.hasNetwork(setupNetwork.chainId)} onConnect={() => void wallet.connectNetwork(setupNetwork)} />}
    </div>
    {crossChain && fees ? <FalconSafe signer={falcon} wallet={wallet} deployment={crossChain} fees={fees} /> : <section className={styles.card}>
      <h2>Your Falcon Safe</h2>
      <p className={styles.hint}>On-chain actions are unavailable for this dashboard configuration. You can still create a key and verify signatures in the browser.</p>
    </section>}
    <section className={styles.card} aria-labelledby={id('sign-heading')}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>[ 03 / SIGN &amp; VERIFY ]</p>
        <h2 id={id('sign-heading')}>Signature playground</h2>
        <p>Sign a message, then change a byte to see verification fail.</p>
      </header>
      <fieldset className={styles.fields} disabled={falcon.busy}>
        <label className={styles.label} htmlFor={id('message')}>Message · 32 bytes</label>
        <textarea id={id('message')} data-testid="message" className={styles.input} rows={3} spellCheck={false} autoCapitalize="off" value={falcon.message} onChange={event => falcon.editMessage(event.target.value)} aria-describedby={id('message-help')} />
        <p id={id('message-help')} className={styles.hint}>Enter hexadecimal bytes. These exact bytes will be signed.</p>
        <div className={styles.actions}>
          <button id="sign" className={`btn btn-solid ${styles.action}`} disabled={!hasKey} onClick={() => void falcon.sign()}>Sign message <span aria-hidden="true">→</span></button>
        </div>
        <label className={styles.label} htmlFor={id('signature')}>Signature</label>
        <textarea id={id('signature')} data-testid="signature" className={styles.input} rows={6} spellCheck={false} autoCapitalize="off" value={falcon.signature} onChange={event => falcon.editSignature(event.target.value)} placeholder="Your signature will appear here." />
        <p className={styles.hint}>{falcon.signatureInfo}</p>
        <div className={styles.actions}>
          <button id="verify" className={`btn btn-outline ${styles.action}`} disabled={!canVerify} onClick={() => void falcon.verify()}>Verify in browser</button>
          <button id="download" className={`btn btn-outline ${styles.action}`} disabled={!canVerify} onClick={() => void falcon.exportSample()}>Export public sample</button>
        </div>
      </fieldset>
      <Status id="signature-status" notice={falcon.signatureNotice} />
      {crossChain && <L2Verification key={crossChain.l2.chainId} deployment={crossChain} message={falcon.message} signature={falcon.signature} publicKey={falcon.publicKeyHex} disabled={!canVerify} wallet={wallet} />}
    </section>
    </div>
  </div>;
}
