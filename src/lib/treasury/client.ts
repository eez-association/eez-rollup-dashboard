import { treasuryRpc } from "./rpcTransport.ts";
import pairedTestnet from './paired-testnet-network.json' with { type: 'json' };
import { validatePairedPayments } from "./pairedPolicy.ts";
import { readPaymentDeployment, paymentVersion, recordedPaymentTransaction, verifiesL1Initiation, verifiesReverseFunding } from "./savedPayments.ts";
import type { RecordedPayment } from "./savedPayments.ts";
import { verifyTransferHelper, transferRollup } from "./transfers.ts";
import { parseMainnetBindings, validateMainnet } from "./mainnet.ts";
import type { MainnetBindings } from "./mainnet.ts";
import { decodeSafeExecution, safeExecutionTopics } from "./safeEvents.ts";
import { supportedSafeVersion } from "./safeSetup.ts";
import { mirrorRelayOutcome } from "./mirrorRelay.ts";
import { l1PaymentOutcome } from "./l1Payments.ts";
import { quoteCrossChainFees } from "../fees/payment.mjs";
import { invoiceAbi, invoiceEvidence, verifyInvoiceRollback } from "./invoices.ts";
import type { Rollback } from "./invoices.ts";
import { paymentTransaction, settledPayment, contractRead, paymentAbi, tokenAbi, moduleAbi, treasuryBridgeAbi } from "./payments.ts";
import type { Payment, PaymentDeployment, PaymentContributions } from "./payments.ts";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import { probeComposer } from "../composerDiscovery.ts";
import { buildSafeTransaction, encodeSafeExecution, l1OwnersAbi, packOwnerApprovals, packEOAApprovals, safeTransactionHash, safeTypedDataJSON } from "./safeTransactions.ts";
import type { ReviewedSafeTransaction } from "./safeTransactions.ts";

