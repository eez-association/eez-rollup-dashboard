import { encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { EezClient } from './eez.ts';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import { canonicalReceipt, checkChain, sameAddress } from './l1Controller.ts';
import { controllerOwner, inspectExistingSafe, loadRemoteSafe, safeAbi, safeFactoryAbi, safeCallFields, type SafeAttachment } from './safe.ts';
import { buildSafeTransaction, safeTransactionHash } from '../treasury/safeTransactions.ts';
import { ownerFingerprint } from '../treasury/safeSetup.ts';
import { decodeSafeExecution } from '../treasury/safeEvents.ts';
import { loadMainnetManifest, type SetupNetwork } from '../treasury/mainnetSetup.ts';
import { checkRecoveryOutcome, findRecoveryByNonce } from './recoveryChecks.ts';
import { matchesRecoveryTransaction, recoveryKey, type RecoveryAttempt } from './recoveryJournal.ts';

const adminAbi = parseAbi(['function addOwnerWithThreshold(address owner,uint256 threshold)']);
export class SafeSelectionConflict extends Error {}
export const attachmentKey = (d: CrossChainDeployment, publicKey: Hex) => `${recoveryKey(d, 'owner')}:safe:${publicKey.toLowerCase()}`;
export function readAttachment(storage: Pick<Storage, 'getItem'>, key: string): SafeAttachment | undefined {
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  const value = JSON.parse(raw) as SafeAttachment;
  if (!value || !isAddress(value.target) || BigInt(value.target) <= 1n
    || value.walletOwner !== undefined && !isAddress(value.walletOwner)) throw new Error('Saved Falcon Safe address is invalid.');
  return { target: getAddress(value.target), ...(value.walletOwner ? { walletOwner: getAddress(value.walletOwner) } : {}) };
}
/** Caller holds the attachment Web Lock. A second tab must not silently replace
 * the Safe selected for this controller after a different owner change confirms. */
export function saveAttachment(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, next: SafeAttachment, expectedRaw?: string | null) {
  const current = readAttachment(storage, key);
  const same = current && sameAddress(current.target, next.target) && (current.walletOwner ?? '').toLowerCase() === (next.walletOwner ?? '').toLowerCase();
  if (!same && (expectedRaw !== undefined ? storage.getItem(key) !== expectedRaw : !!current)) {
    throw new SafeSelectionConflict('Another Safe was selected for this Falcon key. The confirmed owner transaction remains saved for review.');
  }
  storage.setItem(key, JSON.stringify(next));
}
/** Under the same selection lock, return to on-chain factory discovery. */
export function selectFactorySafe(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, expectedRaw?: string | null) {
  const current = storage.getItem(key);
  if (current === null) return;
  if (current !== expectedRaw) throw new SafeSelectionConflict('Another Safe was selected. Review the current selection before switching.');
  storage.removeItem(key);
}
/** No wallet-owner signature is needed when the selected controller already has authority.
 * Returns null when the owner-addition flow must review the address instead; a result
 * without `attachment` is the factory Safe, which is selected by clearing the saved selection. */
export async function inspectSafeSelection(client: EezClient, d: CrossChainDeployment, controller: Address, target: Address, signal: AbortSignal) {
  const [, block] = await Promise.all([checkChain(client, d.l1), client.getBlockNumber()]);
  // This first read is only a route hint. Existing authority is accepted only
  // after loadRemoteSafe validates implementation, threshold and proxy binding.
  // A failed hint (EOA, non-Safe contract, RPC error) falls back to the owner-addition
  // review, which reports a readable reason.
  const [owner, owners] = await Promise.all([
    controllerOwner(client, d, controller, block),
    client.readContract({ address: target, abi: safeAbi, functionName: 'getOwners', blockNumber: block }).catch(() => null),
  ]);
  signal.throwIfAborted();
  if (!owners?.some(existing => sameAddress(existing, owner))) return null;
  // Identify the factory's recorded address before validating its Safe. Never
  // reinterpret failed factory validation as permission to use external rules.
  const cfg = d.l1.safe;
  if (!cfg) throw new Error('Safe deployment has not been configured.');
  const code = await client.getCode({ address: cfg.factory.address, blockNumber: block });
  if ((!code || code === '0x') && d.walletSetup) {
    return loadRemoteSafe(client, d, controller, signal, block, { target });
  }
  if (!code || keccak256(code) !== cfg.factory.runtimeCodeHash) throw new Error('Safe factory bytecode does not match this deployment.');
  const factoryTarget = await client.readContract({ address: cfg.factory.address, abi: safeFactoryAbi,
    functionName: 'safes', args: [owner], blockNumber: block });
  signal.throwIfAborted();
  if (sameAddress(factoryTarget, target)) return loadRemoteSafe(client, d, controller, signal, block);
  return loadRemoteSafe(client, d, controller, signal, block, { target });
}
/** A completed, matching Treasury is an address suggestion, never an authorization. */
export function treasurySafeSuggestion(storage: Pick<Storage, 'getItem' | 'key' | 'length'>, d: CrossChainDeployment): string {
  const candidates = new Set<string>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !(key.startsWith('eez:treasury:discovered:') && key.endsWith(':network') || key.startsWith('eez:treasury:network-selection:'))) continue;
    try {
      const network = JSON.parse(storage.getItem(key) ?? 'null') as SetupNetwork;
      if (network.chains.l1.chainId !== d.l1.chainId || network.chains.l2.chainId !== d.l2.chainId
        || !sameAddress(network.registry, d.l1.registry) || !sameAddress(network.manager, d.l2.manager)) continue;
      const manifest = loadMainnetManifest(storage, network);
      if (manifest && isAddress(manifest.safeL1) && isAddress(manifest.safeL2)) candidates.add(getAddress(manifest.safeL1));
    } catch { /* An incomplete or unrelated Treasury must not select a Safe. */ }
  }
  return candidates.size === 1 ? [...candidates][0]! : '';
}
export function ownerTransaction(d: CrossChainDeployment, safe: Address, owner: Address, nonce: bigint) {
  return buildSafeTransaction({ chainId: BigInt(d.l1.chainId), safe, to: safe, nonce,
    data: encodeFunctionData({ abi: adminAbi, functionName: 'addOwnerWithThreshold', args: [owner, 1n] }) });
}
export async function prepareOwnerAddition(client: EezClient, d: CrossChainDeployment, controller: Address, target: Address, account: Address, signal: AbortSignal) {
  signal.throwIfAborted();
  const [, safe] = await Promise.all([
    checkChain(client, d.l1), inspectExistingSafe(client, target, signal),
  ]);
  if (safe.threshold !== 1) throw new Error('Adding Falcon requires a Safe with threshold 1. This flow cannot collect multiple owner approvals.');
  if (!safe.signableOwners.some(owner => sameAddress(owner, account))) throw new Error('Connect a signing wallet that is already an owner of this Safe.');
  // Inspection is bounded to 50 owners, including the owner about to be added.
  if (safe.owners.length >= 50) throw new Error('This setup supports at most 50 owners after adding Falcon.');
  const owner = await controllerOwner(client, d, controller, BigInt(safe.block));
  if (BigInt(owner) <= 1n || sameAddress(owner, account) || sameAddress(owner, target)) throw new Error('Invalid Falcon owner proxy.');
  if (safe.owners.some(existing => sameAddress(existing, owner))) throw new Error('This Falcon controller is already an owner of the Safe.');
  const transaction = ownerTransaction(d, target, owner, BigInt(safe.nonce));
  const hash = await client.readContract({ address: target, abi: safeAbi, functionName: 'getTransactionHash',
    args: [...safeCallFields(target, 0n, transaction.message.data), BigInt(safe.nonce)], blockNumber: BigInt(safe.block) });
  if (hash !== safeTransactionHash(transaction)) throw new Error('Safe transaction hash does not match the reviewed owner change.');
  signal.throwIfAborted();
  // Enabled modules can change owners without consuming the Safe transaction nonce.
  return { transaction, owner, ownerFingerprint: ownerFingerprint(safe.owners, safe.threshold) };
}
export async function verifyOwnerAddition(client: EezClient, d: CrossChainDeployment, attempt: RecoveryAttempt, signal: AbortSignal) {
  if (attempt.kind !== 'owner' || attempt.chainId !== d.l1.chainId || !attempt.controller || !attempt.hash || attempt.safeNonce === undefined) throw new Error('Owner recovery belongs to a different deployment.');
  await checkChain(client, d.l1);
  // An unrelated reverted transaction must never clear this pending request.
  const submitted = await client.getTransaction({ hash: attempt.hash });
  if (!sameAddress(submitted.hash, attempt.hash) || !matchesRecoveryTransaction(submitted, attempt)) throw new Error('Owner transaction does not match the saved request.');
  const receipt = await canonicalReceipt(client, attempt.hash, signal);
  const tx = await client.getTransaction({ hash: attempt.hash });
  if (!sameAddress(receipt.transactionHash, attempt.hash) || !sameAddress(tx.hash, attempt.hash)
    || !matchesRecoveryTransaction(tx, attempt) || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber
    || !sameAddress(receipt.from, attempt.account) || !sameAddress(receipt.to ?? '', attempt.to)) throw new Error('Owner transaction does not match the saved request.');
  const attachment = { target: attempt.to, walletOwner: attempt.account };
  const remote = await loadRemoteSafe(client, d, attempt.controller, signal, receipt.blockNumber, attachment);
  const transaction = ownerTransaction(d, attempt.to, remote.owner, BigInt(attempt.safeNonce));
  const hash = safeTransactionHash(transaction);
  // Another Safe transaction may execute later in the same block. Its nonce
  // must not hide this operation's exact success event.
  if (remote.nonce === null || remote.nonce <= BigInt(attempt.safeNonce) || !receipt.logs.some(log => {
    const event = sameAddress(log.address, attempt.to) ? decodeSafeExecution(log) : undefined;
    return event?.eventName === 'ExecutionSuccess' && event.args.txHash === hash && event.args.payment === 0n;
  })) throw new Error('The receipt does not confirm this Safe owner addition.');
  const again = await canonicalReceipt(client, attempt.hash, signal);
  if (again.blockHash !== receipt.blockHash) throw new Error('Owner transaction confirmation changed.');
  return attachment;
}


