import assert from 'node:assert/strict';
import test from 'node:test';
import { ETH_USD_PRICE_URL, fetchEthUsdPrice, parseEthUsdPrice } from '../../src/lib/falcon/ethPrice.ts';

test('ETH/USD quote parsing preserves decimal precision and rejects wrong pairs and invalid prices', () => {
  const body = { data: { base: 'ETH', currency: 'USD', amount: '2237.905' } };
  assert.deepEqual(parseEthUsdPrice(body, 123), { usdPerEthE8: 223790500000n, observedAt: 123 });
  for (const patch of [{base:'BTC'}, {currency:'EUR'}, {amount:'0'}, {amount:'-1'}, {amount:'NaN'}, {amount:2000}, {amount:'1e3'}, {amount:'1.000000001'}]) {
    assert.throws(() => parseEthUsdPrice({ data: { ...body.data, ...patch } }));
  }
});

test('public price lookup omits credentials and wallet data; failures do not invent a rate', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, ETH_USD_PRICE_URL); assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer'); assert.equal(options?.body, undefined);
    return new Response(JSON.stringify({ data: { base:'ETH', currency:'USD', amount:'2000' } }));
  };
  assert.equal((await fetchEthUsdPrice(new AbortController().signal, fetcher)).usdPerEthE8, 200000000000n);
  await assert.rejects(fetchEthUsdPrice(new AbortController().signal, async () => new Response('', { status: 503 })), /unavailable/);
});
