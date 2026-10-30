import assert from 'node:assert/strict';
import test from 'node:test';
import { falconReadProvider } from '../../src/lib/falcon/readOnly.ts';

test('confirmation requests use the configured HTTP endpoint and reject wallet or send methods', async t => {
  const calls: { url: string; method: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); calls.push({ url, method: body.method });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }));
  });
  const rpc = falconReadProvider('https://example.invalid/composer/l2', new AbortController().signal, 'Testnet');
  await rpc.request({ method: 'eez_getSettlementByL2Block', params: ['0x1234'] });
  assert.deepEqual(calls, [{ url: 'https://example.invalid/composer/l2', method: 'eez_getSettlementByL2Block' }]);
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'wallet_switchEthereumChain']) {
    await assert.rejects(rpc.request({ method, params: [] }), /Only read-only/);
  }
  assert.equal(calls.length, 1);
});

test('unsupported confirmation methods are not reported as fee quote failures', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: -32601, message: 'Method not found' } })));
  const rpc = falconReadProvider('https://example.invalid/composer/l2', new AbortController().signal, 'Testnet');
  await assert.rejects(rpc.request({ method: 'eez_getSettlementByL2Block', params: ['0x1234'] }), /Testnet RPC does not support eez_getSettlementByL2Block/);
});
