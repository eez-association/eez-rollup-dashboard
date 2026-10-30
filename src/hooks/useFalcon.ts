import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createKeyPair, fromHex, MESSAGE_BYTES, publicSample, SIGNATURE_BYTES,
  signMessage, toHex, verifySignature, type KeyPair,
} from '../lib/falcon/falcon.ts';
import { decryptKeystore, encryptKeystore, MAX_KEYSTORE_BYTES, parseKeystore } from '../lib/falcon/keystore.ts';
import { downloadJson } from '../lib/falcon/download.ts';
import { BROWSER_KEYSTORE_KEY, readBrowserKeystore, removeBrowserKeystore, saveBrowserKeystore } from '../lib/falcon/browserKeystore.ts';
import type { Hex } from 'viem';

export type Notice = { kind: 'neutral' | 'pending' | 'valid' | 'invalid' | 'error'; text: string };
type SavedKey = { kind: 'empty' | 'unavailable' | 'invalid' | 'saved'; publicKeyHex?: string };
type Scope = 'key' | 'signature';
const initialKey: Notice = { kind: 'neutral', text: 'Generate a key, unlock a saved key, or import an encrypted backup.' };
const initialSignature: Notice = { kind: 'neutral', text: 'Unlock a key to sign your first message.' };

async function updateSavedKey(current: () => boolean, action: () => void): Promise<boolean> {
  if (!navigator.locks) throw new Error('Browser storage updates are unavailable. Use an encrypted backup file.');
  // localStorage has no compare-and-set. Serialize this app's writes across tabs;
  // keep slow key derivation outside the lock and recheck cancellation on entry.
  return navigator.locks.request(BROWSER_KEYSTORE_KEY, { ifAvailable: true }, lock => {
    if (!current()) return false;
    if (!lock) throw new Error('Another tab is updating the saved key. Try again.');
    action();
    return true;
  });
}

