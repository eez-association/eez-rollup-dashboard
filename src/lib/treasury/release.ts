import type { DeploymentArtifacts } from './deployment';
import current from './current-build.json';
const bundles = import.meta.glob('./builds/*.json');
/** Historical bundles remain verification evidence, never deployment fallbacks. */
export async function loadTreasuryArtifacts(saved?: { build?: string } | null): Promise<DeploymentArtifacts> {
  const build = current.build;
  if (saved && saved.build !== build) throw new Error('This setup uses a retired contract release. Start a new paired setup; its old record has been preserved.');
  const loader = bundles[`./builds/${build}.json`];
  if (!loader) throw new Error('This setup’s original contract build is unavailable. Restore that build before continuing.');
  const module = await loader() as { default: DeploymentArtifacts };
  if (module.default.build !== build) throw new Error('Treasury build identity differs');
  if (!module.default.contracts.PairedTreasuryPolicy || !module.default.contracts.TestUSDC)
    throw new Error('The current paired contract release is incomplete');
  return module.default;
}