export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)", "function VERSION() view returns (string)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)", "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
export const actionAbi = parseAbi(["function value() view returns (uint256)", "function safe() view returns (address)", "function setValue(uint256 next)"]);
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export type TreasuryChain = { chainId: number; rpc: string; front?: string; genesis?: Hex; checkpoint?: { number: Hex; hash: Hex }; explorer?: string };
export type TreasuryConfig = {
  version: 1; environment: "isolated-devnet" | "dashboard-testnet" | "ethereum-mainnet"; instance: string;
  mainnet?: MainnetBindings;
  l1: TreasuryChain; l2: TreasuryChain & { front: string };
  fees?: { maxTotalWei: string; l1MaxTotalWei?: string };
  safeImplementations?: { l1: Address; l2: Address };
  protocol?: { chain: "l1" | "l2"; proxy: Address; implementation: Address }[];
  registry: Address; manager: Address; safeL1: Address; safeL2: Address; adapter: Address; action?: Address;
  code: { chain: "l1" | "l2"; address: Address; hash: Hex }[];
  ownerLabels: Record<string, string>;
  safeAppUrl?: string;
  payments?: PaymentDeployment;
  previousPayments?: PaymentDeployment;
  olderPayments?: PaymentDeployment[];
};
export function parseTreasuryConfig(value: unknown): TreasuryConfig {
  const c = value as TreasuryConfig;
  requireThat(c && c.version === 1 && ["isolated-devnet", "dashboard-testnet", "ethereum-mainnet"].includes(c.environment) && hash(c.instance), "Unsupported treasury environment configuration");
  for (const key of ["registry", "manager", "safeL1", "safeL2", "adapter"] as const)
    requireThat(typeof c[key] === "string" && isAddress(c[key]) && BigInt(c[key]) !== 0n, `Invalid treasury ${key}`);
  requireThat(c.action === undefined ? !!c.payments : typeof c.action === "string" && isAddress(c.action) && BigInt(c.action) !== 0n, "Invalid treasury action");
  for (const chain of [c.l1, c.l2]) {
    requireThat(chain && Number.isSafeInteger(chain.chainId) && (chain.chainId > 1 || c.environment === "ethereum-mainnet" && chain === c.l1 && chain.chainId === 1), "Invalid treasury chain identity");
    requireThat(hash(chain.genesis) && !chain.checkpoint || c.environment !== "isolated-devnet" && !chain.genesis
      && chain.checkpoint && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(chain.checkpoint.number) && hash(chain.checkpoint.hash), "Invalid treasury chain reference");
    if (chain.explorer !== undefined) {
      const explorer = new URL(chain.explorer);
      requireThat(explorer.protocol === "https:" && !explorer.username && !explorer.password && !explorer.search && !explorer.hash, "Invalid treasury explorer URL");
    }
    for (const endpoint of [chain.rpc, ...(chain.front ? [chain.front] : [])]) {
      requireThat(typeof endpoint === "string", "Missing treasury RPC");
      const url = new URL(endpoint);
      requireThat((url.protocol === "http:" && url.hostname === "127.0.0.1" || c.environment !== "isolated-devnet" && url.protocol === "https:")
        && !url.username && !url.password && !url.hash, "Treasury RPC must use loopback HTTP or HTTPS");
    }
  }
  requireThat(typeof c.l2.front === "string" && c.l2.front.length > 0, "Missing L2 Composer endpoint");
  requireThat(c.l1.chainId !== c.l2.chainId && Array.isArray(c.code) && c.code.length >= 4, "Incomplete treasury bindings");
  for (const binding of c.code) requireThat(["l1", "l2"].includes(binding.chain) && isAddress(binding.address) && hash(binding.hash), "Invalid code binding");
  for (const [chain, address] of [["l1", c.safeL1], ["l2", c.safeL2], ["l2", c.adapter], ...(c.action ? [["l2", c.action] as const] : [])] as const)
    requireThat(c.code.some(b => b.chain === chain && same(b.address, address)), "Missing application code identity");
  if (c.environment !== "isolated-devnet") {
    if (c.environment === "dashboard-testnet") requireThat(c.l1.chainId === pairedTestnet.chains.l1.chainId && c.l2.chainId === (c.payments?.pair ? pairedTestnet.chains.l2.chainId : 906969), "Unsupported dashboard testnet pair");
    requireThat(c.fees && /^[1-9]\d{0,77}$/.test(c.fees.maxTotalWei), "Dashboard treasury requires a fee reservation limit");
    requireThat(Array.isArray(c.protocol) && c.protocol.length === 2, "Shared treasury requires protocol implementation bindings");
    for (const chain of ["l1", "l2"] as const) {
      const binding = c.protocol.find(p => p.chain === chain);
      requireThat(binding && isAddress(binding.proxy) && isAddress(binding.implementation)
        && same(binding.proxy, chain === "l1" ? c.registry : c.manager)
        && c.code.some(b => b.chain === chain && same(b.address, binding.proxy))
        && c.code.some(b => b.chain === chain && same(b.address, binding.implementation)), "Invalid protocol implementation binding");
    }
    requireThat(c.payments?.invoiceControl === undefined && c.payments?.invoiceMerchant === undefined, "Invoice fixture controls are isolated-devnet only");
  }
  if (c.safeImplementations) for (const chain of ["l1", "l2"] as const)
    requireThat(isAddress(c.safeImplementations[chain]) && c.code.some(b => b.chain === chain && same(b.address, c.safeImplementations![chain])), "Missing Safe implementation code binding");
  if (c.payments) {
    const p = readPaymentDeployment(c.payments);
    requireThat(c.environment === "isolated-devnet" || p.bridgeKind === "standard" || p.aliasReaderL1, "Shared-network payments require an L1 alias reader");
    if (p.aliasReaderL1 !== undefined) requireThat(isAddress(p.aliasReaderL1) && BigInt(p.aliasReaderL1) !== 0n
      && c.code.some(b => b.chain === "l1" && same(b.address, p.aliasReaderL1!)), "Invalid alias reader identity");
    if (p.invoiceMerchant !== undefined) {
      requireThat(isAddress(p.invoiceMerchant) && BigInt(p.invoiceMerchant) !== 0n && c.code.some(b => b.chain === "l1" && same(b.address, p.invoiceMerchant!)), "Invalid invoice merchant identity");
    }
    if (p.invoiceControl !== undefined) {
      const url = new URL(p.invoiceControl);
      requireThat(p.invoiceMerchant && url.origin === new URL(c.l2.rpc).origin && url.pathname === "/treasury-fixture/invoices" && !url.search && !url.hash && !url.username && !url.password, "Invalid invoice fixture endpoint");
    }
    requireThat(p.bridgeKind === undefined || p.bridgeKind === "standard", "Unsupported bridge profile");
    if (p.bridgeKind === "standard") {
      requireThat(verifiesL1Initiation(p) && verifiesReverseFunding(p) && p.safeL2Alias && isAddress(p.safeL2Alias)
        && c.code.some(b => b.chain === "l1" && same(b.address, p.safeL2Alias!)), "Missing standard bridge relay identity");
      if (p.pair) {
        requireThat(p.pair.version === 1 && p.version === 2 && isAddress(p.pair.policyL1) && BigInt(p.pair.policyL1) > 1n
          && isAddress(p.pair.peerProxyL2) && BigInt(p.pair.peerProxyL2) > 1n && !p.bridgeExecutorL1 && !p.predecessor && !p.aliasReaderL1 && !p.invoiceMerchant
          && c.code.some(b => b.chain === "l1" && same(b.address, p.pair!.policyL1))
          && c.code.some(b => b.chain === "l2" && same(b.address, p.pair!.peerProxyL2)), "Invalid paired policy identity");
      } else requireThat(p.bridgeExecutorL1 && isAddress(p.bridgeExecutorL1)
        && c.code.some(b => b.chain === "l1" && same(b.address, p.bridgeExecutorL1!)), "Missing standard bridge executor identity");
    } else requireThat(p.pair === undefined && p.safeL2Alias === undefined && p.bridgeExecutorL1 === undefined, "Unexpected mirror relay identity");
    if (verifiesL1Initiation(p)) requireThat(c.l1.front && (!c.fees || /^[1-9]\d{0,77}$/.test(c.fees.l1MaxTotalWei ?? "")), "Missing L1 Composer or fee configuration");
    requireThat(p.decimals === 6 && p.period === 600 && p.globalLimit === "150000000" && (c.environment === "isolated-devnet" ? p.assetLabel === "Devnet USDC" : c.environment === "ethereum-mainnet" ? p.assetLabel === "USDC" : p.assetLabel === "Test USDC"), "Unsupported payment configuration");
    for (const key of ["policy", "alias", "tokenL1", "tokenL2", "moduleL1", "moduleL2", "bridgeL1", "bridgeL2", "recipient"] as const)
      requireThat(isAddress(p[key]) && BigInt(p[key]) !== 0n, `Invalid payment ${key}`);
    for (const [chain, keys] of [["l1", ["alias", "tokenL1", "moduleL1", "bridgeL1"]], ["l2", ["policy", "tokenL2", "moduleL2", "bridgeL2"]]] as const)
      for (const key of keys) requireThat(c.code.some(b => b.chain === chain && same(b.address, p[key])), `Missing payment code identity: ${key}`);
  }
  requireThat(c.olderPayments === undefined || Array.isArray(c.olderPayments) && c.olderPayments.length <= 8 && c.previousPayments, "Invalid older policy history");
  if (c.previousPayments !== undefined || c.payments?.predecessor !== undefined) {
    requireThat(c.previousPayments && (c.payments && verifiesL1Initiation(c.payments))
      && same(c.payments.predecessor ?? "", c.previousPayments.policy)
      && !same(c.payments.policy, c.previousPayments.policy), "Invalid previous policy binding");
    const policies = [c.payments, c.previousPayments, ...(c.olderPayments ?? [])];
    requireThat(new Set(policies.map(p => p.policy.toLowerCase())).size === policies.length, "Repeated historical policy");
    for (const key of ["tokenL1", "tokenL2", "moduleL1", "moduleL2", "bridgeL1", "bridgeL2", "aliasReaderL1"] as const)
      requireThat(c.payments[key] === c.previousPayments[key], "Upgrade changed the treasury infrastructure");
    parseTreasuryConfig({ ...c, payments: c.previousPayments, previousPayments: c.olderPayments?.[0],
      olderPayments: (c.olderPayments?.length ?? 0) > 1 ? c.olderPayments!.slice(1) : undefined });
  }
  if (c.safeAppUrl !== undefined) {
    const url = new URL(c.safeAppUrl);
    const valid = c.environment === "isolated-devnet"
      ? url.protocol === "http:" && url.hostname === "127.0.0.1" && url.searchParams.get("safe")?.toLowerCase() === `trl1:${c.safeL1.toLowerCase()}`
      : url.origin === "https://app.safe.global" && url.searchParams.get("safe")?.toLowerCase() === `${c.environment === "ethereum-mainnet" ? "eth" : "chiado"}:${c.safeL1.toLowerCase()}`;
    requireThat(valid && !url.username && !url.password, "Invalid L1 Safe app link");
  }
  if (c.environment === "ethereum-mainnet") parseMainnetBindings(c);
  else requireThat(c.mainnet === undefined, "Mainnet bindings cannot be used on a test network");
  return c;
}
/** A shared-network manifest must match the dashboard's selected network and fee settings. */
export function requireDashboardTreasury(c: TreasuryConfig, dashboard: {
  l1ChainId: string; l2ChainId: string; l1Rpc: string; l2Rpc: string; l2Front: string; l1Front?: string;
  registry: string; manager: string; feesEnabled: boolean; maxTotalWei: string; l1FeesEnabled?: boolean; l1MaxTotalWei?: string;
}) {
  if (c.environment === "isolated-devnet") return;
  requireThat(BigInt(c.l1.chainId) === BigInt(dashboard.l1ChainId) && BigInt(c.l2.chainId) === BigInt(dashboard.l2ChainId)
    && same(c.registry, dashboard.registry) && same(c.manager, dashboard.manager), "Treasury does not match the dashboard network");
  for (const [actual, expected] of [[c.l1.rpc, dashboard.l1Rpc], [c.l2.rpc, dashboard.l2Rpc], [c.l2.front, dashboard.l2Front], ...((c.payments && verifiesL1Initiation(c.payments)) ? [[c.l1.front, dashboard.l1Front]] : [])])
    requireThat(new URL(actual!).href === new URL(expected!).href, "Treasury must use the dashboard RPC endpoints");
  requireThat(dashboard.feesEnabled && c.fees?.maxTotalWei === dashboard.maxTotalWei, "Treasury fees do not match the dashboard settings");
  if ((c.payments && verifiesL1Initiation(c.payments))) requireThat(dashboard.l1FeesEnabled && c.fees?.l1MaxTotalWei === dashboard.l1MaxTotalWei, "Treasury L1 fees do not match the dashboard settings");
}
export type Snapshot = { source?: "l1" | "l2"; owners: Address[]; threshold: number; nonce: bigint; value: bigint; l1Block: string; fingerprint: string };
export type Approval = { owner: Address; signature: Hex };
export type Intent = { submissionChain?: "l1" | "l2"; version: 1; instance: string; value: string; nonce: string; safeHash: Hex; data: Hex; sender: Address; sourceNonce: Hex; startBlock: Hex; l2StartBlock?: Hex; hash?: Hex; payment?: RecordedPayment };
export type Outcome = { kind: "pending" | "settled" | "rejected" | "unknown"; detail: string; rejectionStage?: "preparation" | "execution"; block?: string; sourceBlock?: string; hash?: Hex; execution?: { l1?: Hex; l2?: Hex }; contributions?: PaymentContributions; rollback?: Rollback };
type Block = { number: Hex; hash: Hex; baseFeePerGas: Hex };
type Receipt = { status: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[] };
export function unchanged(a: Snapshot, b: Snapshot) { return (a.source ?? "l2") === (b.source ?? "l2") && a.nonce === b.nonce && a.fingerprint === b.fingerprint; }
export function actionTransaction(c: TreasuryConfig, value: string, nonce: bigint) {
  requireThat(c.action, "This treasury has no owner-action fixture; use a payment");
  requireThat(/^\d{1,78}$/.test(value) && BigInt(value) < 1n << 256n, "Enter a whole number from 0 to 2²⁵⁶ − 1");
  return buildSafeTransaction({ chainId: BigInt(c.l2.chainId), safe: c.safeL2, to: c.action,
    data: encodeFunctionData({ abi: actionAbi, functionName: "setValue", args: [BigInt(value)] }), nonce });
}
/** Persist the submitted identity before opening the wallet. A missing response
 * is unresolved, not permission to submit another transaction after reload. */
