import { loadMainnetManifest, mainnetSetupStepsFor, readMainnetSetup, setupIdentity } from './mainnetSetup.ts';
import type { SetupNetwork } from './mainnetSetup.ts';
import { readSafeFaucetClaim } from './safeFaucet.ts';
import type { SetupTransaction } from './setupTransactions.ts';

type Reader = Pick<Storage, 'getItem'>;
export const pairedSetupKey = (network: SetupNetwork) => `eez:treasury:paired-setup:${setupIdentity(network)}`;
export function pairedSetupSnapshot(storage: Reader, network: SetupNetwork) {
  const key = pairedSetupKey(network), raw = storage.getItem(key);
  const state = readMainnetSetup(raw, network), manifest = loadMainnetManifest(storage, network);
  let blocked = state?.pending ? 'Resolve the pending setup transaction before starting a new treasury.' : '';
  if (manifest) {
    if (storage.getItem(`eez:treasury:submission:${manifest.instance}`) !== null) blocked = 'A payment is pending verification.';
    else if (storage.getItem(`eez:treasury:owners:${manifest.instance}`) !== null) blocked = 'Finish the owner change and choose Done before starting a new treasury.';
    else if ((['l1', 'l2'] as const).some(chain => readSafeFaucetClaim(manifest, storage, chain).pending)) blocked = 'Wait for faucet confirmation before starting a new treasury.';
  }
  return { key, raw, state, manifest, blocked };
}
export type PairedSetupSnapshot = ReturnType<typeof pairedSetupSnapshot>;

/** Caller holds the same setup lock as signing, submissions and faucet requests.
 * Archive before selecting an empty journal; a failed write preserves selection.
 */
export function restartPairedSetup(storage: Reader & Pick<Storage, 'setItem'>, network: SetupNetwork, expected: PairedSetupSnapshot) {
  const current = pairedSetupSnapshot(storage, network);
  if (!current.state || current.state.salt !== expected.state?.salt || current.manifest?.instance !== expected.manifest?.instance)
    throw new Error('Treasury changed in another tab. Review the current setup before restarting.');
  if (current.blocked) throw new Error(current.blocked);
  storage.setItem(`${current.key}:archive:${current.state.salt}`, JSON.stringify({ state: current.state, manifest: current.manifest,
    sourceRequests: current.state.sourceRequests ?? [], archivedAt: new Date().toISOString() }));
  storage.setItem(current.key, '');
}

export function pairedSetupTransactions(storage: Reader, network: SetupNetwork): SetupTransaction[] {
  const state = readMainnetSetup(storage.getItem(pairedSetupKey(network)), network);
  if (!state) return [];
  const label = (index: number) => mainnetSetupStepsFor(state)[index]!.label.split('Ethereum').join(network.testnet ? 'Chiado' : 'Ethereum');
  const records: SetupTransaction[] = state.completed.map((tx, index) => ({ id: `${state.salt}:${index}`, label: label(index), chain: tx.chain,
    hash: tx.hash, completed: true, inclusion: { blockNumber: tx.number, blockHash: tx.blockHash } }));
  if (state.pending) records.push({ id: `${state.salt}:${state.pending.id}`, label: label(state.completed.length), chain: state.pending.chain, hash: state.pending.hash, completed: false });
  return records;
}
