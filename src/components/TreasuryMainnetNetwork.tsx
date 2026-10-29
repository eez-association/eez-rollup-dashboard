import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { TreasuryMainnetSetup } from './TreasuryMainnetSetup';
import { MainnetSetup, readMainnetSetup, setupIdentity } from '../lib/treasury/mainnetSetup';
import { loadTreasuryArtifacts } from '../lib/treasury/release';
import styles from './TreasuryDemo.module.css';

/** New network profiles must be provisioned and verified before Safe setup. */
export function TreasuryMainnetNetwork(props: ComponentProps<typeof TreasuryMainnetSetup> & { network: NonNullable<ComponentProps<typeof TreasuryMainnetSetup>['network']> }) {
  const { network, target } = props;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ network: typeof network; target: typeof target; attempt: number; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = readMainnetSetup(localStorage.getItem(`eez:treasury:paired-setup:${setupIdentity(network)}`), network);
      const artifacts = await loadTreasuryArtifacts(saved);
      await new MainnetSetup(target, artifacts, network).validate();
      if (active) setResult({ network, target, attempt });
    })().catch(error => { if (active) setResult({ network, target, attempt, error: (error as Error).message }); });
    return () => { active = false; };
  }, [network, target, attempt]);
  if (result?.network !== network || result.target !== target || result.attempt !== attempt)
    return <p role="status">Checking the RollupX treasury network and USDC…</p>;
  if (result.error) return <section className={styles.card} aria-label="Treasury network readiness">
    <h3>Treasury setup is not ready</h3>
    <p role="status">{result.error}</p>
    <button type="button" className="btn btn-outline" onClick={() => setAttempt(value => value + 1)}>Check again</button>
  </section>;
  return <TreasuryMainnetSetup {...props} />;
}
