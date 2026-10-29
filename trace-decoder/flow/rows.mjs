// Pure selection/layout input shared by the React views and regression tests.
// Hidden protocol calls and local reads promote their children; evidence stays visible.
const isLocalRead = node => (node.isStatic || node.callType === "STATICCALL") &&
  !node.failed && !node.reverted && node.kind !== "ghost" &&
  !node.crossing && !node.outgoing && !node.crossChainRead &&
  !node.preparedResult && !node.preparedResponse;
export function traceRows(model, { transaction = "", protocol = false, localReads = true, search = "", collapsed = new Set() } = {}) {
  const txs = new Map(model.transactions.map(tx => [tx.chain + ":" + tx.hash, tx]));
  const roots = model.roots.filter(root => {
    const tx = txs.get(root.chain + ":" + root.tx);
    return transaction || protocol || tx?.requested || (root.inFlow ?? tx?.inFlow) !== false;
  });
  const rootIds = new Set(roots.map(root => root.node));
  const stack = roots.slice().reverse().map(root => ({ id: root.node, depth: 0, parent: null }));
  const rows = [], visited = new Set(), query = search.trim().toLowerCase();
  while (stack.length) {
    const item = stack.pop(), node = model.nodes[item.id];
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);
    const inTransaction = !transaction || node.chain + ":" + node.tx === transaction;
    const matches = !query || [node.contract, node.fn, node.address, node.tx, node.input].some(value => String(value || "").toLowerCase().includes(query));
    // Keep top-level reads and evidence; an explicit search also reveals matching local reads.
    const showRead = localReads || !!query || rootIds.has(node.id) || !isLocalRead(node);
    const visible = inTransaction && (protocol || !node.protocol) && showRead && matches;
    if (visible) rows.push({ node, depth: item.depth, parent: item.parent });
    if (visible && collapsed.has(node.id) && !query) continue;
    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push({ id: node.children[index], depth: visible ? item.depth + 1 : item.depth, parent: visible ? node.id : item.parent });
    }
  }
  return rows;
}
