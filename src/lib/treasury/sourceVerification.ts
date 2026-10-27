export type SourceRequest = { build: string; chainId: number; transactionHash: string };
export type SourceJob = { id: string; status: string; error?: string; contracts: { address: string; name?: string; status: string; error?: string; explorer?: string; sourcify?: string }[] };
const valid = (r: SourceRequest) => r && /^[a-f\d]{64}$/.test(r.build) && Number.isSafeInteger(r.chainId)
  && r.chainId > 0 && /^0x[a-f\d]{64}$/i.test(r.transactionHash);
/** The deployment journal is the outbox: save confirmation and verification
 * intent together before any HTTP delivery. No separate window can lose work. */
export function sourceRequests(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): SourceRequest[] {
  const all = new Map<string, SourceRequest>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith('eez:treasury:') || key.startsWith('eez:treasury:source-jobs:')) continue;
    try {
      const record = JSON.parse(storage.getItem(key) ?? 'null');
      if (!Array.isArray(record?.sourceRequests)) continue;
      for (const request of record.sourceRequests) if (valid(request)) all.set(JSON.stringify(request), request);
    } catch { /* An unrelated/legacy journal is never a verification request. */ }
  }
  return [...all.values()];
}
export function appendSourceRequest(previous: SourceRequest[] | undefined, build: string | undefined, chainId: number, transactionHash: string) {
  if (!build) return previous;
  const request = { build, chainId, transactionHash };
  if (!valid(request)) throw new Error('Invalid source verification identity');
  return [...(previous ?? []), request];
}
export async function deliverSourceRequest(request: SourceRequest, endpoint: string, fetcher = fetch): Promise<SourceJob> {
  if (!valid(request)) throw new Error('Invalid source verification identity');
  const result = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), keepalive: true, signal: AbortSignal.timeout(10_000) });
  if (!result.ok) {
    const body = await result.json().catch(() => null) as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error.slice(0, 300) : '';
    throw new Error(detail ? `Source verification: ${detail}. It will retry automatically.`
      : 'Source verification is waiting for its service; it will retry automatically.');
  }
  const job = await result.json() as SourceJob;
  if (!/^[a-f\d]{64}$/.test(job.id) || !Array.isArray(job.contracts)) throw new Error('Invalid verification response');
  return job;
}

/** Preserve verification work when Start new treasury removes a setup journal. */
export function retainSourceRequests(storage: Pick<Storage, 'getItem' | 'setItem'>, requests?: SourceRequest[]) {
  if (!requests?.length) return;
  const key = 'eez:treasury:source-outbox';
  const saved = JSON.parse(storage.getItem(key) ?? '{"sourceRequests":[]}') as { sourceRequests: SourceRequest[] };
  const unique = new Map(saved.sourceRequests.filter(valid).map(r => [JSON.stringify(r), r]));
  for (const r of requests) { if (!valid(r)) throw new Error('Invalid verification request'); unique.set(JSON.stringify(r), r); }
  storage.setItem(key, JSON.stringify({ sourceRequests: [...unique.values()] }));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('treasury-source-request'));
}
