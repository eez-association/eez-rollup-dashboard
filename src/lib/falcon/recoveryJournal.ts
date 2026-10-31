import { isAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import type { CrossChainDeployment } from './crossChainDeployment.ts';

/** Public submission details only. Never store a Falcon secret or signature here. */
export type RecoveryAttempt = {
  version: 1; id: string; kind: 'funding' | 'controller'; chainId: number;
  account: Address; to: Address; nonce: string; value: string; data: Hex;
  publicKey: Hex; controller?: Address; hash?: Hex;
};
export function recoveryKey(deployment: CrossChainDeployment, kind: RecoveryAttempt['kind']) {
  const identity = [deployment.l1.chainId, deployment.l1.anchor.blockHash, deployment.l1.registry,
    deployment.l2.chainId, deployment.l2.anchor.blockHash, deployment.l2.manager, deployment.l2.factory.address];
  return `eez:falcon:recovery:${keccak256(toHex(JSON.stringify(identity).toLowerCase()))}:${kind}`;
}
export type RecoveryOwner = Pick<RecoveryAttempt, 'account' | 'publicKey'>;
export function scopedRecoveryKey(base: string, owner: RecoveryOwner) {
  return `${base}:${owner.account.toLowerCase()}:${keccak256(owner.publicKey)}`;
}
/** Called under the deployment journal lock. Only the recorded owner can adopt a legacy request. */
export function migrateRecovery(storage: JournalStorage, base: string, owner: RecoveryOwner) {
  const key = scopedRecoveryKey(base, owner);
  const raw = storage.getItem(base);
  if (!raw) return;
  const legacy = JSON.parse(raw) as RecoveryAttempt;
  if (legacy?.account?.toLowerCase() !== owner.account.toLowerCase()
    || legacy?.publicKey?.toLowerCase() !== owner.publicKey.toLowerCase()) return;
  const attempt = readRecovery(raw)!;
  const current = readRecovery(storage.getItem(key));
  if (current && (current.id !== attempt.id || JSON.stringify({ ...current, hash: undefined }) !== JSON.stringify({ ...attempt, hash: undefined })
    || current.hash && attempt.hash && current.hash !== attempt.hash)) {
    throw new Error('Two saved Falcon requests need review for this wallet and key. Both records have been preserved.');
  }
  // Write first: a failed write must leave the only copy intact. Repeating migration is safe.
  storage.setItem(key, JSON.stringify(current?.hash ? current : attempt));
  storage.removeItem(base);
}
export function readRecovery(raw: string | null): RecoveryAttempt | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as RecoveryAttempt;
  if (!value || value.version !== 1 || !['funding', 'controller'].includes(value.kind)
    || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.chainId) || value.chainId <= 0
    || typeof value.account !== 'string' || !isAddress(value.account) || typeof value.to !== 'string' || !isAddress(value.to)
    || typeof value.nonce !== 'string' || !/^(0|[1-9]\d*)$/.test(value.nonce)
    || typeof value.value !== 'string' || !/^(0|[1-9]\d*)$/.test(value.value)
    || typeof value.data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(value.data)
    || typeof value.publicKey !== 'string' || !/^0x[\da-f]{1794}$/i.test(value.publicKey)
    || value.kind === 'funding' && (!isAddress(value.controller ?? '') || value.data !== '0x')
    || value.hash !== undefined && !/^0x[\da-f]{64}$/i.test(value.hash)) {
    throw new Error('Saved Falcon recovery details are invalid. Preserve this record and check wallet activity before sending again.');
  }
  return value;
}

type Transaction = { from: string; to: string | null; nonce: number | bigint; value: bigint; input: string; chainId?: number };
export function matchesRecoveryTransaction(tx: Transaction, attempt: RecoveryAttempt) {
  return tx.from.toLowerCase() === attempt.account.toLowerCase()
    && tx.to?.toLowerCase() === attempt.to.toLowerCase()
    && BigInt(tx.nonce) === BigInt(attempt.nonce) && tx.value === BigInt(attempt.value)
    && tx.input.toLowerCase() === attempt.data.toLowerCase()
    && (tx.chainId === undefined || tx.chainId === attempt.chainId);
}

/** Caller holds the journal's Web Lock. Compare IDs so late replies cannot replace a newer attempt. */
export function updateRecovery(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string,
  expected: string | null, next: RecoveryAttempt | null) {
  const current = readRecovery(storage.getItem(key));
  if (!current && expected && !next) return; // Confirmation may already have finished in another tab.
  if ((current?.id ?? null) !== expected) throw new Error('Another Falcon request is pending or recovery changed in another tab.');
  if (next) { readRecovery(JSON.stringify(next)); storage.setItem(key, JSON.stringify(next)); }
  else storage.removeItem(key);
}

type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Automatic wallet replies can fill a missing hash, never replace a user's recovery choice. */
export function recordWalletHash(storage: JournalStorage, key: string, attempt: RecoveryAttempt, hash: Hex) {
  const current = readRecovery(storage.getItem(key));
  if (current?.id !== attempt.id) return null; // Resolved or superseded while the prompt was open.
  if (current.hash) return current;
  const next = { ...current, hash };
  updateRecovery(storage, key, current.id, next);
  return next;
}
/** A late rejection of the original prompt must not erase a recovered transaction. */
export function rejectWalletRequest(storage: JournalStorage, key: string, attempt: RecoveryAttempt) {
  const current = readRecovery(storage.getItem(key));
  if (current?.id === attempt.id && !current.hash) updateRecovery(storage, key, attempt.id, null);
}
/** Explicit recovery updates compare the observed hash as well as the attempt ID. */
export function resolveRecovery(storage: JournalStorage, key: string, attempt: RecoveryAttempt, hash: Hex | null) {
  const current = readRecovery(storage.getItem(key));
  if (!current || current.id !== attempt.id || current.hash !== attempt.hash) {
    throw new Error('Recovery changed while checking. Review the current request and try again.');
  }
  updateRecovery(storage, key, attempt.id, hash ? { ...current, hash } : null);
}
