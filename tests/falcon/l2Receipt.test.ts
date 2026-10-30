import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import { EEZ, recordAbi, verifiedReceipt } from '../../src/lib/falcon/eez.ts';

test('receipt requires the verifier event bound to sender and all public inputs', () => {
  const account: Address = '0x1111111111111111111111111111111111111111';
  const other: Address = '0x2222222222222222222222222222222222222222';
  const sample = { message: '0x01' as Hex, signature: '0x02' as Hex, publicKey: '0x03' as Hex };
  const topics = encodeEventTopics({ abi: recordAbi, eventName: 'SignatureVerified', args: { submitter: account, publicKeyHash: keccak256(sample.publicKey), messageHash: keccak256(sample.message) } });
  const log = { address: EEZ.address, topics, data: encodeAbiParameters([{ type: 'bytes32' }], [keccak256(sample.signature)]) };
  const receipt = { status: 'success', to: EEZ.address, logs: [log] } as unknown as TransactionReceipt;
  assert.equal(verifiedReceipt(receipt, sample, account), true);
  assert.equal(verifiedReceipt({ ...receipt, status: 'reverted' }, sample, account), false);
  assert.equal(verifiedReceipt({ ...receipt, logs: [] }, sample, account), false);
  assert.equal(verifiedReceipt({ ...receipt, to: other }, sample, account), false);
  assert.equal(verifiedReceipt({ ...receipt, logs: [{ ...receipt.logs[0]!, address: other }] }, sample, account), false);
  assert.equal(verifiedReceipt(receipt, sample, other), false);
  for (const field of ['message', 'signature', 'publicKey'] as const) {
    assert.equal(verifiedReceipt(receipt, { ...sample, [field]: '0xff' }, account), false);
  }
});
