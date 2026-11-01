import { concatHex, encodeFunctionData, getAddress, keccak256, parseAbi, size, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { DeploymentIO } from "./deploymentIO.ts";

export type SetupChain = "l1" | "l2";
export type SafeInspection = {
  address: Address; singleton: Address; proxyHash: Hex; singletonHash: Hex;
  owners: Address[]; threshold: number; nonce: string; block: Hex;
  signableOwners: Address[]; modules: Address[]; moreModules: boolean;
  adapter?: { address: Address; safeL1: Address; manager: Address };
};
export const SAFE_GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const SAFE_MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";
// Reviewed proxy builds whose executable bodies differ from the Treasury artifact.
// Bind full runtime hashes; VERSION() or a recognized singleton alone cannot authenticate a proxy.
const reviewedProxyHashes = new Set<Hex>([
  // Published @safe-global/safe-smart-account@1.5.0 SafeProxy.
  "0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f",
  // SafeProxy used by FalconSafeFactory; also pinned in Falcon's deployment bindings.
  "0xb30ba1e3d8e15fff550f82025529177dabc8e791b5473a8f0e66d5f6f08bffbf",
]);
const sentinel = getAddress("0x0000000000000000000000000000000000000001");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const canonicalSingletons = new Map<Hex, string>([
  // Official safe-deployments e9cc9798: 1.4.1 Safe/SafeL2 and 1.3.0 GnosisSafe/GnosisSafeL2.
  // Safe apps label the latter "1.3.0+L2"; VERSION() still returns "1.3.0".
  ["0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4", "1.4.1"],
  ["0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff", "1.4.1"],
  ["0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e", "1.3.0"],
  ["0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f", "1.3.0"],
  // Official safe-deployments 8e200b0b4c72dbbfe371cbd61b3a21ae2ec4af62: Safe/SafeL2 1.5.0.
  ["0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2", "1.5.0"],
  ["0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc", "1.5.0"],
]);
export function supportedSafeVersion(version: unknown, chain: SetupChain) {
  // L1 1.5 retains legacy checkSignatures for EOA quorums. A 1.5 mirror instead
  // calls modern ERC-1271, which the current L1Owners adapter does not implement.
  return version === "1.3.0" || version === "1.4.1" || chain === "l1" && version === "1.5.0";
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** SafeProxy always terminates before its compiler metadata. Accept the same
 * executable proxy body across builds, while binding the complete observed hash.
 * Singleton execution code must match a reviewed build or an official code hash.
 */
export function executableCode(code: Hex): Hex {
  const bytes = size(code);
  if (bytes < 3) return code;
  const length = Number.parseInt(code.slice(-4), 16);
  const from = bytes - length - 2;
  if (length < 4 || from <= 0 || code.slice(2 + from * 2 - 2, 2 + from * 2).toLowerCase() !== "fe") return code;
  if (!/^a[1-9a-f]/i.test(code.slice(2 + from * 2))) return code;
  return code.slice(0, 2 + from * 2) as Hex;
}
export function matchingSafeCode(code: Hex, expected: Hex) { return code !== "0x" && executableCode(code).toLowerCase() === executableCode(expected).toLowerCase(); }
export function ownerFingerprint(owners: readonly Address[], threshold: number) {
  return `${threshold}:${owners.map(a => a.toLowerCase()).join(",")}`;
}

/** Inspect a real Safe at one canonical block; version() alone is insufficient. */
export async function inspectSafe(d: Pick<DeploymentIO, "artifacts" | "rpc" | "read" | "runtimeMatches">, chain: SetupChain, address: Address): Promise<SafeInspection> {
  const block = await d.rpc<{ number: Hex; hash: Hex }>(chain, "eth_getBlockByNumber", ["latest", false]);
  check(block, "Canonical Safe state is unavailable");
  const [proxy, slot, guard] = await Promise.all([
    d.rpc<Hex>(chain, "eth_getCode", [address, block.number]),
    d.rpc<Hex>(chain, "eth_getStorageAt", [address, "0x0", block.number]),
    d.rpc<Hex>(chain, "eth_getStorageAt", [address, SAFE_GUARD_SLOT, block.number]),
  ]);
  check(matchingSafeCode(proxy, d.artifacts.contracts.SafeProxy!.runtime) || reviewedProxyHashes.has(keccak256(proxy)), "This address is not a supported Safe proxy");
  const singleton = getAddress(`0x${slot.slice(-40)}`);
  const code = await d.rpc<Hex>(chain, "eth_getCode", [singleton, block.number]);
  const implementationVersion = canonicalSingletons.get(keccak256(code))
    ?? (["Safe", "SafeL2"].some(name => matchingSafeCode(code, d.artifacts.contracts[name]!.runtime)) ? "1.4.1" : undefined);
  check(implementationVersion, "Unsupported Safe implementation. Reuse supports verified Safe / SafeL2 1.3.0, 1.4.1 and 1.5.0");
  check(supportedSafeVersion(implementationVersion, chain), "EEZ-X mirrors require Safe 1.3.0 or 1.4.1 with the current owner adapter");
  if (implementationVersion === "1.5.0") {
    const moduleGuard = await d.rpc<Hex>(chain, "eth_getStorageAt", [address, SAFE_MODULE_GUARD_SLOT, block.number]);
    check(BigInt(moduleGuard) === 0n, "This Safe has a module Guard. Setup will not remove it; use an unguarded Safe");
  }
  check(BigInt(guard) === 0n, "This Safe has a transaction Guard. Setup will not remove it; use an unguarded Safe");
  const [version, owners, threshold, nonce, modules] = await Promise.all([
    d.read<string>(chain, address, "Safe", "VERSION", [], block.number),
    d.read<Address[]>(chain, address, "Safe", "getOwners", [], block.number),
    d.read<bigint>(chain, address, "Safe", "getThreshold", [], block.number),
    d.read<bigint>(chain, address, "Safe", "nonce", [], block.number),
    d.read<[Address[], Address]>(chain, address, "Safe", "getModulesPaginated", [sentinel, 50n], block.number),
  ]);
  check(version === implementationVersion, "Safe version does not match its verified implementation");
  check(owners.length > 0 && owners.length <= 50 && threshold > 0n && threshold <= BigInt(owners.length), "Unsupported Safe owners or threshold");
  const ownerCode = await Promise.all(owners.map(owner => d.rpc<Hex>(chain, "eth_getCode", [owner, block.number])));
  const signableOwners = owners.filter((_, i) => ownerCode[i] === "0x" || /^0xef0100[\da-f]{40}$/i.test(ownerCode[i]!));
  let adapter: SafeInspection["adapter"];
  if (chain === "l2" && owners.length === 1 && threshold === 1n && ["L1Owners", "LegacyL1Owners"].some(name =>
    d.artifacts.contracts[name] && d.runtimeMatches(ownerCode[0]!, name))) {
    const [safeL1, manager, safeL1Proxy] = await Promise.all([
      d.read<Address>(chain, owners[0]!, "L1Owners", "safeL1", [], block.number),
      d.read<Address>(chain, owners[0]!, "L1Owners", "manager", [], block.number),
      d.read<Address>(chain, owners[0]!, "L1Owners", "safeL1Proxy", [], block.number),
    ]);
    const expectedProxy = await d.read<Address>(chain, manager, "Registry", "computeCrossChainProxyAddress", [safeL1, 0n], block.number);
    check(same(safeL1Proxy, expectedProxy), "Owner adapter's L1 Safe proxy binding is invalid");
    const [registration, proxyCode] = await Promise.all([
      d.read<[boolean, Address, bigint]>(chain, manager, "Registry", "authorizedProxies", [safeL1Proxy], block.number),
      d.rpc<Hex>(chain, "eth_getCode", [safeL1Proxy, block.number]),
    ]);
    check(registration[0] && same(registration[1], safeL1) && registration[2] === 0n && proxyCode !== "0x", "Owner adapter's L1 Safe proxy is not registered");
    adapter = { address: owners[0]!, safeL1, manager };
  }
  check(adapter || signableOwners.length >= Number(threshold), owners.length === 1
    ? `This Safe is controlled by contract ${owners[0]}. This setup cannot collect contract-owner signatures; authorize changes through the existing owner.`
    : "This Safe requires contract-owner signatures that this setup UI cannot collect");
  const again = await d.rpc<{ hash: Hex }>(chain, "eth_getBlockByNumber", [block.number, false]);
  check(again?.hash === block.hash, "Safe state changed during inspection; review again");
  return { address: getAddress(address), singleton, proxyHash: keccak256(proxy), singletonHash: keccak256(code),
    owners, threshold: Number(threshold), nonce: String(nonce), block: block.number, signableOwners,
    modules: modules[0], moreModules: !same(modules[1], sentinel), ...(adapter ? { adapter } : {}) };
}

/** Call-only batches keep the Safe's address, balances, modules and handler.
 * Removing the old list and installing the L1 adapter happens in one transaction
 * authorized by the old quorum, so no intermediate owner set is observable.
 */
export function adoptL1Owners(safe: Address, owners: readonly Address[], adapter: Address): Hex {
  check(owners.length > 0 && owners.length <= 50 && !owners.some(o => same(o, adapter)), "Owner migration needs a fresh adapter and a valid owner list");
  const abi = parseAbi(["function removeOwner(address,address,uint256)", "function swapOwner(address,address,address)"]);
  const calls: Hex[] = [];
  for (const owner of owners.slice(0, -1)) calls.push(encodeFunctionData({ abi, functionName: "removeOwner", args: [sentinel, owner, 1n] }));
  calls.push(encodeFunctionData({ abi, functionName: "swapOwner", args: [sentinel, owners[owners.length - 1]!, adapter] }));
  return packSafeCalls(calls.map(data => ({ to: safe, data })));
}

/** All inner operations are CALL with zero native value. The outer Safe delegates
 * to the verified helper so Safe self-administration and module calls retain
 * the Safe as msg.sender; a generic wallet multicall cannot provide that identity.
 */
export function packSafeCalls(calls: readonly { to: Address; data: Hex }[]) {
  return concatHex(calls.map(({ to, data }) => concatHex(["0x00", to, toHex(0n, { size: 32 }), toHex(size(data), { size: 32 }), data])));
}
