import assert from 'node:assert/strict';
import test from 'node:test';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
import type { RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import { checkNoObservedSubmission, checkRecoveryOutcome, findRecoveryByNonce } from '../../src/lib/falcon/recoveryChecks.ts';

const account = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const hash = `0x${'ab'.repeat(32)}` as const, blockHash = `0x${'cd'.repeat(32)}` as const;
const attempt: RecoveryAttempt = { version: 1, id: 'test', kind: 'funding', chainId: 10200,
  account, to, nonce: '7', value: '10', data: '0x', controller: to, publicKey: `0x${'ab'.repeat(897)}` };
test('missing hashes are recovered only through the recorded sender/nonce and validated transaction', async () => {
  const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    assert.equal(method, 'eth_getTransactionBySenderAndNonce'); assert.deepEqual(params, [account, '0x7']); return { hash };
  } };
  const signal = new AbortController().signal;
  assert.deepEqual(await findRecoveryByNonce(fixture({ recipient: to, value: 10n }), provider, attempt, signal), { hash, outcome: 'matching' });
  assert.deepEqual(await findRecoveryByNonce(fixture(), provider, attempt, signal), { hash, outcome: 'replaced' });
  assert.equal(await findRecoveryByNonce(fixture(), { request: async () => null }, attempt, signal), null);
  await assert.rejects(findRecoveryByNonce(fixture({ nonce: 8 }), provider, attempt, signal), /sender, nonce/);
  await assert.rejects(findRecoveryByNonce(fixture(), { request: async () => ({ hash: 'bad' }) }, attempt, signal), /invalid transaction/);
});
function fixture({ pending = false, reorg = false, nonce = 7, status = 'success', recipient = account, value = 0n, chain = 10200 } = {}) {
  const tx = { hash, from: account, to: recipient, nonce, value, input: '0x', chainId: chain,
    blockNumber: pending ? null : 10n, blockHash: pending ? null : blockHash };
  return {
    getChainId: async () => chain,
    getTransaction: async () => tx,
    getTransactionReceipt: async () => ({ transactionHash: hash, from: account, status, blockNumber: 10n, blockHash }),
    getBlock: async () => ({ number: 10n, hash: reorg ? `0x${'ef'.repeat(32)}` : blockHash }),
  } as unknown as EezClient;
}

test('matching pending transactions remain under normal confirmation', async () => {
  assert.equal(await checkRecoveryOutcome(fixture({ pending: true, recipient: to, value: 10n }), attempt, hash, new AbortController().signal), 'matching');
});
test('a mined cancellation or other replacement resolves the consumed nonce without claiming original success', async () => {
  for (const status of ['success', 'reverted']) {
    assert.equal(await checkRecoveryOutcome(fixture({ status }), attempt, hash, new AbortController().signal), 'replaced');
  }
});
test('pending, reorganized, wrong-nonce and wrong-network replacements do not clear an attempt', async () => {
  for (const options of [{ pending: true }, { reorg: true }, { nonce: 6 }, { chain: 1 }]) {
    await assert.rejects(checkRecoveryOutcome(fixture(options), attempt, hash, new AbortController().signal));
  }
});
test('unsent recovery requires both mined and pending nonce to be unchanged', async () => {
  for (const [mined, pending, allowed] of [[7, 7, true], [7, 8, false], [8, 8, false], [6, 7, false]] as const) {
    const client = { ...fixture(), getTransactionCount: async ({ blockTag }: { blockTag?: string }) => blockTag === 'pending' ? pending : mined } as unknown as EezClient;
    const check = checkNoObservedSubmission(client, attempt, new AbortController().signal);
    if (allowed) await check; else await assert.rejects(check, /nonce has pending or mined activity/);
  }
});
test('unsent recovery rejects known hashes and changed canonical blocks', async () => {
  const client = { ...fixture(), getTransactionCount: async () => 7 } as unknown as EezClient;
  await assert.rejects(checkNoObservedSubmission(client, { ...attempt, hash }, new AbortController().signal), /hash is already recorded/);
  let reads = 0;
  const changed = { ...client, getBlock: async () => ({ number: 10n, hash: ++reads === 1 ? blockHash : hash }) } as unknown as EezClient;
  await assert.rejects(checkNoObservedSubmission(changed, attempt, new AbortController().signal), /Network state changed/);
});
