import assert from 'node:assert/strict';
import test from 'node:test';
import { readRecovery, recoveryKey, scopedRecoveryKey, migrateRecovery, updateRecovery, recordWalletHash, rejectWalletRequest, resolveRecovery, matchesRecoveryTransaction, type RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import { crossChainDeployment, testnetDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';

const attempt: RecoveryAttempt = {
  version: 1, id: 'attempt-1', kind: 'funding', chainId: 10200,
  account: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222',
  controller: '0x3333333333333333333333333333333333333333', nonce: '7', value: '10000000000000000', data: '0x',
  publicKey: `0x${'ab'.repeat(897)}`,
};
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
test('unknown and known submissions can be restored after the component is gone', () => {
  const saved = storage();
  updateRecovery(saved, 'key', null, attempt);
  assert.deepEqual(readRecovery(saved.getItem('key')), attempt);
  const sent = { ...attempt, hash: `0x${'cd'.repeat(32)}` as const };
  updateRecovery(saved, 'key', attempt.id, sent);
  assert.deepEqual(readRecovery(saved.getItem('key')), sent);
  updateRecovery(saved, 'key', attempt.id, null);
  assert.equal(readRecovery(saved.getItem('key')), null);
});
test('a different tab cannot start a second attempt or erase one with a late reply', () => {
  const saved = storage();
  updateRecovery(saved, 'key', null, attempt);
  assert.throws(() => updateRecovery(saved, 'key', null, { ...attempt, id: 'attempt-2' }), /Another Falcon request/);
  assert.throws(() => updateRecovery(saved, 'key', 'old-attempt', null), /Another Falcon request/);
  assert.deepEqual(readRecovery(saved.getItem('key')), attempt);
});
test('an old identical transfer cannot recover a newer nonce', () => {
  const tx = { from: attempt.account, to: attempt.to, nonce: 7, value: BigInt(attempt.value), input: '0x', chainId: 10200 };
  assert.equal(matchesRecoveryTransaction(tx, attempt), true);
  for (const patch of [{ nonce: 6 }, { chainId: 1 }, { from: attempt.to }, { to: attempt.account }, { value: 1n }, { input: '0xab' }]) {
    assert.equal(matchesRecoveryTransaction({ ...tx, ...patch }, attempt), false);
  }
});
test('malformed records fail closed and each deployment and operation has its own journal', () => {
  for (const patch of [{ nonce: undefined }, { publicKey: '0x' }, { data: '0x1' }, { kind: 'unknown' }, { chainId: 0 }, { controller: undefined }]) {
    assert.throws(() => readRecovery(JSON.stringify({ ...attempt, ...patch })), /invalid/);
  }
  assert.notEqual(recoveryKey(crossChainDeployment, 'funding'), recoveryKey(testnetDeployment, 'funding'));
  assert.notEqual(recoveryKey(testnetDeployment, 'funding'), recoveryKey(testnetDeployment, 'controller'));
});

test('late wallet success or rejection preserves an explicitly recovered replacement', () => {
  const saved = storage(), originalHash = `0x${'ab'.repeat(32)}` as const, replacement = `0x${'cd'.repeat(32)}` as const;
  updateRecovery(saved, 'key', null, attempt);
  resolveRecovery(saved, 'key', attempt, replacement);
  assert.equal(recordWalletHash(saved, 'key', attempt, originalHash)?.hash, replacement);
  rejectWalletRequest(saved, 'key', attempt);
  assert.equal(readRecovery(saved.getItem('key'))?.hash, replacement);
  const recovered = readRecovery(saved.getItem('key'))!;
  resolveRecovery(saved, 'key', recovered, null);
  assert.equal(recordWalletHash(saved, 'key', attempt, originalHash), null, 'a resolved attempt is not recreated');
  assert.equal(readRecovery(saved.getItem('key')), null);
});

test('manual clear cannot erase a hash received while nonce checks were running', () => {
  const saved = storage(), hash = `0x${'cd'.repeat(32)}` as const;
  updateRecovery(saved, 'key', null, attempt);
  recordWalletHash(saved, 'key', attempt, hash);
  assert.throws(() => resolveRecovery(saved, 'key', attempt, null), /Recovery changed/);
  assert.equal(readRecovery(saved.getItem('key'))?.hash, hash);
});

test('late replies for a previous attempt do not alter a newer one', () => {
  const saved = storage(), next = { ...attempt, id: 'attempt-2', nonce: '8' };
  updateRecovery(saved, 'key', null, next);
  assert.equal(recordWalletHash(saved, 'key', attempt, `0x${'ab'.repeat(32)}`), null);
  rejectWalletRequest(saved, 'key', attempt);
  assert.deepEqual(readRecovery(saved.getItem('key')), next);
});


test('wallet and Falcon key scope are independent and normalize hex casing', () => {
  const base = recoveryKey(testnetDeployment, 'funding');
  const key = scopedRecoveryKey(base, attempt);
  assert.notEqual(key, scopedRecoveryKey(base, { ...attempt, account: attempt.to }));
  assert.notEqual(key, scopedRecoveryKey(base, { ...attempt, publicKey: `0x${'cd'.repeat(897)}` }));
  assert.equal(key, scopedRecoveryKey(base, { ...attempt, publicKey: attempt.publicKey.toUpperCase().replace('0X', '0x') as `0x${string}` }));
});
test('legacy recovery migrates only for its owner and survives reload and late replies', () => {
  const saved = storage(), base = recoveryKey(testnetDeployment, 'funding'), key = scopedRecoveryKey(base, attempt);
  saved.setItem(base, JSON.stringify(attempt));
  for (const other of [{ ...attempt, account: attempt.to }, { ...attempt, publicKey: `0x${'cd'.repeat(897)}` as const }]) {
    migrateRecovery(saved, base, other);
    assert.equal(saved.getItem(scopedRecoveryKey(base, other)), null);
    assert.deepEqual(readRecovery(saved.getItem(base)), attempt);
  }
  migrateRecovery(saved, base, attempt);
  assert.equal(saved.getItem(base), null);
  assert.deepEqual(readRecovery(saved.getItem(key)), attempt);
  migrateRecovery(saved, base, attempt);
  const other = { ...attempt, account: attempt.to, id: 'wallet-b' };
  const otherKey = scopedRecoveryKey(base, other);
  updateRecovery(saved, otherKey, null, other);
  recordWalletHash(saved, key, attempt, `0x${'ab'.repeat(32)}`);
  assert.deepEqual(readRecovery(saved.getItem(otherKey)), other);
  assert.equal(readRecovery(saved.getItem(key))?.hash, `0x${'ab'.repeat(32)}`);
});
test('legacy migration preserves both conflicting records and retains a recovered hash', () => {
  const saved = storage(), base = recoveryKey(testnetDeployment, 'funding'), key = scopedRecoveryKey(base, attempt);
  saved.setItem(base, JSON.stringify(attempt));
  const newer = { ...attempt, id: 'newer' };
  saved.setItem(key, JSON.stringify(newer));
  assert.throws(() => migrateRecovery(saved, base, attempt), /Both records have been preserved/);
  assert.deepEqual(readRecovery(saved.getItem(base)), attempt);
  assert.deepEqual(readRecovery(saved.getItem(key)), newer);
  const recovered = { ...attempt, hash: `0x${'ab'.repeat(32)}` as const };
  saved.setItem(key, JSON.stringify(recovered));
  migrateRecovery(saved, base, attempt);
  assert.equal(saved.getItem(base), null);
  assert.deepEqual(readRecovery(saved.getItem(key)), recovered);
});
test('a failed migration write never removes the legacy request', () => {
  const saved = storage(), base = recoveryKey(testnetDeployment, 'funding');
  saved.setItem(base, JSON.stringify(attempt));
  assert.throws(() => migrateRecovery({ ...saved, setItem: () => { throw new Error('storage full'); } }, base, attempt), /storage full/);
  assert.deepEqual(readRecovery(saved.getItem(base)), attempt);
});
