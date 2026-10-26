import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TraceRow } from "../../../trace-decoder/flow/rows.mjs";
import type { TraceChain, TraceModel, TraceNode } from "../../../trace-decoder/service/types";
import { TokenNotes, tokenNotesHeight } from "./TokenTransfers";
import styles from "./CallMap.module.css";

// Port of the standalone viewer's call flow: one box per call, depth runs left to right,
// execution order top to bottom. Each chain is a horizontal band; the band of the chain
// the flow starts on is drawn first, so a flow that starts on L2 still reads from the top left.
const F = { w: 264, h: 112, senderW: 180, senderH: 64, gap: 46, row: 22, pad: 48, side: 28, label: 40 };

// Boxes wrap names and signatures instead of truncating them, so heights are estimated from
// text length (average glyph widths of the card fonts) and each row takes its tallest box.
const TEXT_WIDTH = F.w - 34;
const lines = (text: string, glyph: number, max: number) => Math.min(max, Math.max(1, Math.ceil(text.length * glyph / TEXT_WIDTH)));
const boxHeight = (node: TraceNode) =>
  20 + 22 + lines(node.contract, 8.6, 3) * 20 + lines(node.fn, 6.8, 4) * 16 + (node.ret.status === "void" ? 0 : 24) + 12;

interface Item {
  id: string; node?: TraceNode; chain: TraceChain; col: number; row: number; parent: Item | null;
  step?: number; sender?: { title: string; address: string | null }; lane: number;
  x: number; y: number; w: number; h: number;
}

