import type { Intent, TreasuryClient } from './client.ts';

/** Providers can wrap EIP-1193's explicit rejection in an RPC/transport error.
 * A timeout or a generic send failure is never evidence of cancellation.
 */
export function walletRejected(error: unknown): boolean {
  const queue: unknown[] = [error], seen = new Set<unknown>();
  while (queue.length && seen.size < 32) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const entry = value as Record<string, unknown>;
    if (entry.code === 4001 || entry.code === '4001') return true;
    queue.push(entry.cause, entry.error, entry.data, entry.originalError);
  }
  return false;
}

/** Only used after the user explicitly confirms rejecting the wallet prompt.
 * Absence of a hash alone cannot establish cancellation: refuse cleanup if
 * tracking finds a transaction or either node observes a consumed/pending nonce.
 */
export async function checkCancelledSubmission(client: TreasuryClient, intent: Intent) {
  if (intent.hash) throw new Error('This transaction has a hash and must remain tracked.');
  const c = client.config;
  const transport = intent.submissionChain ?? (c.payments?.bridgeKind === 'standard' ? 'l1' : intent.payment?.source ?? 'l2');
  const chain = c[transport], source = intent.payment?.source ?? 'l2';
  const [, outcome, snapshot, ...nonces] = await Promise.all([
    client.validate(), client.outcome(intent), client.snapshot(source),
    client.rpc<string>(chain.rpc, 'eth_getTransactionCount', [intent.sender, 'latest']),
    client.rpc<string>(chain.rpc, 'eth_getTransactionCount', [intent.sender, 'pending']),
    client.rpc<string>(chain.front ?? chain.rpc, 'eth_getTransactionCount', [intent.sender, 'pending']),
  ]);
  if (outcome.hash || outcome.kind !== 'unknown' || snapshot.nonce !== BigInt(intent.nonce)
    || nonces.some(nonce => !/^0x[\da-f]+$/i.test(nonce) || BigInt(nonce) !== BigInt(intent.sourceNonce)))
    throw new Error('Transaction activity was detected. Keep this request tracked until its status is resolved.');
}
