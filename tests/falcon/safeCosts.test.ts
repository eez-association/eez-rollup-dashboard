import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatTransaction, type Hex, type RpcTransaction, type Transaction, type TransactionReceipt } from 'viem';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
import { calldataCost, COST_REFERENCE, encodedSafeTransferBytes, estimateSafeCosts, formatCostUsd, observeGas, observeSettlementCost, observeSourceCost, parseCostPrices, proportionalBlobFee, serializedSourceTransaction } from '../../src/lib/falcon/safeCosts.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/safe-costs.json', import.meta.url), 'utf8'));
const sourceTx = formatTransaction(fixture.source as RpcTransaction);
const settlementTx = formatTransaction(fixture.settlement as RpcTransaction);
const client = (tx: Transaction) => ({ getTransaction: async () => tx, getBlock: async () => ({ hash: tx.blockHash, number: tx.blockNumber, baseFeePerGas: 49n }) }) as unknown as EezClient;
const signal = () => new AbortController().signal;
function receipt(tx: Transaction, settlement = false): TransactionReceipt {
  return {
    transactionHash: tx.hash, blockHash: tx.blockHash!, blockNumber: tx.blockNumber!,
    from: tx.from, to: tx.to, status: 'success',
    gasUsed: BigInt(settlement ? fixture.expected.settlementGasUsed : fixture.expected.sourceGasUsed),
    effectiveGasPrice: BigInt(settlement ? fixture.expected.settlementGasPrice : fixture.expected.sourceGasPrice),
    ...(settlement ? { blobGasUsed: 131_072n, blobGasPrice: 1_000_000_000n } : {}),
  } as TransactionReceipt;
}
const source = () => observeSourceCost(client(sourceTx), receipt(sourceTx), 906969, sourceTx.input, `0x${'01'.repeat(484)}`, signal());
const settlement = () => observeSettlementCost(client(settlementTx), receipt(settlementTx, true), 10200, signal());

test('Small nonzero fees remain distinct instead of sharing a display threshold', () => {
  const price = 2_466_255_000n;
  assert.equal(formatCostUsd(5_972_975n, price), '$1.47e-8');
  assert.equal(formatCostUsd(29_344n, price), '$7.24e-11');
  assert.equal(formatCostUsd(0n, price), '$0.00');
  assert.equal(formatCostUsd(1n, 1n), '$1.00e-24');
  assert.equal(formatCostUsd(1_000_000_000_000n, 1_000_000n), '$0.000001');
  assert.equal(formatCostUsd(999_999_999_999n, 1_000_000n), '$1.00e-6');
  assert.equal(formatCostUsd(2_536_000_000_000_000n, price), '$6.25');
});

test('Public transaction bytes reproduce independently counted calldata and retrieved blob sizes', async () => {
  assert.deepEqual(calldataCost(sourceTx.input), { bytes: 2404, zeroBytes: 767, gas: 29260n, floorGas: 94150n });
  assert.deepEqual(calldataCost(settlementTx.input), { bytes: 2980, zeroBytes: 2539, gas: 17212n, floorGas: 64030n });
  assert.equal((serializedSourceTransaction(sourceTx).length - 2) / 2, 2521);
  assert.equal(encodedSafeTransferBytes(2521, 484), 3180);
  const observed = await source();
  assert.equal(observed.encodedBlobBytes, 3180);
  assert.equal(observed.serializedBytes, 2521);
  for (const bad of ['0x0', '0xzz', '1234']) assert.throws(() => calldataCost(bad as Hex), /Invalid transaction calldata/);
});

test('Cost totals separate calldata, use fractional blob capacity, and preserve pending L1', async () => {
  const s = await source(), l1 = await settlement(), prices = parseCostPrices(COST_REFERENCE)!;
  const pending = estimateSafeCosts(s, null, prices);
  assert.equal(pending.eezTotal, null); assert.equal(pending.blob, null);
  assert.equal(pending.l2Total, s.gasUsed * 49n);
  assert.equal(pending.paidL2, 5_728_321_674_009n);
  assert.equal(pending.paidPriority + pending.l2Total, pending.paidL2);
  const result = estimateSafeCosts(s, l1, prices);
  assert.equal(result.blob, 73_535_731_510n);
  assert.equal(result.eezTotal, 111_207_586_886_921n - result.paidPriority);
  assert.equal(result.eezTotal, result.l2Execution + result.l2Calldata + result.l1Execution! + result.l1Calldata! + result.blob!);
  assert.equal(result.ethereum[0], (5_384_699n + 21_000n + 29_260n) * 466_277_369n);
  assert.equal(result.ethereum[1], (5_650_196n + 21_000n + 29_260n) * 466_277_369n);
  const dataHeavy = estimateSafeCosts({ ...s, calldata: calldataCost(`0x${'ff'.repeat(300_000)}`) }, null, prices);
  assert.equal(dataHeavy.directGas[0], 12_021_000n, 'EIP-7623 floor is a maximum, not an added calldata surcharge');
});

