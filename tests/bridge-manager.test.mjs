import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, toFunctionSelector, zeroAddress } from 'viem';
import { readBridgeManager } from '../src/lib/bridgeManager.ts';

const current = toFunctionSelector('EEZContract()'), legacy = toFunctionSelector('manager()');
const manager = '0x3333333333333333333333333333333333333333';
const encoded = address => encodeAbiParameters([{ type: 'address' }], [address]);

test('bridge identity prefers EEZContract without calling the legacy getter', async () => {
  const calls = [];
  assert.equal(await readBridgeManager(async data => {
    calls.push(data); return encoded(manager);
  }), manager);
  assert.deepEqual(calls, [current]);
});

test('a failed, missing or malformed EEZContract response falls back to manager', async () => {
  for (const response of [new Error('execution reverted'), '0x', undefined, 'not-an-address', `0x1${'0'.repeat(63)}`]) {
    const calls = [];
    assert.equal(await readBridgeManager(async data => {
      calls.push(data);
      if (data === legacy) return encoded(manager);
      if (response instanceof Error) throw response;
      return response;
    }), manager);
    assert.deepEqual(calls, [current, legacy]);
  }
});

test('a valid zero or different EEZContract address cannot be overridden by manager', async () => {
  for (const address of [zeroAddress, '0x4444444444444444444444444444444444444444']) {
    const calls = [];
    assert.equal(await readBridgeManager(async data => {
      calls.push(data); return encoded(data === current ? address : manager);
    }), address);
    assert.deepEqual(calls, [current]);
  }
});

test('both getters failing or returning malformed data rejects the identity read', async () => {
  for (const response of [new Error('RPC unavailable'), '0x', `0x${'f'.repeat(64)}`]) {
    const calls = [];
    await assert.rejects(readBridgeManager(async data => {
      calls.push(data);
      if (response instanceof Error) throw response;
      return response;
    }), /RPC unavailable|Invalid bridge manager/);
    assert.deepEqual(calls, [current, legacy]);
  }
});
