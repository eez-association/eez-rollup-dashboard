import { formatUnits, keccak256, parseUnits, serializeTransaction, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import type { EezClient } from './eez.ts';
import { nativeCurrency } from '../networkIdentity.ts';

// Frozen reference, not a live price feed. Provenance and model limits: docs/falcon/cost-comparison.md.
export const COST_REFERENCE = {
  timestamp: '2026-10-14T13:16:29Z',
  l1Gwei: '0.466277369', blobGwei: '0.022401805', ethUsd: '2466.255',
  directExecutionGas: [5_384_699n, 5_650_196n] as const,
  blobGas: 131_072n, blobCapacity: 126_976n,
  sharedFramingBytes: 38,
};
export type CostPrices = { l1Gwei: string; blobGwei: string; ethUsd: string };
export type ParsedCostPrices = { l1Wei: bigint; blobWei: bigint; usdMicros: bigint };
export type CalldataCost = { bytes: number; zeroBytes: number; gas: bigint; floorGas: bigint };
export type GasObservation = {
  hash: Hex; blockHash: Hex; gasUsed: bigint; gasPrice: bigint; calldata: CalldataCost;
};
export type SourceCost = GasObservation & { baseFeePerGas: bigint; serializedBytes: number; encodedBlobBytes: number };
export type SettlementCost = GasObservation & { blobGasUsed: bigint; blobGasPrice: bigint };
export type SafeCostEvidence = {
  sourceHash: Hex; source: SourceCost | null; settlement: SettlementCost | null; l1Verified?: boolean; problem?: string;
  receiptFee?: { gasUsed: bigint; gasPrice: bigint; l1GasPrice: bigint | null };
  settlementFee?: { gasUsed: bigint; gasPrice: bigint; blobGasUsed?: bigint; blobGasPrice?: bigint };
};

/** The complete wallet fee already includes EEZ settlement. Never add the batch fee again. */
export function simpleGasCosts(gasUsed: bigint, paidGasPrice: bigint, l1GasPrice: bigint | null) {
  if (gasUsed <= 0n || paidGasPrice < 0n || (l1GasPrice !== null && l1GasPrice < 0n)) throw new Error('Invalid gas cost inputs.');
  return { actualWei: gasUsed * paidGasPrice, withoutEezWei: l1GasPrice === null ? null : gasUsed * l1GasPrice };
}

/** L2 inherits the bridged L1 native asset; explicit ETH/xDAI metadata takes priority. */
export function gasToken(symbol: string, l1ChainId: number): 'ETH' | 'xDAI' {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === 'ETH') return 'ETH';
  if (normalized === 'XDAI') return 'xDAI';
  return nativeCurrency(String(l1ChainId)).symbol === 'xDAI' ? 'xDAI' : 'ETH';
}

