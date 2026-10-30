import { keccak256, parseUnits, toHex, type Hex } from 'viem';
import { feeQuoteTransaction, requestFeeQuote, sendFeeQuotedTransaction } from '../fees/l2-fees.mjs';

import type { FeeIntent, FeeQuote, FeeTransaction, FeeType } from '../fees/l2-fees.mjs';
export type { FeeIntent, FeeQuote, FeeTransaction, FeeType } from '../fees/l2-fees.mjs';
export type FeeConfig = { url: string; maxTotalFee: bigint; nativeSymbol: string };
type QuoteSelection = { quote: FeeQuote; intent: FeeIntent; type: FeeType; chainId: Hex };
export type QuotedFee = QuoteSelection & { transaction: FeeTransaction };
type Reader = Pick<EthereumProvider, 'request'>;
export class FeeRpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;
  readonly feeCode: string | undefined;
  constructor(error: { code: number; message: string; data?: { code?: string; message?: string } }) {
    super(error.data?.message ?? error.message);
    this.rpcCode = error.code; this.data = error.data; this.feeCode = error.data?.code;
  }
}
export class FeeOptionError extends Error {
  readonly feeCode: string;
  constructor(error: { code: string; message: string }) {
    super(error.message); this.feeCode = error.code;
  }
}
export class StaleFeeQuote extends Error {}
/** A wallet transport failure is not evidence that the transaction was rejected. */
export class UnknownFeeSubmission extends Error {}

export function parseFeeLimit(value: string) {
  if (!/^(0|[1-9]\d{0,59})(\.\d{1,18})?$/.test(value)) throw new Error('Invalid maximum fee: use a positive decimal with at most 18 decimal places.');
  const limit = parseUnits(value, 18);
  if (limit <= 0n || limit >= 2n ** 256n) throw new Error('Maximum fee is outside the supported range.');
  return limit;
}

export function walletQuantity(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value)) return BigInt(value);
  throw new Error('Invalid wallet quantity.');
}
export function errorCode(error: unknown): string | number | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const e = error as { feeCode?: string; code?: number; data?: { code?: string }; cause?: unknown };
    if (e.feeCode || typeof e.data?.code === 'string') return e.feeCode ?? e.data!.code;
    if (error instanceof FeeRpcError && [-32601, -32602].includes(error.rpcCode)) return error.rpcCode;
    if (e.code === 4001 || e.code === -32601 || e.code === -32602) return e.code;
    error = e.cause;
  }
}
export function feeErrorMessage(error: unknown) {
  const code = errorCode(error);
  const messages: Record<string, string> = {
    '-32601': 'Fee quotes are unavailable at this endpoint. Configure the Composer L2 quote URL.',
    starting_up: 'Composer is starting. Try estimating the fee again shortly.',
    stale_context: 'The settlement context changed. Request a fresh fee estimate.',
    quote_busy: 'Composer is quoting another transaction. Try again shortly.',
    quote_unavailable: 'A settlement fee is not available yet. Try estimating again shortly.',
    quote_timeout: 'Settlement estimation timed out. Try again shortly.',
    l2_tip_underfunded: 'Settlement fee no longer covers this call. Review and send again to request a fresh quote.',
    invalid_transaction: 'Composer rejected the transaction. No transaction was sent.',
    unsupported_transaction: 'This call is not supported by the fee estimator. No transaction was sent.',
    insufficient_funds: 'The L2 gas wallet cannot cover the transaction and maximum fee. No transaction was sent.',
    poster_insufficient_funds: 'Composer cannot fund L1 settlement. The operator needs to restore its posting balance.',
    quote_limit: 'This call exceeds a fee-estimation limit. No transaction was sent.',
    quotes_disabled: 'Settlement fee quotes are disabled. No transaction was sent.',
  };
  return code !== undefined && messages[String(code)] ? `${messages[String(code)]} (${code})` : null;
}
function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Only documented read-only failures are retried. Never use around wallet submission. */
export async function retryFeeRead<T>(read: () => Promise<T>, signal: AbortSignal, codes = ['starting_up', 'stale_context', 'quote_busy', 'quote_unavailable', 'quote_timeout']) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      if (attempt >= 2 || !codes.includes(String(errorCode(error)))) throw error;
      await pause(250 * (attempt + 1), signal);
    }
  }
}

const hashText = (text: string) => keccak256(toHex(text));
export const feeQuoteExpired = (quote: FeeQuote, now = Date.now()) =>
  typeof quote.expiresAt === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(quote.expiresAt) && BigInt(quote.expiresAt) * 1000n <= BigInt(now);

