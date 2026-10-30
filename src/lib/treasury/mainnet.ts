import pairedTestnet from './paired-testnet-network.json' with { type: 'json' };
import { pairedPolicyAbi } from "./pairedPolicy.ts";
import { paymentVersion, verifiesL1Initiation, verifiesReverseFunding } from "./savedPayments.ts";
import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, parseAbi, toHex, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import type { TreasuryClient, TreasuryConfig } from "./client.ts";
import { matchesRuntime } from "./runtimeCode.ts";

// Circle's Ethereum deployment, not a token discovered by its symbol.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
// Circle's legacy Zeppelin proxy uses this slot, not EIP-1967.
export const USDC_IMPLEMENTATION_SLOT = keccak256(toHex("org.zeppelinos.proxy.implementation"));
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
type BridgeImplementation = { kind: "immutable" } | { kind: "eip1967"; address: Address };
export type MainnetBindings = {
  rollupId: number;
  usdcImplementation: Address;
  bridgeImplementations: { l1: BridgeImplementation; l2: BridgeImplementation };
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
/** Explorer links are optional on dashboard-discovered networks, including
 * local deployments served over HTTP. Validate before any setup transaction. */
export function treasuryExplorerUrl(value: string | undefined, dashboardNetwork = false): string | undefined {
  if (value === undefined || dashboardNetwork && value.trim() === '') return undefined;
  const url = new URL(value);
  check((url.protocol === 'https:' || dashboardNetwork && url.protocol === 'http:')
    && !url.username && !url.password && !url.search && !url.hash, 'Invalid treasury explorer URL');
  return value;
}
const address = (a: unknown): a is Address => typeof a === "string" && isAddress(a) && BigInt(a) > 1n;
function bound(c: TreasuryConfig, chain: "l1" | "l2", a: Address) {
  return c.code.some(b => b.chain === chain && same(b.address, a));
}

/** Explicit bindings keep the testnet wizard and its journals out of mainnet.
 * Hashes are reviewed operator inputs; matching them is not a security audit. */
export function parseMainnetBindings(c: TreasuryConfig) {
  const m = c.mainnet, p = c.payments;
  check(c.l1.chainId === 1 && c.l2.chainId > 1 && c.l2.chainId !== 906969 && c.l2.chainId !== pairedTestnet.chains.l2.chainId && c.l2.chainId !== 10200,
    "Mainnet requires Ethereum and a separately configured Ethereum-anchored EEZ network");
  check(m && Number.isSafeInteger(m.rollupId) && m.rollupId > 0 && address(m.usdcImplementation), "Missing mainnet deployment bindings");
  check(c.safeImplementations && !c.action && p && !p.invoiceMerchant && !p.invoiceControl,
    "Mainnet requires existing Safe implementations and payments without demo fixtures");
  check(p.tokenL1 && same(p.tokenL1, ETHEREUM_USDC) && p.assetLabel === "USDC", "Mainnet requires Circle's Ethereum USDC");
  check(p.bridgeKind === "standard" && p.safeL2Alias, "Mainnet requires the standard bridge and mirror Safe relay profile");
  check(paymentVersion(p) > 0 && verifiesL1Initiation(p) && verifiesReverseFunding(p),
    "Mainnet treasury requires the bidirectional split policy");
  check(bound(c, "l1", m.usdcImplementation), "Missing USDC implementation code identity");
  for (const chain of ["l1", "l2"] as const) {
    const b = m.bridgeImplementations?.[chain];
    check(b && (b.kind === "immutable" || b.kind === "eip1967" && address(b.address) && bound(c, chain, b.address)),
      "Missing bridge implementation identity");
    const explorer = c[chain].explorer;
    check(typeof explorer === "string", "Mainnet requires explicit explorers for both chains");
    const url = new URL(explorer);
    check(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
      "Invalid mainnet explorer URL");
  }
  check(c.code.length <= 128 && new Set(c.code.map(b => `${b.chain}:${b.address.toLowerCase()}`)).size === c.code.length,
    "Duplicate or excessive mainnet code identities");
}

export const usdcAbi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function paused() view returns (bool)",
]);
const networkAbi = parseAbi([
  "function ROLLUP_ID() view returns (uint64)", "function MAINNET_ROLLUP_ID() view returns (uint64)",
  "function wrappedTokenInfo(address) view returns (address,uint64)", "function BRIDGE() view returns (address)",
  "function getTokenAllowance(address,address,address) view returns (uint256[5])",
]);
const policyAbi = parseAbi(["function rollupId() view returns (uint64)"]);
type Block = { number: Hex; hash: Hex };

