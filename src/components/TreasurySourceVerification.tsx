import { useEffect, useState } from 'react';
import { deliverSourceRequest, sourceRequests } from '../lib/treasury/sourceVerification';
import type { SourceJob } from '../lib/treasury/sourceVerification';
import { L1_CHAIN, L2_CHAIN, config } from '../config';
import styles from './TreasuryDemo.module.css';

export function TreasurySourceVerification() {
  const [jobs, setJobs] = useState<{ chainId: number; job: SourceJob }[]>([]), [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let alive = true, running = false, dirty = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (running) { dirty = true; return; }
      running = true; clearTimeout(timer);
      try {
        const results = [];
        let deliveryError = '';
        // Delivery is idempotent; the persistent worker continues when this
        // component unmounts. Reopening also retries undelivered journal intents.
        for (const request of sourceRequests(localStorage).filter(r => [Number(BigInt(L1_CHAIN.chainId)), Number(BigInt(L2_CHAIN.chainId))].includes(r.chainId))) {
          if (!alive) return;
          try {
            results.push({ chainId: request.chainId, job: await deliverSourceRequest(request, `${import.meta.env.BASE_URL}treasury-verification/jobs`) });
          } catch (e) {
            // A missing/reorganized receipt must not block unrelated deployments.
            deliveryError = (e as Error).message;
          }
        }
        if (alive) { setJobs(results); setError(deliveryError); }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { running = false; if (alive) timer = setTimeout(poll, dirty ? 0 : 15_000); dirty = false; }
    };
    const changed = () => { void poll(); };
    window.addEventListener('treasury-source-request', changed);
    void poll(); return () => { alive = false; clearTimeout(timer); window.removeEventListener('treasury-source-request', changed); };
  }, []);
  if (!jobs.length && !error) return null;
  const entries = jobs.flatMap(({ chainId, job }) => job.contracts.map(c => ({ chainId, ...c })));
  const unique = [...new Map(entries.map(c => [`${c.chainId}:${c.address}`, c])).values()];
  const verified = unique.filter(c => c.status === 'verified').length;
  const sourceOnly = unique.filter(c => c.status === 'sourcify-verified').length;
  const partial = unique.filter(c => c.explorer === 'partial').length;
  const pending = jobs.some(j => !['verified','reverted','not-applicable'].includes(j.job.status));
  const retryable = jobs.filter(({ job }) => !['verified','reverted','not-applicable','source-unavailable'].includes(job.status));
  if (!unique.length && !error) return null;
  return <details className={styles.hint} aria-label="Contract source verification">
    <summary>{error ? 'Contract source verification will retry automatically' : !pending ? 'Contract sources verified on explorers' : `Publishing to explorers · ${verified} of ${unique.length} verified${partial ? ` · ${partial} partial` : ''}`}</summary>
    {error && <p role="status">{error}</p>}
    {sourceOnly > 0 && <p>{sourceOnly} exact source {sourceOnly === 1 ? 'match' : 'matches'} on Sourcify; explorer publication is still pending.</p>}
    <ul>{unique.map(c => <li key={`${c.chainId}:${c.address}`}>
      <a href={`${(c.chainId === 1 ? 'https://eth.blockscout.com' : c.chainId === Number(BigInt(L1_CHAIN.chainId)) ? config.l1Explorer : config.l2Explorer).replace(/\/$/, '')}/address/${c.address}?tab=contract`} target="_blank" rel="noreferrer">{c.name ?? 'Contract'} · {c.address.slice(0, 8)}…{c.address.slice(-4)}</a>{' · '}
      {c.status === 'verified' ? 'Verified on explorer' : c.status === 'sourcify-verified' ? <><a href={`https://repo.sourcify.dev/${c.chainId}/${c.address}`} target="_blank" rel="noreferrer">Exact source verified</a> · {c.explorer === 'partial' ? 'explorer reports partial verification' : 'explorer publication pending'}</> : c.status === 'source-unavailable' ? 'Source build needs attention' : c.explorer === 'partial' ? 'Explorer reports partial verification; checking exact sources' : 'Publishing automatically'}
      {c.error && c.status !== 'verified' && <span> · {c.error}</span>}
    </li>)}</ul>
    {jobs.map(({ job }) => job.error && <p key={job.id} role="status">{job.error}</p>)}
    {pending && <button type="button" className="btn btn-sm btn-outline" disabled={retrying} onClick={() => {
      setRetrying(true); setError('');
      void Promise.all(retryable.map(async ({ job }) => {
        const response = await fetch(`${import.meta.env.BASE_URL}treasury-verification/jobs/${job.id}/retry`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('Verification retry is unavailable; automatic retries remain scheduled.');
      })).then(() => window.dispatchEvent(new Event('treasury-source-request'))).catch(e => setError(e.message)).finally(() => setRetrying(false));
    }}>{retrying ? 'Requesting retry…' : retryable.length ? 'Retry source publication' : 'Recheck source inputs'}</button>}
  </details>;
}
