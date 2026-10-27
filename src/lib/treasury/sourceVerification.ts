import currentRelease from './current-build.json' with { type: 'json' };
import type { TreasuryConfig } from './client.ts';
export type SourceRequest = { build: string; chainId: number } & (
  { transactionHash: string; address?: never } | { address: string; transactionHash?: never }
);
export type SourceJob = { id: string; status: string; error?: string; contracts: { address: string; name?: string; status: string; error?: string; explorer?: string; explorerUrl?: string; sourcify?: string }[] };
const contractAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[a-f\d]{40}$/i.test(value) && BigInt(value) > 0n;
const valid = (r: SourceRequest) => r && /^[a-f\d]{64}$/.test(r.build) && Number.isSafeInteger(r.chainId)
  && r.chainId > 0 && (r.address !== undefined ? contractAddress(r.address) && r.transactionHash === undefined : /^0x[a-f\d]{64}$/i.test(r.transactionHash));
/** Reused bindings are source-publication targets too. These requests contain
 * identities only: the service selects retained inputs and checks live code. */
export function dependencySourceRequests(value: unknown, build = currentRelease.build): SourceRequest[] {
  const c = value as Partial<TreasuryConfig> | null;
  if (!c || !['dashboard-testnet','ethereum-mainnet'].includes(c.environment ?? '') || !c.payments?.pair) return [];
  const requests = new Map<string, SourceRequest>();
  const add = (chain: 'l1' | 'l2', address: unknown) => {
    const chainId = c[chain]?.chainId;
    if (!contractAddress(address) || !Number.isSafeInteger(chainId)) return;
    const r: SourceRequest = { build, chainId: chainId!, address: address.toLowerCase() };
    if (valid(r)) requests.set(`${r.chainId}:${r.address}`, r);
  };
  if (Array.isArray(c.code)) for (const binding of c.code) if (binding && ['l1','l2'].includes(binding.chain)) add(binding.chain, binding.address);
  add('l1', c.safeL1); add('l2', c.safeL2); add('l2', c.adapter);
  add('l1', c.registry); add('l2', c.manager);
  add('l1', c.safeImplementations?.l1); add('l2', c.safeImplementations?.l2);
  if (Array.isArray(c.protocol)) for (const binding of c.protocol) if (binding && ['l1','l2'].includes(binding.chain)) {
    add(binding.chain, binding.proxy); add(binding.chain, binding.implementation);
  }
  return [...requests.values()];
}
/** The deployment journal is the outbox: save confirmation and verification
 * intent together before any HTTP delivery. No separate window can lose work. */
export function sourceRequests(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, configured?: unknown): SourceRequest[] {
  const all = new Map<string, SourceRequest>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith('eez:treasury:') || key.startsWith('eez:treasury:source-jobs:')) continue;
    try {
      const record = JSON.parse(storage.getItem(key) ?? 'null');
      if (Array.isArray(record?.sourceRequests)) for (const request of record.sourceRequests) if (valid(request)) all.set(JSON.stringify(request), request);
      const setup = key.endsWith(':manifest') ? JSON.parse(storage.getItem(key.slice(0, -9)) ?? 'null') : null;
      const build = /^[a-f\d]{64}$/.test(setup?.build ?? '') ? setup.build : currentRelease.build;
      for (const request of dependencySourceRequests(record, build)) all.set(JSON.stringify(request), request);
    } catch { /* An unrelated/legacy journal is never a verification request. */ }
  }
  for (const request of dependencySourceRequests(configured)) all.set(JSON.stringify(request), request);
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