// Fixture exclusion also ignores Solidity's trailing CBOR metadata. Via-IR
// runtimes may place data before it without SafeProxy's separating INVALID.
// This normalization only rejects known fixtures; it never approves bytecode.
function fixtureExecutable(code: Hex): Hex {
  if (code.length < 10) return code;
  const length = Number.parseInt(code.slice(-4), 16), from = code.length - 4 - length * 2;
  return length >= 4 && from > 2 && /^a[1-9a-f]/i.test(code.slice(from)) ? code.slice(0, from) as Hex : code;
}

/** Revalidate upgradeable identities and mint authority at fixed blocks. Reject
 * our known test bridges even when a manifest supplies their correct hashes.
 * Other bytecode still needs independent review and a target-network rehearsal. */
export async function validateMainnet(client: TreasuryClient) {
  const c = client.config;
  parseMainnetBindings(c);
  const p = c.payments!, m = c.mainnet!;
  const blocks = await Promise.all((["l1", "l2"] as const).map(chain => client.rpc<Block | null>(c[chain].rpc, "eth_getBlockByNumber", ["latest", false])));
  check(blocks.every(b => b?.hash && b.number), "Mainnet validation blocks are unavailable");
  const tags = { l1: blocks[0]!.number, l2: blocks[1]!.number };
  const codes = new Map<string, Hex>();
  await Promise.all(c.code.map(async b => {
    const code = await client.rpc<Hex>(c[b.chain].rpc, "eth_getCode", [b.address, tags[b.chain]]);
    check(code !== "0x" && keccak256(code) === b.hash, "Mainnet contract code changed");
    codes.set(`${b.chain}:${b.address.toLowerCase()}`, code);
  }));
  const slot = async (chain: "l1" | "l2", proxy: Address, position: Hex, expected: Address) => {
    const value = await client.rpc<Hex>(c[chain].rpc, "eth_getStorageAt", [proxy, position, tags[chain]]);
    check(/^0x[\da-f]{64}$/i.test(value) && same(`0x${value.slice(-40)}`, expected), "Mainnet proxy implementation changed; review its new code before reconnecting");
  };
  await Promise.all([
    slot("l1", p.tokenL1, USDC_IMPLEMENTATION_SLOT, m.usdcImplementation),
    ...(["l1", "l2"] as const).map(chain => slot(chain, chain === "l1" ? c.safeL1 : c.safeL2, toHex(0, { size: 32 }), c.safeImplementations![chain])),
    ...c.protocol!.map(b => slot(b.chain, b.proxy, EIP1967_IMPLEMENTATION_SLOT, b.implementation)),
    ...(["l1", "l2"] as const).map(chain => {
      const implementation = m.bridgeImplementations[chain];
      return slot(chain, chain === "l1" ? p.bridgeL1 : p.bridgeL2, EIP1967_IMPLEMENTATION_SLOT,
        implementation.kind === "eip1967" ? implementation.address : zeroAddress);
    }),
  ]);
  const { default: artifacts } = await import("./deployment-artifacts.json", { with: { type: "json" } });
  for (const chain of ["l1", "l2"] as const) {
    const bridge = chain === "l1" ? p.bridgeL1 : p.bridgeL2, implementation = m.bridgeImplementations[chain];
    const executable = implementation.kind === "eip1967" ? implementation.address : bridge;
    const code = codes.get(`${chain}:${executable.toLowerCase()}`)!;
    for (const name of ["ConfiguredTreasuryBridge", "BootstrapTreasuryBridge", "SharedTreasuryBridge"] as const) {
      const artifact = artifacts.contracts[name] as Parameters<typeof matchesRuntime>[1];
      check(!matchesRuntime(fixtureExecutable(code), { ...artifact, runtime: fixtureExecutable(artifact.runtime) }),
        "The packaged treasury bridge is test-only; configure a reviewed production bridge");
    }
  }
  const read = async (chain: "l1" | "l2", target: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
    const data = encodeFunctionData({ abi, functionName, args });
    return decodeFunctionResult({ abi, functionName, data: await client.rpc<Hex>(c[chain].rpc, "eth_call", [{ to: target, data }, tags[chain]]) });
  };
  const [symbol, decimals, paused, l1Rollup, l2Rollup, policyRollup, origin, authority, limitL1, limitL2] = await Promise.all([
    read("l1", p.tokenL1, usdcAbi, "symbol"), read("l1", p.tokenL1, usdcAbi, "decimals"), read("l1", p.tokenL1, usdcAbi, "paused"),
    read("l1", c.registry, networkAbi, "MAINNET_ROLLUP_ID"), read("l2", c.manager, networkAbi, "ROLLUP_ID"),
    read("l2", p.policy, p.pair ? pairedPolicyAbi : policyAbi, p.pair ? "l2RollupId" : "rollupId"), read("l2", p.bridgeL2, networkAbi, "wrappedTokenInfo", [p.tokenL2]),
    read("l2", p.tokenL2, networkAbi, "BRIDGE"),
    read("l1", p.moduleL1, networkAbi, "getTokenAllowance", [c.safeL1, p.pair?.policyL1 ?? p.bridgeExecutorL1!, p.tokenL1]),
    read("l2", p.moduleL2, networkAbi, "getTokenAllowance", [c.safeL2, p.policy, p.tokenL2]),
  ]);
  for (const limit of [limitL1, limitL2] as bigint[][])
    check(limit[0] === 100_000_000n && limit[2] === 10n, "Mainnet Safe spending limits must be 100 USDC per ten minutes");
  check(symbol === "USDC" && decimals === 6 && paused === false, "Ethereum USDC metadata changed or transfers are paused");
  check(l1Rollup === 0n && l2Rollup === BigInt(m.rollupId) && policyRollup === BigInt(m.rollupId), "Mainnet rollup binding changed");
  const [original, source] = origin as [Address, bigint];
  check(same(original, ETHEREUM_USDC) && source === 0n && same(authority as Address, p.bridgeL2), "Mainnet wrapped token origin or mint authority changed");
  await Promise.all((["l1", "l2"] as const).map(async (chain, i) => {
    const again = await client.rpc<Block | null>(c[chain].rpc, "eth_getBlockByNumber", [tags[chain], false]);
    check(again?.hash === blocks[i]!.hash, "Mainnet state changed during verification; retry");
  }));
  return { l1: blocks[0]!, l2: blocks[1]! };
}

