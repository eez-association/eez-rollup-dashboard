import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { readRecovery, updateRecovery, recordWalletHash, rejectWalletRequest, resolveRecovery, migrateRecovery, scopedRecoveryKey, type RecoveryOwner, type RecoveryAttempt } from '../lib/falcon/recoveryJournal';

export function useFalconRecovery(base: string, owner: RecoveryOwner | null) {
  const key = owner ? scopedRecoveryKey(base, owner) : null;
  const [state, setState] = useState<{ key: string | null; attempt: RecoveryAttempt | null; error: string }>({ key: null, attempt: null, error: '' });
  const current = useRef(key); current.current = key;
  const mounted = useRef(false);
  const read = () => {
    try { return { key, attempt: key ? readRecovery(localStorage.getItem(key)) : null, error: '' }; }
    catch (error) { return { key, attempt: null, error: error instanceof Error ? error.message : 'Falcon recovery storage is unavailable.' }; }
  };
  const publish = () => { if (mounted.current && current.current === key) setState(read()); };
  async function locked<T>(action: () => T): Promise<T> {
    if (!key || !owner) throw new Error('Connect your wallet and unlock your Falcon key first.');
    if (!navigator.locks) throw new Error('Falcon recovery requires browser Web Locks support.');
    // Share the legacy lock during migration and writes, including late wallet replies.
    return navigator.locks.request(base, () => {
      try { migrateRecovery(localStorage, base, owner); }
      catch (error) {
        if (mounted.current && current.current === key) setState({ key, attempt: null,
          error: error instanceof Error ? error.message : 'Falcon recovery storage is unavailable.' });
        throw error;
      }
      try { return action(); } finally { publish(); }
    });
  }
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (!key) { publish(); return; }
      void locked(() => {}).catch(error => {
        if (mounted.current && current.current === key) setState({ key, attempt: null, error: error.message });
      });
    };
    refresh();
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === key || event.key === base) refresh(); };
    window.addEventListener('storage', changed);
    return () => { mounted.current = false; window.removeEventListener('storage', changed); };
  }, [key, base]);
  return {
    key,
    attempt: key && state.key === key ? state.attempt : null,
    error: !key ? '' : state.key === key ? state.error : 'Loading Falcon recovery…',
    begin: (attempt: RecoveryAttempt) => locked(() => {
      if (scopedRecoveryKey(base, attempt) !== key) throw new Error('Wallet or Falcon key changed. Review and try again.');
      updateRecovery(localStorage, key!, null, attempt);
    }),
    finish: (id: string) => locked(() => updateRecovery(localStorage, key!, id, null)),
    reject: (attempt: RecoveryAttempt) => locked(() => rejectWalletRequest(localStorage, key!, attempt)),
    selectHash: (attempt: RecoveryAttempt, hash: Hex) => locked(() => resolveRecovery(localStorage, key!, attempt, hash)),
    resolve: (attempt: RecoveryAttempt) => locked(() => resolveRecovery(localStorage, key!, attempt, null)),
    // Closures retain the original owner even if the wallet replies after a switch or unmount.
    recordHash: (attempt: RecoveryAttempt, hash: Hex) => locked(() => recordWalletHash(localStorage, key!, attempt, hash)),
  };
}
