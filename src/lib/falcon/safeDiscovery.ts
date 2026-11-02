import type { Hex } from 'viem';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import type { EezClient } from './eez.ts';
import { checkChain, checkControllerDeployment, findL1Controller, inspectL1Controller } from './l1Controller.ts';
import { loadRemoteSafe, type SafeAttachment } from './safe.ts';

/** Discover through dashboard reads, publishing nothing until every inspection passes.
 * The wallet's Composer route is checked separately before setup or submission.
 */
export async function loadSafeAccount(l2: EezClient, l1: EezClient, deployment: CrossChainDeployment,
  publicKey: Hex, signal: AbortSignal, attachment?: SafeAttachment) {
  signal.throwIfAborted();
  const block = l2.getBlock();
  const checks = Promise.all([
    checkChain(l2, deployment.l2),
    block.then(source => checkControllerDeployment(l2, deployment, signal, source.number)),
  ]);
  const discovery = block.then(async source => {
    signal.throwIfAborted();
    const address = await findL1Controller(l2, deployment, publicKey, source.number);
    signal.throwIfAborted();
    if (!address) return { controller: null, remote: null };
    // L1 reads need the address, not the outcome of the independent L2 checks.
    const [controller, remote] = await Promise.all([
      inspectL1Controller(l2, deployment, publicKey, address, source, signal),
      loadRemoteSafe(l1, deployment, address, signal, undefined, attachment),
    ]);
    return { controller, remote };
  });
  const [, account] = await Promise.all([checks, discovery]);
  signal.throwIfAborted();
  return account;
}
