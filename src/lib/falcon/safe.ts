import { decodeAbiParameters, decodeEventLog, encodeFunctionData, getAddress, isAddress, maxUint256, pad, parseAbi, parseUnits, zeroAddress, zeroHash, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { EezClient } from './eez.ts';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import { canonicalReceipt, checkChain, checkCode, managerAbi, sameAddress, type Settlement } from './l1Controller.ts';

export const safeFactoryAbi = parseAbi([
  'function singleton() view returns (address)', 'function fallbackHandler() view returns (address)',
  'function safes(address owner) view returns (address)', 'function createSafe() returns (address)',
  'event SafeCreated(address indexed owner,address indexed safe)',
]);
export const safeAbi = parseAbi([
  'function VERSION() view returns (string)', 'function masterCopy() view returns (address)',
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)', 'event ExecutionFailure(bytes32 indexed txHash,uint256 payment)',
  'event SafeMultiSigTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures,bytes additionalInfo)',
]);
const sentinel = '0x0000000000000000000000000000000000000001' as Address;
const guardSlot = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8' as Hex;
const fallbackSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5' as Hex;
export type RemoteSafe = { owner: Address; target: Address | null; nonce: bigint | null; balance: bigint | null };
export type SafeOperation = { kind: 'create' } | {
  kind: 'transfer'; target: Address; owner: Address; recipient: Address; value: bigint; data?: Hex; safeNonce: bigint; safeTxHash: Hex;
};

/** Safe v=1 approval is authenticated by its caller. These public bytes alone grant no authority. */
export function safeOwnerApproval(owner: Address): Hex {
  if (!isAddress(owner) || sameAddress(owner, zeroAddress)) throw new Error('Invalid Safe owner.');
  return `${pad(owner, { size: 32 })}${zeroHash.slice(2)}01` as Hex;
}
/** CALL only, no gas refund. Safe 1.4.1 then reverts GS013 on inner failure instead of returning false. */
export const safeCallFields = (to: Address, value: bigint, data: Hex = '0x') => [to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
export function safeCallData(owner: Address, to: Address, value: bigint, data: Hex = '0x') {
  return encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [...safeCallFields(to, value, data), safeOwnerApproval(owner)] });
}
export function parseSafeTransfer(recipient: string, amount: string): { recipient: Address; value: bigint } {
  if (!isAddress(recipient) || sameAddress(recipient, zeroAddress)) throw new Error('Enter a valid, nonzero recipient address.');
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amount)) throw new Error('Enter an amount with at most 18 decimal places.');
  const value = parseUnits(amount, 18);
  if (value <= 0n || value > maxUint256) throw new Error('Transfer amount must be positive and fit uint256.');
  return { recipient: getAddress(recipient), value };
}
export function parseSafeData(input: string): Hex {
  const data = input.trim() || '0x';
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error('Data must be complete hexadecimal bytes starting with 0x.');
  if (data.length > 2 + 60 * 1024 * 2) throw new Error('Transaction data exceeds 60 KiB.');
  return data.toLowerCase() as Hex;
}
export function parseSafeTransaction(recipient: string, amount: string, input = ''): { recipient: Address; value: bigint; data: Hex } {
  const data = parseSafeData(input);
  if (data === '0x') return { ...parseSafeTransfer(recipient, amount), data };
  if (!isAddress(recipient) || sameAddress(recipient, zeroAddress)) throw new Error('Enter a valid, nonzero recipient address.');
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amount)) throw new Error('Enter an amount with at most 18 decimal places.');
  const value = parseUnits(amount, 18);
  if (value > maxUint256) throw new Error('Transaction amount must fit uint256.');
  return { recipient: getAddress(recipient), value, data };
}
export function safeOperationCall(d: CrossChainDeployment, op: SafeOperation) {
  if (!d.l1.safe) throw new Error('Safe deployment has not been configured.');
  return op.kind === 'create'
    ? { target: d.l1.safe.factory.address, data: encodeFunctionData({ abi: safeFactoryAbi, functionName: 'createSafe' }) }
    : { target: op.target, data: safeCallData(op.owner, op.recipient, op.value, op.data ?? '0x') };
}

