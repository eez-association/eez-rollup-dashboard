// Read-only mocked wallet provider; no network access, signatures or broadcasts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionResult, toHex, stringToHex } from 'viem';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER, probeComposer, sameChainId } from '../src/lib/composerDiscovery.ts';

test('chain comparisons reject malformed provider values without throwing', () => {
  for (const value of [null, undefined, 'invalid', '', '0x', '10200', 10200, {}, '0xzz']) {
    assert.equal(sameChainId(value, '0x27d8'), false);
  }
  assert.equal(sameChainId('0x027D8', '0x27d8'), true);
  assert.equal(sameChainId('0x1', '0x27d8'), false);
  assert.equal(sameChainId('invalid', 'invalid'), false);
});

const registry = '0x' + '11'.repeat(20);
const l2 = '0x' + '22'.repeat(20);
const manager = '0x' + '33'.repeat(20);
const expected = { l1ChainId: '0x27d8', l2ChainId: '0xdd6d9', registryAddress: registry, l2Address: l2, rollupManagerAddress: manager };
const metadata = {
  version: '0.1.0', supportedNetworks: { eezL1: 10200, eezL2: 906969 },
  eezContracts: { eezRegistryAddress: registry, eezL2Address: l2, eezRollupManagerAddress: manager },
};
globalThis.fetch = () => { throw new Error('Discovery must use the selected wallet, not HTTP'); };

function wallet(options = {}) {
  const calls = [];
  let chainReads = 0;
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (options.error) throw new Error(options.error);
      if (request.method === 'eth_chainId') return ++chainReads === 2 && options.afterChain
        ? options.afterChain : options.chain || expected.l1ChainId;
      assert.equal(request.method, 'eth_call');
      assert.equal(request.params[0].to, COMPOSER_DISCOVERY_ADDRESS);
      assert.equal(request.params[1], 'latest');
      assert.deepEqual(Object.keys(request.params[0]).sort(), ['data', 'to']);
      assert.equal(request.params[0].data.slice(0, 10), '0x98da5085');
      if (options.hang) return new Promise(() => {});
      if (options.response !== undefined) return options.response;
      const nonce = '0x' + request.params[0].data.slice(10);
      let response = encodeFunctionResult({
        abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo',
        result: [options.marker || COMPOSER_DISCOVERY_MARKER, options.schema ?? 1n,
          options.nonce || nonce, options.source ?? BigInt(options.chain || expected.l1ChainId),
          options.bytes || stringToHex(options.json ?? JSON.stringify(options.info || metadata))],
      });
      if (options.uppercase) response = '0x' + response.slice(2).toUpperCase();
      return response;
    },
  };
}

test('both Composer fronts are detected through the selected provider', async () => {
  for (const chain of [expected.l1ChainId, expected.l2ChainId]) {
    const provider = wallet({ chain });
    const result = await probeComposer(provider, expected);
    assert.equal(result.status, 'detected');
    assert.equal(BigInt(result.chainId), BigInt(chain));
    assert.deepEqual(result.info, metadata);
    assert.deepEqual(provider.calls.map(c => c.method), ['eth_chainId', 'eth_call', 'eth_chainId']);
  }
});

test('fresh nonces bypass identical-parameter wallet caches', async () => {
  const provider = wallet();
  await probeComposer(provider, expected);
  await probeComposer(provider, expected);
  const calls = provider.calls.filter(c => c.method === 'eth_call');
  assert.notEqual(calls[0].params[0].data, calls[1].params[0].data);
});

test('empty responses mean not detected', async () => {
  const result = await probeComposer(wallet({ response: '0x' }), expected);
  assert.equal(result.status, 'not-detected');
  assert.equal(result.detail, 'The wallet read did not identify Composer.');
});

test('unsupported networks are not mislabeled as ordinary RPCs', async () => {
  const provider = wallet({ chain: '0x1' });
  assert.equal((await probeComposer(provider, expected)).status, 'unsupported-network');
  assert.equal(provider.calls.length, 1);
});

for (const [name, options] of [
  ['wrong marker', { marker: toHex(new Uint8Array(32)) }],
  ['unsupported schema', { schema: 2n }],
  ['stale nonce', { nonce: toHex(new Uint8Array(32)) }],
  ['malformed hex', { response: 'not hex' }],
  ['truncated ABI', { response: '0x01' }],
  ['oversized response', { response: '0x' + '00'.repeat(16385) }],
  ['invalid JSON', { json: '{' }],
  ['invalid UTF-8', { bytes: '0xff' }],
  ['invalid metadata', { info: [] }],
  ['unsafe network number', { info: { ...metadata, supportedNetworks: { eezL1: 2 ** 54, eezL2: 906969 } } }],
  ['missing required address', { info: { ...metadata, eezContracts: { eezL2Address: l2 } } }],
  ['invalid optional address', { info: { ...metadata, eezContracts: { ...metadata.eezContracts, eezL1BridgeSender: 'invalid' } } }],
  ['provider rejection', { error: 'Unauthorized provider' }],
  ['invalid wallet chain ID', { chain: 'invalid' }],
  ['chain changes mid-probe', { afterChain: expected.l2ChainId }],
]) {
  test(`${name} returns unable to verify, never a positive detection`, async () => {
    assert.equal((await probeComposer(wallet(options), expected)).status, 'unavailable');
  });
}

test('provider timeouts are bounded', async () => {
  const result = await probeComposer(wallet({ hang: true }), expected, 20);
  assert.equal(result.status, 'unavailable');
  assert.match(result.detail, /timed out/);
});

test('wrong front source ID is a network mismatch', async () => {
  assert.equal((await probeComposer(wallet({ source: 906969n }), expected)).status, 'mismatch');
});

test('wrong network pair is a mismatch even when its source chain matches', async () => {
  const info = { ...metadata, supportedNetworks: { eezL1: 10200, eezL2: 6291 } };
  const result = await probeComposer(wallet({ info }), expected);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /network pair/);
});

for (const [key, name] of [['eezRegistryAddress', 'L1 registry'], ['eezL2Address', 'L2 manager'], ['eezRollupManagerAddress', 'rollup manager']]) {
  test(`different ${name} deployment is rejected`, async () => {
    const info = { ...metadata, eezContracts: { ...metadata.eezContracts, [key]: '0x' + '99'.repeat(20) } };
    const result = await probeComposer(wallet({ info }), expected);
    assert.equal(result.status, 'mismatch');
    assert.ok(result.detail.includes(name));
  });
}

test('advertised bridge bindings are checked against configured bridges', async () => {
  const info = { ...metadata, eezContracts: { ...metadata.eezContracts, eezL1BridgeSender: registry, eezL2BridgeReceiver: l2 } };
  assert.equal((await probeComposer(wallet({ info }), { ...expected, l1BridgeAddress: registry, l2BridgeAddress: l2 })).status, 'detected');
  assert.equal((await probeComposer(wallet({ info }), { ...expected, l1BridgeAddress: l2 })).status, 'mismatch');
  assert.equal((await probeComposer(wallet({ info }), { ...expected, l2BridgeAddress: registry })).status, 'mismatch');
});

test('optional absent bindings and different hex casing are supported', async () => {
  const info = { ...metadata, eezContracts: { eezRegistryAddress: registry, eezL2Address: l2 } };
  assert.equal((await probeComposer(wallet({ info, uppercase: true }), expected)).status, 'detected');
});
