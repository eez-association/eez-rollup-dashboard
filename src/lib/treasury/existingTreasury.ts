import { getAddress, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import type { DeploymentIO } from './deploymentIO.ts';
import type { SetupNetwork } from './mainnetSetup.ts';
import type { SafeInspection } from './safeSetup.ts';
import type { TreasuryConfig } from './client.ts';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export class TreasurySetupRequired extends Error {}

/** Discover only reviewed policy code through enabled allowance modules. Bound
 * discovery and fail on incomplete reads; an RPC failure is not missing setup.
 * The resulting bindings still need the normal full manifest validation.
 */
export async function existingTreasury(io: DeploymentIO, network: SetupNetwork, l1: SafeInspection, l2: SafeInspection) {
  check(l2.adapter && same(l2.adapter.safeL1, l1.address) && same(l2.adapter.manager, network.manager),
    'Choose an EEZ-X mirror already connected to this L1 Safe.');
  check(!l2.moreModules, 'This Safe has too many modules for automatic treasury discovery.');
  const addresses: Record<string, Address> = { safeL1: l1.address, safeL2: l2.address, singletonL1: l1.singleton,
    singletonL2: l2.singleton, adapter: l2.adapter.address };
  const code: TreasuryConfig['code'] = [];
  const tags = { l1: l1.block, l2: l2.block };
  const blocks = await Promise.all((['l1', 'l2'] as const).map(chain => io.rpc<{ hash: Hex }>(chain, 'eth_getBlockByNumber', [tags[chain], false])));
  check(blocks.every(block => block?.hash), 'Treasury discovery blocks are unavailable.');
  const unchanged = () => Promise.all((['l1', 'l2'] as const).map(async (chain, i) => {
    const after = await io.rpc<{ hash: Hex }>(chain, 'eth_getBlockByNumber', [tags[chain], false]);
    check(after?.hash === blocks[i]!.hash, 'Treasury state changed during discovery. Try again.');
  }));
  const bind = async (chain: 'l1' | 'l2', address: Address, artifact?: string) => {
    const bytes = await io.rpc<Hex>(chain, 'eth_getCode', [address, tags[chain]]);
    check(bytes !== '0x' && (!artifact || io.runtimeMatches(bytes, artifact)), `Unsupported treasury ${artifact ?? 'proxy'} on ${chain.toUpperCase()}.`);
    code.push({ chain, address, hash: keccak256(bytes) });
  };
  type Candidate = { policy: Address; module: Address; peerPolicy: Address; peerProxy: Address };
  const candidates: Candidate[] = [];
  let inspected = 0;
  for (const module of l2.modules) {
    const moduleCode = await io.rpc<Hex>('l2', 'eth_getCode', [module, l2.block]);
    if (!io.runtimeMatches(moduleCode, 'AllowanceModule')) continue;
    const [delegates, next] = await io.read<[Address[], number]>('l2', module, 'AllowanceModule', 'getDelegates', [l2.address, 0n, 50], l2.block);
    inspected += delegates.length;
    check(next === 0 && inspected <= 50, 'This Safe has too many delegates for automatic treasury discovery.');
    // Most treasuries have one delegate; cap simultaneous RPCs for larger lists.
    for (let offset = 0; offset < delegates.length; offset += 4) await Promise.all(delegates.slice(offset, offset + 4).map(async policy => {
      const bytes = await io.rpc<Hex>('l2', 'eth_getCode', [policy, l2.block]);
      if (!io.runtimeMatches(bytes, 'PairedTreasuryPolicy')) return;
      const [cfg, token, allowance, peerSafe] = await Promise.all([
        io.read<{ safe: Address; peerPolicy: Address; peerProxy: Address }>('l2', policy, 'PairedTreasuryPolicy', 'configuration', [], l2.block),
        io.read<Address>('l2', policy, 'PairedTreasuryPolicy', 'token', [], l2.block),
        io.read<Address>('l2', policy, 'PairedTreasuryPolicy', 'allowanceModule', [], l2.block),
        io.read<Address>('l2', policy, 'PairedTreasuryPolicy', 'peerSafe', [], l2.block),
      ]);
      if (same(cfg.safe, l2.address) && same(token, network.contracts.wrappedUSDC.address) && same(allowance, module) && same(peerSafe, l1.address))
        candidates.push({ policy: getAddress(policy), module: getAddress(module), peerPolicy: getAddress(cfg.peerPolicy), peerProxy: getAddress(cfg.peerProxy) });
    }));
  }
  await unchanged();
  if (!candidates.length) throw new TreasurySetupRequired('No supported treasury policies were found for these Safes. Treasury setup is still required.');
  check(candidates.length === 1, 'Multiple treasury policies match these Safes. Restore the saved treasury selection instead of choosing one automatically.');
  const chosen = candidates[0]!;
  await bind('l1', chosen.peerPolicy, 'PairedTreasuryPolicy');
  const [moduleL1, alias, safeL2Alias] = await Promise.all([
    io.read<Address>('l1', chosen.peerPolicy, 'PairedTreasuryPolicy', 'allowanceModule', [], l1.block),
    io.read<Address>('l2', chosen.policy, 'PairedTreasuryPolicy', 'localAliasOnPeer', [], l2.block),
    io.read<Address>('l1', getAddress(network.registry), 'Registry', 'computeCrossChainProxyAddress', [l2.address, BigInt(network.rollupId)], l1.block),
  ]);
  Object.assign(addresses, { policy: chosen.policy, policyL1: chosen.peerPolicy, moduleL1, moduleL2: chosen.module, alias, safeL2Alias });
  code.push({ chain: 'l1', address: l1.address, hash: l1.proxyHash }, { chain: 'l1', address: l1.singleton, hash: l1.singletonHash },
    { chain: 'l2', address: l2.address, hash: l2.proxyHash }, { chain: 'l2', address: l2.singleton, hash: l2.singletonHash });
  await Promise.all([bind('l1', moduleL1, 'AllowanceModule'), bind('l1', alias), bind('l1', safeL2Alias),
    bind('l2', chosen.policy, 'PairedTreasuryPolicy'), bind('l2', chosen.module, 'AllowanceModule'), bind('l2', l2.adapter.address), bind('l2', chosen.peerProxy)]);
  await unchanged();
  return { addresses, code };
}
