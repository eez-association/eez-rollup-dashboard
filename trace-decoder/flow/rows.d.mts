import type { TraceModel, TraceNode } from "../service/types";
export interface TraceRow { node: TraceNode; depth: number; parent: number | null }
export function traceRows(model: TraceModel, options?: {
  transaction?: string; protocol?: boolean; localReads?: boolean; search?: string; collapsed?: Set<number>;
}): TraceRow[];

export interface TraceConnection { from: number; to: number; protocol: boolean }
export function traceConnections(rows: TraceRow[], protocolLinks?: { from: number; to: number }[], crossChainLinks?: { from: number; to: number; manager?: number }[]): TraceConnection[];
