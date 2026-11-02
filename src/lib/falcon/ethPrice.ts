import { parseUnits } from 'viem';

export const ETH_USD_PRICE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
export type EthUsdPrice = { usdPerEthE8: bigint; observedAt: number };

export function parseEthUsdPrice(body: unknown, observedAt = Date.now()): EthUsdPrice {
  const data = (body as { data?: { base?: unknown; currency?: unknown; amount?: unknown } } | null)?.data;
  if (data?.base !== 'ETH' || data.currency !== 'USD' || typeof data.amount !== 'string'
    || !/^(0|[1-9]\d{0,8})(\.\d{1,8})?$/.test(data.amount)) throw new Error('Invalid ETH/USD price response.');
  const usdPerEthE8 = parseUnits(data.amount, 8);
  if (usdPerEthE8 <= 0n) throw new Error('ETH/USD price must be positive.');
  return { usdPerEthE8, observedAt };
}

/** Public spot price only; no wallet address, signature or transaction is sent. */
export async function fetchEthUsdPrice(signal: AbortSignal, fetchImpl = fetch): Promise<EthUsdPrice> {
  const response = await fetchImpl(ETH_USD_PRICE_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (!response.ok) throw new Error('ETH/USD price is unavailable.');
  return parseEthUsdPrice(await response.json());
}
