import { crossChainDeployment } from './crossChainDeployment.ts';
import type { FeeConfig } from './l2Fees.ts';

type DashboardBinding = {
  l1ChainId: string | null; l2ChainId: string | null;
  registry: string; manager: string; rollupId: string;
  feesEnabled: boolean; quoteUrl: string; maxTotalWei: string; nativeSymbol: string;
};

/** Chain discovery must succeed before offering actions for the pinned deployment.
 * Wallet reads still independently check chain checkpoints, code and controller routing.
 */
export function falconDashboardConfig(host: DashboardBinding) {
  const deployment = crossChainDeployment;
  try {
    if (!host.l1ChainId || !host.l2ChainId
      || BigInt(host.l1ChainId) !== BigInt(deployment.l1.chainId)
      || BigInt(host.l2ChainId) !== BigInt(deployment.l2.chainId)
      || host.registry.toLowerCase() !== deployment.l1.registry.toLowerCase()
      || host.manager.toLowerCase() !== deployment.l2.manager.toLowerCase()
      || BigInt(host.rollupId) !== deployment.l2.rollupId) throw new Error('deployment mismatch');
  } catch {
    return { deployment: null, fees: null,
      message: 'On-chain demo requires the verified EEZ-X devnet (916969, rollup 4) and Chiado (10200). Browser signing remains available.' };
  }
  if (!host.feesEnabled) return { deployment, fees: null,
    message: 'Enable L2 fee quotes in the dashboard configuration to use the Falcon Safe.' };
  if (!host.quoteUrl || !/^[1-9]\d{0,77}$/.test(host.maxTotalWei) || BigInt(host.maxTotalWei) >= 2n ** 256n) {
    return { deployment, fees: null, message: 'The dashboard needs a Composer L2 quote URL and a valid maximum fee before Safe actions can be enabled.' };
  }
  const fees: FeeConfig = { url: host.quoteUrl, maxTotalFee: BigInt(host.maxTotalWei), nativeSymbol: host.nativeSymbol };
  return { deployment, fees, message: null };
}
