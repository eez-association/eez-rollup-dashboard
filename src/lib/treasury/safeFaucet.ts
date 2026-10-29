import { getAddress } from 'viem';
import type { TreasuryConfig } from './client.ts';
import type { DeploymentArtifacts } from './deployment.ts';
import { TestnetAsset, readAssetJournal } from './testnetAsset.ts';
import type { AssetJournal } from './testnetAsset.ts';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const safeFaucetKey = (c: TreasuryConfig, chain?: 'l1' | 'l2') => `eez:treasury:safe-faucet:${c.instance}:${c.payments!.tokenL1.toLowerCase()}${chain ? `:${chain}` : ''}`;

/** A symbol or label is not proof that an asset exposes the test-only mint. */
export async function verifiedSafeFaucet(c: TreasuryConfig, artifacts: DeploymentArtifacts): Promise<TestnetAsset | null> {
  const p = c.payments;
  if (c.environment !== 'dashboard-testnet' || !p?.pair || p.bridgeKind !== 'standard' || !c.fees || !c.l1.front) return null;
  const d = new TestnetAsset({ l1: { rpc: c.l1.rpc, front: c.l1.front, explorer: c.l1.explorer ?? '' },
    l2: { rpc: c.l2.rpc, front: c.l2.front, explorer: c.l2.explorer ?? '' },
    fees: { l1: c.fees.l1MaxTotalWei!, l2: c.fees.maxTotalWei } }, artifacts, p.bridgeL1, p.bridgeL2);
  const code = await d.rpc<`0x${string}`>('l1', 'eth_getCode', [p.tokenL1, 'latest']);
  if (!d.runtimeMatches(code, 'TestUSDC')) return null;
  await d.validate(); await d.validateToken(p.tokenL1);
  const wrapped = await d.read<string>('l2', p.bridgeL2, 'Bridge', 'getWrappedToken', [p.tokenL1, 0n]);
  if (!same(wrapped, p.tokenL2)) throw new Error('The treasury wrapped token does not match this faucet');
  return d;
}

export function readSafeFaucet(c: TreasuryConfig, raw: string | null): AssetJournal {
  const state = raw ? readAssetJournal(raw) : { token: getAddress(c.payments!.tokenL1) };
  const p = state.pending;
  if (!state.token || !same(state.token, c.payments!.tokenL1)
    || p && (p.kind === 'deploy' || !same(p.recipient, p.kind === 'l1' ? c.safeL1 : c.safeL2)))
    throw new Error('Saved faucet request belongs to another token or Safe; preserve it for recovery');
  return state;
}

/** Keep pre-existing single-claim journals recoverable without moving or erasing them. */
export function readSafeFaucetClaim(c: TreasuryConfig, storage: Pick<Storage, 'getItem'>, chain: 'l1' | 'l2'): AssetJournal {
  const raw = storage.getItem(safeFaucetKey(c, chain));
  let state: AssetJournal | undefined;
  if (raw !== null) {
    state = readSafeFaucet(c, raw);
    if (state.pending && state.pending.kind !== chain) throw new Error('Saved faucet request belongs to the other Safe');
  }
  const legacy = readSafeFaucet(c, storage.getItem(safeFaucetKey(c)));
  if (legacy.pending?.kind === chain) {
    if (legacy.pending.hash && state?.last?.hash === legacy.pending.hash && !state.pending) return state;
    if (state?.pending && !sameClaim(state.pending, legacy.pending)) throw new Error('Two different faucet requests are recorded for this Safe. Preserve both records for recovery.');
    return state?.pending ? state : legacy;
  }
  if (state) return state;
  return legacy.pending?.kind === chain || !legacy.pending && legacy.last?.destination === chain ? legacy : readSafeFaucet(c, null);
}

function sameClaim(a: NonNullable<AssetJournal['pending']>, b: NonNullable<AssetJournal['pending']>) {
  return (['kind', 'sender', 'nonce', 'data', 'recipient', 'token', 'to', 'build'] as const)
    .every(key => String(a[key]).toLowerCase() === String(b[key]).toLowerCase());
}

/** Caller holds the faucet lock. Retire a legacy pending slot only after the
 * exact request has been canonically reconciled, never because a new slot exists.
 */
export function saveReconciledFaucet(c: TreasuryConfig, storage: Pick<Storage, 'getItem' | 'setItem'>, chain: 'l1' | 'l2', previous: AssetJournal, next: AssetJournal) {
  readSafeFaucet(c, JSON.stringify(next));
  storage.setItem(safeFaucetKey(c, chain), JSON.stringify(next));
  if (!previous.pending || next.pending || !next.last) return;
  const legacy = readSafeFaucet(c, storage.getItem(safeFaucetKey(c)));
  if (legacy.pending && sameClaim(legacy.pending, previous.pending))
    storage.setItem(safeFaucetKey(c), JSON.stringify({ ...legacy, pending: undefined, last: next.last }));
}
