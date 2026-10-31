import assert from 'node:assert/strict';
import test from 'node:test';
import { toHex } from 'viem';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
import type { RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import { findOwnerRecovery } from '../../src/lib/falcon/existingSafe.ts';
const account = toHex(100, { size: 20 }), safe = toHex(200, { size: 20 });
const hash = toHex(300, { size: 32 }), oldHash = toHex(301, { size: 32 });
const blockHash = toHex(400, { size: 32 }), headHash = toHex(401, { size: 32 });
const attempt: RecoveryAttempt = { version: 1, id: 'owner', kind: 'owner', chainId: 10200, account,
  to: safe, nonce: '7', value: '0', data: '0x1234', publicKey: `0x${'11'.repeat(897)}`, controller: toHex(500, { size: 20 }), safeNonce: '4', startBlock: '910' };
function fixture({ mined = true, replacement = false, reorg = false, earliest = 900n, chain = 10200 } = {}) {
  const calls: bigint[] = [];
  const tx = { hash, from: account, to: replacement ? account : safe, nonce: 7, value: 0n, input: replacement ? '0x' : attempt.data,
    chainId: 10200, blockNumber: 915n, blockHash };
  const client = {
    getChainId: async () => chain,
    getBlock: async ({ blockTag, blockNumber, includeTransactions }: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) => {
      const number = blockTag === 'latest' ? 1000n : blockNumber!;
      return { number, hash: number === 1000n ? reorg && blockTag !== 'latest' ? oldHash : headHash : blockHash,
        transactions: includeTransactions ? [tx] : [] };
    },
    getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.push(blockNumber);
      if (blockNumber < earliest) throw new Error(`pruned history unavailable: earliest available ${earliest}`);
      return mined && blockNumber >= 915n ? 8 : 7;
    },
    getTransaction: async () => tx,
    getTransactionReceipt: async () => ({ transactionHash: hash, from: account, status: replacement ? 'reverted' : 'success', blockNumber: 915n, blockHash }),
  } as unknown as EezClient;
  const provider = { request: async () => { throw new Error('Sender/nonce extension cannot read pruned history'); } };
  return { client, provider, calls };
}
const signal = () => new AbortController().signal;
test('owner recovery finds the exact canonical transaction when the RPC extension fails', async () => {
  const f = fixture();
  assert.deepEqual(await findOwnerRecovery(f.client, f.provider, attempt, signal()), { hash, outcome: 'matching' });
  assert(f.calls.length < 12, 'nonce bisection stays bounded');
});
test('older owner journals use retained history instead of requiring genesis state', async () => {
  const f = fixture();
  assert.deepEqual(await findOwnerRecovery(f.client, f.provider, { ...attempt, startBlock: undefined }, signal()), { hash, outcome: 'matching' });
  assert(f.calls.includes(0n)); assert(f.calls.includes(900n));
});
test('speed-ups and mined cancellations are recovered even when an original hash was saved', async () => {
  for (const replacement of [false, true]) {
    const f = fixture({ replacement });
    assert.deepEqual(await findOwnerRecovery(f.client, f.provider, { ...attempt, hash: oldHash }, signal()), { hash, outcome: replacement ? 'replaced' : 'matching' });
  }
});
test('unmined requests remain pending and unavailable old history never clears them', async () => {
  const pending = fixture({ mined: false });
  assert.equal(await findOwnerRecovery(pending.client, pending.provider, attempt, signal()), null);
  const pruned = fixture({ earliest: 950n });
  await assert.rejects(findOwnerRecovery(pruned.client, pruned.provider, attempt, signal()), /pending record is preserved/);
});
test('reorganizations, different chains and aborts cannot resolve an owner request', async () => {
  const reorg = fixture({ reorg: true });
  await assert.rejects(findOwnerRecovery(reorg.client, reorg.provider, attempt, signal()), /history changed/);
  const wrong = fixture({ chain: 1 });
  await assert.rejects(findOwnerRecovery(wrong.client, wrong.provider, attempt, signal()), /different chain/);
  const abort = new AbortController(); abort.abort();
  const f = fixture();
  await assert.rejects(findOwnerRecovery(f.client, f.provider, attempt, abort.signal));
  assert.deepEqual(f.calls, []);
});
