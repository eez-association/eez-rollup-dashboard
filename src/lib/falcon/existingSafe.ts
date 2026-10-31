import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from 'viem';
import type { EezClient } from './eez.ts';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import { canonicalReceipt, checkChain, sameAddress } from './l1Controller.ts';
import { controllerOwner, inspectExistingSafe, loadRemoteSafe, safeAbi, safeCallFields, type SafeAttachment } from './safe.ts';
import { buildSafeTransaction, safeTransactionHash } from '../treasury/safeTransactions.ts';
import { decodeSafeExecution } from '../treasury/safeEvents.ts';
import { loadMainnetManifest, type SetupNetwork } from '../treasury/mainnetSetup.ts';
import { matchesRecoveryTransaction, recoveryKey, type RecoveryAttempt } from './recoveryJournal.ts';

const adminAbi = parseAbi(['function addOwnerWithThreshold(address owner,uint256 threshold)']);
export const attachmentKey = (d: CrossChainDeployment, publicKey: Hex) => `${recoveryKey(d, 'owner')}:safe:${publicKey.toLowerCase()}`;
export function readAttachment(storage: Pick<Storage, 'getItem'>, key: string): SafeAttachment | undefined {
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  const value = JSON.parse(raw) as SafeAttachment;
  if (!value || !isAddress(value.target) || !isAddress(value.walletOwner)) throw new Error('Saved Falcon Safe address is invalid.');
  return { target: getAddress(value.target), walletOwner: getAddress(value.walletOwner) };
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
  await checkChain(client, d.l1);
  const safe = await inspectExistingSafe(client, target, signal);
  if (safe.threshold !== 1 || safe.owners.length !== 1 || !sameAddress(safe.owners[0]!, account)
    || !safe.signableOwners.some(owner => sameAddress(owner, account))) {
    throw new Error('Only a 1-of-1 Safe owned by the connected wallet is supported.');
  }
  const owner = await controllerOwner(client, d, controller, BigInt(safe.block));
  if (BigInt(owner) <= 1n || sameAddress(owner, account) || sameAddress(owner, target)) throw new Error('Invalid Falcon owner proxy.');
  const transaction = ownerTransaction(d, target, owner, BigInt(safe.nonce));
  const hash = await client.readContract({ address: target, abi: safeAbi, functionName: 'getTransactionHash',
    args: [...safeCallFields(target, 0n, transaction.message.data), BigInt(safe.nonce)], blockNumber: BigInt(safe.block) });
  if (hash !== safeTransactionHash(transaction)) throw new Error('Safe transaction hash does not match the reviewed owner change.');
  signal.throwIfAborted();
  return { transaction, owner };
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
