import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFeeRates, formatGwei } from '../src/lib/treasury/feeDisplay.ts';

test('quoted fee rates show two gwei decimals with exact rounding', () => {
  assert.equal(formatGwei(0n), '0.00');
  assert.equal(formatGwei(1_234_999_999n), '1.23');
  assert.equal(formatGwei(1_235_000_000n), '1.24');
  assert.equal(formatGwei(999_995_000_000n), '1000.00');
  assert.equal(describeFeeRates({ price: '0x77359400', priority: '0x3b9aca00' }),
    'Max gas price: 2.00 gwei · Max priority fee: 1.00 gwei.');
  assert.equal(describeFeeRates({ price: '2000000000' }),
    'Gas price: 2.00 gwei · Max priority fee: Not applicable.');
});