export function useFalcon() {
  // Secret bytes never enter render state, persisted stores, or component props.
  const key = useRef<KeyPair | undefined>(undefined);
  const epoch = useRef(0);
  const keyRevision = useRef(0);
  const mounted = useRef(false);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [publicKeyHex, setPublicKeyHex] = useState('');
  const [message, setMessage] = useState('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const [signature, setSignature] = useState('');
  const [keyNotice, setKeyNotice] = useState<Notice>(initialKey);
  const [signatureNotice, setSignatureNotice] = useState<Notice>(initialSignature);
  const [signatureInfo, setSignatureInfo] = useState('Padded Falcon-512 signature');
  const [savedKey, setSavedKey] = useState<SavedKey>({ kind: 'empty' });
  const savedText = useRef<string | null>(null);

  const refreshSavedKey = useCallback(() => {
    let text: string | null;
    try {
      text = window.localStorage.getItem(BROWSER_KEYSTORE_KEY);
    } catch {
      savedText.current = null;
      setSavedKey({ kind: 'unavailable' });
      setKeyNotice({ kind: 'error', text: 'Browser storage is unavailable. You can still use encrypted backup files.' });
      return;
    }
    savedText.current = text;
    if (text === null) {
      setSavedKey({ kind: 'empty' });
      return;
    }
    try {
      const item = parseKeystore(text);
      setSavedKey({ kind: 'saved', publicKeyHex: item.publicKeyHex });
    } catch {
      setSavedKey({ kind: 'invalid' });
      setKeyNotice({ kind: 'error', text: 'The saved key could not be read. Import a backup for this session, or remove this saved copy before saving a replacement.' });
    }
  }, []);

  const lock = useCallback(() => {
    // Web Crypto work cannot be aborted. Invalidate its result before clearing the active key.
    epoch.current += 1;
    keyRevision.current += 1;
    key.current?.secretKey.fill(0);
    key.current = undefined;
    running.current = false;
    setBusy(false);
    setPublicKeyHex('');
    setSignature('');
    setSignatureInfo('Padded Falcon-512 signature');
    setKeyNotice({ kind: 'neutral', text: 'Choose a key to continue signing.' });
    setSignatureNotice(initialSignature);
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshSavedKey();
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== null && event.key !== BROWSER_KEYSTORE_KEY) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      lock();
      setKeyNotice({ kind: 'neutral', text: 'The saved key changed in another tab. Unlock the current copy to continue.' });
      refreshSavedKey();
    };
    window.addEventListener('pagehide', lock);
    window.addEventListener('storage', storageChanged);
    window.addEventListener('pageshow', refreshSavedKey);
    return () => {
      mounted.current = false;
      epoch.current += 1;
      keyRevision.current += 1;
      key.current?.secretKey.fill(0);
      key.current = undefined;
      window.removeEventListener('pagehide', lock);
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('pageshow', refreshSavedKey);
    };
  }, [lock, refreshSavedKey]);

  async function run(scope: Scope, text: string, action: (current: () => boolean) => void | Promise<void>) {
    if (running.current) return;
    const revision = ++epoch.current;
    const current = () => mounted.current && epoch.current === revision;
    const report = scope === 'key' ? setKeyNotice : setSignatureNotice;
    running.current = true;
    setBusy(true);
    report({ kind: 'pending', text });
    // Let pending UI paint before synchronous Falcon operations. Worker isolation is still planned.
    await new Promise(resolve => setTimeout(resolve, 20));
    try {
      if (current()) await action(current);
    } catch (error) {
      if (current()) report({ kind: 'error', text: error instanceof Error ? error.message : 'Operation failed.' });
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  function installKey(next: KeyPair) {
    keyRevision.current += 1;
    key.current = next;
    setPublicKeyHex(toHex(next.publicKey));
    setSignature('');
    setSignatureNotice({ kind: 'neutral', text: 'Key ready. Review the message, then sign it.' });
  }

  function generate() {
    return run('key', 'Generating a Falcon key…', () => {
      if (key.current) throw new Error('Select Switch key before creating another key.');
      if (savedKey.kind === 'saved' || savedKey.kind === 'invalid') throw new Error('Remove the saved key before creating another.');
      const start = performance.now();
      installKey(createKeyPair());
      setKeyNotice({ kind: 'neutral', text: `Key generated in ${(performance.now() - start).toFixed(1)} ms. Save it in this browser or download a backup before reloading.` });
    });
  }

  function backup(password: string, confirmation: string, remember = false) {
    return run('key', remember ? 'Encrypting the key for this browser…' : 'Encrypting your backup…', async current => {
      if (!key.current) throw new Error('Unlock a key first.');
      if (password !== confirmation) throw new Error('Passwords do not match.');
      const encrypted = await encryptKeystore(key.current, password);
      if (!current()) return;
      if (remember) {
        try {
          if (!await updateSavedKey(current, () => saveBrowserKeystore(window.localStorage, encrypted))) return;
        }
        catch (error) {
          if (current()) refreshSavedKey();
          throw error;
        }
        if (!current()) return;
        refreshSavedKey();
        setKeyNotice({ kind: 'valid', text: 'Encrypted key saved in this browser. After reloading, enter your password to unlock it.' });
        return;
      }
      downloadJson('falcom-devcon-poc.keystore.json', encrypted);
      setKeyNotice({ kind: 'valid', text: 'Encrypted download requested. Keep the file and password so you can restore this key.' });
    });
  }

  function unlockSaved(password: string) {
    return run('key', 'Unlocking the saved key…', async current => {
      if (key.current) throw new Error('Select Switch key before unlocking another key.');
      const text = window.localStorage.getItem(BROWSER_KEYSTORE_KEY);
      if (text === null) {
        refreshSavedKey();
        throw new Error('No key is saved in this browser.');
      }
      const next = await decryptKeystore(text, password);
      let installed = false;
      try {
        if (!current()) return;
        if (window.localStorage.getItem(BROWSER_KEYSTORE_KEY) !== text) {
          refreshSavedKey();
          throw new Error('The saved key changed while unlocking. Try again with the current copy.');
        }
        installKey(next);
        installed = true;
        setKeyNotice({ kind: 'valid', text: 'Saved key unlocked in this tab.' });
      } finally {
        if (!installed) next.secretKey.fill(0);
      }
    });
  }

  function downloadSaved() {
    return run('key', 'Preparing your encrypted backup…', () => {
      const item = readBrowserKeystore(window.localStorage);
      if (!item) throw new Error('No key is saved in this browser.');
      downloadJson('falcom-devcon-poc.keystore.json', item);
      setKeyNotice({ kind: 'valid', text: 'Saved encrypted backup download requested. Its existing password is unchanged.' });
    });
  }

  function removalSnapshot(): string | null {
    return savedText.current;
  }

  function removeSaved(expected: string) {
    // Locking also invalidates any in-flight unlock before this saved copy is removed.
    lock();
    return run('key', 'Removing the saved key…', async current => {
      try {
        if (!await updateSavedKey(current, () => removeBrowserKeystore(window.localStorage, expected))) return;
      }
      finally { if (current()) refreshSavedKey(); }
      if (!current()) return;
      setKeyNotice({ kind: 'neutral', text: 'Saved key removed from this browser. Your downloaded backups are unchanged.' });
    });
  }

  function restore(file: File | undefined, password: string, remember = false) {
    return run('key', 'Unlocking your backup…', async current => {
      if (key.current) throw new Error('Select Switch key before importing another key.');
      if (!file) throw new Error('Choose an encrypted key file.');
      if (file.size > MAX_KEYSTORE_BYTES) throw new Error('Encrypted key file exceeds the 16 KiB limit.');
      const text = await file.text();
      if (!current()) return;
      const next = await decryptKeystore(text, password);
      if (!current()) {
        next.secretKey.fill(0);
        return;
      }
      installKey(next);
      if (remember) {
        try {
          if (!await updateSavedKey(current, () => saveBrowserKeystore(window.localStorage, parseKeystore(text)))) return;
        }
        catch {
          if (!current()) return;
          refreshSavedKey();
          setKeyNotice({ kind: 'error', text: 'Key restored in this tab, but it could not be saved in this browser. Keep your backup file.' });
          return;
        }
        if (!current()) return;
        refreshSavedKey();
        setKeyNotice({ kind: 'valid', text: 'Key restored and saved in this browser. After reloading, unlock it with the same password.' });
        return;
      }
      setKeyNotice({ kind: 'valid', text: 'Key restored and unlocked in this tab.' });
    });
  }

  function sign() {
    return run('signature', 'Signing the message…', () => {
      if (!key.current) throw new Error('Unlock a key first.');
      const bytes = fromHex(message, MESSAGE_BYTES);
      const start = performance.now();
      const signed = signMessage(bytes, key.current.secretKey);
      setSignature(toHex(signed));
      setSignatureInfo(`${signed.length} bytes · signed in ${(performance.now() - start).toFixed(1)} ms`);
      setSignatureNotice({ kind: 'neutral', text: 'Signature ready. Verify it against the current message.' });
    });
  }

  // Capture only a public lifecycle token. No private key is passed to the action UI.
  function captureKeyGuard() {
    const revision = keyRevision.current;
    return () => mounted.current && key.current !== undefined && keyRevision.current === revision;
  }

  async function signActionDigest(digest: Hex, isCurrent: () => boolean): Promise<Hex> {
    if (running.current) throw new Error('Wait for the current key operation to finish.');
    const revision = ++epoch.current;
    running.current = true;
    setBusy(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!isCurrent() || !key.current || epoch.current !== revision) throw new Error('Falcon key changed. Review the action and sign again.');
      return `0x${toHex(signMessage(fromHex(digest, MESSAGE_BYTES), key.current.secretKey))}`;
    } finally {
      if (mounted.current && epoch.current === revision) { running.current = false; setBusy(false); }
    }
  }

  function verify() {
    return run('signature', 'Verifying the signature…', () => {
      if (!key.current) throw new Error('Unlock a key first.');
      const bytes = fromHex(message, MESSAGE_BYTES);
      const signed = fromHex(signature, SIGNATURE_BYTES);
      const start = performance.now();
      const valid = verifySignature(bytes, signed, key.current.publicKey);
      const time = (performance.now() - start).toFixed(1);
      setSignatureNotice({ kind: valid ? 'valid' : 'invalid', text: `${valid ? 'Valid' : 'Invalid'} signature · checked in your browser in ${time} ms.` });
    });
  }

  function exportSample() {
    return run('signature', 'Preparing the public sample…', () => {
      if (!key.current) throw new Error('Unlock a key first.');
      const sample = publicSample(fromHex(message, MESSAGE_BYTES), fromHex(signature, SIGNATURE_BYTES), key.current.publicKey);
      downloadJson(sample.expectedValid ? 'falcon-valid-sample.json' : 'falcon-invalid-sample.json', sample);
      setSignatureNotice({ kind: 'neutral', text: `Public sample download requested. Signature ${sample.expectedValid ? 'valid' : 'invalid'} for the current message.` });
    });
  }

  function editMessage(value: string) {
    setMessage(value);
    setSignatureNotice({ kind: 'neutral', text: 'Message changed. Sign it or verify the existing signature again.' });
  }

  function editSignature(value: string) {
    setSignature(value);
    setSignatureInfo('Edited signature · verify to check');
    setSignatureNotice({ kind: 'neutral', text: 'Signature changed. Verify again to check it.' });
  }

  return {
    busy, publicKeyHex, message, signature, keyNotice, signatureNotice, signatureInfo, savedKey,
    generate, lock, backup, restore, sign, verify, exportSample, editMessage, editSignature,
    unlockSaved, downloadSaved, removalSnapshot, removeSaved,
    signActionDigest, captureKeyGuard,
  };
}