/** Polyline → path with rounded corners. */
function roundPath(points: [number, number][], radius = 9) {
  const p = points.filter((q, i) => i === 0 || q[0] !== points[i - 1]![0] || q[1] !== points[i - 1]![1]);
  let d = `M${p[0]![0]} ${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1]!, [x1, y1] = p[i]!, [x2, y2] = p[i + 1]!;
    const r = Math.min(radius, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
    d += ` L${x1 - Math.sign(x1 - x0) * r} ${y1 - Math.sign(y1 - y0) * r} Q${x1} ${y1} ${x1 + Math.sign(x2 - x1) * r} ${y1 + Math.sign(y2 - y1) * r}`;
  }
  return d + ` L${p[p.length - 1]![0]} ${p[p.length - 1]![1]}`;
}

export function CallMap({ model, rows, steps, physical, selected, onSelect, collapsed, onToggle, contractColor, contractKey, returnLabel, tokens }: {
  model: TraceModel; rows: TraceRow[]; steps: number[]; physical: boolean;
  selected: number | null; onSelect: (id: number) => void;
  collapsed: Set<number>; onToggle: (id: number) => void;
  contractColor: Map<string, number>; contractKey: (node: TraceNode) => string;
  returnLabel: (node: TraceNode) => string; tokens: boolean;
}) {
  const marker = "map-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const scroller = useRef<HTMLDivElement>(null);
  // null follows the available width; an explicit zoom stays fixed until Fit is chosen.
  const [zoom, setZoom] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setZoom(null); }, [model]);

  const layout = useMemo(() => {
    const visibleIds = new Set(rows.map(row => row.node.id));
    const children = new Map<number, TraceRow[]>();
    const roots: { row: TraceRow; index: number }[] = [];
    rows.forEach((row, index) => {
      if (row.parent !== null && visibleIds.has(row.parent)) {
        const list = children.get(row.parent) ?? []; list.push(row); children.set(row.parent, list);
      } else roots.push({ row, index });
    });
    const stepOf = new Map(rows.map((row, index) => [row.node.id, steps[index]!]));
    const txs = new Map(model.transactions.map(tx => [tx.chain + ":" + tx.hash, tx]));

    const items: Item[] = [], cursor = new Map<string, number>();
    const place = (item: Item, pref: Partial<Record<TraceChain, number>>) => {
      const key = item.chain + "|" + item.col;
      item.row = Math.max(pref[item.chain] ?? 0, cursor.get(key) ?? 0);
      cursor.set(key, item.row + 1); items.push(item);
    };
    const blank = { lane: 0, x: 0, y: 0, w: F.w, h: F.h, row: 0 };
    // A box's first call stays on its row; later calls stack below the previous call's subtree.
    const visit = (row: TraceRow, col: number, pref: Partial<Record<TraceChain, number>>, parent: Item) => {
      const item: Item = { ...blank, h: Math.max(F.h, boxHeight(row.node)) + (tokens ? tokenNotesHeight(row.node.tokenTransfers?.length ?? 0) : 0), id: String(row.node.id), node: row.node, chain: row.node.chain, col, parent, step: stepOf.get(row.node.id) };
      place(item, pref);
      const reach: Partial<Record<TraceChain, number>> = { [item.chain]: item.row };
      const next = { ...pref, [item.chain]: item.row };
      for (const child of children.get(row.node.id) ?? []) {
        const sub = visit(child, col + 1, next, item);
        for (const [chain, value] of Object.entries(sub) as [TraceChain, number][]) {
          reach[chain] = Math.max(reach[chain] ?? -1, value); next[chain] = value + 1;
        }
      }
      return reach;
    };
    const nextRootRow: Partial<Record<TraceChain, number>> = {};
    for (const { row } of roots) {
      const tx = txs.get(row.node.chain + ":" + row.node.tx);
      const continued = row.parent !== null;
      const sender: Item = { ...blank, id: "sender:" + row.node.id, chain: row.node.chain, col: 0, parent: null, w: F.senderW, h: F.senderH,
        sender: { title: continued ? "Continued from earlier page" : tx?.label || "Transaction sender", address: continued ? null : tx?.from ?? null } };
      place(sender, nextRootRow);
      const pref = { ...nextRootRow, [row.node.chain]: sender.row };
      const sub = visit(row, 1, pref, sender);
      for (const [chain, value] of Object.entries(sub) as [TraceChain, number][]) pref[chain] = value + 1;
      for (const [chain, value] of Object.entries(pref) as [TraceChain, number][]) nextRootRow[chain] = Math.max(nextRootRow[chain] ?? 0, value);
    }

    // One trunk lane per parent in the corridor right of its column, so sibling arrows never overlap.
    const columns = Math.max(1, ...items.map(item => item.col + 1)), lanesIn = Array<number>(columns).fill(0);
    const parents = new Set(items.map(item => item.parent));
    for (const item of items) if (parents.has(item)) item.lane = lanesIn[item.col]!++;
    const corridor = (col: number) => F.gap + Math.max(0, lanesIn[col]! - 1) * 7;
    const colX: number[] = [];
    let x = F.side;
    for (let col = 0; col < columns; col++) { colX[col] = x; x += (col === 0 ? F.senderW : F.w) + corridor(col); }
    const width = x - corridor(columns - 1) + F.side;

    const first = roots[0]?.row.node.chain ?? "L1";
    const bands = (first === "L1" ? ["L1", "L2"] : ["L2", "L1"]).filter(chain => items.some(item => item.chain === chain)) as TraceChain[];
    const bandTop = {} as Record<TraceChain, number>, bandHeight = {} as Record<TraceChain, number>;
    const rowTop = {} as Record<TraceChain, number[]>, rowHeight = {} as Record<TraceChain, number[]>;
    let y = 0;
    for (const chain of bands) {
      const own = items.filter(item => item.chain === chain);
      const heights = rowHeight[chain] = Array<number>(Math.max(1, ...own.map(item => item.row + 1))).fill(F.h);
      for (const item of own) heights[item.row] = Math.max(heights[item.row]!, item.h);
      bandTop[chain] = y;
      let top = y + F.label + F.pad;
      rowTop[chain] = heights.map(height => { const at = top; top += height + F.row; return at; });
      bandHeight[chain] = top - F.row + F.pad - y;
      y += bandHeight[chain];
    }
    for (const item of items) {
      item.x = colX[item.col]!;
      item.y = rowTop[item.chain][item.row]! + (rowHeight[item.chain][item.row]! - item.h) / 2;
    }
    const boundary = bands.length > 1 ? bandTop[bands[1]!] : null;

    const edges = items.filter(item => item.parent && item.node).map(item => {
      const parent = item.parent!, node = item.node!;
      const trunk = parent.x + parent.w + 18 + parent.lane * 7, py = parent.y + parent.h / 2, cy = item.y + item.h / 2;
      const crosses = parent.chain !== item.chain;
      const crossing = node.crossing;
      const uncertain = node.kind === "ghost" || !!crossing && crossing.status !== "matched";
      return {
        item, trunk, crosses, uncertain, failed: node.failed || node.reverted,
        // Recorded traces never connect independent transactions across chains.
        hidden: physical && (crosses || !!parent.node && parent.node.tx !== node.tx),
        d: roundPath([[parent.x + parent.w, py], [trunk, py], [trunk, cy], [item.x - 2, cy]]),
      };
    });
    // Neighbouring trunks sit only a few pixels apart, so crossings closer than a badge's width
    // share one badge with a numbered entry per crossing instead of stacking badges on top of each other.
    const badges: { x: number; edges: typeof edges }[] = [];
    for (const edge of edges.filter(edge => edge.crosses && !edge.hidden && boundary !== null).sort((a, b) => a.trunk - b.trunk)) {
      const last = badges[badges.length - 1];
      if (last && edge.trunk - last.x < 90) last.edges.push(edge); else badges.push({ x: edge.trunk, edges: [edge] });
    }
    return { items, edges, badges, bands, bandTop, bandHeight, boundary, width, height: y };
  }, [rows, steps, model, physical, tokens]);

  const { items, edges, badges, bands, bandTop, bandHeight, boundary, width, height } = layout;
  // Fit never shrinks below 40%, where labels stop being readable; wider maps scroll instead.
  const scale = zoom ?? Math.max(0.4, Math.min(1, (viewportWidth ? Math.max(1, viewportWidth - 2) : width) / width));
  const fit = () => {
    setZoom(null);
    scroller.current?.scrollTo({ left: 0, top: 0 });
  };
  const selectedNode = selected === null ? undefined : model.nodes[selected];
  const selectedContract = selectedNode ? contractKey(selectedNode) : null;
  const top = bands[0] ?? "L1", bottom = bands[1] ?? top;

  return <div className={styles.map}>
    <div className={styles.zoom} role="group" aria-label="Map zoom">
      <span className={styles.zoomHint}>{scale < 0.6 ? "Overview. Use 100% to read labels." : "Calls branch left to right."}</span>
      <button className="btn btn-sm btn-outline" onClick={() => setZoom(Math.max(0.1, scale - 0.15))} aria-label="Zoom out">−</button>
      <output aria-label="Zoom level">{Math.round(scale * 100)}%</output>
      <button className="btn btn-sm btn-outline" onClick={() => setZoom(Math.min(2, scale + 0.15))} aria-label="Zoom in">+</button>
      <button className="btn btn-sm btn-outline" onClick={() => setZoom(1)} aria-pressed={zoom === 1} title="Actual size. Scroll to explore the map.">100%</button>
      <button className="btn btn-sm btn-outline" onClick={fit} aria-pressed={zoom === null}>Fit width</button>
    </div>
    <div className={styles.scroller} ref={scroller} tabIndex={0} role="region" aria-label="Call map canvas">
      <div style={{ width: width * scale, height: height * scale }}>
        <div className={styles.canvas} style={{ width, height, transform: scale === 1 ? undefined : `scale(${scale})` }}>
          {bands.map(chain => <div key={chain} className={styles.band} data-chain={chain} style={{ top: bandTop[chain], height: bandHeight[chain] }}>
            <span className={styles.bandLabel}>{chain} · {model.chains[chain].name}{model.chains[chain].chainId ? <small>chain {model.chains[chain].chainId}</small> : null}</span>
          </div>)}
          {boundary !== null && <div className={styles.boundary} style={{ top: boundary }}><span>chain boundary</span></div>}
          <svg className={styles.edges} width={width} height={height} aria-hidden="true">
            <defs>
              {(["L1", "L2", "uncertain", "failed"] as const).map(tone => <marker key={tone} id={marker + "-" + tone} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M1 1 9 5 1 9" className={styles.arrowHead} data-tone={tone} /></marker>)}
              {boundary !== null && <linearGradient id={marker + "-cross"} gradientUnits="userSpaceOnUse" x1="0" y1={boundary - 80} x2="0" y2={boundary + 80}>
                <stop offset="0" style={{ stopColor: `var(--chain-${top.toLowerCase()})` }} />
                <stop offset="0.5" style={{ stopColor: "var(--accent)" }} />
                <stop offset="1" style={{ stopColor: `var(--chain-${bottom.toLowerCase()})` }} />
              </linearGradient>}
            </defs>
            {edges.filter(edge => !edge.hidden).map(edge => {
              const node = edge.item.node!, parentNode = edge.item.parent?.node;
              const active = selected === node.id || selected === parentNode?.id;
              const tone = edge.failed ? "failed" : edge.uncertain ? "uncertain" : node.chain;
              const verified = edge.crosses && tone === node.chain;
              return <g key={edge.item.id} data-active={active} data-dimmed={selected !== null && !active}>
                {verified && <path d={edge.d} className={styles.glow} style={{ stroke: `url(#${marker}-cross)` }} />}
                <path d={edge.d} className={styles.edge} data-from={parentNode?.id} data-to={node.id} data-tone={tone} data-crossing={edge.crosses} data-uncertain={edge.uncertain}
                  style={verified ? { stroke: `url(#${marker}-cross)` } : undefined} markerEnd={`url(#${marker}-${tone})`} />
              </g>;
            })}
          </svg>
          {items.map(item => {
            const style = { left: item.x, top: item.y, width: item.w, height: item.h };
            if (item.sender) return <div key={item.id} className={styles.sender} data-chain={item.chain} style={style} title={item.sender.address ?? undefined}>
              <strong>{item.sender.title}</strong><code>{item.sender.address ? item.sender.address.slice(0, 8) + "…" + item.sender.address.slice(-6) : item.chain}</code>
            </div>;
            const node = item.node!, failed = node.failed || node.reverted;
            const marks = [node.kind === "ghost" ? "not observed" : node.protocol ? "EEZ" : "", node.isStatic ? "read" : ""].filter(Boolean).join(" · ");
            const color = contractColor.get(contractKey(node));
            return <div key={item.id}>
              <button className={styles.box} data-map-node={node.id} data-chain={node.chain} data-contract={color} data-selected={selected === node.id}
                data-same={selected !== node.id && selectedContract === contractKey(node)} data-failed={failed} data-ghost={node.kind === "ghost"}
                style={style} onClick={() => onSelect(node.id)} aria-pressed={selected === node.id}
                title={`${item.step}. ${node.contract}.${node.fn} → ${returnLabel(node)}`}>
                <span className={styles.kick}><span className={styles.num}>{item.step}</span>{marks}
                  {node.failed ? <span className={styles.fail}>✕ failed</span> : node.reverted ? <span className={styles.fail} data-undone="true">↺ rolled back</span> : null}</span>
                <span className={styles.name}>{node.contract}</span>
                <code className={styles.fn}>{node.fn}</code>
                {tokens && <TokenNotes model={model} chain={node.chain} transfers={node.tokenTransfers ?? []} />}
                {node.ret.status !== "void" && <span className={styles.ret} data-state={failed ? "failed" : node.ret.status}>→ {returnLabel(node)}</span>}
              </button>
              {node.children.length > 0 && <button className={styles.fold} data-chain={node.chain}
                style={{ left: item.x + item.w - 34, top: item.y + item.h - 30 }} aria-expanded={!collapsed.has(node.id)}
                aria-label={(collapsed.has(node.id) ? "Show the calls made by " : "Fold the calls made by ") + node.contract + " " + node.fn}
                onClick={() => onToggle(node.id)}>{collapsed.has(node.id) ? "+" : "−"}</button>}
            </div>;
          })}
          {boundary !== null && badges.map(({ x, edges: group }) => {
            const from = group[0]!.item.parent!.chain, to = group[0]!.item.chain;
            const mixed = group.some(edge => edge.item.chain !== to);
            const uncertain = group.some(edge => edge.uncertain);
            return <div key={x} className={styles.badge} data-uncertain={uncertain} style={{ left: x + (group[group.length - 1]!.trunk - x) / 2, top: boundary }}>
              {mixed ? <span>L1⇄L2</span> : <span><b data-chain={from}>{from}</b>→<b data-chain={to}>{to}</b></span>}
              {group.map(edge => {
                const node = edge.item.node!, status = node.crossing?.status;
                return <button key={edge.item.id} className={styles.crossing} data-state={status} data-selected={selected === node.id}
                  onClick={() => onSelect(node.id)} aria-label={`Show crossing call ${edge.item.step}: ${node.contract}.${node.fn}${status ? " (" + status + ")" : ""}`}
                  title={`${edge.item.step}. ${node.contract}.${node.fn}${status ? " · " + status : ""}`}>
                  {edge.item.step}{status && <i />}
                </button>;
              })}
            </div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}
