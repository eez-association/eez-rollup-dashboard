import { checkedRecordedPayment, encodeSplitPayment, verifiesL1Initiation } from "./savedPayments.ts";
import type { RecordedPayment } from "./savedPayments.ts";
import { transferTransaction } from "./transfers.ts";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { buildSafeTransaction } from "./safeTransactions.ts";
import type { TreasuryClient, TreasuryConfig } from "./client.ts";

export type PaymentDeployment = {
  version?: 0 | 1 | 2;
  pair?: { version: 1 | 2; policyL1: Address; peerProxyL2: Address };
  bridgeKind?: "standard"; bridgeExecutorL1?: Address; safeL2Alias?: Address;
  predecessor?: Address; aliasReaderL1?: Address; policy: Address; alias: Address; tokenL1: Address; tokenL2: Address; moduleL1: Address; moduleL2: Address;
  bridgeL1: Address; bridgeL2: Address; invoiceMerchant?: Address; invoiceControl?: string; recipient: Address; decimals: 6; period: 600; globalLimit: "150000000"; assetLabel: "Devnet USDC" | "Test USDC" | "USDC" };
// For pair v2, epoch is display metadata; only deadline is signed as the time condition.
type PaymentIdentity = { source?: "l1" | "l2"; recipient: Address; destination: "l1" | "l2"; epoch: string; deadline?: string };
// Missing kind is the existing fixed-payment format, including saved submissions.
export type Payment = PaymentIdentity & (
  { kind?: "fixed"; amount: string; fromL1: string } |
  { kind: "transfer"; source: "l1"; destination: "l2"; amount: string; rollupId: string } |
  { kind: "invoice"; invoiceId: Hex; amount: string; destination: "l1" }
);
export type PaymentContributions = { fromL1: string; fromL2: string };
export type PaymentState = { observedTimestamp?: bigint; epoch: bigint; resetsAt: number; observedL1: string; observedL2: string; balanceL1: bigint; balanceL2: bigint;
  allowanceL1: readonly bigint[]; allowanceL2: readonly bigint[]; spent: bigint; globalLimit: bigint };
