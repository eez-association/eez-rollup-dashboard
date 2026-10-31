import assert from "node:assert/strict";
import test from "node:test";
import { traceRows } from "../flow/rows.mjs";

function model() {
  return {
    transactions: [{ chain: "L1", hash: "source", requested: true, inFlow: true }, { chain: "L2", hash: "other", inFlow: false }],
    roots: [{ node: 0, chain: "L1", tx: "source" }, { node: 4, chain: "L2", tx: "other" }],
    nodes: [
      { id: 0, chain: "L1", tx: "source", contract: "Caller", children: [1] },
      { id: 1, chain: "L1", tx: "source", protocol: true, children: [2] },
      { id: 2, chain: "L2", tx: "delivery", contract: "Counter", children: [3] },
      { id: 3, chain: "L1", tx: null, kind: "ghost", contract: "Unobserved", children: [] },
      { id: 4, chain: "L2", tx: "other", contract: "Unrelated", children: [] },
    ],
  };
}
test("hidden protocol nodes promote children while preserving crossing direction", () => {
  const rows = traceRows(model());
  assert.deepEqual(rows.map(row => row.node.id), [0, 2, 3]);
  assert.equal(rows[1].parent, 0);
  assert.equal(rows[2].node.kind, "ghost");
});
test("transaction selection can find a delivery nested under another transaction's root", () => {
  assert.deepEqual(traceRows(model(), { transaction: "L2:delivery" }).map(row => row.node.id), [2]);
  assert.deepEqual(traceRows(model(), { transaction: "L2:other" }).map(row => row.node.id), [4]);
});
test("search explores collapsed descendants and protocol visibility is explicit", () => {
  assert.deepEqual(traceRows(model(), { collapsed: new Set([0]) }).map(row => row.node.id), [0]);
  assert.deepEqual(traceRows(model(), { search: "counter", collapsed: new Set([0]) }).map(row => row.node.id), [2]);
  assert.deepEqual(traceRows(model(), { protocol: true }).map(row => row.node.id), [0, 1, 2, 3, 4]);
});
test("iterative traversal handles deep traces and guards against duplicate or cyclic edges", () => {
  const data = model();
  data.roots = [{ node: 0, chain: "L1", tx: "source" }];
  data.nodes = Array.from({ length: 10000 }, (_, id) => ({
    id, chain: "L1", tx: "source", children: id < 9999 ? [id + 1] : [0],
  }));
  assert.equal(traceRows(data).length, 10000);
});

test("a shared batch dependency does not add its unrelated roots to the connected flow", () => {
  const data = model();
  data.transactions[1].inFlow = true;
  data.roots[0].inFlow = true;
  data.roots[1].inFlow = false;
  assert.deepEqual(traceRows(data).map(row => row.node.id), [0, 2, 3]);
  assert.deepEqual(traceRows(data, { transaction: "L2:other" }).map(row => row.node.id), [4]);
  assert.deepEqual(traceRows(data, { protocol: true }).map(row => row.node.id), [0, 1, 2, 3, 4]);
});

test("local reads can be hidden without hiding cross-chain evidence or descendants", () => {
  const data = model();
  data.nodes[1].protocol = false;
  data.nodes[1].isStatic = true;
  data.nodes[2].isStatic = true;
  data.nodes[2].crossing = { from: "L1", to: "L2", status: "matched" };
  data.nodes[3].isStatic = true;
  const rows = traceRows(data, { localReads: false });
  assert.deepEqual(rows.map(row => row.node.id), [0, 2, 3]);
  assert.equal(rows[1].parent, 0);
  assert.deepEqual(traceRows(data, { localReads: true }).map(row => row.node.id), [0, 1, 2, 3]);
});

test("failed reads, prepared results, top-level reads and explicit search stay visible", () => {
  const data = model();
  data.nodes[0].isStatic = true;
  data.nodes[1].protocol = false;
  data.nodes[1].isStatic = true;
  data.nodes[1].contract = "LocalReader";
  for (const flag of ["failed", "reverted", "preparedResult", "preparedResponse", "crossChainRead"]) {
    data.nodes[1][flag] = true;
    assert.ok(traceRows(data, { localReads: false }).some(row => row.node.id === 1), flag);
    delete data.nodes[1][flag];
  }
  assert.equal(traceRows(data, { localReads: false })[0].node.id, 0);
  assert.deepEqual(traceRows(data, { localReads: false, search: "LocalReader" }).map(row => row.node.id), [1]);
});

test("related execution table loads precede an L2 trigger in recorded chain order", () => {
  const data = {
    origin: { chain: 'L2' },
    transactions: [
      { chain: 'L2', hash: 'source', requested: true, block: 20, index: 2, inFlow: true },
      { chain: 'L2', hash: 'load-same-block', role: 'table-load', block: 20, index: 0, inFlow: true },
      { chain: 'L2', hash: 'load-earlier-block', role: 'table-load', block: 19, index: 8, inFlow: true },
      { chain: 'L2', hash: 'load-later', role: 'table-load', block: 20, index: 3, inFlow: true },
      { chain: 'L2', hash: 'load-unrelated', role: 'table-load', block: 19, index: 1, inFlow: false },
    ],
  };
  data.roots = data.transactions.map((tx, node) => ({ node, chain: tx.chain, tx: tx.hash }));
  data.nodes = data.transactions.map((tx, id) => ({ id, chain: tx.chain, tx: tx.hash, protocol: !tx.requested, children: [] }));
  const original = structuredClone(data);
  for (const mode of ['combined', 'physical']) {
    assert.deepEqual(traceRows({ ...data, mode }, { protocol: true }).map(row => row.node.id), [2, 1, 0, 3, 4]);
  }
  assert.deepEqual(traceRows(data, { protocol: false }).map(row => row.node.id), [0]);
  assert.deepEqual(traceRows(data, { protocol: true, transaction: 'L2:source' }).map(row => row.node.id), [0]);
  assert.deepEqual(traceRows({ ...data, origin: { chain: 'L1' } }, { protocol: true }).map(row => row.node.id), [0, 1, 2, 3, 4]);
  assert.deepEqual(data, original, 'view ordering does not mutate the decoded model');
  data.transactions[1].index = null;
  assert.deepEqual(traceRows(data, { protocol: true }).map(row => row.node.id), [2, 0, 1, 3, 4], 'unknown same-block order is not guessed');
});