export function readIntent(c: TreasuryConfig, text: string | null): Intent | null {
  if (text === null) return null;
  const i = JSON.parse(text) as Intent;
  requireThat(i.version === 1 && i.instance === c.instance && hash(i.safeHash) && (!i.hash || hash(i.hash)) && isAddress(i.sender)
    && /^0x[\da-f]+$/i.test(i.sourceNonce) && /^0x[\da-f]+$/i.test(i.startBlock) && /^0x(?:[\da-f]{2})+$/i.test(i.data)
    && /^\d{1,78}$/.test(i.nonce), "Saved submission is invalid; keep its wallet transaction hash for recovery");
  requireThat(safeTransactionHash(i.payment ? recordedPaymentTransaction(c, i.payment, BigInt(i.nonce)) : actionTransaction(c, i.value, BigInt(i.nonce))) === i.safeHash, "Saved Safe transaction does not match this treasury deployment");
  requireThat(!(i.payment?.source === "l1" || c.payments?.bridgeKind === "standard") || /^0x[\da-f]+$/i.test(i.l2StartBlock ?? ""), "Missing L2 observation for the saved L1 payment");
  const transport = c.payments?.bridgeKind === "standard" ? "l1" : i.payment?.source ?? "l2";
  requireThat(i.submissionChain === undefined || i.submissionChain === transport, "Saved submission network does not match this treasury");
  requireThat(c.payments?.bridgeKind !== "standard" || i.submissionChain === "l1", "Missing Ethereum relay identity");
  return i;
}
/** A historical failed request can outlive Composer's diagnostic queue. Both
 * canonical nonces must have advanced before missing queue data can retire it.
 * This only closes the request; separate trace/state evidence must prove rollback. */
