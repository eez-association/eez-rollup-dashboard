import { encodeFunctionData, parseAbi } from "viem";
import type { TreasuryConfig } from "./client.ts";
import { checkedPayment, paymentTransaction } from "./payments.ts";
import type { Payment, PaymentDeployment } from "./payments.ts";
import { buildSafeTransaction } from "./safeTransactions.ts";

type LegacyFixed = Omit<Extract<Payment, { kind?: "fixed" }>, "fromL1"> & { funding: "local" | "combined" };
export type RecordedPayment = Payment | LegacyFixed;
type OldDeployment = PaymentDeployment & { abiVersion?: 2; exactSplits?: boolean; combinedL2?: boolean; l1Initiation?: boolean };
const oldAbi = parseAbi([
  "function paySplit(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch,uint256 fromL1)",
  "function pay(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch)",
  "function payRouted(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch)",
]);
const splitAbi = parseAbi(["function paySplit(address recipient,uint256 amount,bool onL1,uint256 expectedEpoch,uint256 fromL1)"]);

/** Version is an immutable contract interface, not a feature switch. Old
 * manifests are read without rewriting storage or changing the deployed policy. */
export function paymentVersion(p: PaymentDeployment): 0 | 1 | 2 {
  const old = p as OldDeployment;
  return p.version ?? (old.exactSplits ? old.abiVersion ?? 1 : 0);
}
export const verifiesL1Initiation = (p: PaymentDeployment) => p.version !== undefined ? p.version > 0 : (p as OldDeployment).l1Initiation === true;
export const verifiesReverseFunding = (p: PaymentDeployment) => p.version !== undefined ? p.version > 0 : (p as OldDeployment).combinedL2 === true;
export function readPaymentDeployment(value: PaymentDeployment): PaymentDeployment {
  const p = value as OldDeployment;
  for (const key of ["exactSplits", "combinedL2", "l1Initiation"] as const)
    if (p[key] !== undefined && typeof p[key] !== "boolean") throw new Error("Invalid saved payment capability");
  if (p.abiVersion !== undefined && (p.abiVersion !== 2 || !p.exactSplits)) throw new Error("Invalid payment ABI version");
  if (p.version !== undefined && ![0, 1, 2].includes(p.version)) throw new Error("Invalid payment interface version");
  const version = paymentVersion(p);
  if (![0, 1, 2].includes(version) || p.version !== undefined && (p.abiVersion !== undefined || p.exactSplits !== undefined
      || p.combinedL2 !== undefined || p.l1Initiation !== undefined)) throw new Error("Conflicting payment interface versions");
  return value;
}
/** v1 signs a fixed epoch; v2 signs an optional deadline (zero is unlimited).
 * Never reinterpret old approvals as non-expiring payments. */
export function paymentAuthorizationTime(deployment: PaymentDeployment, p: Payment): bigint {
  if (deployment.pair?.version === 2) {
    if (p.deadline === undefined) throw new Error("This policy requires an explicit deadline; use 0 for no expiry");
    return BigInt(p.deadline);
  }
  if (p.deadline !== undefined) throw new Error("This deployed policy still uses period-bound approvals");
  return BigInt(p.epoch);
}
export function encodeSplitPayment(deployment: PaymentDeployment, p: Extract<Payment, { kind?: "fixed" }>) {
  const version = paymentVersion(deployment);
  if (version === 0) throw new Error("This payment requires a treasury created with the current setup");
  const args = [p.recipient, BigInt(p.amount), p.destination === "l1", paymentAuthorizationTime(deployment, p), BigInt(p.fromL1)] as const;
  return version === 2 ? encodeFunctionData({ abi: splitAbi, functionName: "paySplit", args })
    : encodeFunctionData({ abi: oldAbi, functionName: "paySplit", args: [deployment.tokenL1, ...args] });
}
/** Validate a saved shape without normalizing the stored object: its signatures,
 * transaction identity and history must survive reload byte for byte. */
export function checkedRecordedPayment(value: RecordedPayment): RecordedPayment {
  const p = value as RecordedPayment & { funding?: string };
  if (p && "funding" in p) {
    const { funding, ...plain } = p;
    if (funding === "split" || p.kind === "transfer" && funding === "local" || p.kind === "invoice" && funding === "combined") {
      checkedPayment(plain as Payment); return value;
    }
    if ((p.kind === undefined || p.kind === "fixed") && ["local", "combined"].includes(funding!) && !("fromL1" in p)) {
      checkedPayment({ ...plain, fromL1: "0" } as Payment); return value;
    }
    throw new Error("Invalid saved payment review");
  }
  return checkedPayment(value as Payment);
}
export function recordedPaymentTransaction(c: TreasuryConfig, input: RecordedPayment, nonce: bigint) {
  const p = checkedRecordedPayment(input);
  if ("funding" in p && (p.kind === undefined || p.kind === "fixed") && !("fromL1" in p)) {
    if (!c.payments) throw new Error("Missing recorded payment deployment");
    const source = p.source ?? "l2";
    return buildSafeTransaction({ chainId: BigInt(c[source].chainId), safe: source === "l1" ? c.safeL1 : c.safeL2,
      to: source === "l1" ? c.payments.alias : c.payments.policy, nonce,
      data: encodeFunctionData({ abi: oldAbi, functionName: p.funding === "local" ? "pay" : "payRouted",
        args: [c.payments.tokenL1, p.recipient, BigInt(p.amount), p.destination === "l1", BigInt(p.epoch)] }) });
  }
  const { funding, ...plain } = p as RecordedPayment & { funding?: string };
  return paymentTransaction(c, plain as Payment, nonce);
}