function selectedOption(quote: FeeQuote, type: FeeType) {
  const option = quote.options.find(option => option.type === type);
  if (!option) throw new Error('The requested fee option is unavailable.');
  if ('error' in option) {
    if (!option.error || typeof option.error.code !== 'string' || typeof option.error.message !== 'string') throw new Error('Invalid fee option error.');
    throw new FeeOptionError(option.error);
  }
  return option;
}
function validateQuote(selection: QuoteSelection, config: FeeConfig) {
  if (feeQuoteExpired(selection.quote)) throw new StaleFeeQuote('Fee quote expired. Request a fresh estimate.');
  const { quote, intent, type, chainId } = selection;
  return feeQuoteTransaction({ quote, transaction: intent, type, chainId, keccak256: hashText, maxTotalFee: config.maxTotalFee });
}

/** Composer resolves omitted gas/nonce. This is the only direct HTTP RPC; the wallet owns reads and broadcasts. */
export async function fetchFeeQuote(intent: FeeIntent, config: FeeConfig, selection: { chainId: number; type: FeeType }, signal: AbortSignal, fetchImpl = globalThis.fetch): Promise<QuotedFee> {
  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetchImpl(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const body = await response.json();
    if (!body || body.jsonrpc !== '2.0' || body.id !== 1) throw new Error('Invalid fee quote RPC response.');
    if (body.error) throw new FeeRpcError(body.error);
    if (!response.ok || !body.result) throw new Error('Invalid fee quote RPC response.');
    return body.result;
  };
  const quote = await retryFeeRead(() => requestFeeQuote({ rpc, transaction: intent, transactionTypes: [selection.type] }), signal);
  signal.throwIfAborted();
  selectedOption(quote, selection.type);
  const quoted = { quote, intent, type: selection.type, chainId: toHex(selection.chainId) };
  return { ...quoted, transaction: validateQuote(quoted, config) };
}

export function feeAmounts({ quote, transaction, type }: QuotedFee) {
  const option = selectedOption(quote, type);
  const cap = BigInt(type === '0x0' ? transaction.gasPrice! : transaction.maxFeePerGas!);
  return { estimated: BigInt(option.estimatedFee), maximum: BigInt(transaction.gas) * cap };
}

export async function submitFeeQuote({ quoted, config, wallet, isCurrent, send }: {
  quoted: QuotedFee; config: FeeConfig; wallet: Reader; isCurrent: () => boolean;
  send: (tx: FeeTransaction, validate: () => void) => Promise<Hex>;
}): Promise<Hex> {
  const { quote, intent, type, chainId } = quoted;
  const validate = () => {
    if (!isCurrent()) throw new Error('Signature, key or fee options changed. Review and try again.');
    return validateQuote({ quote, intent, type, chainId }, config);
  };
  const transaction = validate();
  const balance = walletQuantity(await wallet.request({ method: 'eth_getBalance', params: [transaction.from, 'pending'] }));
  if (balance < BigInt(transaction.value) + feeAmounts({ ...quoted, transaction }).maximum) throw new Error(`Insufficient ${config.nativeSymbol} in your L2 gas wallet for the maximum fee.`);
  let prompted = false;
  try {
    return await sendFeeQuotedTransaction({ quote, transaction: intent, type, chainId, keccak256: hashText, maxTotalFee: config.maxTotalFee,
      wallet: { request: async args => {
        if (args.method === 'eth_sendTransaction') {
          validate();
          return send(args.params![0] as FeeTransaction, () => { validate(); prompted = true; });
        }
        const result = await wallet.request(args);
        validate();
        if (args.method === 'eth_accounts' && (!Array.isArray(result) || String(result[0]).toLowerCase() !== intent.from.toLowerCase())) throw new Error('Wallet account changed. Review and try again.');
        if (args.method === 'eth_getTransactionCount' && walletQuantity(result) !== BigInt(transaction.nonce)) throw new StaleFeeQuote('Wallet nonce changed. Request a fresh estimate.');
        return result;
      } },
    }) as Hex;
  } catch (error) {
    if (!prompted && feeQuoteExpired(quote) && isCurrent()) throw new StaleFeeQuote('Fee quote expired. Request a fresh estimate.');
    throw error;
  }
}

/** Use only a user-supplied wallet hash to reconcile an ambiguous broadcast; never resubmit it. */
export async function recoverFeeTransaction(wallet: Reader, hash: string, intent: Required<FeeIntent>): Promise<Hex> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter the transaction hash from your wallet activity.');
  const tx = await wallet.request({ method: 'eth_getTransactionByHash', params: [hash] }) as Record<string, unknown> | null;
  if (!tx) throw new Error('Transaction not found yet. Check the hash and try the lookup again.');
  for (const field of ['from', 'to', 'data'] as const) {
    if (String(tx[field === 'data' ? 'input' : field]).toLowerCase() !== intent[field].toLowerCase()) throw new Error('Transaction does not match the submitted Safe call.');
  }
  for (const field of ['chainId', 'nonce', 'value'] as const) if (walletQuantity(tx[field]) !== BigInt(intent[field])) throw new Error('Transaction does not match the submitted Safe call.');
  return hash as Hex;
}