export async function canonicalRequestRetired(client: TreasuryClient, intent: Intent): Promise<boolean> {
  const c = client.config;
  const block = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]);
  requireThat(block, "Canonical request observation is unavailable");
  const [safeNonce, sourceNonce] = await Promise.all([
    client.read(c.l2.rpc, c.safeL2, safeAbi, "nonce", block.number),
    client.rpc<Hex>(c.l2.rpc, "eth_getTransactionCount", [intent.sender, block.number]),
  ]);
  const again = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [block.number, false]);
  requireThat(again?.hash === block.hash, "Canonical request observation changed during verification");
  return typeof safeNonce === "bigint" && safeNonce > BigInt(intent.nonce) && BigInt(sourceNonce) > BigInt(intent.sourceNonce);
}

export class TreasuryClient {
  readonly config: TreasuryConfig;
  constructor(config: TreasuryConfig) { this.config = config; }
  async rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
    return treasuryRpc<T>(url, method, params);
  }
  async read(url: string, address: Address, abi: typeof safeAbi | typeof actionAbi | typeof l1OwnersAbi, functionName: "getOwners" | "getThreshold" | "nonce" | "VERSION" | "safeL1" | "manager" | "safe" | "value", tag = "latest"): Promise<unknown> {
    const result = await this.rpc<Hex>(url, "eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName }) }, tag]);
    return decodeFunctionResult({ abi, functionName, data: result });
  }
  private validation?: Promise<void>;
  async validate() {
    if (this.validation) return this.validation;
    const pending = this.validateBindings(); this.validation = pending;
    try { await pending; } finally { if (this.validation === pending) this.validation = undefined; }
  }
  private async validateBindings() {
    const c = this.config;
    await Promise.all((["l1", "l2"] as const).map(async name => {
      const chain = c[name];
      const [id, genesis] = await Promise.all([this.rpc<Hex>(chain.rpc, "eth_chainId"), this.rpc<Block>(chain.rpc, "eth_getBlockByNumber", [chain.checkpoint?.number ?? "0x0", false])]);
      requireThat(BigInt(id) === BigInt(chain.chainId) && genesis && same(genesis.hash, chain.checkpoint?.hash ?? chain.genesis!), "Network identity changed; reconnect to the current deployment");
    }));
    await Promise.all(c.code.map(async binding => {
      const code = await this.rpc<Hex>(c[binding.chain].rpc, "eth_getCode", [binding.address, "latest"]);
      requireThat(code !== "0x" && keccak256(code) === binding.hash, "Deployed contract code does not match this treasury deployment");
    }));
    for (const binding of c.protocol ?? []) {
      const slot = await this.rpc<Hex>(c[binding.chain].rpc, "eth_getStorageAt", [binding.proxy,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]);
      requireThat(same(`0x${slot.slice(-40)}`, binding.implementation), "Protocol implementation changed; revalidate this treasury deployment");
    }
    if (c.safeImplementations) for (const chain of ["l1", "l2"] as const) {
      const slot = await this.rpc<Hex>(c[chain].rpc, "eth_getStorageAt", [chain === "l1" ? c.safeL1 : c.safeL2, "0x0", "latest"]);
      requireThat(same(`0x${slot.slice(-40)}`, c.safeImplementations[chain]), "Safe implementation changed; revalidate this treasury deployment");
    }
    const [l1Version, l2Version, owners, threshold, remote, manager, actionSafe] = await Promise.all([
      this.read(c.l1.rpc, c.safeL1, safeAbi, "VERSION"), this.read(c.l2.rpc, c.safeL2, safeAbi, "VERSION"),
      this.read(c.l2.rpc, c.safeL2, safeAbi, "getOwners"), this.read(c.l2.rpc, c.safeL2, safeAbi, "getThreshold"),
      this.read(c.l2.rpc, c.adapter, l1OwnersAbi, "safeL1"), this.read(c.l2.rpc, c.adapter, l1OwnersAbi, "manager"),
      c.action ? this.read(c.l2.rpc, c.action, actionAbi, "safe") : c.safeL2,
    ]);
    requireThat(supportedSafeVersion(l1Version, "l1") && supportedSafeVersion(l2Version, "l2") && threshold === 1n && (owners as Address[]).length === 1
      && same((owners as Address[])[0]!, c.adapter) && same(remote as string, c.safeL1) && same(manager as string, c.manager)
      && same(actionSafe as string, c.safeL2), "Safe or owner-adapter binding changed");
    await this.validatePayments();
    if (c.environment === "ethereum-mainnet") await validateMainnet(this);
  }
  async validatePayments() {
    const c = this.config, p = c.payments;
    if (!p) return;
    if (p.pair) return validatePairedPayments(this);
    const bindings = [["safeL1", c.safeL1], ["safeL2", c.safeL2], ["canonicalToken", p.tokenL1], ["wrappedToken", p.tokenL2], ["allowanceL2", p.moduleL2], ["bridge", p.bridgeL2]];
    for (const [name, expected] of bindings) requireThat(same(await contractRead(this, "l2", p.policy, paymentAbi, name!) as string, expected!), "Payment policy bindings changed");
    const [limit, period, d1, d2, m1, m2] = await Promise.all([
      contractRead(this, "l2", p.policy, paymentAbi, "GLOBAL_LIMIT"), contractRead(this, "l2", p.policy, paymentAbi, "PERIOD"),
      contractRead(this, "l1", p.tokenL1, tokenAbi, "decimals"), contractRead(this, "l2", p.tokenL2, tokenAbi, "decimals"),
      contractRead(this, "l1", c.safeL1, moduleAbi, "isModuleEnabled", [p.moduleL1]), contractRead(this, "l2", c.safeL2, moduleAbi, "isModuleEnabled", [p.moduleL2]),
    ]);
    requireThat(limit === 150_000_000n && period === 600n && d1 === 6 && d2 === 6 && m1 && m2, "Payment deployment configuration changed");
    if (p.predecessor) {
      requireThat(await contractRead(this, "l2", p.policy, paymentAbi, "active") === true
        && same(await contractRead(this, "l2", p.policy, paymentAbi, "previousPolicy") as string, p.predecessor), "Policy handover is not active");
    }
    if (verifiesL1Initiation(p)) {
      const registryAbi = parseAbi(["function computeCrossChainProxyAddress(address,uint64) view returns (address)", "function authorizedProxies(address) view returns (bool,address,uint64)"]);
      const proxy = await contractRead(this, "l2", p.policy, paymentAbi, "safeL1Proxy") as Address;
      const expected = await contractRead(this, "l2", c.manager, registryAbi, "computeCrossChainProxyAddress", [c.safeL1, 0n]) as Address;
      const [registered, original, origin] = await contractRead(this, "l2", c.manager, registryAbi, "authorizedProxies", [proxy]) as [boolean, Address, bigint];
      requireThat(same(proxy, expected) && registered && same(original, c.safeL1) && origin === 0n, "L1 Safe initiation binding changed");
    }
    if (p.bridgeKind === "standard") {
      requireThat(same(await contractRead(this, "l2", p.policy, paymentAbi, "bridgeExecutorL1") as string, p.bridgeExecutorL1!), "Bridge executor binding changed");
      const registryAbi = parseAbi(["function computeCrossChainProxyAddress(address,uint64) view returns (address)", "function authorizedProxies(address) view returns (bool,address,uint64)"]);
      const delegateAbi = parseAbi(["function safe() view returns(address)", "function policyAlias() view returns(address)",
        "function allowance() view returns(address)", "function token() view returns(address)", "function bridge() view returns(address)", "function rollupId() view returns(uint64)"]);
      for (const [name, expected] of [["safe", c.safeL1], ["policyAlias", p.alias], ["allowance", p.moduleL1], ["token", p.tokenL1], ["bridge", p.bridgeL1]])
        requireThat(same(await contractRead(this, "l1", p.bridgeExecutorL1!, delegateAbi, name!) as string, expected!), "Ethereum funding delegate binding changed");
      const rollup = await contractRead(this, "l2", p.policy, paymentAbi, "rollupId") as bigint;
      requireThat(await contractRead(this, "l1", p.bridgeExecutorL1!, delegateAbi, "rollupId") === rollup, "Ethereum funding delegate rollup changed");
      const policyAlias = await contractRead(this, "l1", c.registry, registryAbi, "computeCrossChainProxyAddress", [p.policy, rollup]) as Address;
      const [policyRegistered, policyOriginal, policyOrigin] = await contractRead(this, "l1", c.registry, registryAbi, "authorizedProxies", [p.alias]) as [boolean, Address, bigint];
      requireThat(same(policyAlias, p.alias) && policyRegistered && same(policyOriginal, p.policy) && policyOrigin === rollup, "Policy alias binding changed");
      const expected = await contractRead(this, "l1", c.registry, registryAbi, "computeCrossChainProxyAddress", [c.safeL2, rollup]) as Address;
      const [registered, original, origin] = await contractRead(this, "l1", c.registry, registryAbi, "authorizedProxies", [p.safeL2Alias!]) as [boolean, Address, bigint];
      requireThat(same(expected, p.safeL2Alias!) && registered && same(original, c.safeL2) && origin === rollup, "Mirror Safe relay binding changed");
    }
    if (p.aliasReaderL1) {
      const readerAbi = parseAbi(["function registry() view returns (address)", "function aliasOf(address,uint64) view returns (address)"]);
      requireThat(same(await contractRead(this, "l2", p.policy, paymentAbi, "aliasReaderL1") as string, p.aliasReaderL1)
        && same(await contractRead(this, "l1", p.aliasReaderL1, readerAbi, "registry") as string, c.registry), "Alias reader binding changed");
      const rollup = await contractRead(this, "l2", p.policy, paymentAbi, "rollupId") as bigint;
      requireThat(same(await contractRead(this, "l1", p.aliasReaderL1, readerAbi, "aliasOf", [p.policy, rollup]) as string, p.alias), "Policy alias changed");
    }
    if (p.invoiceMerchant) {
      requireThat(same(await contractRead(this, "l2", p.policy, paymentAbi, "invoiceMerchant") as string, p.invoiceMerchant)
        && same(await contractRead(this, "l1", p.invoiceMerchant, invoiceAbi, "token") as string, p.tokenL1)
        && same(await contractRead(this, "l1", p.invoiceMerchant, invoiceAbi, "policyAlias") as string, p.alias), "Invoice merchant bindings changed");
    }
    if (paymentVersion(p) > 0) requireThat(await contractRead(this, "l2", p.policy, paymentAbi, "SPLIT_VERSION") === BigInt(paymentVersion(p)), "Custom split configuration changed");
    if (verifiesReverseFunding(p)) {
      requireThat(same(await contractRead(this, "l2", p.policy, paymentAbi, "bridgeL1") as string, p.bridgeL1), "Reverse route bridge changed");
      const rollup = await contractRead(this, "l2", p.policy, paymentAbi, "rollupId") as bigint;
      requireThat(rollup > 0n, "Invalid reverse route rollup");
      for (const chain of ["l1", "l2"] as const) {
        const bridge = chain === "l1" ? p.bridgeL1 : p.bridgeL2;
        for (const [name, expected] of [...(p.bridgeKind === "standard" ? [] : [["canonicalToken", p.tokenL1]]), ["manager", chain === "l1" ? c.registry : c.manager],
          ["canonicalBridgeAddress", chain === "l1" ? p.bridgeL2 : p.bridgeL1]])
          requireThat(same(await contractRead(this, chain, bridge, treasuryBridgeAbi, name!) as string, expected!), "Reverse route bridge bindings changed");
        requireThat((p.bridgeKind === "standard" || await contractRead(this, chain, bridge, treasuryBridgeAbi, "treasuryRollupId") === rollup)
          && await contractRead(this, chain, bridge, treasuryBridgeAbi, "rollupId") === (chain === "l1" ? 0n : rollup), "Reverse route rollup binding changed");
      }
      requireThat(same(await contractRead(this, "l2", p.bridgeL2, treasuryBridgeAbi, "getWrappedToken", [p.tokenL1, 0n]) as string, p.tokenL2), "Reverse route wrapped asset changed");
      if (p.bridgeKind === "standard") {
        const [original, origin] = await contractRead(this, "l2", p.bridgeL2, treasuryBridgeAbi, "wrappedTokenInfo", [p.tokenL2]) as [Address, bigint];
        requireThat(same(original, p.tokenL1) && origin === 0n
          && same(await contractRead(this, "l2", p.tokenL2, treasuryBridgeAbi, "BRIDGE") as string, p.bridgeL2), "Wrapped token authority changed");
      }
    }
  }
  async snapshot(source: "l1" | "l2" = "l2"): Promise<Snapshot> {
    const c = this.config;
    const l1 = await this.rpc<Block>(c.l1.rpc, "eth_getBlockByNumber", ["latest", false]);
    const [owners, threshold, nonce, value] = await Promise.all([
      this.read(c.l1.rpc, c.safeL1, safeAbi, "getOwners", l1.number), this.read(c.l1.rpc, c.safeL1, safeAbi, "getThreshold", l1.number),
      this.read(c[source].rpc, source === "l1" ? c.safeL1 : c.safeL2, safeAbi, "nonce", source === "l1" ? l1.number : "latest"), c.action ? this.read(c.l2.rpc, c.action, actionAbi, "value", "safe") : 0n,
    ]);
    const again = await this.rpc<Block>(c.l1.rpc, "eth_getBlockByNumber", [l1.number, false]);
    requireThat(again.hash === l1.hash, "L1 changed while reading owners; refresh again");
    const sorted = (owners as Address[]).map(owner => getAddress(owner)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const count = Number(threshold);
    requireThat(count > 0 && count <= sorted.length, "Invalid L1 Safe threshold");
    return { source, owners: sorted, threshold: count, nonce: nonce as bigint, value: value as bigint, l1Block: String(BigInt(l1.number)), fingerprint: `${count}:${sorted.join(",").toLowerCase()}` };
  }
  private async walletIdentity(provider: EthereumProvider, expectedAddress?: string, source: "l1" | "l2" = "l2") {
    const [accounts, id] = await Promise.all([
      provider.request({ method: "eth_accounts" }) as Promise<string[]>,
      provider.request({ method: "eth_chainId" }) as Promise<string>,
    ]);
    requireThat(accounts[0] && (!expectedAddress || same(accounts[0], expectedAddress)), "Wallet account changed; try again with the selected owner");
    requireThat(BigInt(id) === BigInt(this.config[source].chainId), "Switch your wallet to the selected Safe’s network first");
    return getAddress(accounts[0]);
  }
  async wallet(provider: EthereumProvider, expectedAddress?: string, source: "l1" | "l2" = "l2") {
    const c = this.config, sender = await this.walletIdentity(provider, expectedAddress, source);
    const result = await probeComposer(provider, { l1ChainId: toHex(c.l1.chainId), l2ChainId: toHex(c.l2.chainId), registryAddress: c.registry, l2Address: c.manager });
    requireThat(result.status === "detected", `Wallet RPC: ${result.detail}`);
    const genesis = await provider.request({ method: "eth_getBlockByNumber", params: [c[source].checkpoint?.number ?? "0x0", false] }) as Block;
    requireThat(genesis && same(genesis.hash, c[source].checkpoint?.hash ?? c[source].genesis!), "Wallet is connected to a different treasury deployment");
    return sender;
  }
  async approve(provider: EthereumProvider, tx: ReviewedSafeTransaction, snapshot: Snapshot, address: Address): Promise<Approval> {
    const source = this.transactionSource(tx);
    // The testnet signs the immutable reviewed transaction without another
    // complete audit. Keep the production gate and delegatecall helper checks.
    if (this.config.environment === "ethereum-mainnet") await this.validate();
    if (tx.message.operation === 1) await verifyTransferHelper(this);
    requireThat((snapshot.source ?? "l2") === source && snapshot.nonce === tx.message.nonce,
      "Safe signing snapshot does not match the reviewed transaction");
    await this.walletIdentity(provider, address, source);
    requireThat(snapshot.owners.some(owner => same(owner, address)), "This wallet is not an L1 Safe owner");
    const signature = await provider.request({ method: "eth_signTypedData_v4", params: [address, safeTypedDataJSON(tx)] }) as Hex;
    await this.walletIdentity(provider, address, source);
    // Threshold 1 validates this one recovered EOA approval. The real threshold
    // is enforced when packing the complete quorum and again by the L1 Safe.
    await packEOAApprovals(tx, snapshot.owners, 1, [{ owner: address, signature }]);
    return { owner: address, signature };
  }
  transactionSource(tx: ReviewedSafeTransaction): "l1" | "l2" {
    const c = this.config;
    if (tx.domain.chainId === BigInt(c.l1.chainId) && same(tx.domain.verifyingContract, c.safeL1)) return "l1";
    requireThat(tx.domain.chainId === BigInt(c.l2.chainId) && same(tx.domain.verifyingContract, c.safeL2), "Safe signing domain does not match this treasury");
    return "l2";
  }
  /** Transport does not change the owners' Safe signing domain or nonce. */
  submissionSource(tx: ReviewedSafeTransaction): "l1" | "l2" {
    return this.config.payments?.bridgeKind === "standard" ? "l1" : this.transactionSource(tx);
  }
  async prepare(provider: EthereumProvider, tx: ReviewedSafeTransaction, snapshot: Snapshot, approvals: Approval[], payment?: Payment): Promise<{ intent: Intent; request: Record<string, string>; expiresAt?: string }> {
    const c = this.config, source = this.transactionSource(tx), transport = this.submissionSource(tx), chain = c[transport];
    requireThat(source === "l2" || payment?.source === "l1", "L1 initiation requires a reviewed payment");
    await this.validate();
    requireThat(unchanged(snapshot, await this.snapshot(source)), "Owners or Safe nonce changed. Review the action again.");
    if (payment) requireThat(safeTransactionHash(paymentTransaction(c, payment, tx.message.nonce)) === safeTransactionHash(tx), "Payment changed after review");
    if (payment?.kind === "transfer") {
      await verifyTransferHelper(this);
      requireThat(payment.rollupId === await transferRollup(this), "The bridge destination changed. Review the transfer again.");
    }
    const sender = await this.wallet(provider, undefined, transport);
    const packed = source === "l1" ? await packEOAApprovals(tx, snapshot.owners, snapshot.threshold, approvals)
      : await packOwnerApprovals(tx, c.adapter, snapshot.owners, snapshot.threshold, approvals);
    const data = encodeSafeExecution(tx, packed), safe = source === "l1" ? c.safeL1 : transport === "l1" ? c.payments!.safeL2Alias! : c.safeL2;
    const [sourceNonce, block, l2Block] = await Promise.all([
      this.rpc<Hex>(chain.rpc, "eth_getTransactionCount", [sender, "pending"]), this.rpc<Block>(chain.rpc, "eth_getBlockByNumber", ["latest", false]),
      transport === "l1" ? this.rpc<Block>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]) : undefined,
    ]);
    // Plain estimateGas lacks the EEZ tables. The isolated fixture uses its tested
    // ceiling; shared networks require a Composer fee quote for the source chain.
    let request: Record<string, string> = { from: sender, to: safe, data, value: "0x0", chainId: toHex(chain.chainId), nonce: sourceNonce,
      gas: toHex(8_000_000n), maxPriorityFeePerGas: toHex(1_000_000_000n), maxFeePerGas: toHex(2n * BigInt(block.baseFeePerGas) + 1_000_000_000n) };
    let expiresAt: string | undefined;
    if (c.fees) {
      const quote = await quoteCrossChainFees({ tx: { to: safe, data, value: "0x0", nonce: sourceNonce },
        from: sender, chainId: toHex(chain.chainId), wallet: provider,
        rpc: (method, params) => this.rpc(chain.front!, method, params), maxTotalFee: BigInt(transport === "l1" ? c.fees.l1MaxTotalWei! : c.fees.maxTotalWei) });
      request = quote.transaction; expiresAt = quote.expiresAt;
    }
    const next = payment ? "0" : BigInt(`0x${tx.message.data.slice(10)}`).toString();
    requireThat(transport !== "l1" || l2Block, "Canonical L2 observation unavailable");
    return { intent: { version: 1, instance: c.instance, value: next, nonce: String(tx.message.nonce), safeHash: safeTransactionHash(tx), data,
      sender, sourceNonce, startBlock: block.number, ...(c.payments?.bridgeKind === "standard" ? { submissionChain: transport } : {}), ...(l2Block ? { l2StartBlock: l2Block.number } : {}), ...(payment ? { payment } : {}) }, request, ...(expiresAt ? { expiresAt } : {}) };
  }
  async outcome(intent: Intent): Promise<Outcome> {
    if (intent.payment?.source === "l1") return l1PaymentOutcome(this, intent);
    if (this.config.payments?.bridgeKind === "standard") return mirrorRelayOutcome(this, intent);
    const c = this.config;
    let txHash = intent.hash;
    if (!txHash) {
      // Recover a lost wallet response from Safe execution logs. Absence of a
      // log is not rejection; queued work and lost responses remain unresolved.
      const logs = await this.rpc<Receipt["logs"][number][]>(c.l2.rpc, "eth_getLogs", [{ address: c.safeL2, fromBlock: intent.startBlock, toBlock: "latest", topics: [safeExecutionTopics] }]);
      for (const log of logs) {
        if (same(log.address, c.safeL2) && decodeSafeExecution(log)?.args.txHash === intent.safeHash)
          txHash = (log as typeof log & { transactionHash: Hex }).transactionHash;
      }
      if (!txHash) return { kind: "unknown", detail: "No transaction hash yet. Check wallet activity; this action will not be resubmitted automatically." };
    }
    const [receipt, status] = await Promise.all([
      this.rpc<Receipt | null>(c.l2.rpc, "eth_getTransactionReceipt", [txHash]),
      // Request ownership is a Composer API; the chain RPC only provides execution evidence.
      this.rpc<{ lifecycle?: string; ownership?: { reason?: string } } | null>(c.l2.front, "eez_getCrossChainTransaction", [txHash]),
    ]);
    if (receipt) {
      const [safe, block, transaction] = await Promise.all([
        this.rpc<Block>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]),
        this.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
        this.rpc<{ from: string; to: string; input: string }>(c.l2.rpc, "eth_getTransactionByHash", [txHash]),
      ]);
      requireThat(transaction && same(transaction.from, intent.sender) && same(transaction.to, c.safeL2) && same(transaction.input, intent.data), "Transaction hash does not match this reviewed action");
      if (safe && BigInt(safe.number) >= BigInt(receipt.blockNumber) && block?.hash === receipt.blockHash) {
        const success = receipt.logs.some(log => {
          if (!same(log.address, c.safeL2)) return false;
          const event = decodeSafeExecution(log);
          return event?.eventName === "ExecutionSuccess" && event.args.txHash === intent.safeHash;
        });
        const contributions = intent.payment ? settledPayment(c, intent.payment, receipt.logs) : undefined;
        requireThat(!intent.payment || !success || contributions, "Safe succeeded without the expected payment event; investigate this transaction");
        return { contributions, execution: { l2: txHash }, kind: receipt.status === "0x1" && success ? "settled" : "rejected", hash: txHash,
          block: String(BigInt(receipt.blockNumber)), rejectionStage: receipt.status === "0x1" && success ? undefined : "execution", detail: receipt.status === "0x1" && success ? "Settled on L1. Safe execution is in the canonical L2 safe chain." : "Canonical transaction failed; the Safe action did not succeed." };
      }
      return { kind: "pending", hash: txHash, detail: "Executed speculatively. Waiting for canonical L1 settlement." };
    }
    const reason = status?.ownership?.reason;
    if (intent.payment?.kind === "invoice") {
      const report = await invoiceEvidence(this, intent);
      if (report?.phase === "verified") {
        const disposed = status?.lifecycle === "terminal" && ["PoolDiscarded", "AttemptsExhausted", "NonceGap"].includes(reason ?? "");
        if (!disposed && !await canonicalRequestRetired(this, intent))
          return { kind: "pending", hash: txHash, detail: "L1 payment effects rolled back. Waiting for Composer to finish reconciliation." };
        const rollback = await verifyInvoiceRollback(this, intent, report);
        return { kind: "rejected", hash: txHash, rollback, detail: "Rollback verified at L1 settlement. Both payment legs executed before invoice rejection; no payment funds or budget were consumed." };
      }
      if (report?.phase === "unverified" && status?.lifecycle === "terminal" && ["PoolDiscarded", "AttemptsExhausted", "NonceGap"].includes(reason ?? ""))
        return { kind: "rejected", hash: txHash, detail: `Composer ended this request (${reason}). The fixture did not verify the intended rollback: ${report.detail}` };
      if (report && ["armed", "executing", "unverified"].includes(report.phase))
        return { kind: "pending", hash: txHash, detail: report.phase === "unverified" ? `Invoice outcome remains unverified: ${report.detail}` : "Invoice payment is being checked for canonical rollback evidence." };
      if (status?.lifecycle === "terminal" && reason === "PoolDiscarded" && report?.mode === "preparation"
          && report.phase === "open" && report.id === intent.payment.invoiceId && report.amount === intent.payment.amount
          && report.recipient?.toLowerCase() === intent.payment.recipient.toLowerCase())
        return { kind: "rejected", hash: txHash, rejectionStage: "preparation", detail: "Rejected during preparation: the fixture closed this invoice before submission. Composer discarded the request; no L1 rollback is claimed." };
    }
    if (status?.lifecycle === "terminal" && ["PoolDiscarded", "AttemptsExhausted", "NonceGap"].includes(reason ?? ""))
      return { kind: "rejected", hash: txHash, detail: `Composer ended this request (${reason}). Refresh owners and nonce before a new review.` };
    return { kind: "pending", hash: txHash, detail: status ? "Composer accepted the request. Waiting for canonical settlement." : "Outcome unresolved. Checking the submitted hash; no automatic resubmission." };
  }
}