export function nativeFeeCents(wei: bigint, usdPerTokenE8: bigint): string {
  if (wei < 0n || usdPerTokenE8 <= 0n) throw new Error('Invalid native-token cost inputs.');
  const cents = Number(formatUnits(wei * usdPerTokenE8, 24));
  if (cents > 0 && cents < 0.000001) return `${cents.toPrecision(3)}¢`;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: cents < 1 ? 6 : 2 }).format(cents)}¢`;
}

/** Keep distinct positive fees visible below one millionth of a dollar. */
export function formatCostUsd(wei: bigint, usdMicros: bigint) {
  const amount = Number(formatUnits(wei * usdMicros, 24));
  if (amount > 0 && amount < 0.000001) return `$${amount.toExponential(2)}`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: amount < 0.01 ? 6 : amount < 1 ? 4 : 2 }).format(amount);
}

export function calldataCost(data: Hex): CalldataCost {
  if (data.length > 2_097_154 || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error('Invalid transaction calldata.');
  const bytes = (data.length - 2) / 2;
  let zeroBytes = 0;
  for (let i = 2; i < data.length; i += 2) if (data.slice(i, i + 2) === '00') zeroBytes++;
  const tokens = BigInt(zeroBytes + 4 * (bytes - zeroBytes));
  return { bytes, zeroBytes, gas: 4n * tokens, floorGas: 21_000n + 10n * tokens };
}

function varintBytes(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0xffff_ffff) throw new Error('Unsupported encoded size.');
  let bytes = 1;
  while (size >= 128) { size = Math.floor(size / 128); bytes++; }
  return bytes;
}

/** One native Safe transfer: signed transaction, outbound CALL, bool return and closing marker.
 * The 38 shared carrier bytes are from the observed batch, not a measurement of this new batch.
 * No beacon endpoint is contacted from the browser; batching/metadata differences remain estimates.
 */
export function encodedSafeTransferBytes(signedTransactionBytes: number, safeCalldataBytes: number) {
  return COST_REFERENCE.sharedFramingBytes
    + 1 + 8 + varintBytes(signedTransactionBytes) + signedTransactionBytes
    + 1 + 8 + 20 + 20 + 32 + 8 + varintBytes(safeCalldataBytes) + safeCalldataBytes
    + 1 + 1 + 32 + 1;
}

export function serializedSourceTransaction(tx: Transaction): Hex {
  const base = { to: tx.to, nonce: tx.nonce, gas: tx.gas, value: tx.value, data: tx.input };
  const signature = { r: tx.r, s: tx.s, v: tx.v, yParity: tx.yParity };
  let raw: Hex;
  switch (tx.type) {
    case 'legacy': raw = serializeTransaction({ ...base, type: tx.type, chainId: tx.chainId, gasPrice: tx.gasPrice }, signature); break;
    case 'eip2930': raw = serializeTransaction({ ...base, type: tx.type, chainId: tx.chainId, gasPrice: tx.gasPrice, accessList: tx.accessList }, signature); break;
    case 'eip1559': raw = serializeTransaction({ ...base, type: tx.type, chainId: tx.chainId, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList }, signature); break;
    case 'eip7702': raw = serializeTransaction({ ...base, type: tx.type, chainId: tx.chainId, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList, authorizationList: tx.authorizationList }, signature); break;
    default: throw new Error('Source transaction type is not supported by the cost model.');
  }
  if (keccak256(raw).toLowerCase() !== tx.hash.toLowerCase()) throw new Error('Signed transaction does not match its hash.');
  return raw;
}

/** Call only after the workflow has verified the canonical receipt and operation-specific events. */
export async function observeGas(client: EezClient, receipt: TransactionReceipt, chainId: number, signal: AbortSignal) {
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  signal.throwIfAborted();
  if (receipt.status !== 'success' || tx.hash !== receipt.transactionHash || tx.blockHash !== receipt.blockHash
    || tx.blockNumber !== receipt.blockNumber || tx.to?.toLowerCase() !== receipt.to?.toLowerCase()
    || tx.from.toLowerCase() !== receipt.from.toLowerCase() || (tx.chainId !== undefined && tx.chainId !== chainId)) {
    throw new Error('Cost transaction does not match the verified receipt.');
  }
  const calldata = calldataCost(tx.input);
  if (typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed < 21_000n + calldata.gas
    || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n) throw new Error('Receipt has unusable gas data.');
  const observation: GasObservation = { hash: receipt.transactionHash, blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, calldata };
  return { tx, observation };
}

export async function observeSourceCost(client: EezClient, receipt: TransactionReceipt, chainId: number, expectedData: Hex, safeData: Hex, signal: AbortSignal): Promise<SourceCost> {
  const { tx, observation } = await observeGas(client, receipt, chainId, signal);
  if (tx.input.toLowerCase() !== expectedData.toLowerCase()) throw new Error('Cost calldata differs from the signed operation.');
  const block = await client.getBlock({ blockHash: receipt.blockHash });
  signal.throwIfAborted();
  if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber || typeof block.baseFeePerGas !== 'bigint'
    || block.baseFeePerGas < 0n || block.baseFeePerGas > observation.gasPrice) throw new Error('L2 block base fee is unavailable or inconsistent.');
  const serializedBytes = (serializedSourceTransaction(tx).length - 2) / 2;
  return { ...observation, baseFeePerGas: block.baseFeePerGas, serializedBytes, encodedBlobBytes: encodedSafeTransferBytes(serializedBytes, calldataCost(safeData).bytes) };
}

export async function observeSettlementCost(client: EezClient, receipt: TransactionReceipt, chainId: number, signal: AbortSignal): Promise<SettlementCost> {
  const { tx, observation } = await observeGas(client, receipt, chainId, signal);
  const blobGasUsed = receipt.blobGasUsed, blobGasPrice = receipt.blobGasPrice;
  if (tx.type !== 'eip4844' || typeof blobGasUsed !== 'bigint' || blobGasUsed <= 0n
    || blobGasUsed !== BigInt(tx.blobVersionedHashes.length) * COST_REFERENCE.blobGas
    || typeof blobGasPrice !== 'bigint' || blobGasPrice < 0n) throw new Error('Settlement blob fee data is unavailable.');
  return { ...observation, blobGasUsed, blobGasPrice };
}

export function parseCostPrices(input: CostPrices): ParsedCostPrices | null {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,9})?$/.test(input.l1Gwei)
    || !/^(0|[1-9]\d{0,8})(\.\d{1,9})?$/.test(input.blobGwei)
    || !/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(input.ethUsd)) return null;
  const usdMicros = parseUnits(input.ethUsd, 6);
  if (usdMicros === 0n) return null;
  return { l1Wei: parseUnits(input.l1Gwei, 9), blobWei: parseUnits(input.blobGwei, 9), usdMicros };
}

/** Capacity allocation at full utilization, rounded up to one wei. Never a standalone blob fee. */
export function proportionalBlobFee(encodedBytes: number, blobWei: bigint) {
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes <= 0 || blobWei < 0n) throw new Error('Invalid blob cost input.');
  const numerator = BigInt(encodedBytes) * COST_REFERENCE.blobGas * blobWei;
  return (numerator + COST_REFERENCE.blobCapacity - 1n) / COST_REFERENCE.blobCapacity;
}

export function estimateSafeCosts(source: SourceCost, settlement: SettlementCost | null, prices: ParsedCostPrices) {
  // Calldata is split out of receipt gas, never added on top. EIP-7623 is a total-gas floor.
  const directGas = COST_REFERENCE.directExecutionGas.map(execution => {
    const standard = 21_000n + source.calldata.gas + execution;
    return standard > source.calldata.floorGas ? standard : source.calldata.floorGas;
  });
  // Priority fees recover settlement; exclude them beside modeled L1 costs to avoid counting settlement twice.
  const l2Execution = (source.gasUsed - source.calldata.gas) * source.baseFeePerGas;
  const l2Calldata = source.calldata.gas * source.baseFeePerGas;
  const blob = proportionalBlobFee(source.encodedBlobBytes, prices.blobWei);
  return {
    directGas, ethereum: directGas.map(gas => gas * prices.l1Wei),
    ethereumExecution: directGas.map(gas => (gas - source.calldata.gas) * prices.l1Wei),
    ethereumCalldata: source.calldata.gas * prices.l1Wei,
    l2Execution, l2Calldata, l2Total: l2Execution + l2Calldata,
    paidL2: source.gasUsed * source.gasPrice,
    paidPriority: source.gasUsed * (source.gasPrice - source.baseFeePerGas),
    l1Execution: settlement ? (settlement.gasUsed - settlement.calldata.gas) * prices.l1Wei : null,
    l1Calldata: settlement ? settlement.calldata.gas * prices.l1Wei : null,
    blob: settlement ? blob : null,
    eezTotal: settlement ? l2Execution + l2Calldata + settlement.gasUsed * prices.l1Wei + blob : null,
  };
}
