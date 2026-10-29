import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, maxUint256, parseAbi, parseUnits, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import type { Intent, Outcome, TreasuryClient, TreasuryConfig } from "./client.ts";
import type { Payment } from "./payments.ts";
import { buildSafeTransaction } from "./safeTransactions.ts";
import { packSafeCalls } from "./safeSetup.ts";
import officialSafe from "./official-safe-deployments.json" with { type: "json" };

// The call-only helper is independent of the Safe singleton version. Check its
// exact deployed code before signatures and submission; never deploy a replacement.
export const transferHelper = officialSafe.deployments.find(d => d.kind === "multiSend" && d.version === "1.3.0")!;
export const transferAbi = parseAbi([
  "function rollupId() view returns(uint64)",
  "function approve(address,uint256) returns(bool)", "function multiSend(bytes)",
  "function bridgeTokens(address,uint256,uint64,address)", "function treasuryRollupId() view returns(uint64)",
  "function receiveTokens(address,uint64,address,uint256,string,string,uint8,uint64)",
  "event CrossChainCallExecuted(bytes32 indexed crossChainCallHash,address indexed proxy,address sourceAddress,bytes callData,uint256 value)",
  "event IncomingCrossChainCallExecuted(bytes32 indexed crossChainCallHash,bool isStatic,address sourceAddress,uint64 sourceRollup,address destination,uint256 value,uint64 callGas,bytes data)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TokensBridged(address indexed token,address indexed sender,uint64 indexed rollupId,uint256 amount)",
  "event WrappedTokensMinted(address indexed wrappedToken,address indexed to,uint256 amount)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function parseTransferAmount(value: string): bigint {
  check(value.length <= 85 && /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value), "Enter a positive USDC amount with up to 6 decimals");
  const amount = parseUnits(value, 6);
  check(amount > 0n && amount <= maxUint256, "Enter a positive ERC-20 amount");
  return amount;
}
export function transferTransaction(c: TreasuryConfig, p: Extract<Payment, { kind: "transfer" }>, nonce: bigint) {
  const asset = c.payments;
  check(asset && p.source === "l1" && p.destination === "l2" && same(p.recipient, c.safeL2), "Transfers must go from this treasury’s L1 Safe to its EEZ-X Safe");
  const approve = (amount: bigint) => ({ to: asset.tokenL1, data: encodeFunctionData({ abi: transferAbi, functionName: "approve", args: [asset.bridgeL1, amount] }) });
  const calls = [approve(0n), approve(BigInt(p.amount)), { to: asset.bridgeL1,
    data: encodeFunctionData({ abi: transferAbi, functionName: "bridgeTokens", args: [asset.tokenL1, BigInt(p.amount), BigInt(p.rollupId), c.safeL2] }) }, approve(0n)];
  // Pending transfer journals retain lowercase calldata, including inner targets.
  const packed = packSafeCalls(calls).toLowerCase() as Hex;
  return buildSafeTransaction({ chainId: BigInt(c.l1.chainId), safe: c.safeL1, nonce, operation: 1,
    to: transferHelper.address as Address, data: encodeFunctionData({ abi: transferAbi, functionName: "multiSend", args: [packed] }) });
}
export async function verifyTransferHelper(client: TreasuryClient) {
  const code = await client.rpc<Hex>(client.config.l1.rpc, "eth_getCode", [transferHelper.address, "latest"]);
  check(keccak256(code) === transferHelper.codeHash, "Safe’s verified batch helper is unavailable on this network");
}
/** A Safe-to-Safe deposit needs its source balance, independent of payment
 * allowances and the shared spending budget. Keep the read pinned and reorg checked.
 */
