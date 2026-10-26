import { useId, useEffect, useState, type RefObject } from "react";
import type { TraceRow } from "../../../trace-decoder/flow/rows.mjs";
import styles from "./TraceDetailView.module.css";

interface Connection {
  from: number; to: number; chain: "L1" | "L2"; path: string;
  uncertain: boolean; failed: boolean; crosses: boolean;
}

/** Measure the actual cards so connectors follow wrapping, folding and resizing. */
export function FlowConnections({ container, rows, physical, selected }: {
  container: RefObject<HTMLDivElement | null>; rows: TraceRow[];
  physical: boolean; selected: number | null;
}) {
  const marker = "trace-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [layout, setLayout] = useState<{ width: number; height: number; edges: Connection[] }>({
    width: 0, height: 0, edges: [],
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const cards = new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-flow-node]"))
        .map(card => [Number(card.dataset.flowNode), card.getBoundingClientRect()] as const));
      const byId = new Map(rows.map(row => [row.node.id, row.node]));
      const edges: Connection[] = [];
      for (const { node, parent } of rows) {
        if (parent === null) continue;
        const caller = byId.get(parent), start = cards.get(parent), end = cards.get(node.id);
        // Never fabricate a connection across pages or independent recorded transactions.
        if (!caller || !start || !end || physical && (caller.chain !== node.chain || caller.tx !== node.tx)) continue;
        const crosses = caller.chain !== node.chain;
        // Anchor near the card title; compact cards are shorter than the anchor offset.
        const sy = start.top - bounds.top + Math.min(26, start.height / 2);
        const ty = end.top - bounds.top + Math.min(26, end.height / 2);
        let path: string;
        if (crosses) {
          const forward = caller.chain === "L1";
          const sx = (forward ? start.right : start.left) - bounds.left;
          const tx = (forward ? end.left : end.right) - bounds.left;
          const rail = bounds.width / 2;
          path = `M ${sx} ${sy} H ${rail} V ${ty} H ${tx}`;
        } else {
          const sx = start.left - bounds.left, tx = end.left - bounds.left;
          const rail = Math.max(8, Math.min(sx, tx) - 16);
          path = `M ${sx} ${sy} H ${rail} V ${ty} H ${tx}`;
        }
        const crossing = node.crossing;
        edges.push({
          from: parent, to: node.id, chain: node.chain, path, crosses,
          uncertain: node.kind === "ghost" || !!crossing && crossing.status !== "matched",
          failed: node.failed || node.reverted,
        });
      }
      const next = { width: bounds.width, height: bounds.height, edges };
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("[data-flow-node]").forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [container, rows, physical]);

  return <svg className={styles.connections} width={layout.width} height={layout.height} aria-hidden="true">
    <defs>{(["L1", "L2", "uncertain", "failed"] as const).map(tone =>
      <marker key={tone} id={marker + "-" + tone} viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 1 1 L 9 5 L 1 9 Z" className={styles.arrowHead} data-tone={tone} />
      </marker>)}
      {/* Lanes are fixed (L1 left, L2 right), so one horizontal gradient serves both directions. */}
      <linearGradient id={marker + "-cross"} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={layout.width} y2="0">
        <stop offset="0.3" style={{ stopColor: "var(--chain-l1)" }} />
        <stop offset="0.5" style={{ stopColor: "var(--accent)" }} />
        <stop offset="0.7" style={{ stopColor: "var(--chain-l2)" }} />
      </linearGradient></defs>
    {layout.edges.map(edge => {
      const active = selected === edge.from || selected === edge.to;
      const tone = edge.failed ? "failed" : edge.uncertain ? "uncertain" : edge.chain;
      const verified = edge.crosses && tone === edge.chain;
      return <g key={edge.to} data-active={active} data-dimmed={selected !== null && !active}>
        {verified && <path d={edge.path} className={styles.connectionGlow} style={{ stroke: `url(#${marker}-cross)` }} />}
        <path d={edge.path} className={styles.connection}
          data-tone={tone} data-uncertain={edge.uncertain} data-crossing={edge.crosses}
          data-from={edge.from} data-to={edge.to}
          style={verified ? { stroke: `url(#${marker}-cross)` } : undefined}
          markerEnd={`url(#${marker}-${tone})`} />
      </g>;
    })}
  </svg>;
}
