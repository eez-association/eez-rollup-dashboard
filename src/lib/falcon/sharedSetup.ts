import { keccak256, type Hex } from 'viem';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import type { EezClient } from './eez.ts';
import { checkChain, checkCode, canonicalReceipt, FalconTransactionReverted, managerAbi, sameAddress } from './l1Controller.ts';
import { sharedSetupPlan, type SetupContract } from './sharedSetupPlan.ts';
import { matchingDeployer, matchingDeployerHash } from '../treasury/matchingSafes.ts';
import type { RecoveryAttempt } from './recoveryJournal.ts';
import { checkRecoveryOutcome } from './recoveryChecks.ts';

export type SetupStatus = SetupContract & { deployed: boolean };
export function deploymentSetupPlan(d: CrossChainDeployment) {
  if (!d.walletSetup || !d.l1.safe) throw new Error('Wallet setup is unavailable for this deployment.');
  const plan = sharedSetupPlan(d.l2.manager, d.l1.chainId, d.l1.safe.singleton.address, d.l1.safe.fallbackHandler.address);
  for (const [index, binding] of [d.l2.verifier, d.l2.factory, d.l1.safe.factory].entries()) {
    if (!sameAddress(plan[index]!.address, binding.address) || plan[index]!.runtimeCodeHash !== binding.runtimeCodeHash) {
      throw new Error('Falcon setup artifacts do not match this deployment.');
    }
  }
  return plan;
}

/** Read once per setup attempt, at one canonical block per chain. Absent code
 * permits deployment; conflicting code or dependencies never do.
 */
export async function inspectSetupChain(client: EezClient, d: CrossChainDeployment, chain: 'l1' | 'l2', signal: AbortSignal): Promise<SetupStatus[]> {
  const plan = deploymentSetupPlan(d).filter(step => step.chain === chain);
  await checkChain(client, d[chain]);
  const block = await client.getBlock({ blockTag: 'latest' });
  await checkCode(client, { address: matchingDeployer, runtimeCodeHash: matchingDeployerHash }, 'Deterministic deployer', block.number);
  if (chain === 'l1') {
    await Promise.all([
      checkCode(client, d.l1.safe!.singleton, 'Safe singleton', block.number),
      checkCode(client, d.l1.safe!.fallbackHandler, 'Safe fallback handler', block.number),
    ]);
    const registry = await client.getCode({ address: d.l1.registry, blockNumber: block.number });
    if (!registry || registry === '0x') throw new Error('The configured L1 registry is absent.');
  } else {
    const [rollupId, useGasLeft] = await Promise.all([
      client.readContract({ address: d.l2.manager, abi: managerAbi, functionName: 'ROLLUP_ID', blockNumber: block.number }),
      client.readContract({ address: d.l2.manager, abi: managerAbi, functionName: 'USE_GAS_LEFT', blockNumber: block.number }),
    ]);
    if (rollupId !== d.l2.rollupId || useGasLeft) throw new Error('Controller routing does not match the supported EEZ deployment.');
  }
  const status = await Promise.all(plan.map(async step => {
    const code = await client.getCode({ address: step.address, blockNumber: block.number });
    const deployed = !!code && code !== '0x';
    if (deployed && keccak256(code) !== step.runtimeCodeHash) throw new Error(`${step.label} address contains incompatible bytecode.`);
    return { ...step, deployed };
  }));
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Setup block changed. Check again.');
  signal.throwIfAborted();
  return status;
}

export async function inspectSharedSetup(clients: Record<'l1' | 'l2', EezClient>, d: CrossChainDeployment, signal: AbortSignal) {
  const [l2, l1] = await Promise.all(['l2', 'l1'].map(chain => inspectSetupChain(clients[chain as 'l1' | 'l2'], d, chain as 'l1' | 'l2', signal)));
  return [...l2!, ...l1!];
}

/** Storage is a tracking hint, not authority to submit arbitrary saved calldata. */
export function setupAttemptContract(d: CrossChainDeployment, attempt: RecoveryAttempt) {
  const step = deploymentSetupPlan(d).find(step => attempt.chainId === d[step.chain].chainId && step.data === attempt.data);
  if (!step || attempt.kind !== 'infrastructure' || attempt.publicKey !== '0x' || attempt.value !== '0'
    || !sameAddress(attempt.to, matchingDeployer)) throw new Error('Saved setup request does not match this deployment.');
  return step;
}

export async function confirmSharedSetup(client: EezClient, d: CrossChainDeployment, attempt: RecoveryAttempt, hash: Hex, signal: AbortSignal) {
  const step = setupAttemptContract(d, attempt);
  await checkChain(client, d[step.chain]);
  // A wallet can return a hash before the read RPC observes the transaction.
  // Wait for inclusion, but never clear a reverted request without checking its identity.
  let receipt;
  try { receipt = await canonicalReceipt(client, hash, signal); }
  catch (error) {
    if (!(error instanceof FalconTransactionReverted)) throw error;
    receipt = await client.getTransactionReceipt({ hash });
  }
  if (await checkRecoveryOutcome(client, attempt, hash, signal) === 'replaced') return 'replaced' as const;
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !sameAddress(receipt.from, attempt.account)
    || !sameAddress(receipt.to ?? '', matchingDeployer)
    || receipt.status !== 'success' && receipt.status !== 'reverted') throw new Error('Unexpected shared deployment receipt.');
  if (receipt.status === 'success') await checkCode(client, step, step.label, receipt.blockNumber);
  // The code read (or revert) must still refer to the receipt's canonical block.
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Deployment receipt changed. Check again.');
  signal.throwIfAborted();
  return receipt.status === 'success' ? 'deployed' as const : 'reverted' as const;
}
