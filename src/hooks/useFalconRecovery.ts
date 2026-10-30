import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { readRecovery, updateRecovery, recordWalletHash, rejectWalletRequest, resolveRecovery, type RecoveryAttempt } from '../lib/falcon/recoveryJournal';

export function useFalconRecovery(key: string) {
  const read = () => {
    try { return { key, attempt: readRecovery(localStorage.getItem(key)), error: '' }; }
    catch (error) { return { key, attempt: null, error: error instanceof Error ? error.message : 'Falcon recovery storage is unavailable.' }; }
  };
  const [state, setState] = useState(read);
  const current = useRef(key); current.current = key;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true; setState(read());
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === key) setState(read()); };
    window.addEventListener('storage', changed);
    return () => { mounted.current = false; window.removeEventListener('storage', changed); };
  }, [key]);
  const publish = () => { if (mounted.current && current.current === key) setState(read()); };
  async function locked<T>(action: () => T): Promise<T> {
    if (!navigator.locks) throw new Error('Falcon recovery requires browser Web Locks support.');
    try { return await navigator.locks.request(key, action); }
    finally { publish(); }
  }
  return {
    attempt: state.key === key ? state.attempt : null,
    error: state.key === key ? state.error : 'Loading Falcon recovery…',
    begin: (attempt: RecoveryAttempt) => locked(() => updateRecovery(localStorage, key, null, attempt)),
    finish: (id: string) => locked(() => updateRecovery(localStorage, key, id, null)),
    reject: (attempt: RecoveryAttempt) => locked(() => rejectWalletRequest(localStorage, key, attempt)),
    selectHash: (attempt: RecoveryAttempt, hash: Hex) => locked(() => resolveRecovery(localStorage, key, attempt, hash)),
    resolve: (attempt: RecoveryAttempt) => locked(() => resolveRecovery(localStorage, key, attempt, null)),
    async recordHash(attempt: RecoveryAttempt, hash: Hex) {
      // This still persists a late wallet reply after the demo has unmounted.
      return locked(() => recordWalletHash(localStorage, key, attempt, hash));
    },
  };
}