export async function loadRemoteSafe(client: EezClient, d: CrossChainDeployment, controller: Address, signal: AbortSignal, atBlock?: bigint): Promise<RemoteSafe> {
  const cfg = d.l1.safe;
  if (!cfg) throw new Error('Safe deployment has not been configured.');
  await checkChain(client, d.l1);
  const blockNumber = atBlock ?? await client.getBlockNumber();
  await Promise.all([
    checkCode(client, cfg.factory, 'Safe factory', blockNumber), checkCode(client, cfg.singleton, 'Safe implementation', blockNumber),
    checkCode(client, cfg.fallbackHandler, 'Safe fallback handler', blockNumber),
  ]);
  const factory = { address: cfg.factory.address, abi: safeFactoryAbi, blockNumber } as const;
  const [singleton, handler, owner] = await Promise.all([
    client.readContract({ ...factory, functionName: 'singleton' }), client.readContract({ ...factory, functionName: 'fallbackHandler' }),
    client.readContract({ address: d.l1.registry, abi: managerAbi, functionName: 'computeCrossChainProxyAddress', args: [controller, d.l2.rollupId], blockNumber }),
  ]);
  if (!sameAddress(singleton, cfg.singleton.address) || !sameAddress(handler, cfg.fallbackHandler.address)) throw new Error('Safe factory configuration does not match this deployment.');
  const target = await client.readContract({ ...factory, functionName: 'safes', args: [owner] });
  signal.throwIfAborted();
  if (sameAddress(target, zeroAddress)) return { owner, target: null, nonce: null, balance: null };
  await checkCode(client, { address: target, runtimeCodeHash: cfg.proxyRuntimeCodeHash }, 'Safe proxy', blockNumber);
  const read = { address: target, abi: safeAbi, blockNumber } as const;
  const [implementation, version, owners, threshold, nonce, balance, modules, guard, fallback, proxy] = await Promise.all([
    client.readContract({ ...read, functionName: 'masterCopy' }), client.readContract({ ...read, functionName: 'VERSION' }),
    client.readContract({ ...read, functionName: 'getOwners' }), client.readContract({ ...read, functionName: 'getThreshold' }),
    client.readContract({ ...read, functionName: 'nonce' }), client.getBalance({ address: target, blockNumber }),
    client.readContract({ ...read, functionName: 'getModulesPaginated', args: [sentinel, 1n] }),
    client.getStorageAt({ address: target, slot: guardSlot, blockNumber }), client.getStorageAt({ address: target, slot: fallbackSlot, blockNumber }),
    client.readContract({ address: d.l1.registry, abi: managerAbi, functionName: 'authorizedProxies', args: [owner], blockNumber }),
  ]);
  if (!sameAddress(implementation, singleton) || version !== cfg.version || owners.length !== 1 || !sameAddress(owners[0]!, owner) || threshold !== 1n
    || modules[0].length !== 0 || !sameAddress(modules[1], sentinel) || guard !== zeroHash || fallback?.toLowerCase() !== pad(handler, { size: 32 }).toLowerCase()
    || !proxy[0] || !sameAddress(proxy[1], controller) || proxy[2] !== d.l2.rollupId) throw new Error('Safe authority or configuration changed. This demo requires the controller proxy as sole owner, with no modules or guard.');
  signal.throwIfAborted();
  return { owner, target, nonce, balance };
}

