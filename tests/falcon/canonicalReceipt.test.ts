import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
import { canonicalReceipt, FalconTransactionReverted } from '../../src/lib/falcon/l1Controller.ts';

const hash = ('0x' + 'ab'.repeat(32)) as Hex;
const blockHash = ('0x' + 'cd'.repeat(32)) as Hex;
function client(status: string, canonical = true) {
  return {
    getTransactionReceipt: async () => ({ transactionHash: hash, status, blockHash, blockNumber: 1n }),
    getBlock: async () => ({ hash: canonical ? blockHash : '0x' + 'ef'.repeat(32) }),
  } as unknown as EezClient;
}

test('a canonical revert identifies the transaction eligible for recovery', async () => {
  await assert.rejects(canonicalReceipt(client('reverted'), hash, new AbortController().signal), error =>
    error instanceof FalconTransactionReverted && error.transactionHash === hash);
});

test('an orphaned revert must not authorize a fresh submission', async () => {
  await assert.rejects(canonicalReceipt(client('reverted', false), hash, new AbortController().signal), error =>
    error instanceof Error && !(error instanceof FalconTransactionReverted) && /no longer canonical/.test(error.message));
});

test('a successful canonical receipt is retained', async () => {
  const receipt = await canonicalReceipt(client('success'), hash, new AbortController().signal);
  assert.equal(receipt.transactionHash, hash);
  assert.equal(receipt.status, 'success');
});
