import { toHex, type Hex } from 'viem';
import type { EezClient } from './eez.ts';
import { matchesRecoveryTransaction, type RecoveryAttempt } from './recoveryJournal.ts';

/** Recover a missing wallet reply using the exact recorded sender/nonce. Absence is never cancellation evidence. */
export async function findRecoveryByNonce(client: EezClient, provider: Pick<EthereumProvider, 'request'>, attempt: RecoveryAttempt, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await provider.request({ method: 'eth_getTransactionBySenderAndNonce', params: [attempt.account, toHex(BigInt(attempt.nonce))] });
  signal.throwIfAborted();
  if (result === null) return null;
  const hash = (result as { hash?: unknown } | undefined)?.hash;
  if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Sender/nonce lookup returned an invalid transaction.');
  const normalized = hash.toLowerCase() as Hex;
  return { hash: normalized, outcome: await checkRecoveryOutcome(client, attempt, normalized, signal) };
}

/** A different payload can resolve an attempt only after the same sender/nonce is canonically mined. */
export async function checkRecoveryOutcome(client: EezClient, attempt: RecoveryAttempt, hash: Hex, signal: AbortSignal): Promise<'matching' | 'replaced'> {
  signal.throwIfAborted();
  if (await client.getChainId() !== attempt.chainId) throw new Error('Recovery RPC serves a different chain.');
  const tx = await client.getTransaction({ hash });
  signal.throwIfAborted();
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || tx.from.toLowerCase() !== attempt.account.toLowerCase()
    || BigInt(tx.nonce) !== BigInt(attempt.nonce) || tx.chainId !== undefined && tx.chainId !== attempt.chainId) {
    throw new Error('This transaction does not match the recorded sender, nonce and network.');
  }
  if (matchesRecoveryTransaction(tx, attempt)) return 'matching';
  if (tx.blockNumber === null || tx.blockHash === null) throw new Error('The replacement or cancellation must be mined before clearing the original request.');
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.from.toLowerCase() !== attempt.account.toLowerCase()
    || receipt.blockNumber !== tx.blockNumber || receipt.blockHash !== tx.blockHash
    || (receipt.status !== 'success' && receipt.status !== 'reverted')) throw new Error('Replacement inclusion could not be verified.');
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  signal.throwIfAborted();
  if (block.hash !== receipt.blockHash) throw new Error('The replacement block changed. Check again before clearing the request.');
  // Even a reverted replacement consumes the sender's nonce. It is not success for the original intent.
  return 'replaced';
}

/** These checks detect known activity; the user must also attest that all wallet prompts were cancelled. */
export async function checkNoObservedSubmission(client: EezClient, attempt: RecoveryAttempt, signal: AbortSignal) {
  signal.throwIfAborted();
  if (attempt.hash) throw new Error('A transaction hash is already recorded. Recover or cancel that transaction instead.');
  if (await client.getChainId() !== attempt.chainId) throw new Error('Recovery RPC serves a different chain.');
  const block = await client.getBlock({ blockTag: 'latest' });
  const [mined, pending] = await Promise.all([
    client.getTransactionCount({ address: attempt.account, blockNumber: block.number }),
    client.getTransactionCount({ address: attempt.account, blockTag: 'pending' }),
  ]);
  if (BigInt(mined) !== BigInt(attempt.nonce) || BigInt(pending) !== BigInt(attempt.nonce)) {
    throw new Error('This nonce has pending or mined activity, or earlier requests are unresolved. Recover its transaction hash or wait; the saved request was kept.');
  }
  const again = await client.getBlock({ blockNumber: block.number });
  signal.throwIfAborted();
  if (again.hash !== block.hash) throw new Error('Network state changed during the check. Try again.');
}
