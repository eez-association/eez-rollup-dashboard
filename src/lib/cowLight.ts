import { formatUnits, parseUnits } from 'viem';
export interface CowConfig {
  network: string; l1ChainId: number; l2ChainId: number; settlement: string; vaultRelayer: string;
  wethL1: string; wethL2: string; bridgeL2: string; nativeWethL2: string | null; l2NativeSymbol: string;
}
export interface CowToken { address: string; symbol: string; name: string; decimals: number; pair: string; wethReserve?: string | null }
export function catalogWethReserve(token: CowToken): bigint | null {
  return token.wethReserve != null && /^\d+$/.test(token.wethReserve) ? BigInt(token.wethReserve) : null;
}
export function hasMinimumWethReserve(token: CowToken): boolean {
  const reserve = catalogWethReserve(token);
  // Missing catalog data is unknown, not a zero-liquidity pool.
  return reserve === null || reserve >= 10_000_000_000_000_000n;
}
export interface CowQuote { amountIn: string; amountOut: string; tokenDecimals: number; tokenSymbol: string; priceImpactBps: number; block: number; pair: string; fetchedAt: number }
export interface CowOrder {
  id: string; signer: string; status: string; signature?: string; receivedAt: number;
  order: { sellAmount: string; buyAmount: string; receiver?: string }; quote?: { tokenSymbol: string; tokenDecimals: number };
  solverDebug?: { state?: string; txHash?: string; settlement?: string; l1Tx?: string; message?: string; error?: unknown; settlementBlock?: number; l1Block?: number };
}
export function swapOutcome(order: CowOrder): 'settled' | 'pending' | 'failed' | 'expired' {
  const state = order.solverDebug?.state || order.status;
  return state === 'settled' ? 'settled' : state === 'expired' ? 'expired'
    : ['failed', 'reverted', 'rejected'].includes(state) ? 'failed' : 'pending';
}
export function nativeWrapIsSellAsset(cfg: CowConfig) {
  return cfg.l2NativeSymbol === 'ETH' && !!cfg.nativeWethL2 && cfg.nativeWethL2.toLowerCase() === cfg.wethL2.toLowerCase();
}
export const orderTypes = { Order: [
  { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
] };
export function sellAmount(value: string) {
  if (!/^\d+(\.\d{1,18})?$/.test(value) || parseUnits(value, 18) <= 0n) throw new Error('Enter a positive amount with at most 18 decimals.');
  return parseUnits(value, 18);
}
export function minimumOutput(output: string, slippage: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(slippage)) throw new Error('Enter slippage between 0.01% and 20%, with at most two decimals.');
  const bps = parseUnits(slippage, 2);
  if (bps < 1n || bps > 2000n) throw new Error('Slippage must be between 0.01% and 20%.');
  return (BigInt(output) * (10000n - bps) / 10000n).toString();
}
export function requireFreshQuote(quote: CowQuote, now = Date.now()) {
  if (now - quote.fetchedAt >= 60000) throw new Error('Quote expired. Request a fresh quote before signing.');
}
export function orderData(cfg: CowConfig, quote: CowQuote, buyToken: string, receiver: string, slippage: string) {
  requireFreshQuote(quote);
  return { sellToken: cfg.wethL2, buyToken, receiver, sellAmount: quote.amountIn,
    buyAmount: minimumOutput(quote.amountOut, slippage), validTo: Math.floor(Date.now() / 1000) + 1800,
    appData: `0x${'00'.repeat(32)}`, feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
}
export function cowScope(cfg: CowConfig) {
  return [cfg.l1ChainId, cfg.l2ChainId, cfg.settlement, cfg.bridgeL2, cfg.wethL2].join(':').toLowerCase();
}
export function displayAmount(value: string, decimals = 18) {
  const [whole, fraction] = formatUnits(BigInt(value), decimals).split('.');
  const trimmed = fraction?.slice(0, 6).replace(/0+$/, '');
  return whole + (trimmed ? `.${trimmed}` : '');
}
