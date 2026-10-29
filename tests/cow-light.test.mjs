import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimumOutput, sellAmount, requireFreshQuote, orderData, cowScope, displayAmount } from '../src/lib/cowLight.ts';

test('sell amounts retain wei precision and reject rounding or scientific notation', () => {
  assert.equal(sellAmount('9007199254740993.000000000000000001'), 9007199254740993000000000000000001n);
  for (const input of ['0', '-1', '1e-3', '0.0000000000000000001', 'NaN']) assert.throws(() => sellAmount(input));
});
test('changing slippage always derives the minimum from the original output', () => {
  assert.equal(minimumOutput('1000000000000000000', '3'), '970000000000000000');
  assert.equal(minimumOutput('1000000000000000000', '1'), '990000000000000000');
  for (const input of ['0', '20.01', '-1', '3.001']) assert.throws(() => minimumOutput('1000', input));
});
test('expired quotes cannot produce an order; live orders bind receiver and assets', () => {
  const cfg = { l1ChainId: 10200, l2ChainId: 916969, settlement: 'settlement', wethL2: 'sell', bridgeL2: 'bridge' };
  const q = { amountIn: '1000', amountOut: '10000', fetchedAt: Date.now() };
  assert.equal(orderData(cfg, q, 'buy', 'owner', '3').buyAmount, '9700');
  assert.equal(orderData(cfg, q, 'buy', 'owner', '3').receiver, 'owner');
  assert.throws(() => requireFreshQuote(q, q.fetchedAt + 60000));
  assert.throws(() => orderData(cfg, { ...q, fetchedAt: Date.now() - 60001 }, 'buy', 'owner', '3'));
  assert.notEqual(cowScope(cfg), cowScope({ ...cfg, bridgeL2: 'replacement' }));
  assert.equal(displayAmount('1234567', 6), '1.234567');
});
