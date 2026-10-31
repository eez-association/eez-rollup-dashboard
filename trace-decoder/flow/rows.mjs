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
  if (protocol && model.origin?.chain === 'L2') {
    const source = model.transactions.find(tx => tx.requested && tx.chain === 'L2');
    const prerequisites = new Set(roots.filter(root => {
      const tx = txs.get(root.chain + ':' + root.tx);
      return root.chain === 'L2' && tx?.role === 'table-load' && tx.inFlow === true &&
        Number.isSafeInteger(tx.block) && Number.isSafeInteger(source?.block) &&
        (tx.block < source.block || tx.block === source.block &&
          Number.isSafeInteger(tx.index) && Number.isSafeInteger(source.index) && tx.index < source.index);
    }).map(root => root.node));
    // Within L2, a verified earlier table load precedes the transaction that
    // consumes it. Preserve the other roots' logical order across chains.
    roots.sort((a, b) => {
      const earlier = prerequisites.has(a.node), later = prerequisites.has(b.node);
      if (earlier !== later) return earlier ? -1 : 1;
      if (!earlier) return 0;
      const x = txs.get(a.chain + ':' + a.tx), y = txs.get(b.chain + ':' + b.tx);
      return x.block - y.block || (x.index ?? 0) - (y.index ?? 0);
    });
  }
  const rootIds = new Set(roots.map(root => root.node));
  const stack = roots.slice().reverse().map(root => ({ id: root.node, depth: 0, parent: null }));
  const rows = [], visited = new Set(), query = search.trim().toLowerCase();
  while (stack.length) {
    const item = stack.pop(), node = model.nodes[item.id];
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);
    // Prune the whole unrelated batch entry, rather than promoting its calls.
    // Selecting a transaction explicitly restores its full recorded contents.
    if (!transaction && model.mode !== 'physical' && node.flowAttempt === 'other') continue;
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
