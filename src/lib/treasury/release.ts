import type { DeploymentArtifacts } from './deployment';
import current from './current-build.json';
import shared from './shared-build.json';
const bundles = import.meta.glob('./builds/*.json');
/** A saved setup selects its original build. Missing legacy build IDs always
 * select the frozen artifacts, never today's creation bytecode. */
export async function loadTreasuryArtifacts(saved?: { build?: string } | null, mainnet = false): Promise<DeploymentArtifacts> {
  const legacy = await import('./deployment-artifacts.json');
  const oldMainnet = mainnet ? (await import('./mainnet-artifacts.json')).default.contracts : {};
  // Chiado's retained planner still deploys TreasuryPolicy and its shared
  // bridge. Do not mix that plan with a release containing only paired policies.
  const build = saved ? saved.build : mainnet ? current.build : shared.build;
  const base = { ...legacy.default, contracts: { ...legacy.default.contracts, ...oldMainnet } } as DeploymentArtifacts;
  if (!build) return base;
  if (!/^[a-f\d]{64}$/.test(build)) throw new Error('Invalid treasury build');
  const loader = bundles[`./builds/${build}.json`];
  if (!loader) throw new Error('This setup’s original contract build is unavailable. Restore that build before continuing.');
  const module = await loader() as { default: DeploymentArtifacts };
  if (module.default.build !== build) throw new Error('Treasury build identity differs');
  // Retain the reviewed adapter for reusing an existing mirror. New deployments
  // still use this release's L1Owners; reuse does not enqueue historical code.
  return { ...module.default, contracts: { ...base.contracts,
    LegacyL1Owners: base.contracts.L1Owners!, ...module.default.contracts } };
}
