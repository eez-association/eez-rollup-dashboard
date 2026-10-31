import { BaseError, ContractFunctionRevertedError, decodeEventLog, encodeFunctionData, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { eezClient, type EezClient } from './eez.ts';
import type { ChainBinding, CodeBinding, CrossChainDeployment } from './crossChainDeployment.ts';
import { probeComposer } from '../composerDiscovery.ts';
import { l1ActionDigest, l1ControllerAbi, l1ControllerFactoryAbi, type SignedL1Action } from './l1Action.ts';

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const managerAbi = parseAbi([
  'function ROLLUP_ID() view returns (uint64)', 'function USE_GAS_LEFT() view returns (bool)',
  'function computeCrossChainProxyAddress(address originalAddress,uint64 originalRollupId) view returns (address)',
  'function authorizedProxies(address proxy) view returns (bool isProxy,address originalAddress,uint64 originalRollupId)',
]);
export type ControllerState = { controller: Address; nonce: bigint; timestamp: bigint };
export type Settlement = { l1BlockNumber: bigint; l1BlockHash: Hex; l1TransactionHash: Hex };
export class FalconTransactionReverted extends Error {
  readonly transactionHash: Hex;
  constructor(transactionHash: Hex) {
    super('Transaction reverted. Inspect its trace before trying again.');
    this.transactionHash = transactionHash;
  }
}

export async function checkChain(client: EezClient, chain: ChainBinding) {
  if (await client.getChainId() !== chain.chainId) throw new Error(`Select ${chain.chainName} in your wallet.`);
  if ((await client.getBlock({ blockNumber: chain.anchor.blockNumber })).hash !== chain.anchor.blockHash) throw new Error(`${chain.chainName} identity checkpoint does not match this deployment.`);
}
export async function checkCode(client: EezClient, binding: CodeBinding, label: string, blockNumber: bigint) {
  const code = await client.getCode({ address: binding.address, blockNumber });
  if (!code || keccak256(code) !== binding.runtimeCodeHash) throw new Error(`${label} bytecode does not match this deployment.`);
}

/** Discovery and subsequent requests use the same provider, pinned to this deployment. */
export async function controllerClient(provider: Pick<EthereumProvider, 'request'>, deployment: CrossChainDeployment, signal: AbortSignal) {
  const { l1, l2 } = deployment;
  const discovery = await probeComposer(provider, {
    l1ChainId: toHex(l1.chainId), l2ChainId: toHex(l2.chainId), registryAddress: l1.registry, l2Address: l2.manager,
  });
  if (discovery.status !== 'detected') throw new Error(`Select your configured EEZ Composer network in the wallet. ${discovery.detail}`);
  const client = eezClient(provider);
  await checkChain(client, l2);
  const blockNumber = await client.getBlockNumber();
  await checkCode(client, l2.verifier, 'Falcon verifier', blockNumber);
  await checkCode(client, l2.factory, 'L1 controller factory', blockNumber);
  const read = { address: l2.factory.address, abi: l1ControllerFactoryAbi, blockNumber } as const;
  const [verifier, manager, chain, rollupId, useGasLeft] = await Promise.all([
    client.readContract({ ...read, functionName: 'verifier' }), client.readContract({ ...read, functionName: 'eezL2' }),
    client.readContract({ ...read, functionName: 'l1ChainId' }),
    client.readContract({ address: l2.manager, abi: managerAbi, functionName: 'ROLLUP_ID', blockNumber }),
    client.readContract({ address: l2.manager, abi: managerAbi, functionName: 'USE_GAS_LEFT', blockNumber }),
  ]);
  if (!sameAddress(verifier, l2.verifier.address) || !sameAddress(manager, l2.manager) || chain !== BigInt(l1.chainId)
    || rollupId !== l2.rollupId || useGasLeft) throw new Error('Controller routing does not match the supported EEZ deployment.');
  signal.throwIfAborted();
  return client;
}

export async function loadL1Controller(client: EezClient, d: CrossChainDeployment, publicKey: Hex, signal: AbortSignal): Promise<ControllerState | null> {
  const block = await client.getBlock();
  const keyHash = keccak256(publicKey);
  const controller = await client.readContract({ address: d.l2.factory.address, abi: l1ControllerFactoryAbi, functionName: 'controllers', args: [keyHash], blockNumber: block.number });
  if (sameAddress(controller, zeroAddress)) return null;
  const read = { address: controller, abi: l1ControllerAbi, blockNumber: block.number } as const;
  const [authority, verifier, manager, chain, nonce] = await Promise.all([
    client.readContract({ ...read, functionName: 'publicKeyHash' }), client.readContract({ ...read, functionName: 'verifier' }),
    client.readContract({ ...read, functionName: 'eezL2' }), client.readContract({ ...read, functionName: 'l1ChainId' }),
    client.readContract({ ...read, functionName: 'nonce' }),
  ]);
  if (authority !== keyHash || !sameAddress(verifier, d.l2.verifier.address) || !sameAddress(manager, d.l2.manager) || chain !== BigInt(d.l1.chainId)) throw new Error('Controller authority does not match this key and deployment.');
  signal.throwIfAborted();
  return { controller, nonce, timestamp: block.timestamp };
}

export const createL1ControllerData = (publicKey: Hex) => encodeFunctionData({ abi: l1ControllerFactoryAbi, functionName: 'createController', args: [keccak256(publicKey)] });
export const l1CallArgs = (s: SignedL1Action) => [s.action.target, s.action.data, s.action.nonce, s.action.deadline, s.signature, s.publicKey] as const;
export const executeL1Data = (s: SignedL1Action) => encodeFunctionData({ abi: l1ControllerAbi, functionName: 'execute', args: l1CallArgs(s) });

export async function checkL1Authorization(client: EezClient, d: CrossChainDeployment, signed: SignedL1Action, signal: AbortSignal) {
  const a = signed.action;
  const state = await loadL1Controller(client, d, signed.publicKey, signal);
  if (!state || !sameAddress(state.controller, a.controller) || a.sourceChainId !== BigInt(d.l2.chainId)
    || a.destinationChainId !== BigInt(d.l1.chainId) || !sameAddress(a.eezL2, d.l2.manager)) throw new Error('Signed action belongs to a different controller or deployment.');
  const digest = await client.readContract({ address: a.controller, abi: l1ControllerAbi, functionName: 'checkAuthorization', args: l1CallArgs(signed) });
  if (digest !== l1ActionDigest(a)) throw new Error('Browser and controller authorization digests disagree.');
  return state;
}

export function l1CallResult(receipt: TransactionReceipt, signed: SignedL1Action, account: Address): Hex | null {
  if (receipt.status !== 'success' || !receipt.to || !sameAddress(receipt.to, signed.action.controller)) return null;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, signed.action.controller)) continue;
    try {
      const { args } = decodeEventLog({ abi: l1ControllerAbi, eventName: 'CallExecuted', data: log.data, topics: log.topics, strict: true });
      if (args.digest === l1ActionDigest(signed.action) && args.nonce === signed.action.nonce
        && sameAddress(args.target, signed.action.target) && sameAddress(args.relayer, account)
        && args.signatureHash === keccak256(signed.signature)) return args.result;
    } catch { /* Other logs cannot establish this authorization's result. */ }
  }
  return null;
}

