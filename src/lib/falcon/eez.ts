import { createPublicClient, custom, decodeEventLog, encodeFunctionData, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import { verifierAbi } from './verifierAbi.ts';

import { crossChainDeployment } from './crossChainDeployment.ts';

// Use the same checked deployment for the standalone verifier and the Safe flow.
export const EEZ = {
  chainId: crossChainDeployment.l2.chainId,
  chainName: crossChainDeployment.l2.chainName,
  explorer: crossChainDeployment.l2.explorer,
  genesisHash: crossChainDeployment.l2.anchor.blockHash,
  address: crossChainDeployment.l2.verifier.address,
  runtimeCodeHash: crossChainDeployment.l2.verifier.runtimeCodeHash,
} as const;

export const EEZ_CHAIN = {
  chainId: `0x${EEZ.chainId.toString(16)}`,
};

const inputs = [{ name: 'message', type: 'bytes' }, { name: 'signature', type: 'bytes' }, { name: 'publicKey', type: 'bytes' }] as const;
export const recordAbi = [
  { type: 'function', name: 'verifyAndRecord', stateMutability: 'nonpayable', inputs, outputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'event', name: 'SignatureVerified', inputs: [
    { name: 'submitter', type: 'address', indexed: true },
    { name: 'publicKeyHash', type: 'bytes32', indexed: true },
    { name: 'messageHash', type: 'bytes32', indexed: true },
    { name: 'signatureHash', type: 'bytes32', indexed: false },
  ] },
] as const;

export type PublicSample = { message: Hex; signature: Hex; publicKey: Hex };
export function recordData(sample: PublicSample) {
  return encodeFunctionData({ abi: recordAbi, functionName: 'verifyAndRecord', args: [sample.message, sample.signature, sample.publicKey] });
}

/** Every network read uses the selected wallet's configured endpoint. There is no HTTP fallback. */
export function eezClient(provider: Pick<EthereumProvider, 'request'>) {
  return createPublicClient({ ccipRead: false, transport: custom(provider, { retryCount: 0 }) });
}
export type EezClient = ReturnType<typeof eezClient>;

export async function checkDeployment(client: EezClient, signal: AbortSignal) {
  signal.throwIfAborted();
  if (await client.getChainId() !== EEZ.chainId) throw new Error('The RPC is on a different chain.');
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (genesis.hash !== EEZ.genesisHash) throw new Error('The devnet has changed. Update the verifier deployment.');
  const blockNumber = await client.getBlockNumber();
  const code = await client.getCode({ address: EEZ.address, blockNumber });
  if (!code || keccak256(code) !== EEZ.runtimeCodeHash) throw new Error('Verifier bytecode does not match the pinned deployment.');
  signal.throwIfAborted();
  return { client, blockNumber };
}

export async function simulateL2(client: EezClient, sample: PublicSample, signal: AbortSignal, account: Address) {
  const { blockNumber } = await checkDeployment(client, signal);
  const valid = await client.readContract({ address: EEZ.address, abi: verifierAbi, functionName: 'verify', args: [sample.message, sample.signature, sample.publicKey], blockNumber });
  if (!valid) return { valid, blockNumber, gas: null };
  const gas = await client.estimateGas({ account, to: EEZ.address, data: recordData(sample), blockNumber });
  return { valid, blockNumber, gas };
}

/** Receipt success alone is insufficient: require this verifier's event bound to all submitted inputs. */
export function verifiedReceipt(receipt: TransactionReceipt, sample: PublicSample, submitter: Address) {
  if (receipt.status !== 'success' || receipt.to?.toLowerCase() !== EEZ.address.toLowerCase()) return false;
  return receipt.logs.some(log => {
    if (log.address.toLowerCase() !== EEZ.address.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: recordAbi, eventName: 'SignatureVerified', data: log.data, topics: log.topics, strict: true });
      return event.args.submitter.toLowerCase() === submitter.toLowerCase()
        && event.args.publicKeyHash === keccak256(sample.publicKey)
        && event.args.messageHash === keccak256(sample.message)
        && event.args.signatureHash === keccak256(sample.signature);
    } catch { return false; }
  });
}

export async function waitForVerification(client: EezClient, hash: Hex, sample: PublicSample, submitter: Address, signal: AbortSignal) {
  await checkDeployment(client, signal);
  // An explicit bounded poll stops on unmount; a timeout leaves the submitted hash available for rechecking.
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    let receipt: TransactionReceipt | undefined;
    try { receipt = await client.getTransactionReceipt({ hash }); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error;
    }
    if (receipt) {
      if (receipt.status !== 'success') throw new Error('The L2 transaction reverted.');
      if (!verifiedReceipt(receipt, sample, submitter)) throw new Error('The receipt does not contain the expected Falcon verification event.');
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('The receipt block was reorganized. Check the transaction again.');
      return receipt;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error('Still waiting for an L2 receipt. Keep the transaction hash and check again.');
}