export function treasuryExplorer(c: TreasuryConfig, chain: "l1" | "l2", dashboardFallback: string) {
  return c.environment === "isolated-devnet" ? "" : c[chain].explorer ?? (c.environment === "dashboard-testnet" ? dashboardFallback : "");
}

/** Exercise the same application validation used before signing, plus both
 * Composer endpoints. No provider, key or transaction submission is accepted. */
export async function mainnetPreflight(client: TreasuryClient) {
  const c = client.config;
  check(c.environment === "ethereum-mainnet", "Supply an explicit Ethereum-mainnet manifest");
  await client.validate();
  const { probeComposer } = await import("../composerDiscovery.ts");
  for (const chain of ["l1", "l2"] as const) {
    const result = await probeComposer({ request: ({ method, params }) => client.rpc(c[chain].front!, method, (params as unknown[] | undefined) ?? []) }, {
      l1ChainId: toHex(c.l1.chainId), l2ChainId: toHex(c.l2.chainId), registryAddress: c.registry, l2Address: c.manager,
    });
    check(result.status === "detected" && result.chainId === toHex(c[chain].chainId), `Mainnet ${chain} Composer does not match this deployment`);
  }
  const owners = await client.snapshot();
  const ownerCode = await Promise.all(owners.owners.map(a => client.rpc<Hex>(c.l1.rpc, "eth_getCode", [a, toHex(BigInt(owners.l1Block))])));
  const signable = ownerCode.filter(code => code === "0x" || /^0xef0100[\da-f]{40}$/i.test(code)).length;
  check(signable >= owners.threshold, "The current quorum requires contract-owner signatures that this UI cannot collect");
  return { version: 1, environment: c.environment, instance: c.instance, checkedAt: new Date().toISOString(),
    chains: { ethereum: c.l1.chainId, eez: c.l2.chainId }, rollupId: c.mainnet!.rollupId,
    safes: { ethereum: c.safeL1, eez: c.safeL2 }, asset: { ethereum: c.payments!.tokenL1, eez: c.payments!.tokenL2, decimals: 6 },
    owners: owners.owners, threshold: owners.threshold, observedOwnerBlock: owners.l1Block, code: c.code,
    configurationVerified: true, productionReady: false,
    scope: "Read-only deployment, proxy, asset, Safe and Composer checks. No payment, proof, replay, wallet-extension rehearsal or security audit." };
}