export async function transferFunds(client: TreasuryClient) {
  const c = client.config;
  const block = await client.rpc<{ number: Hex; hash: Hex; timestamp: Hex }>(c.l1.rpc, "eth_getBlockByNumber", ["latest", false]);
  check(block?.number && block.hash, "Transfer source observation is unavailable");
  const abi = parseAbi(["function balanceOf(address) view returns(uint256)"]);
  const balance = decodeFunctionResult({ abi, functionName: "balanceOf", data: await client.rpc<Hex>(c.l1.rpc, "eth_call",
    [{ to: c.payments!.tokenL1, data: encodeFunctionData({ abi, functionName: "balanceOf", args: [c.safeL1] }) }, block.number]) });
  const again = await client.rpc<{ hash: Hex }>(c.l1.rpc, "eth_getBlockByNumber", [block.number, false]);
  check(again?.hash === block.hash, "Chain state changed while reading the transfer balance");
  return { balance, epoch: BigInt(block.timestamp) / 600n };
}
export function transferFunding(balance: bigint, amount: bigint) {
  check(amount <= balance, "Insufficient balance in the source Safe");
  return { fromL1: amount, fromL2: 0n };
}
export async function transferRollup(client: TreasuryClient): Promise<string> {
  const c = client.config;
  const standard = c.payments!.bridgeKind === "standard", name = standard ? "rollupId" : "treasuryRollupId";
  const rollup = decodeFunctionResult({ abi: transferAbi, functionName: name,
    data: await client.rpc<Hex>(standard ? c.l2.rpc : c.l1.rpc, "eth_call", [{ to: standard ? c.payments!.bridgeL2 : c.payments!.bridgeL1, data: encodeFunctionData({ abi: transferAbi, functionName: name }) }, "latest"]) });
  check(rollup > 0n && rollup < 1n << 64n, "Invalid bridge destination");
  return String(rollup);
}

type Log = { address: Address; data: Hex; topics: [Hex, ...Hex[]]; blockHash: Hex; blockNumber: Hex; transactionHash: Hex };
type Receipt = { status: Hex; blockHash: Hex; blockNumber: Hex; logs: Log[] };
type Block = { number: Hex; hash: Hex };
const decoded = (log: Log, address: Address, event: string): Record<string, unknown> | undefined => {
  if (!same(log.address, address)) return;
  try { const result = decodeEventLog({ abi: transferAbi, ...log }); if (result.eventName === event) return result.args as Record<string, unknown>; } catch { /* Other token/bridge events are unrelated. */ }
};

/** Source Safe success is already checked by l1PaymentOutcome. Match the exact
 * token lock and destination mint, then require the destination block's canonical
 * settlement to belong to this source block. Matching amounts alone are not a
 * cross-chain identity. Ambiguous deposits stay unresolved rather than guessing.
 */
