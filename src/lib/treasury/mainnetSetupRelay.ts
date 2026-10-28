import { decodeEventLog, encodeEventTopics, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { DeploymentPending } from "./deployment.ts";
import type { DeploymentIO } from "./deploymentIO.ts";
import { transferAbi } from "./transfers.ts";
import network from "./mainnet-network.json" with { type: "json" };

type Log = { address: Address; topics: [Hex, ...Hex[]]; data: Hex; blockHash: Hex; blockNumber: Hex; transactionHash: Hex };
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function event(log: Pick<Log, "address" | "topics" | "data">, address: string, name: string) {
  if (!same(log.address, address)) return;
  try { const e = decodeEventLog({ abi: transferAbi, ...log }); if (e.eventName === name) return e.args as Record<string, unknown>; } catch { /* Other events. */ }
}
/** Setup completion requires the exact incoming call and canonical L1 inclusion.
 * The signature hash alone does not establish which source transaction consumed it. */
export async function findIncomingCallEvidence(io: Pick<DeploymentIO, "rpc">, safe: Address, p: DeploymentPending,
  source: { blockHash: Hex; blockNumber: Hex; logs: Pick<Log, "address" | "topics" | "data">[] },
  bindings: { registry: string; manager: string } = network, fromBlock: Hex = "0x0") {
  if (!/^0x[\da-f]+$/i.test(fromBlock)) throw new Error("Invalid incoming-call recovery block");
  const calls = source.logs.flatMap(l => { const e = event(l, bindings.registry, "CrossChainCallExecuted");
    return e && same(e.proxy, p.to) && same(e.sourceAddress, p.sender) && same(e.callData, p.data) && e.value === 0n ? [e] : []; });
  if (calls.length !== 1) throw new Error("Missing unique mirror setup source call");
  const callHash = calls[0]!.crossChainCallHash as Hex;
  const origins = await io.rpc<Log[]>("l1", "eth_getLogs", [{ address: bindings.registry, blockHash: source.blockHash,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "CrossChainCallExecuted", args: { crossChainCallHash: callHash } }) }]);
  if (origins.length !== 1) throw new Error("Ambiguous cross-chain source call; preserve this request for verification");
  const safeHead = await io.rpc<{ number: Hex } | null>("l2", "eth_getBlockByNumber", ["safe", false]);
  if (!safeHead?.number) return null;
  // Recovery must still work after a long absence. Page from the saved starting
  // block (genesis for older setup journals), never a moving recent-block window.
  const high = BigInt(safeHead.number), incoming: Log[] = [];
  const topics = encodeEventTopics({ abi: transferAbi, eventName: "IncomingCrossChainCallExecuted", args: { crossChainCallHash: callHash } });
  for (let low = BigInt(fromBlock); low <= high; low += 4096n) {
    const end = low + 4095n < high ? low + 4095n : high;
    incoming.push(...await io.rpc<Log[]>("l2", "eth_getLogs", [{ address: bindings.manager,
      fromBlock: toHex(low), toBlock: toHex(end), topics }]));
  }
  const matches: { logs: Log[]; transactionHash: Hex; blockNumber: Hex; blockHash: Hex }[] = [];
  for (const log of incoming) {
    if (BigInt(log.blockNumber) < BigInt(fromBlock) || BigInt(log.blockNumber) > high) continue;
    const e = event(log, bindings.manager, "IncomingCrossChainCallExecuted");
    if (!e || !same(e.crossChainCallHash, callHash) || e.isStatic !== false || e.sourceRollup !== 0n || e.value !== 0n || !same(e.destination, safe) || !same(e.sourceAddress, p.sender) || !same(e.data, p.data)) continue;
    const settlement = await io.rpc<{ canonicalL2: boolean; l1BlockHash: Hex; l1BlockNumber: Hex; l2Blocks: { number: Hex; hash: Hex }[] }>("l2", "eez_getSettlementByL2Block", [log.blockHash], true);
    if (!settlement?.canonicalL2 || settlement.l1BlockHash !== source.blockHash || BigInt(settlement.l1BlockNumber) !== BigInt(source.blockNumber)
      || !settlement.l2Blocks.some(b => b.hash === log.blockHash && BigInt(b.number) === BigInt(log.blockNumber))) continue;
    const receipt = await io.rpc<{ status: Hex; blockHash: Hex; logs: Log[] }>("l2", "eth_getTransactionReceipt", [log.transactionHash]);
    const [block, anchor] = await Promise.all([io.rpc<{ hash: Hex }>("l2", "eth_getBlockByNumber", [log.blockNumber, false]),
      io.rpc<{ hash: Hex }>("l1", "eth_getBlockByNumber", [source.blockNumber, false])]);
    const included = receipt?.logs.some(item => same(item.address, log.address) && item.data === log.data
      && item.topics.length === log.topics.length && item.topics.every((topic, i) => topic === log.topics[i]));
    if (receipt?.status === "0x1" && included && receipt.blockHash === log.blockHash && block?.hash === log.blockHash && anchor?.hash === source.blockHash) matches.push({ logs: receipt.logs, transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash });
  }
  if (matches.length > 1) throw new Error("Ambiguous incoming cross-chain execution");
  return matches[0] ?? null;
}

/** Existing setup callers only need the verified incoming receipt's logs. */
export async function findIncomingCall(...args: Parameters<typeof findIncomingCallEvidence>) {
  return (await findIncomingCallEvidence(...args))?.logs ?? null;
}