/** Recover on RPCs whose sender/nonce extension searches unavailable genesis state.
 * Canonical nonce history identifies a block; only the exact transaction and
 * receipt can establish success or a mined replacement. Never infer failure
 * from an absent hash, and never submit a transaction from this path.
 */
export async function findOwnerRecovery(client: EezClient, provider: Pick<EthereumProvider, 'request'>, attempt: RecoveryAttempt, signal: AbortSignal) {
  if (attempt.kind !== 'owner' || await client.getChainId() !== attempt.chainId) throw new Error('Owner recovery RPC serves a different chain.');
  try {
    const found = await findRecoveryByNonce(client, provider, attempt, signal);
    if (found) return found;
  } catch { signal.throwIfAborted(); /* Use canonical recent history if the extension is unavailable. */ }
  const head = await client.getBlock({ blockTag: 'latest' });
  signal.throwIfAborted();
  if (head.number === null || !head.hash) throw new Error('Canonical L1 history is unavailable.');
  const nonce = BigInt(attempt.nonce);
  const nonceAt = async (blockNumber: bigint) => {
    signal.throwIfAborted();
    const result = await client.getTransactionCount({ address: attempt.account, blockNumber });
    signal.throwIfAborted();
    return BigInt(result);
  };
  let high = head.number;
  if (await nonceAt(high) <= nonce) return null;
  let low = attempt.startBlock !== undefined ? BigInt(attempt.startBlock) : high > 8192n ? high - 8192n : 0n;
  if (low > high) throw new Error('L1 is behind this owner request. Waiting for network history.');
  if (low > 0n) low--;
  let before: bigint;
  try { before = await nonceAt(low); }
  catch (error) {
    signal.throwIfAborted();
    const earliest = /earliest available (\d+)/i.exec(error instanceof Error ? error.message : '');
    if (!earliest || BigInt(earliest[1]!) <= low || BigInt(earliest[1]!) > high) throw error;
    low = BigInt(earliest[1]!);
    before = await nonceAt(low);
  }
  if (before > nonce) throw new Error('This owner transaction is older than the available L1 history. Its pending record is preserved.');
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (await nonceAt(middle) > nonce) high = middle; else low = middle;
  }
  const block = await client.getBlock({ blockNumber: high, includeTransactions: true });
  if (block.number !== high || !block.hash) throw new Error('Owner transaction block is unavailable.');
  const tx = block.transactions.find(tx => typeof tx !== 'string' && sameAddress(tx.from, attempt.account) && BigInt(tx.nonce) === nonce);
  if (!tx || typeof tx === 'string') throw new Error('Owner transaction history is incomplete. Checking again.');
  const again = await client.getBlock({ blockNumber: head.number });
  signal.throwIfAborted();
  if (again.hash !== head.hash) throw new Error('L1 history changed during owner recovery. Checking again.');
  return { hash: tx.hash, outcome: await checkRecoveryOutcome(client, attempt, tx.hash, signal) };
}
