import type { DeploymentArtifacts } from './deployment.ts';
import current from './current-build.json' with { type: 'json' };
const bundles = (() => { try { return import.meta.glob('./builds/*.json'); } catch { return null; } })();
/** Historical bundles remain verification evidence, never deployment fallbacks. */
export async function loadTreasuryArtifacts(saved?: { build?: string } | null): Promise<DeploymentArtifacts> {
  const build = current.build;
  if (saved && saved.build !== build) throw new Error('This setup uses a retired contract release. Start a new paired setup; its old record has been preserved.');
  const loader = bundles ? bundles[`./builds/${build}.json`] : () => import(/* @vite-ignore */ `./builds/${build}.json`, { with: { type: 'json' } });
  if (!loader) throw new Error('This setup’s original contract build is unavailable. Restore that build before continuing.');
  const module = await loader() as { default: DeploymentArtifacts };
  if (module.default.build !== build) throw new Error('Treasury build identity differs');
  if (!module.default.contracts.PairedTreasuryPolicy || !module.default.contracts.TestUSDC)
    throw new Error('The current paired contract release is incomplete');
  return module.default;
}
