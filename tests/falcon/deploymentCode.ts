import { type Address, type Hex } from 'viem';
import devnet from './fixtures/deployed-code.json' with { type: 'json' };
import testnet from './fixtures/testnet-deployed-code.json' with { type: 'json' };
import type { CrossChainDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';
import { deploymentSetupPlan } from '../../src/lib/falcon/sharedSetup.ts';
import { matchingDeployer, matchingDeployerRuntime } from '../../src/lib/treasury/matchingSafes.ts';

/** Mainnet shared code is compiled fixture data, not an assertion of live deployment.
 * Real CREATE2 execution is checked separately by falcon-shared-setup.mjs.
 */
export function deploymentCode(d: CrossChainDeployment): Record<string, { address: Address; code: Hex }> {
  if (!d.walletSetup) return (d.l2.chainId === 699169 ? { ...devnet, ...testnet } : devnet) as ReturnType<typeof deploymentCode>;
  return {
    ...Object.fromEntries(deploymentSetupPlan(d).map(step => [step.id, { address: step.address, code: step.runtime }])),
    singleton: { address: d.l1.safe!.singleton.address, code: devnet.singleton.code as Hex },
    fallbackHandler: { address: d.l1.safe!.fallbackHandler.address, code: devnet.fallbackHandler.code as Hex },
    deployer: { address: matchingDeployer, code: matchingDeployerRuntime },
    registry: { address: d.l1.registry, code: '0x00' },
  };
}
