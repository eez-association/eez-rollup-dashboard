import type { TraceModel, TraceNode } from "../service/types";
export interface TraceRow { node: TraceNode; depth: number; parent: number | null }
export function traceRows(model: TraceModel, options?: {
  transaction?: string; protocol?: boolean; localReads?: boolean; search?: string; collapsed?: Set<number>;
}): TraceRow[];
