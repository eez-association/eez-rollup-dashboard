import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import type { SetupNetwork } from './mainnetSetup.ts';
import type { DeploymentIO } from './deploymentIO.ts';
import { EIP1967_IMPLEMENTATION_SLOT, USDC_IMPLEMENTATION_SLOT } from './mainnet.ts';
import { readBridgeManager } from '../bridgeManager.ts';
import { probeComposer } from '../composerDiscovery.ts';
import { matchingDeployer, matchingDeployerHash } from './matchingSafes.ts';

type Chain = 'l1' | 'l2';
type IO = Pick<DeploymentIO, 'rpc' | 'runtimeMatches'>;
export type DashboardNetwork = { l1ChainId: string; l2ChainId: string; registry: string; manager: string; bridgeL1: string; bridgeL2: string };
export type DiscoveredAsset = { symbol: string; kind: 'demo' | 'erc20'; implementation?: { address: Address; slot: Hex } };
export type NetworkCheck = { label: string; error?: string };
const chains = ['l1', 'l2'] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const abi: Abi = parseAbi([
  'function rollupId() view returns(uint64)', 'function ROLLUP_ID() view returns(uint64)', 'function MAINNET_ROLLUP_ID() view returns(uint64)',
  'function canonicalBridgeAddress() view returns(address)', 'function getWrappedToken(address,uint64) view returns(address)',
  'function wrappedTokenInfo(address) view returns(address,uint64)', 'function BRIDGE() view returns(address)',
  'function decimals() view returns(uint8)', 'function symbol() view returns(string)',
  'function bridgeL1() view returns(address)', 'function destinationRollup() view returns(uint64)',
]);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function read<T>(io: IO, chain: Chain, to: string, functionName: string, args: unknown[] = [], tag = 'latest'): Promise<T> {
  return decodeFunctionResult({ abi, functionName, data: await io.rpc<Hex>(chain, 'eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, tag]) }) as T;
}
async function code(io: IO, chain: Chain, address: string, tag: string, label: string) {
  check(isAddress(address) && !same(address, zeroAddress), `${label}: address is missing from the dashboard configuration.`);
  const bytes = await io.rpc<Hex>(chain, 'eth_getCode', [address, tag]);
  check(bytes !== '0x', `${label}: no contract is deployed at ${address}.`);
  return { chain, address: getAddress(address), hash: keccak256(bytes), bytes };
}
async function implementation(io: IO, chain: Chain, address: string, tag: string, slot = EIP1967_IMPLEMENTATION_SLOT) {
  const value = await io.rpc<Hex>(chain, 'eth_getStorageAt', [address, slot, tag]);
  check(/^0x[\da-f]{64}$/i.test(value), 'Contract implementation slot is unavailable.');
  return getAddress(`0x${value.slice(-40)}`);
}
// The dashboard's configured protocol and bridges are the trust boundary.
// Hashes record the selected deployment for reload/upgrade detection, not a
// per-network or per-version allowlist.
export function dashboardNetworkKey(d: DashboardNetwork) {
  return `eez:treasury:discovered:${keccak256(toHex(JSON.stringify([BigInt(d.l1ChainId).toString(), BigInt(d.l2ChainId).toString(), d.registry.toLowerCase(), d.manager.toLowerCase(), d.bridgeL1.toLowerCase(), d.bridgeL2.toLowerCase()])))}`;
}
export function matchesDashboard(n: SetupNetwork, d: DashboardNetwork) {
  return chains.every(chain => BigInt(n.chains[chain].chainId) === BigInt(chain === 'l1' ? d.l1ChainId : d.l2ChainId))
    && same(n.registry, d.registry) && same(n.manager, d.manager)
    && same(n.contracts.bridgeL1.address, d.bridgeL1) && same(n.contracts.bridgeL2.address, d.bridgeL2);
}
/** Reuse a live infrastructure check for a saved token selection only when
 * both snapshots describe exactly the same chains, anchors and contracts. */
export function assertSameInfrastructure(saved: SetupNetwork, current: SetupNetwork) {
  check(same(saved.registry, current.registry) && same(saved.manager, current.manager) && saved.rollupId === current.rollupId
    && chains.every(c => saved.chains[c].chainId === current.chains[c].chainId && saved.chains[c].number === current.chains[c].number
      && same(saved.chains[c].hash, current.chains[c].hash))
    && JSON.stringify(saved.protocol) === JSON.stringify(current.protocol)
    && JSON.stringify(saved.bridgeImplementations ?? {}) === JSON.stringify(current.bridgeImplementations ?? {})
    && chains.every(c => JSON.stringify(saved.contracts[c === 'l1' ? 'bridgeL1' : 'bridgeL2']) === JSON.stringify(current.contracts[c === 'l1' ? 'bridgeL1' : 'bridgeL2'])),
  'Network contracts changed since setup. Preserve the saved treasury and review this deployment.');
}
export async function matchingDeployerChecks(io: IO): Promise<NetworkCheck[]> {
  return Promise.all(chains.map(async chain => {
    const label = `${chain.toUpperCase()} Arachnid deployer`;
    try {
      const bytes = await io.rpc<Hex>(chain, 'eth_getCode', [matchingDeployer, 'latest']);
      return { label, ...(bytes === '0x' ? { error: `Missing. Deploy Arachnid at ${matchingDeployer} on ${chain.toUpperCase()} before creating matching Safes.` }
        : keccak256(bytes) !== matchingDeployerHash ? { error: `Unexpected code at ${matchingDeployer}; matching Safe creation is unavailable.` } : {}) };
    } catch (e) { return { label, error: `Check unavailable: ${(e as Error).message}` }; }
  }));
}

async function networkAnchor(io: IO, chain: Chain, saved?: SetupNetwork) {
  type Header = { number: Hex; hash: Hex };
  try {
    return await io.rpc<Header>(chain, 'eth_getBlockByNumber', [saved?.chains[chain].number ?? '0x0', false]);
  } catch (error) {
    if (!/pruned history|historical.*(?:unavailable|not available)/i.test((error as Error).message)) throw error;
    if (saved) throw new Error('The RPC has pruned this saved network reference. Use a history-capable RPC to resume; the saved treasury was preserved.');
    // New selections can pin a finalized checkpoint when genesis history is
    // unavailable. An existing journal must always keep its original anchor.
    const block = await io.rpc<Header>(chain, 'eth_getBlockByNumber', ['finalized', false]);
    check(block && /^0x[\da-f]+$/i.test(block.number) && /^0x[\da-f]{64}$/i.test(block.hash), 'A finalized network reference is unavailable.');
    const again = await io.rpc<Header>(chain, 'eth_getBlockByNumber', [block.number, false]);
    check(again?.hash === block.hash, 'Finalized network reference changed; check again.');
    return block;
  }
}

/** Inspect both chains independently so the UI can explain every missing side.
 * A saved snapshot preserves block anchors and setup identities across reloads. */
export async function discoverInfrastructure(io: IO, d: DashboardNetwork, saved?: SetupNetwork): Promise<{ checks: NetworkCheck[]; network?: SetupNetwork }> {
  const observations = await Promise.allSettled(chains.map(async chain => {
    const id = Number(BigInt(chain === 'l1' ? d.l1ChainId : d.l2ChainId));
    check(Number.isSafeInteger(id) && id > 0 && BigInt(d.l1ChainId) !== BigInt(d.l2ChainId), 'Invalid dashboard chain pair.');
    const composerCheck = probeComposer({ request: ({ method, params }) => io.rpc(chain, method, (params ?? []) as unknown[], true) },
      { l1ChainId: toHex(BigInt(d.l1ChainId)), l2ChainId: toHex(BigInt(d.l2ChainId)), registryAddress: d.registry, l2Address: d.manager, l1BridgeAddress: d.bridgeL1, l2BridgeAddress: d.bridgeL2 });
    const [actualId, block, head] = await Promise.all([
      io.rpc<Hex>(chain, 'eth_chainId'),
      networkAnchor(io, chain, saved),
      io.rpc<{ number: Hex; hash: Hex }>(chain, 'eth_getBlockByNumber', ['latest', false]),
    ]);
    check(BigInt(actualId) === BigInt(id), 'RPC serves a different chain.');
    check(block?.number && block.hash && (!saved || same(block.hash, saved.chains[chain].hash)), 'Saved network reference changed or is unavailable.');
    // Read current implementations; the checkpoint is only an identity anchor.
    check(head?.number && head.hash, 'Current network state is unavailable.');
    const tag = head.number, manager = chain === 'l1' ? d.registry : d.manager;
    const bridgeAddress = chain === 'l1' ? d.bridgeL1 : d.bridgeL2;
    const [proxy, implAddress, bridge, bridgeImpl, boundManager, rollup, peer, protocolRollup] = await Promise.all([
      code(io, chain, manager, tag, 'EEZ protocol'), implementation(io, chain, manager, tag),
      code(io, chain, bridgeAddress, tag, 'Normal bridge'), implementation(io, chain, bridgeAddress, tag),
      readBridgeManager(data => io.rpc(chain, 'eth_call', [{ to: bridgeAddress, data }, tag])),
      read<bigint>(io, chain, bridgeAddress, 'rollupId', [], tag), read<Address>(io, chain, bridgeAddress, 'canonicalBridgeAddress', [], tag),
      read<bigint>(io, chain, manager, chain === 'l1' ? 'MAINNET_ROLLUP_ID' : 'ROLLUP_ID', [], tag),
    ]);
    const upgradeable = !same(bridgeImpl, zeroAddress);
    const [impl, executable] = await Promise.all([
      code(io, chain, implAddress, tag, 'EEZ implementation'),
      upgradeable ? code(io, chain, bridgeImpl, tag, 'Bridge implementation') : bridge,
    ]);
    check(same(boundManager, manager) && rollup === protocolRollup && (chain === 'l1' ? rollup === 0n : rollup > 0n && rollup <= BigInt(Number.MAX_SAFE_INTEGER))
      && same(same(peer, zeroAddress) ? bridge.address : peer, chain === 'l1' ? d.bridgeL2 : d.bridgeL1), 'Bridge is connected to a different EEZ deployment or peer.');
    const [composer, canonical] = await Promise.all([composerCheck, io.rpc<{ hash: Hex }>(chain, 'eth_getBlockByNumber', [tag, false])]);
    check(composer.status === 'detected' && BigInt(composer.chainId!) === BigInt(id), `Composer: ${composer.detail}`);
    check(canonical?.hash === head.hash, 'Network changed during inspection; check again.');
    return { chainId: id, number: block.number, hash: block.hash, rollup: Number(rollup),
      protocol: { chain, proxy: proxy.address, implementation: impl.address, proxyHash: proxy.hash, implementationHash: impl.hash },
      bridge: { chain, address: bridge.address, hash: bridge.hash, bindings: { manager, counterpart: chain === 'l1' ? d.bridgeL2 : d.bridgeL1, rollupId: String(rollup) } },
      bridgeImpl: upgradeable ? { kind: 'eip1967' as const, address: executable.address, hash: executable.hash } : undefined };
  }));
  const checks = observations.map((r, i) => ({ label: `${chains[i]!.toUpperCase()} protocol, bridge and Composer`, ...(r.status === 'rejected' ? { error: String(r.reason?.message ?? r.reason) } : {}) }));
  if (observations[0]!.status !== 'fulfilled' || observations[1]!.status !== 'fulfilled') return { checks };
  const l1 = observations[0]!.value, l2 = observations[1]!.value;
  const empty = { chain: 'l1', address: zeroAddress, hash: keccak256('0x') };
  const network: SetupNetwork = { source: 'dashboard', protocolCommit: 'discovered', registry: d.registry, manager: d.manager, rollupId: l2.rollup,
    chains: { l1: { chainId: l1.chainId, number: l1.number, hash: l1.hash }, l2: { chainId: l2.chainId, number: l2.number, hash: l2.hash } },
    protocol: [l1.protocol, l2.protocol], contracts: { bridgeL1: l1.bridge, bridgeL2: l2.bridge, usdcProxy: empty, usdcImplementation: empty, wrappedUSDC: { ...empty, chain: 'l2' } },
    bridgeImplementations: { ...(l1.bridgeImpl ? { l1: l1.bridgeImpl } : {}), ...(l2.bridgeImpl ? { l2: l2.bridgeImpl } : {}) },
    discovered: { symbol: 'Token', kind: 'erc20' } };
  if (saved) {
    assertSameInfrastructure(saved, network);
    return { checks, network: saved };
  }
  return { checks, network };
}
export async function validateInfrastructure(io: IO, network: SetupNetwork) {
  const result = await discoverInfrastructure(io, { l1ChainId: String(network.chains.l1.chainId), l2ChainId: String(network.chains.l2.chainId), registry: network.registry,
    manager: network.manager, bridgeL1: network.contracts.bridgeL1.address, bridgeL2: network.contracts.bridgeL2.address }, network);
  check(result.network, result.checks.filter(c => c.error).map(c => `${c.label}: ${c.error}`).join(' '));
}

export async function discoverToken(io: IO, network: SetupNetwork, token: Address, requireWrapped = true, selectedAsset?: DiscoveredAsset): Promise<SetupNetwork> {
  const [asset, decimals, symbol, eip, usdc, wrapped] = await Promise.all([
    code(io, 'l1', token, 'latest', 'L1 token'), read<number>(io, 'l1', token, 'decimals'), selectedAsset?.symbol ?? read<string>(io, 'l1', token, 'symbol'),
    implementation(io, 'l1', token, 'latest'), implementation(io, 'l1', token, 'latest', USDC_IMPLEMENTATION_SLOT),
    read<Address>(io, 'l2', network.contracts.bridgeL2.address, 'getWrappedToken', [token, 0n]),
  ]);
  check(decimals === 6, 'This demo requires a token with 6 decimal places.');
  check(typeof symbol === 'string' && symbol.trim().length > 0 && symbol.length <= 64, 'Token symbol is invalid.');
  check(same(eip, zeroAddress) || same(usdc, zeroAddress), 'Token has ambiguous proxy implementation slots.');
  const implAddress = !same(eip, zeroAddress) ? eip : usdc;
  const impl = same(implAddress, zeroAddress) ? asset : await code(io, 'l1', implAddress, 'latest', 'Token implementation');
  const demo = io.runtimeMatches(asset.bytes, 'TestUSDC');
  if (demo) check(same(await read<Address>(io, 'l1', token, 'bridgeL1'), network.contracts.bridgeL1.address)
    && await read<bigint>(io, 'l1', token, 'destinationRollup') === BigInt(network.rollupId), 'Demo token belongs to a different bridge or rollup.');
  let wrappedBinding = { chain: 'l2', address: wrapped, hash: keccak256('0x') };
  if (same(wrapped, zeroAddress)) check(!requireWrapped, 'This token has not been bridged to L2 yet. Bridge it once, then check again.');
  else {
    const [binding, origin, authority, wrappedDecimals] = await Promise.all([code(io, 'l2', wrapped, 'latest', 'L2 token'), read<[Address, bigint]>(io, 'l2', network.contracts.bridgeL2.address, 'wrappedTokenInfo', [wrapped]),
      read<Address>(io, 'l2', wrapped, 'BRIDGE'), read<number>(io, 'l2', wrapped, 'decimals')]);
    check(same(origin[0], token) && origin[1] === 0n && same(authority, network.contracts.bridgeL2.address) && wrappedDecimals === 6, 'Wrapped token origin, bridge authority or decimals do not match.');
    wrappedBinding = { chain: 'l2', address: binding.address, hash: binding.hash };
  }
  const binding = ({ chain, address, hash }: typeof asset) => ({ chain, address, hash });
  return { ...network, discovered: { symbol: symbol.trim(), kind: demo ? 'demo' : 'erc20', ...(!same(implAddress, zeroAddress) ? { implementation: { address: impl.address, slot: !same(eip, zeroAddress) ? EIP1967_IMPLEMENTATION_SLOT : USDC_IMPLEMENTATION_SLOT } } : {}) },
    contracts: { ...network.contracts, usdcProxy: binding(asset), usdcImplementation: binding(impl), wrappedUSDC: wrappedBinding } };
}
export async function validateDiscoveredToken(io: IO, network: SetupNetwork) {
  const current = await discoverToken(io, network, getAddress(network.contracts.usdcProxy.address), true, network.discovered);
  check(JSON.stringify(current.contracts) === JSON.stringify(network.contracts) && JSON.stringify(current.discovered) === JSON.stringify(network.discovered), 'Token code or configuration changed since setup.');
}
export async function validateDiscoveredNetwork(io: IO, network: SetupNetwork) {
  await Promise.all([validateInfrastructure(io, network), validateDiscoveredToken(io, network)]);
}
