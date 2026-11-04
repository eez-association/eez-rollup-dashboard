import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeAmountError, nativeBridgeLimit } from '../src/lib/bridgeLimits.ts';

test('Ethereum mainnet permits 0.1 ETH and smaller amounts, with exact decimal boundaries', () => {
  for (const chain of ['0x1', '1']) {
    assert.equal(nativeBridgeLimit(chain, 'eth'), 100_000_000_000_000_000n);
    for (const amount of ['', '0', '0.01', '0.099999999999999999', '0.1', '.1', '00.100000000000000000000']) {
      assert.equal(bridgeAmountError(chain, 'eth', amount), null, amount);
    }
    for (const amount of ['0.100000000000000001', '0.100000000000000000001', '.11', '0.2', '1', '100']) {
      assert.equal(bridgeAmountError(chain, 'eth', amount), 'Only 0.1 ETH or less is allowed.', amount);
    }
  }
});

test('ERC-20 tokens and native assets on other L1 networks remain unrestricted', () => {
  assert.equal(nativeBridgeLimit('0x1', 'erc20'), null);
  assert.equal(bridgeAmountError('0x1', 'erc20', '1000'), null);
  for (const chain of ['0x64', '0x27d8', '0xaa36a7', '0x539']) {
    assert.equal(nativeBridgeLimit(chain, 'eth'), null);
    assert.equal(bridgeAmountError(chain, 'eth', '1000'), null);
  }
});

test('malformed mainnet ETH amounts are rejected without relying on the input filter', () => {
  for (const amount of ['.', 'abc', '1e-2', '0x1', '-0.1', '+0.1', '0.1.0', ' 0.1', '0.1 ', 'NaN', 'Infinity']) {
    assert.equal(bridgeAmountError('0x1', 'eth', amount), 'Enter a valid ETH amount.', amount);
  }
});
