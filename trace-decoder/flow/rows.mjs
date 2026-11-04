// Pure selection/layout input shared by the React views and regression tests.
// Hidden protocol calls and local reads promote their children; evidence stays visible.
const isLocalRead = node => (node.isStatic || node.callType === "STATICCALL") &&
  !node.failed && !node.reverted && node.kind !== "ghost" &&
  !node.crossing && !node.outgoing && !node.crossChainRead &&
  !node.preparedResult && !node.preparedResponse;
// Protocol view reconstructs each recorded transaction tree without changing
// the ordinary linked application view or any saved model. Ghosts retain their
// requested logical parent; they never become observed physical executions.
function protocolTree(model, enabled) {
  if (!enabled || model.mode === 'physical' || !model.nodes.some(node => 'recordedParent' in node)) return null;
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const logicalParent = new Map(model.nodes.flatMap(node => node.children.map(child => [child, node.id])));
  const requestedParent = new Map((model.crossChainLinks ?? []).filter(link => link.manager !== undefined).map(link => [link.to, link.manager]));
  const children = new Map(model.nodes.map(node => [node.id, []]));
  const roots = [...model.roots], rootIds = new Set(roots.map(root => root.node));
  for (const node of model.nodes) {
    const parent = node.recordedParent === undefined ? requestedParent.get(node.id) ?? logicalParent.get(node.id) ?? null : node.recordedParent;
    if (parent !== null && parent !== node.id && byId.has(parent)) children.get(parent).push(node.id);
    else if (!rootIds.has(node.id)) {
      roots.push({ node: node.id, chain: node.chain, tx: node.tx, inFlow: node.inFlow });
      rootIds.add(node.id);
    }
  }
  const compare = (a, b) => {
    const x = byId.get(a).path?.split('.').map(Number), y = byId.get(b).path?.split('.').map(Number);
    if (!x || !y) return Number(!x) - Number(!y) || a - b;
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length || a - b;
  };
  for (const ids of children.values()) ids.sort(compare);
  return { roots, children };
}

/** One edge per pair: protocol-parent edges can replace tree styling, while
 * explicit proxy crossings connect independently recorded transaction trees. */
export function traceConnections(rows, protocolLinks = [], crossChainLinks = []) {
  const edges = new Map();
  const add = (from, to, protocol) => edges.set(`${from}:${to}`, { from, to, protocol });
  for (const row of rows) if (row.parent !== null) add(row.parent, row.node.id, false);
  for (const link of crossChainLinks) add(link.manager ?? link.from, link.to, false);
  for (const link of protocolLinks) add(link.from, link.to, true);
  return [...edges.values()];
}

export function traceRows(model, { transaction = "", protocol = false, localReads = true, search = "", collapsed = new Set() } = {}) {
  const txs = new Map(model.transactions.map(tx => [tx.chain + ":" + tx.hash, tx]));
  const tree = protocolTree(model, protocol);
  const roots = (tree?.roots ?? model.roots).filter(root => {
    const tx = txs.get(root.chain + ":" + root.tx);
    return transaction || protocol || tx?.requested || (root.inFlow ?? tx?.inFlow) !== false;
  });
  const triggers = model.transactions.filter(tx => tx.role === 'trigger' && tx.inFlow === true);
  const source = triggers.find(tx => tx.requested) ?? (triggers.length === 1 ? triggers[0] : undefined)
    ?? model.transactions.find(tx => tx.requested && !tx.role);
  if (protocol && source) {
    const prerequisiteRole = source.chain === 'L1' ? 'settlement' : 'table-load';
    const prerequisites = new Set(roots.filter(root => {
      const tx = txs.get(root.chain + ':' + root.tx);
      return root.chain === source.chain && tx?.role === prerequisiteRole && tx.inFlow === true &&
        Number.isSafeInteger(tx.block) && Number.isSafeInteger(source?.block) &&
        (tx.block < source.block || tx.block === source.block &&
          Number.isSafeInteger(tx.index) && Number.isSafeInteger(source.index) && tx.index < source.index);
    }).map(root => root.node));
    // Put verified prerequisites before their initiating transaction: L1 batch
    // preparation for L1 origins, or the L2 table load for L2 origins. Never
    // compare block heights across chains or guess unknown transaction indices.
    roots.sort((a, b) => {
      const earlier = prerequisites.has(a.node), later = prerequisites.has(b.node);
      if (earlier !== later) return earlier ? -1 : 1;
      if (!earlier) return 0;
      const x = txs.get(a.chain + ':' + a.tx), y = txs.get(b.chain + ':' + b.tx);
      return x.block - y.block || (x.index ?? 0) - (y.index ?? 0);
    });
  }
  const rootIds = new Set(roots.map(root => root.node));
  const initiatingRoots = new Set(roots.filter(root => {
    const tx = txs.get(root.chain + ':' + root.tx);
    return tx?.role === 'trigger' && (tx.inFlow === true || tx.requested || !!transaction);
  }).map(root => root.node));
  const stack = roots.slice().reverse().map(root => ({ id: root.node, depth: 0, parent: null }));
  const rows = [], visited = new Set(), query = search.trim().toLowerCase();
  while (stack.length) {
    const item = stack.pop(), original = model.nodes[item.id];
    const node = original && tree ? { ...original, children: tree.children.get(original.id) } : original;
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);
    // Prune the whole unrelated batch entry, rather than promoting its calls.
    // Selecting a transaction explicitly restores its full recorded contents.
    if (!transaction && model.mode !== 'physical' && node.flowAttempt === 'other') continue;
    const inTransaction = !transaction || node.chain + ":" + node.tx === transaction;
    const matches = !query || [node.contract, node.proxyContract, node.fn, node.address, node.tx, node.input].some(value => String(value || "").toLowerCase().includes(query));
    // Keep top-level reads and evidence; an explicit search also reveals matching local reads.
    const showRead = localReads || !!query || rootIds.has(node.id) || !isLocalRead(node);
    // A user transaction sent directly to a proxy is still the initiating call,
    // not optional internal plumbing. Keep its chain and first crossing visible.
    const initiatingProxy = initiatingRoots.has(node.id) && !!node.outgoing;
    const visible = inTransaction && (protocol || !node.protocol || initiatingProxy) && showRead && matches;
    if (visible) rows.push({ node, depth: item.depth, parent: item.parent });
    if (visible && collapsed.has(node.id) && !query) continue;
    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push({ id: node.children[index], depth: visible ? item.depth + 1 : item.depth, parent: visible ? node.id : item.parent });
    }
  }
  return rows;
}