test('Blob allocation uses the 31-byte field packing capacity, not the physical blob size', () => {
  assert.equal(proportionalBlobFee(126976, 22401805n), 2_936_249_384_960n);
  assert.equal(proportionalBlobFee(253952, 22401805n), 2n * 2_936_249_384_960n);
  assert.equal(proportionalBlobFee(1563, 22401805n), 36_143_505_771n);
  assert.equal(proportionalBlobFee(3180, 0n), 0n);
  for (const size of [0, -1, 1.5, Infinity]) assert.throws(() => proportionalBlobFee(size, 1n));
  assert.throws(() => proportionalBlobFee(1, -1n));
});

test('Collected priority fees change the wallet bill, not the modeled L1 resource total', async () => {
  const s = await source(), l1 = await settlement(), prices = parseCostPrices(COST_REFERENCE)!;
  const before = estimateSafeCosts(s, l1, prices), after = estimateSafeCosts({ ...s, gasPrice: s.gasPrice + 1_000_000n }, l1, prices);
  assert.equal(after.eezTotal, before.eezTotal);
  assert.equal(after.paidL2 - before.paidL2, s.gasUsed * 1_000_000n);
  assert.equal(after.paidPriority - before.paidPriority, after.paidL2 - before.paidL2);
});

test('Base fees must come from the verified source block and cannot exceed the receipt price', async () => {
  const r = receipt(sourceTx);
  for (const patch of [{ hash: '0x00' }, { number: 1n }, { baseFeePerGas: undefined }, { baseFeePerGas: -1n }, { baseFeePerGas: r.effectiveGasPrice + 1n }]) {
    const c = { ...client(sourceTx), getBlock: async () => ({ hash: r.blockHash, number: r.blockNumber, baseFeePerGas: 49n, ...patch }) } as unknown as EezClient;
    await assert.rejects(observeSourceCost(c, r, 906969, sourceTx.input, '0x', signal()), /base fee is unavailable or inconsistent/);
  }
});

test('Price inputs reject rounding, empty, negative, exponential and nonfinite values', () => {
  assert.deepEqual(parseCostPrices(COST_REFERENCE), { l1Wei: 466_277_369n, blobWei: 22_401_805n, usdMicros: 2_466_255_000n });
  for (const value of ['', '-1', '1e2', 'Infinity', 'NaN', '.1', '01', ' 1', '0.0000000001']) {
    assert.equal(parseCostPrices({ ...COST_REFERENCE, l1Gwei: value }), null, value);
    assert.equal(parseCostPrices({ ...COST_REFERENCE, blobGwei: value }), null, value);
  }
  for (const value of ['0', '', '-1', '1e3', '1.0000001']) assert.equal(parseCostPrices({ ...COST_REFERENCE, ethUsd: value }), null);
  assert.equal(parseCostPrices({ ...COST_REFERENCE, l1Gwei: '0', blobGwei: '0' })?.l1Wei, 0n);
});

test('Receipt-bound observations reject mismatched chain, block, hash, sender, target and gas', async () => {
  const r = receipt(sourceTx);
  for (const patch of [{ blockHash: `0x${'11'.repeat(32)}` }, { hash: `0x${'22'.repeat(32)}` }, { blockNumber: 1n }, { chainId: 1 }, { from: settlementTx.to }, { to: sourceTx.from }]) {
    await assert.rejects(observeGas(client({ ...sourceTx, ...patch } as Transaction), r, 906969, signal()), /does not match the verified receipt/);
  }
  for (const patch of [{ gasUsed: 1n }, { effectiveGasPrice: -1n }, { effectiveGasPrice: undefined }]) {
    await assert.rejects(observeGas(client(sourceTx), { ...r, ...patch } as TransactionReceipt, 906969, signal()), /unusable gas data/);
  }
  await assert.rejects(observeGas(client(sourceTx), { ...r, status: 'reverted' }, 906969, signal()), /does not match/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(observeGas(client(sourceTx), r, 906969, abort.signal), { name: 'AbortError' });
});

test('Source bytes must match both signed input and canonical transaction hash', async () => {
  await assert.rejects(observeSourceCost(client(sourceTx), receipt(sourceTx), 906969, '0x1234', '0x', signal()), /differs from the signed operation/);
  assert.throws(() => serializedSourceTransaction({ ...sourceTx, nonce: sourceTx.nonce + 1 }), /does not match its hash/);
  assert.throws(() => serializedSourceTransaction(settlementTx), /not supported by the cost model/);
});

test('Missing or inconsistent blob receipt data never becomes a zero-cost blob', async () => {
  const r = receipt(settlementTx, true);
  assert.equal((await settlement()).blobGasUsed, 131072n);
  for (const patch of [{ blobGasUsed: undefined }, { blobGasUsed: 0n }, { blobGasUsed: 262144n }, { blobGasPrice: undefined }, { blobGasPrice: -1n }]) {
    await assert.rejects(observeSettlementCost(client(settlementTx), { ...r, ...patch }, 10200, signal()), /blob fee data is unavailable/);
  }
});