export async function canonicalReceipt(client: EezClient, hash: Hex, signal: AbortSignal) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    let receipt: TransactionReceipt | undefined;
    try { receipt = await client.getTransactionReceipt({ hash }); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (receipt) {
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Receipt block is no longer canonical. Recheck the transaction.');
      if (receipt.status !== 'success') throw new FalconTransactionReverted(hash);
      return receipt;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error('Still waiting for inclusion. Keep the transaction hash and check again.');
}

/** Correlation is not execution evidence; the L1 receipt and Safe must still be checked. */
export function parseSettlement(value: unknown, source: TransactionReceipt): Settlement {
  const s = value as Record<string, unknown> | null;
  const hash = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
  if (!s || s.canonicalL2 !== true || !hash(s.l1BlockHash) || !hash(s.l1TransactionHash)
    || typeof s.l1BlockNumber !== 'string' || !/^0x[0-9a-f]+$/i.test(s.l1BlockNumber)
    || !Array.isArray(s.l2Blocks) || !s.l2Blocks.some(b => b && typeof b === 'object'
      && sameAddress(String(b.hash), source.blockHash) && BigInt(b.number) === source.blockNumber)) throw new Error('No canonical L1 settlement for this L2 receipt yet. Check again shortly.');
  return { l1BlockNumber: BigInt(s.l1BlockNumber), l1BlockHash: s.l1BlockHash, l1TransactionHash: s.l1TransactionHash };
}

export function invalidNonce(error: unknown, supplied: bigint): bigint | null {
  const cause = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError) : error;
  if (!(cause instanceof ContractFunctionRevertedError) || cause.data?.errorName !== 'InvalidNonce') return null;
  const args = cause.data.args as readonly bigint[] | undefined;
  return args?.[1] === supplied && args[0]! > supplied ? args[0]! : null;
}
