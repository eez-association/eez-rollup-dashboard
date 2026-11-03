import type { Hex } from 'viem';
import type { CrossChainDeployment } from './crossChainDeployment.ts';
import type { EezClient } from './eez.ts';
import { checkChain, checkControllerDeployment, findL1Controller, inspectL1Controller, type ControllerState } from './l1Controller.ts';
import { loadRemoteSafe, type RemoteSafe, type SafeAttachment } from './safe.ts';

type SafeAccount = { controller: ControllerState | null; remote: RemoteSafe | null; safeError?: string };

/** Controller/deployment checks always fail closed. An explicit UI-only option
 * can retain that verified controller when its Safe is unavailable, for replacement.
 * The wallet's Composer route is checked separately before setup or submission.
 */
export async function loadSafeAccount(l2: EezClient, l1: EezClient, deployment: CrossChainDeployment,
  publicKey: Hex, signal: AbortSignal, attachment?: SafeAttachment,
  options: { allowUnavailableSafe?: boolean } = {}): Promise<SafeAccount> {
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
    const [controller, safe] = await Promise.all([
      inspectL1Controller(l2, deployment, publicKey, address, source, signal),
      loadRemoteSafe(l1, deployment, address, signal, undefined, attachment)
        .then(remote => ({ remote, safeError: undefined as string | undefined }))
        .catch(error => {
          signal.throwIfAborted();
          if (!options.allowUnavailableSafe) throw error;
          return { remote: null, safeError: (error instanceof Error ? error.message.split('\n')[0] : '') || 'Unable to verify the selected Safe.' };
        }),
    ]);
    return { controller, remote: safe.remote, ...(safe.safeError ? { safeError: safe.safeError } : {}) };
  });
  const [, account] = await Promise.all([checks, discovery]);
  signal.throwIfAborted();
  return account;
}
