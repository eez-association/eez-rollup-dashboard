import assert from 'node:assert/strict';
import test from 'node:test';
import { readRecovery, recoveryKey, updateRecovery, recordWalletHash, rejectWalletRequest, resolveRecovery, matchesRecoveryTransaction, type RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
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
