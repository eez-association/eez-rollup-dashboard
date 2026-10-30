import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import { l1ActionDigest, l1ControllerAbi, type L1Action, type SignedL1Action } from '../../src/lib/falcon/l1Action.ts';
import { l1CallResult, parseSettlement } from '../../src/lib/falcon/l1Controller.ts';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const action: L1Action = { sourceChainId: 906969n, destinationChainId: 10200n, controller: address(1), eezL2: address(2), target: address(3), data: '0x12345678', nonce: 0n, deadline: 100n };

test('every source, destination, calldata and replay field changes the signed digest', () => {
  for (const [key, value] of Object.entries({ sourceChainId: 1n, destinationChainId: 1n, controller: address(11), eezL2: address(12), target: address(13), data: '0x12345679', nonce: 1n, deadline: 101n })) {
    assert.notEqual(l1ActionDigest({ ...action, [key]: value }), l1ActionDigest(action), key);
  }
});

test('source result requires this exact authorization, relayer, signature and target', () => {
  const signed: SignedL1Action = { action, signature: '0x1234', publicKey: '0x09' };
  const result = encodeAbiParameters([{ type: 'uint256' }], [7n]);
  const log = {
    address: action.controller,
    topics: encodeEventTopics({ abi: l1ControllerAbi, eventName: 'CallExecuted', args: { digest: l1ActionDigest(action), nonce: 0n, target: action.target } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes' }], [address(4), keccak256(signed.signature), result]),
  };
  const receipt = { status: 'success', to: action.controller, logs: [log] } as unknown as TransactionReceipt;
  assert.equal(l1CallResult(receipt, signed, address(4)), result);
  assert.equal(l1CallResult(receipt, signed, address(5)), null);
  assert.equal(l1CallResult(receipt, { ...signed, signature: '0x1235' }, address(4)), null);
  assert.equal(l1CallResult(receipt, { ...signed, action: { ...action, data: '0x' } }, address(4)), null);
  assert.equal(l1CallResult({ ...receipt, status: 'reverted' }, signed, address(4)), null);
  assert.equal(l1CallResult({ ...receipt, logs: [] }, signed, address(4)), null);
});

test('settlement correlation rejects a different block, noncanonical range and malformed fields', () => {
  const receipt = { blockHash: hash(1), blockNumber: 7n } as TransactionReceipt;
  const settlement = { canonicalL2: true, l1BlockNumber: '0x20', l1BlockHash: hash(2), l1TransactionHash: hash(3), l2Blocks: [{ hash: hash(1), number: '0x7' }] };
  assert.equal(parseSettlement(settlement, receipt).l1BlockNumber, 32n);
  for (const mutation of [null, { ...settlement, canonicalL2: false }, { ...settlement, canonicalL2: undefined }, { ...settlement, l1TransactionHash: '0x' }, { ...settlement, l2Blocks: [] }, { ...settlement, l2Blocks: [{ hash: hash(1), number: '0x8' }] }]) assert.throws(() => parseSettlement(mutation, receipt));
});