export async function prepareSafeTransfer(client: EezClient, d: CrossChainDeployment, controller: Address, recipient: Address, value: bigint, signal: AbortSignal, input: Hex = '0x'): Promise<SafeOperation> {
  const data = parseSafeData(input);
  const blockNumber = await client.getBlockNumber();
  const remote = await loadRemoteSafe(client, d, controller, signal, blockNumber);
  if (!remote.target || remote.nonce === null || remote.balance === null) throw new Error('Create your Safe first.');
  if (sameAddress(recipient, remote.target)) throw new Error('Choose a recipient other than this Safe.');
  if (remote.balance < value) throw new Error('Safe balance is too low. Fund this Safe on L1, then reload.');
  const safeTxHash = await client.readContract({ address: remote.target, abi: safeAbi, functionName: 'getTransactionHash', args: [...safeCallFields(recipient, value, data), remote.nonce], blockNumber });
  signal.throwIfAborted();
  return { kind: 'transfer', target: remote.target, owner: remote.owner, recipient, value, data, safeNonce: remote.nonce, safeTxHash };
}

export function safeCallResult(op: SafeOperation, result: Hex): Address | true {
  if (result.length !== 66) throw new Error('Safe call returned an unexpected result encoding.');
  if (op.kind === 'create') {
    const target = decodeAbiParameters([{ type: 'address' }], result)[0];
    if (sameAddress(target, zeroAddress)) throw new Error('Safe factory returned the zero address.');
    return target;
  }
  if (result.toLowerCase() !== pad('0x01', { size: 32 })) throw new Error('Safe did not report successful execution.');
  return true;
}

/** Require both Safe success and its exact emitted operation; a settlement receipt alone is insufficient. */
export function hasSafeExecution(receipt: TransactionReceipt, op: Extract<SafeOperation, { kind: 'transfer' }>) {
  let success = false, transaction = false;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, op.target)) continue;
    try {
      const event = decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === 'ExecutionFailure' && event.args.txHash === op.safeTxHash) return false;
      if (event.eventName === 'ExecutionSuccess' && event.args.txHash === op.safeTxHash && event.args.payment === 0n) success = true;
      if (event.eventName === 'SafeMultiSigTransaction') {
        const a = event.args;
        if (a.additionalInfo.length !== 194) continue;
        const [nonce, sender, threshold] = decodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], a.additionalInfo);
        transaction = transaction || (sameAddress(a.to, op.recipient) && a.value === op.value && a.data.toLowerCase() === (op.data ?? '0x').toLowerCase() && a.operation === 0
          && a.safeTxGas === 0n && a.baseGas === 0n && a.gasPrice === 0n && sameAddress(a.gasToken, zeroAddress) && sameAddress(a.refundReceiver, zeroAddress)
          && a.signatures.toLowerCase() === safeOwnerApproval(op.owner).toLowerCase() && nonce === op.safeNonce && sameAddress(sender, op.owner) && threshold === 1n);
      }
    } catch { /* An unrelated or malformed event cannot prove execution. */ }
  }
  return success && transaction;
}

export async function verifySafeL1Execution(client: EezClient, d: CrossChainDeployment, controller: Address, op: SafeOperation, result: Hex, settlement: Settlement, signal: AbortSignal) {
  await checkChain(client, d.l1);
  const receipt = await canonicalReceipt(client, settlement.l1TransactionHash, signal);
  if (!sameAddress(receipt.to ?? '', d.l1.registry) || receipt.blockHash !== settlement.l1BlockHash || receipt.blockNumber !== settlement.l1BlockNumber) throw new Error('L1 receipt does not match the expected settlement.');
  const decoded = safeCallResult(op, result);
  const remote = await loadRemoteSafe(client, d, controller, signal, receipt.blockNumber);
  if (!remote.target) throw new Error('Safe not found at the L1 settlement block.');
  if (op.kind === 'create') {
    if (!sameAddress(remote.target, decoded as Address)) throw new Error('Safe address differs from the source result.');
  } else if (!sameAddress(remote.target, op.target) || !sameAddress(remote.owner, op.owner) || remote.nonce === null
    || remote.nonce <= op.safeNonce || !hasSafeExecution(receipt, op)) throw new Error('L1 settlement has no matching successful Safe transaction and consumed nonce.');
  return { remote, receipt };
}
