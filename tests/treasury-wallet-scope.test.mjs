import test from 'node:test';
import assert from 'node:assert/strict';
import { guardWalletRequests } from '../src/lib/treasury/walletRequestScope.ts';

test('wallet request guards prevent stale prompts while preserving already-open responses and provider identity behavior', async () => {
  let active = true, calls = 0, release;
  const provider = { isMetaMask: true, request() { assert.equal(this, provider); calls++; return new Promise(resolve => { release = resolve; }); },
    on() { assert.equal(this, provider); }, removeListener() {} };
  const guarded = guardWalletRequests(provider, () => { if (!active) throw Error('Screen changed'); });
  assert.equal(guarded.isMetaMask, true); guarded.on('test', () => {});
  const response = guarded.request({ method: 'eth_sendTransaction', params: [{}] });
  active = false; release('recorded transaction hash');
  assert.equal(await response, 'recorded transaction hash');
  assert.throws(() => guarded.request({ method: 'eth_signTypedData_v4' }), /Screen changed/);
  assert.equal(calls, 1);
});
test('frozen wallet providers retain their method receiver and discovery flags', async () => {
  const provider = Object.freeze({ isMetaMask: true, request() { assert.equal(this, provider); return Promise.resolve('0x27d8'); }, on() {}, removeListener() {} });
  const guarded = guardWalletRequests(provider, () => {});
  assert.equal(await guarded.request({ method: 'eth_chainId' }), '0x27d8'); assert.equal(guarded.isMetaMask, true);
});
