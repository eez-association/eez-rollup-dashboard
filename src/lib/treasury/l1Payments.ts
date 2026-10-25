import { pairedPolicyAbi } from "./pairedPolicy.ts";
import { findIncomingCallEvidence } from "./mainnetSetupRelay.ts";
import { recordedPaymentTransaction } from "./savedPayments.ts";
import { transferOutcome } from "./transfers.ts";
import { encodeEventTopics, encodeFunctionData, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import type { Intent, Outcome, TreasuryClient } from "./client.ts";
import { decodeSafeExecution, safeExecutionTopics } from "./safeEvents.ts";
import { paymentAbi, settledPayment } from "./payments.ts";
import { safeTransactionHash } from "./safeTransactions.ts";

type Log = { address: Address; data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex; blockHash: Hex; blockNumber: Hex };
type Receipt = { status: Hex; blockNumber: Hex; blockHash: Hex; logs: Log[] };
type Block = { number: Hex; hash: Hex };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** An L1 Safe receipt proves source execution, not canonical L2 payment effects.
 * Paired policies require the local Paid event and exact canonical peer call.
 * Historical policies retain their authenticated L2 nonce/calldata marker.
 */
export async function l1PaymentOutcome(client: TreasuryClient, intent: Intent): Promise<Outcome> {
  const c = client.config, p = intent.payment;
  check(p?.source === "l1" && intent.l2StartBlock && c.l1.front, "Missing L1 payment tracking identity");
  const reviewed = recordedPaymentTransaction(c, p, BigInt(intent.nonce));
  check(safeTransactionHash(reviewed) === intent.safeHash, "L1 Safe transaction does not match the reviewed payment");
  let hash = intent.hash;
  if (!hash) {
    const logs = await client.rpc<Log[]>(c.l1.rpc, "eth_getLogs", [{ address: c.safeL1, fromBlock: intent.startBlock, toBlock: "latest", topics: [safeExecutionTopics] }]);
    hash = logs.find(log => same(log.address, c.safeL1) && decodeSafeExecution(log)?.args.txHash === intent.safeHash)?.transactionHash;
  }
  if (!hash) return { kind: "unknown", detail: "Waiting for the wallet transaction. This payment will not be resubmitted automatically." };
  const [receipt, status] = await Promise.all([
    client.rpc<Receipt | null>(c.l1.rpc, "eth_getTransactionReceipt", [hash]),
    client.rpc<{ lifecycle?: string; ownership?: { reason?: string } } | null>(c.l1.front, "eez_getCrossChainTransaction", [hash]),
  ]);
  if (!receipt) {
    const reason = status?.ownership?.reason;
    if (status?.lifecycle === "terminal" && ["PoolDiscarded", "AttemptsExhausted", "NonceGap"].includes(reason ?? ""))
      return { kind: "rejected", hash, detail: `Composer ended this request (${reason}). Refresh owners and nonce before a new review.` };
    return { kind: "pending", hash, detail: "Waiting for the L1 Safe transaction and cross-chain settlement." };
  }
  const [transaction, l1Block] = await Promise.all([
    client.rpc<{ from: string; to: string; input: string; nonce: Hex; value: Hex } | null>(c.l1.rpc, "eth_getTransactionByHash", [hash]),
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
  ]);
  check(transaction && same(transaction.from, intent.sender) && same(transaction.to, c.safeL1) && same(transaction.input, intent.data)
    && BigInt(transaction.nonce) === BigInt(intent.sourceNonce) && BigInt(transaction.value) === 0n, "Transaction hash does not match this reviewed L1 action");
  if (l1Block?.hash !== receipt.blockHash) return { kind: "pending", hash, detail: "L1 inclusion changed. Rechecking the submitted payment." };
  const sourceSuccess = receipt.status === "0x1" && receipt.logs.some(log => {
    if (!same(log.address, c.safeL1)) return false;
    const event = decodeSafeExecution(log);
    return event?.eventName === "ExecutionSuccess" && event.args.txHash === intent.safeHash;
  });
  if (!sourceSuccess) return { kind: "rejected", hash, sourceBlock: String(BigInt(receipt.blockNumber)), rejectionStage: "execution", detail: "The canonical L1 Safe transaction failed." };
  if (p.kind === "transfer") return transferOutcome(client, intent, hash, receipt);
  if (c.payments!.pair) {
    check(p.kind === undefined || p.kind === "fixed", "Paired policies only support fixed payments here");
    check("fromL1" in p, "Missing signed paired-policy contribution");
    const contributions = settledPayment(c, p, receipt.logs);
    check(contributions, "Missing matching local policy payment event");
    const peerData = encodeFunctionData({ abi: pairedPolicyAbi, functionName: "payFromPeer", args: [
      p.recipient, BigInt(p.amount), p.destination === "l1", BigInt(p.epoch), BigInt(p.fromL1),
    ] });
    const incoming = await findIncomingCallEvidence({
      rpc<T>(chain: "l1" | "l2", method: string, params: unknown[], front = false): Promise<T> {
        return client.rpc<T>(front ? c[chain].front! : c[chain].rpc, method, params);
      },
    }, c.payments!.policy,
      { id: "paired-payment", chain: "l1", sender: c.payments!.pair.policyL1, to: c.payments!.alias,
        nonce: intent.sourceNonce, data: peerData }, receipt, c, intent.l2StartBlock);
    if (!incoming) return { kind: "pending", hash, detail: "L1 Safe executed. Waiting for the exact peer-policy call to settle on EEZ-X." };
    return { kind: "settled", hash, contributions, execution: { l1: hash, l2: incoming.transactionHash },
      sourceBlock: String(BigInt(receipt.blockNumber)), block: String(BigInt(incoming.blockNumber)),
      detail: "The local Safe payment and exact peer-policy call are canonically settled." };
  }
  const safe = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]);
  if (!safe || BigInt(safe.number) < BigInt(intent.l2StartBlock)) return { kind: "pending", hash, detail: "L1 Safe executed. Waiting for canonical L2 payment evidence." };
  const topics = encodeEventTopics({ abi: paymentAbi, eventName: "L1PaymentAuthorized", args: {
    safeNonce: BigInt(intent.nonce) + 1n, callHash: keccak256(reviewed.message.data),
  } });
  const events = await client.rpc<Log[]>(c.l2.rpc, "eth_getLogs", [{ address: c.payments!.policy, topics, fromBlock: intent.l2StartBlock, toBlock: safe.number }]);
  if (!events.length) return { kind: "pending", hash, detail: "L1 Safe executed. Waiting for canonical L2 payment evidence." };
  check(events.length === 1, "Ambiguous L1 payment evidence; keep this request for verification");
  const event = events[0]!;
  const [l2Receipt, l2Block] = await Promise.all([
    client.rpc<Receipt | null>(c.l2.rpc, "eth_getTransactionReceipt", [event.transactionHash]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [event.blockNumber, false]),
  ]);
  if (!l2Receipt || l2Receipt.blockHash !== event.blockHash || l2Block?.hash !== event.blockHash || BigInt(event.blockNumber) > BigInt(safe.number))
    return { kind: "pending", hash, detail: "L2 payment evidence changed. Rechecking settlement." };
  check(l2Receipt.status === "0x1" && l2Receipt.logs.some(log => same(log.address, c.payments!.policy)
    && log.topics.length === topics.length && log.topics.every((topic, index) => topic === topics[index])), "Missing authenticated L1 payment marker in the L2 receipt");
  const contributions = settledPayment(c, p, l2Receipt.logs);
  check(contributions, "L1 Safe succeeded without matching canonical payment events");
  const [l1Again, l2Again, safeAgain] = await Promise.all([
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [event.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]),
  ]);
  if (l1Again?.hash !== receipt.blockHash || l2Again?.hash !== event.blockHash || !safeAgain || BigInt(safeAgain.number) < BigInt(event.blockNumber))
    return { kind: "pending", hash, detail: "Chain observations changed during verification. Rechecking settlement." };
  return { kind: "settled", hash, execution: { l1: hash, l2: event.transactionHash }, sourceBlock: String(BigInt(receipt.blockNumber)), block: String(BigInt(event.blockNumber)), contributions,
    detail: "Settled on L1. The L1 Safe execution and matching L2 payment are canonical." };
}