export async function transferOutcome(client: TreasuryClient, intent: Intent, hash: Hex, receipt: Receipt): Promise<Outcome> {
  const c = client.config, p = intent.payment, asset = c.payments!;
  check(p?.kind === "transfer", "Missing transfer identity");
  const amount = BigInt(p.amount);
  const locked = receipt.logs.filter(log => { const e = decoded(log, asset.tokenL1, "Transfer"); return e && same(e.from as string, c.safeL1) && same(e.to as string, asset.bridgeL1) && e.value === amount; });
  const bridged = receipt.logs.filter(log => { const e = decoded(log, asset.bridgeL1, "TokensBridged"); return e && same(e.token as string, asset.tokenL1) && same(e.sender as string, c.safeL1) && e.rollupId === BigInt(p.rollupId) && e.amount === amount; });
  check(locked.length === 1 && bridged.length === 1, "Missing exact Safe-to-bridge transfer evidence");
  const pending = (): Outcome => ({ kind: "pending", hash, sourceBlock: String(BigInt(receipt.blockNumber)), detail: "Safe transfer included. Verifying the EEZ-X Safe’s receipt." });
  const safe = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]);
  if (!safe || BigInt(safe.number) < BigInt(intent.l2StartBlock!)) return pending();
  const outbound = receipt.logs.flatMap(log => {
    const e = decoded(log, c.registry, "CrossChainCallExecuted");
    if (!e || !same(e.sourceAddress as string, asset.bridgeL1) || e.value !== 0n) return [];
    try {
      const call = decodeFunctionData({ abi: transferAbi, data: e.callData as Hex });
      if (call.functionName !== "receiveTokens") return [];
      const [token, origin, recipient, value, , , , source] = call.args;
      return same(token, asset.tokenL1) && origin === 0n && same(recipient, c.safeL2) && value === amount && source === 0n ? [e] : [];
    } catch { return []; }
  });
  check(outbound.length === 1, "Missing unique bridge execution in the source transaction");
  const call = outbound[0]!, callHash = call.crossChainCallHash as Hex;
  const origins = await client.rpc<Log[]>(c.l1.rpc, "eth_getLogs", [{ blockHash: receipt.blockHash, address: c.registry,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "CrossChainCallExecuted", args: { crossChainCallHash: callHash } }) }]);
  const sourceHashes = new Set(origins.filter(log => same(log.blockHash, receipt.blockHash)
    && decoded(log, c.registry, "CrossChainCallExecuted")?.crossChainCallHash === callHash).map(log => log.transactionHash.toLowerCase()));
  check(sourceHashes.size === 1 && sourceHashes.has(hash.toLowerCase()), "Ambiguous source transfer; keeping this request for verification");
  const logs = await client.rpc<Log[]>(c.l2.rpc, "eth_getLogs", [{ address: c.manager,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "IncomingCrossChainCallExecuted", args: { crossChainCallHash: callHash } }),
    fromBlock: intent.l2StartBlock!, toBlock: safe.number }]);
  const matches: Log[] = [];
  for (const log of logs) {
    const e = decoded(log, c.manager, "IncomingCrossChainCallExecuted");
    if (!e || e.crossChainCallHash !== callHash || e.isStatic !== false || e.sourceRollup !== 0n || e.value !== 0n
      || !same(e.sourceAddress as string, asset.bridgeL1) || !same(e.destination as string, asset.bridgeL2) || e.data !== call.callData) continue;
    const settlement = await client.rpc<{ canonicalL2: boolean; l1BlockHash: Hex; l1BlockNumber: Hex; l2Blocks: Block[] } | null>(c.l2.front, "eez_getSettlementByL2Block", [log.blockHash]);
    if (settlement?.canonicalL2 && same(settlement.l1BlockHash, receipt.blockHash) && BigInt(settlement.l1BlockNumber) === BigInt(receipt.blockNumber)
      && settlement.l2Blocks.some(b => same(b.hash, log.blockHash) && BigInt(b.number) === BigInt(log.blockNumber))) matches.push(log);
  }
  if (!matches.length) return pending();
  check(matches.length === 1, "Ambiguous transfer evidence; keeping this request for verification");
  const log = matches[0]!;
  const [destination, block] = await Promise.all([
    client.rpc<Receipt | null>(c.l2.rpc, "eth_getTransactionReceipt", [log.transactionHash]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [log.blockNumber, false]),
  ]);
  if (!destination || destination.blockHash !== log.blockHash || block?.hash !== log.blockHash || BigInt(log.blockNumber) > BigInt(safe.number)) return pending();
  check(destination.status === "0x1" && BigInt(destination.blockNumber) === BigInt(log.blockNumber) && destination.logs.some(item => {
    const e = decoded(item, c.manager, "IncomingCrossChainCallExecuted"); return e && e.crossChainCallHash === callHash && e.data === call.callData
      && e.isStatic === false && e.sourceRollup === 0n && e.value === 0n && same(e.sourceAddress as string, asset.bridgeL1) && same(e.destination as string, asset.bridgeL2);
  }) && destination.logs.some(item => {
    const e = decoded(item, asset.tokenL2, "Transfer"); return e && same(e.from as string, zeroAddress) && same(e.to as string, c.safeL2) && e.value === amount;
  }) && destination.logs.some(item => {
    const e = decoded(item, asset.bridgeL2, "WrappedTokensMinted"); return e && same(e.wrappedToken as string, asset.tokenL2) && same(e.to as string, c.safeL2) && e.amount === amount;
  }), "Missing exact EEZ-X Safe mint evidence");
  const [l1Again, l2Again, safeAgain] = await Promise.all([
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [log.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]),
  ]);
  if (l1Again?.hash !== receipt.blockHash || l2Again?.hash !== log.blockHash || !safeAgain || BigInt(safeAgain.number) < BigInt(log.blockNumber)) return pending();
  return { kind: "settled", hash, sourceBlock: String(BigInt(receipt.blockNumber)), block: String(BigInt(log.blockNumber)),
    execution: { l1: hash, l2: log.transactionHash }, contributions: { fromL1: p.amount, fromL2: "0" }, detail: "Transfer completed. The EEZ-X Safe received the tokens." };
}
