import { parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { TreasuryClient } from "./client.ts";
import { allowanceAbi, contractRead, moduleAbi, tokenAbi } from "./payments.ts";

export const pairedPolicyAbi = parseAbi([
  "function PAIR_VERSION() view returns(uint256)", "function PERIOD() view returns(uint256)",
  "function GLOBAL_LIMIT() view returns(uint256)", "function active() view returns(bool)",
  "function token() view returns(address)", "function allowanceModule() view returns(address)",
  "function manager() view returns(address)", "function l2RollupId() view returns(uint64)",
  "function peerSafe() view returns(address)", "function localAliasOnPeer() view returns(address)",
  "function payFromPeer(address recipient,uint256 amount,bool onL1,uint256 epochOrDeadline,uint256 fromL1)",
  "function configuration() view returns((address safe,address canonicalToken,address bridge,address remoteBridge,uint64 localRollupId,uint64 l2RollupId,address peerPolicy,address peerProxy))",
]);
const registryAbi = parseAbi([
  "function computeCrossChainProxyAddress(address,uint64) view returns(address)",
  "function authorizedProxies(address) view returns(bool,address,uint64)",
]);
type Configuration = { safe: Address; canonicalToken: Address; bridge: Address; remoteBridge: Address;
  localRollupId: bigint; l2RollupId: bigint; peerPolicy: Address; peerProxy: Address };
type Block = { number: Hex; hash: Hex };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

/** Client-side deployment verification. The contracts themselves validate these
 * immutable pair bindings only during setup, not on every payment. */
export async function validatePairedPayments(client: TreasuryClient) {
  const c = client.config, p = c.payments!, pair = p.pair!;
  const blocks = await Promise.all((["l1", "l2"] as const).map(chain => client.rpc<Block>(c[chain].rpc, "eth_getBlockByNumber", ["latest", false])));
  check(blocks.every(b => b?.number && b.hash), "Paired policy observations are unavailable");
  const rollup = c.mainnet ? BigInt(c.mainnet.rollupId) : await contractRead(client, "l2", p.policy, pairedPolicyAbi, "l2RollupId", [], blocks[1]!.number) as bigint;
  const registered = async (chain: "l1" | "l2", proxy: Address, original: Address, origin: bigint, tag: Hex) => {
    const manager = chain === "l1" ? c.registry : c.manager;
    const expected = await contractRead(client, chain, manager, registryAbi, "computeCrossChainProxyAddress", [original, origin], tag) as Address;
    const [valid, owner, source] = await contractRead(client, chain, manager, registryAbi, "authorizedProxies", [proxy], tag) as [boolean, Address, bigint];
    check(same(expected, proxy) && valid && same(owner, original) && source === origin, "Paired policy proxy identity changed");
  };
  for (const [i, chain] of (["l1", "l2"] as const).entries()) {
    const onL1 = chain === "l1", tag = blocks[i]!.number;
    const policy = onL1 ? pair.policyL1 : p.policy, safe = onL1 ? c.safeL1 : c.safeL2;
    const module = onL1 ? p.moduleL1 : p.moduleL2, token = onL1 ? p.tokenL1 : p.tokenL2;
    const peerPolicy = onL1 ? p.policy : pair.policyL1, peerProxy = onL1 ? p.alias : pair.peerProxyL2;
    const read = (method: string) => contractRead(client, chain, policy, pairedPolicyAbi, method, [], tag);
    const cfg = await read("configuration") as Configuration;
    check(same(cfg.safe, safe) && same(cfg.canonicalToken, p.tokenL1)
      && same(cfg.bridge, onL1 ? p.bridgeL1 : p.bridgeL2) && same(cfg.remoteBridge, onL1 ? p.bridgeL2 : p.bridgeL1)
      && cfg.localRollupId === (onL1 ? 0n : rollup) && cfg.l2RollupId === rollup
      && same(cfg.peerPolicy, peerPolicy) && same(cfg.peerProxy, peerProxy), "Paired policy configuration changed");
    const [version, active, period, limit, asset, allowance, manager, peerSafe, ownAlias] = await Promise.all([
      read("PAIR_VERSION"), read("active"), read("PERIOD"), read("GLOBAL_LIMIT"), read("token"),
      read("allowanceModule"), read("manager"), read("peerSafe"), read("localAliasOnPeer"),
    ]);
    check(version === BigInt(pair.version) && active === true && period === 600n && limit === 150_000_000n
      && same(asset as string, token) && same(allowance as string, module) && same(manager as string, onL1 ? c.registry : c.manager)
      && same(peerSafe as string, onL1 ? c.safeL2 : c.safeL1) && same(ownAlias as string, onL1 ? pair.peerProxyL2 : p.alias), "Paired policy activation or local bindings changed");
    const [enabled, decimals, grant] = await Promise.all([
      contractRead(client, chain, safe, moduleAbi, "isModuleEnabled", [module], tag),
      contractRead(client, chain, token, tokenAbi, "decimals", [], tag),
      contractRead(client, chain, module, allowanceAbi, "getTokenAllowance", [safe, policy, token], tag),
    ]);
    const a = grant as readonly bigint[];
    check(enabled === true && decimals === 6 && a[0] === 100_000_000n && a[2] === 10n && a[3]! % 10n === 0n,
      "Paired Safe allowance configuration changed");
    await registered(chain, peerProxy, peerPolicy, onL1 ? rollup : 0n, tag);
  }
  await registered("l1", p.safeL2Alias!, c.safeL2, rollup, blocks[0]!.number);
  for (const [i, chain] of (["l1", "l2"] as const).entries())
    check((await client.rpc<Block>(c[chain].rpc, "eth_getBlockByNumber", [blocks[i]!.number, false]))?.hash === blocks[i]!.hash,
      "Paired policy observations changed; retry validation");
}
