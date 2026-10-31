import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import { verifierDeployment, recordAbi, verifiedReceipt } from '../../src/lib/falcon/eez.ts';
import { crossChainDeployments } from '../../src/lib/falcon/crossChainDeployment.ts';

for (const deployment of crossChainDeployments) test(`${deployment.l2.chainName} receipt requires its verifier event bound to sender and all public inputs`, () => {
  const verifier = verifierDeployment(deployment);
  const account: Address = '0x1111111111111111111111111111111111111111';
  const other: Address = '0x2222222222222222222222222222222222222222';
  const sample = { message: '0x01' as Hex, signature: '0x02' as Hex, publicKey: '0x03' as Hex };
  const topics = encodeEventTopics({ abi: recordAbi, eventName: 'SignatureVerified', args: { submitter: account, publicKeyHash: keccak256(sample.publicKey), messageHash: keccak256(sample.message) } });
  const log = { address: verifier.address, topics, data: encodeAbiParameters([{ type: 'bytes32' }], [keccak256(sample.signature)]) };
  const receipt = { status: 'success', to: verifier.address, logs: [log] } as unknown as TransactionReceipt;
  assert.equal(verifiedReceipt(receipt, sample, account, verifier), true);
  assert.equal(verifiedReceipt({ ...receipt, status: 'reverted' }, sample, account, verifier), false);
  assert.equal(verifiedReceipt({ ...receipt, logs: [] }, sample, account, verifier), false);
  assert.equal(verifiedReceipt({ ...receipt, to: other }, sample, account, verifier), false);
  assert.equal(verifiedReceipt({ ...receipt, logs: [{ ...receipt.logs[0]!, address: other }] }, sample, account, verifier), false);
  assert.equal(verifiedReceipt(receipt, sample, other, verifier), false);
  for (const otherDeployment of crossChainDeployments.filter(d => d !== deployment)) {
    assert.equal(verifiedReceipt(receipt, sample, account, verifierDeployment(otherDeployment)), false);
  }
  for (const field of ['message', 'signature', 'publicKey'] as const) {
    assert.equal(verifiedReceipt(receipt, { ...sample, [field]: '0xff' }, account, verifier), false);
  }
});
