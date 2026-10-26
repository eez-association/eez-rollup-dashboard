/** Public, versioned contract shared by the decoder API and React dashboard. */
export type TraceChain = "L1" | "L2";
export type TraceSource = "l1" | "l2" | "auto";
export interface TraceRequest {
  hash: string;
  chain: TraceSource;
  chainIds: { l1: string; l2: string };
  refresh?: boolean;
}
export interface TraceArgument { name: string; type: string; value: unknown }
export interface TraceCrossing {
  from: TraceChain; to: TraceChain; status: string; isStatic: boolean;
  sourceAddress?: string; targetAddress?: string; remoteTx?: string | null;
  evidence: string[]; resultKind?: string | null;
}
/** Experimental: an ERC20 Transfer event seen in both the trace and the committed receipt. */
export interface TraceTokenTransfer {
  kind: "transfer" | "mint" | "burn"; token: string; from: string; to: string;
  amount: string; symbol: string | null; decimals: number | null; eventId: string; evidence: string;
}
export interface TraceNode {
  id: number; kind: "call" | "ghost"; frameId: string | null; chain: TraceChain;
  role: string; protocol: boolean; inFlow?: boolean; callType: string; contract: string;
  address: string | null; from?: string | null; fn: string; signature?: string | null;
  args: TraceArgument[];
  ret: { status: string; reason?: string | null; raw?: string | null; items?: TraceArgument[]; alternatives?: number };
  value: string; isStatic: boolean; crossChainRead?: boolean; failed: boolean; reverted: boolean;
  gasUsed: string | null; tx: string | null; block: number | null; path: string | null;
  input: string; output: string | null; children: number[];
  outgoing?: TraceCrossing; crossing?: TraceCrossing;
  preparedResult?: boolean; preparedResponse?: boolean;
  remoteChain?: TraceChain; remoteAddress?: string;
  abiSource?: string | null; abiProvider?: string | null;
  impl?: { contract: string; address: string; frameId: string };
  tokenTransfers?: TraceTokenTransfer[];
}
export interface TraceTransaction {
  chain: TraceChain; hash: string; block: number | null; index: number | null;
  from: string | null; to: string | null; status: string; gasUsed: string | null;
  traced: boolean; traceReason: string | null; requested: boolean;
  role: string; label: string; inFlow: boolean | null; relatedSettlement?: boolean;
  evidence: string[];
}
export interface TraceModel {
  mode?: "combined" | "physical"; recordedView?: TraceModel | null; executionNotice?: string | null;
  matchingNotes?: { code: string; message: string; frameId: string | null }[];
  version: 1; schemaVersion: string | null; label: string; txHash: string;
  origin: { chain: TraceChain; transactionId: string } | null;
  chains: Record<TraceChain, { chainId: string | null; rollupId: string | null; manager: string | null; name: string; explorer: string | null }>;
  nodes: TraceNode[]; transactions: TraceTransaction[];
  roots: { node: number; chain: TraceChain; tx: string; block: number | null; isOrigin: boolean; inFlow?: boolean; preferred?: boolean; unisolatedEntry?: boolean; entryIndex?: number | null; role: string; relatedSettlement?: boolean; label: string }[];
  settlements: { id: string; l1Tx: string; l1Block: number | null; firstL2Block: number | null; lastL2Block: number | null }[];
  unresolved: { code: string; message: string; frameId: string | null }[];
  stats: { frames: number; crossings: number; matched: number; events: number; preparedResults?: number; preparedResponses?: number };
  gas?: Record<TraceChain, TraceGas>;
}
/** Gas units for the requested flow; decimal strings preserve integer precision. */
export interface TraceGas {
  gasUsed: string | null; partial: boolean;
  contributions: { frameId: string; hash: string | null; basis: "receipt" | "frame"; label: string; gasUsed: string | null }[];
  transactionGasUsed: string | null; transactionGasPartial: boolean;
  receipts: { hash: string; label: string; gasUsed: string | null }[];
}
export interface TraceResult {
  apiVersion: 1; observedAt: string; partial: boolean; model: TraceModel;
}
export interface TraceJob {
  apiVersion: 1; id: string; state: "queued" | "running" | "complete" | "failed";
  progress: string; error: string | null; errorCode: string | null;
}