export const paymentAbi = parseAbi([
  "function bridgeExecutorL1() view returns(address)",
  "function SPLIT_VERSION() view returns (uint256)",
  "function paySplit(address recipient,uint256 amount,bool onL1,uint256 epochOrDeadline,uint256 fromL1)",
  "function payInvoice(address token,address recipient,uint256 amount,bytes32 invoiceId,uint256 expectedEpoch)",
  "function invoiceMerchant() view returns (address)",
  "event InvoicePaid(bytes32 indexed invoiceId)",
  "function active() view returns (bool)", "function previousPolicy() view returns (address)",
  "function carriedSpending(uint256) view returns (uint256,uint256)",
  "function safeL1Proxy() view returns (address)",
  "event L1PaymentAuthorized(uint256 indexed safeNonce,bytes32 indexed callHash)",
  "function spent(uint256) view returns (uint256)", "function aliasReaderL1() view returns (address)", "function safeL1() view returns (address)", "function safeL2() view returns (address)",
  "function canonicalToken() view returns (address)", "function wrappedToken() view returns (address)",
  "function allowanceL2() view returns (address)", "function bridge() view returns (address)",
  "function bridgeL1() view returns (address)", "function rollupId() view returns (uint64)",
  "function GLOBAL_LIMIT() view returns (uint256)", "function PERIOD() view returns (uint256)",
  "event Paid(address indexed token,address indexed recipient,bool onL1,uint256 amount,uint256 fromL1,uint256 fromL2,uint256 epoch)",
  "error GlobalLimit()", "error Capacity()", "error StaleEpoch()", "error PaymentExpired()",
]);
export const treasuryBridgeAbi = parseAbi([
  "function wrappedTokenInfo(address) view returns (address,uint64)", "function BRIDGE() view returns(address)",
  "function canonicalToken() view returns (address)", "function treasuryRollupId() view returns (uint64)",
  "function rollupId() view returns (uint64)", "function manager() view returns (address)",
  "function canonicalBridgeAddress() view returns (address)", "function getWrappedToken(address,uint64) view returns (address)",
]);
export const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
export const allowanceAbi = parseAbi(["function getTokenAllowance(address safe,address delegate,address token) view returns (uint256[5])"]);
export const moduleAbi = parseAbi(["function isModuleEnabled(address) view returns (bool)"]);
export function parseUSDC(text: string): bigint {
  if (!/^\d{1,20}(?:\.\d{1,6})?$/.test(text)) throw new Error("Enter a positive USDC amount with at most 6 decimals");
  const [whole, fraction = ""] = text.split(".");
  const value = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (value <= 0n || value > 150_000_000n) throw new Error("A payment must be greater than 0 and at most 150 USDC");
  return value;
}
export function formatUSDC(value: bigint) {
  const whole = value / 1_000_000n, fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
export function formatPercentage(bps: bigint) {
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${bps / 100n}${fraction ? `.${fraction}` : ""}`;
}
export function checkedPayment(p: Payment): Payment {
  if (!p || (p.source !== undefined && !["l1", "l2"].includes(p.source)) || !isAddress(p.recipient) || BigInt(p.recipient) === 0n || !["l1", "l2"].includes(p.destination)
      || "funding" in p || !/^\d{1,16}$/.test(p.epoch)) throw new Error("Invalid payment review");
  if (p.deadline !== undefined && (typeof p.deadline !== "string" || !/^(0|[1-9]\d{0,77})$/.test(p.deadline)
    || BigInt(p.deadline) >= 1n << 256n || p.kind === "transfer" || p.kind === "invoice")) throw new Error("Invalid optional payment deadline");
  if (p.kind === "transfer") {
    if (p.source !== "l1" || p.destination !== "l2" || "fromL1" in p || "bps" in p || "invoiceId" in p
      || !/^[1-9]\d{0,77}$/.test(p.amount) || BigInt(p.amount) >= 1n << 256n
      || !/^[1-9]\d{0,19}$/.test(p.rollupId) || BigInt(p.rollupId) >= 1n << 64n) throw new Error("Invalid Safe transfer");
    return Object.freeze({ ...p, recipient: getAddress(p.recipient) });
  }
  if ((p.kind !== undefined && p.kind !== "fixed" && p.kind !== "invoice") || "bps" in p || !/^\d{1,9}$/.test(p.amount)
      || BigInt(p.amount) < 1n || BigInt(p.amount) > 150_000_000n) throw new Error("Invalid fixed payment review");
  if (p.kind !== "invoice") {
    if (typeof p.fromL1 !== "string" || !/^\d{1,9}$/.test(p.fromL1) || BigInt(p.fromL1) > BigInt(p.amount))
      throw new Error("Invalid Safe contributions");
  } else if ("fromL1" in p) throw new Error("Unexpected Safe contribution");
  if (p.kind === "invoice") {
    if (p.destination !== "l1" || !/^0x[\da-f]{64}$/i.test(p.invoiceId) || BigInt(p.invoiceId) === 0n)
      throw new Error("Invalid invoice payment");
  } else if ("invoiceId" in p) throw new Error("Unexpected invoice condition");
  return Object.freeze({ ...p, recipient: getAddress(p.recipient) });
}
export function paymentTransaction(c: TreasuryConfig, input: Payment, nonce: bigint) {
  const p = checkedPayment(input);
  if (!c.payments) throw new Error("Payments are not deployed on this deployment");
  if (p.kind === "transfer") return transferTransaction(c, p, nonce);
  if ([c.safeL1, c.safeL2, c.payments.policy, c.payments.alias, c.payments.bridgeL1, c.payments.bridgeL2, c.payments.bridgeExecutorL1, c.payments.pair?.policyL1, c.payments.pair?.peerProxyL2].some(a => a?.toLowerCase() === p.recipient.toLowerCase()))
    throw new Error("Payments cannot target this treasury’s contracts. Choose Move to EEZ-X Safe to transfer between your Safes.");
  if (p.kind === "invoice" && !c.payments.invoiceMerchant) throw new Error("This devnet does not support invoice payments");
  const data = p.kind === "invoice"
    ? encodeFunctionData({ abi: paymentAbi, functionName: "payInvoice", args: [c.payments.tokenL1, p.recipient, BigInt(p.amount), p.invoiceId, BigInt(p.epoch)] })
    : encodeSplitPayment(c.payments, p);
  const source = p.source ?? "l2";
  if (source === "l1" && (!verifiesL1Initiation(c.payments) || !c.l1.front)) throw new Error("This policy supports initiation from EEZ-X only");
  return buildSafeTransaction({ chainId: BigInt(c[source].chainId), safe: source === "l1" ? c.safeL1 : c.safeL2,
    to: source === "l1" ? (c.payments.pair?.policyL1 ?? c.payments.alias) : c.payments.policy, nonce, data });
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
export const remaining = (a: readonly bigint[]) => a[0]! > a[1]! ? a[0]! - a[1]! : 0n;
export function defaultSplit(s: PaymentState, amount: bigint, destination: "l1" | "l2") {
  return destination === "l1" ? min(amount, min(s.balanceL1, remaining(s.allowanceL1)))
    : amount - min(amount, min(s.balanceL2, remaining(s.allowanceL2)));
}
export function fundingPreview(s: PaymentState, p: Payment) {
  p = checkedPayment(p);
  if (p.kind === "transfer") {
    const amount = BigInt(p.amount);
    if (amount > s.balanceL1) throw new Error("Insufficient balance in the source Safe");
    return { fromL1: amount, fromL2: 0n };
  }
  const amount = BigInt(p.amount);
  if (p.deadline === undefined && BigInt(p.epoch) !== s.epoch) throw new Error("The budget period changed. Review the payment again.");
  if (p.deadline !== undefined && BigInt(p.deadline) !== 0n && s.observedTimestamp !== undefined && BigInt(p.deadline) < s.observedTimestamp)
    throw new Error("The payment deadline expired. Review the payment again.");
  if (s.spent + amount > s.globalLimit) throw new Error(`Shared budget exceeded: ${formatUSDC(s.globalLimit - s.spent)} USDC remains globally`);
  const cap1 = min(s.balanceL1, remaining(s.allowanceL1)), cap2 = min(s.balanceL2, remaining(s.allowanceL2));
  const fromL1 = p.kind === "invoice" ? min(amount, cap1) : BigInt(p.fromL1);
  const fromL2 = amount - fromL1;
  if (fromL1 > cap1 || fromL2 > cap2) throw new Error("Insufficient balance or Safe allowance for this funding route");
  return { fromL1, fromL2 };
}
export async function contractRead(client: TreasuryClient, chain: "l1" | "l2", address: Address, abi: readonly unknown[], name: string, args: readonly unknown[] = [], tag = "latest") {
  const data = encodeFunctionData({ abi, functionName: name, args });
  const result = await client.rpc<Hex>(client.config[chain].rpc, "eth_call", [{ to: address, data }, tag]);
  return decodeFunctionResult({ abi, functionName: name, data: result });
}
/** Payments use settled L2 state; setup can verify newly included configuration
 * against latest state without waiting for the safe checkpoint. */
export async function paymentState(client: TreasuryClient, l2Tag: "safe" | "latest" = "safe"): Promise<PaymentState> {
  const c = client.config, p = c.payments!;
  const [l1, l2] = await Promise.all((["l1", "l2"] as const).map(chain => client.rpc<{ number: Hex; hash: Hex; timestamp: Hex }>(c[chain].rpc, "eth_getBlockByNumber", [chain === "l1" ? "latest" : l2Tag, false])));
  if (!l1 || !l2) throw new Error("Missing payment chain observation");
  // v1 approvals bind the current L1 period. v2 approvals bind only a deadline:
  // quote each allowance at its observed local period and the shared budget at
  // L2's observed period. Execution checks the then-current capacity again.
  const executionPeriods = p.pair?.version === 2;
  const epoch = BigInt(executionPeriods ? l2.timestamp : l1.timestamp) / 600n;
  const localEpochs = executionPeriods ? [BigInt(l1.timestamp) / 600n, BigInt(l2.timestamp) / 600n] : [epoch, epoch];
  if (BigInt(l2.timestamp) / 600n > epoch) throw new Error("Waiting for L1 to reach the observed L2 budget period");
  const [b1, b2, a1, a2, spent] = await Promise.all([
    contractRead(client, "l1", p.tokenL1, tokenAbi, "balanceOf", [c.safeL1], l1.number),
    contractRead(client, "l2", p.tokenL2, tokenAbi, "balanceOf", [c.safeL2], l2.number),
    contractRead(client, "l1", p.moduleL1, allowanceAbi, "getTokenAllowance", [c.safeL1, p.pair?.policyL1 ?? (p.bridgeKind === "standard" ? p.bridgeExecutorL1! : p.alias), p.tokenL1], l1.number),
    contractRead(client, "l2", p.moduleL2, allowanceAbi, "getTokenAllowance", [c.safeL2, p.policy, p.tokenL2], l2.number),
    contractRead(client, "l2", p.policy, paymentAbi, "spent", [epoch], l2.number),
  ]);
  const allowances = ([a1, a2] as (readonly bigint[])[]).map((a, i) => {
    const localEpoch = localEpochs[i]!;
    if (a[2] !== 10n || a[3]! % 10n !== 0n || a[3]! > localEpoch * 10n)
      throw new Error("Safe allowance periods do not match the shared budget");
    // AllowanceModule.getAllowance resets on load, without a storage write.
    // Apply that same aligned reset to historical L2 reads; preserve the grant
    // and nonce, and never change the actual settled token balances.
    return a[3]! < localEpoch * 10n ? [a[0]!, 0n, a[2]!, localEpoch * 10n, a[4]!] : a;
  });
  if (p.predecessor) {
    const carried = await contractRead(client, "l2", p.policy, paymentAbi, "carriedSpending", [epoch], l2.number) as readonly bigint[];
    for (let i = 0; i < 2; i++) allowances[i] = allowances[i]!.map((value, index) => index === 1 ? value + carried[i]! : value);
  }
  const again = await Promise.all((["l1", "l2"] as const).map((chain, i) => client.rpc<{ hash: Hex }>(c[chain].rpc, "eth_getBlockByNumber", [[l1, l2][i]!.number, false])));
  if (again[0]?.hash !== l1.hash || again[1]?.hash !== l2.hash) throw new Error("Chain state changed while reading payment capacity");
  return { observedTimestamp: BigInt(l1.timestamp) > BigInt(l2.timestamp) ? BigInt(l1.timestamp) : BigInt(l2.timestamp), epoch, resetsAt: Number((epoch + 1n) * 600n), observedL1: String(BigInt(l1.number)), observedL2: String(BigInt(l2.number)),
    balanceL1: b1 as bigint, balanceL2: b2 as bigint, allowanceL1: allowances[0]!, allowanceL2: allowances[1]!, spent: spent as bigint, globalLimit: 150_000_000n };
}
export function settledPayment(c: TreasuryConfig, p: RecordedPayment, logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[]): PaymentContributions | undefined {
  p = checkedRecordedPayment(p);
  const emittingPolicy = c.payments!.pair && p.source === "l1" ? c.payments!.pair.policyL1 : c.payments!.policy;
  const events = logs.flatMap(log => {
    if (log.address.toLowerCase() !== emittingPolicy.toLowerCase()) return [];
    try { return [decodeEventLog({ abi: paymentAbi, ...log })]; } catch { return []; }
  });
  const invoices = events.filter(event => event.eventName === "InvoicePaid");
  if (p.kind === "invoice" ? invoices.length !== 1 || invoices[0]!.args.invoiceId !== p.invoiceId : invoices.length !== 0) return undefined;
  const paid = events.filter(event => event.eventName === "Paid");
  if (paid.length !== 1) return undefined;
  const a = paid[0]!.args;
  const identity = (event: { token: Address; recipient: Address; onL1: boolean; epoch: bigint }) =>
    event.token.toLowerCase() === c.payments!.tokenL1.toLowerCase() && event.recipient.toLowerCase() === p.recipient.toLowerCase()
    && event.onL1 === (p.destination === "l1") && (c.payments!.pair?.version === 2 ? p.deadline !== undefined : event.epoch === BigInt(p.epoch));
  if (!identity(a) || a.amount === 0n || a.amount > 150_000_000n || a.fromL1 + a.fromL2 !== a.amount) return undefined;
  if ("fromL1" in p && a.fromL1 !== BigInt(p.fromL1)) return undefined;
  const contributions = { fromL1: String(a.fromL1), fromL2: String(a.fromL2) };
  return a.amount === BigInt(p.amount) ? contributions : undefined;
}
