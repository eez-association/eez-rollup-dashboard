import assert from 'node:assert/strict';
import test from 'node:test';
import { walletSetupRequest } from '../src/lib/walletSetupRequest.ts';

test('a stalled identity read times out without retrying the provider', async () => {
  let calls = 0;
  const provider = { request: () => { calls++; return new Promise(() => {}); } };
  await assert.rejects(walletSetupRequest(provider, { method: 'eth_chainId' }, new AbortController().signal, 5), /Wallet RPC timed out/);
  assert.equal(calls, 1);
});

test('invalidating setup stops waiting for an old prompt and ignores its late failure', async () => {
  let rejectOld;
  let calls = 0;
  const provider = { request: () => { calls++; return new Promise((_, reject) => { rejectOld = reject; }); } };
  const abort = new AbortController();
  const pending = walletSetupRequest(provider, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }, abort.signal);
  await Promise.resolve();
  const reason = new Error('Selected wallet changed');
  abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
  rejectOld(new Error('Old wallet closed'));
  assert.equal(calls, 1);
  assert.equal(await walletSetupRequest({ request: async () => '0x27d8' }, { method: 'eth_chainId' }, new AbortController().signal, 50), '0x27d8');
});

test('already-invalidated setup cannot open another wallet prompt', async () => {
  const abort = new AbortController(); abort.abort();
  let called = false;
  await assert.rejects(walletSetupRequest({ request: async () => { called = true; } }, { method: 'wallet_addEthereumChain' }, abort.signal));
  assert.equal(called, false);
});
