import { parentPort, workerData } from "node:worker_threads";
import { decodeCrossChainTrace } from "../src/engine.mjs";
import { buildFlowModel } from "../flow/model.mjs";

const reasons = {
  "transaction-links-pending": "Cross-chain transaction links are not complete yet. Retry after composer processing.",
  "invalid-transaction-links": "Cross-chain transaction links could not be verified against the chains.",
  "trace-unavailable": "The configured endpoint could not provide a call trace.",
  "historical-state-unavailable": "Historical state needed for this trace is unavailable.",
  "transaction-unavailable": "A related transaction is not available.",
  "transaction-recovery-failed": "A related transaction could not be verified.",
  "receipt-unavailable": "A transaction receipt is unavailable.",
  "block-unavailable": "A related block is unavailable.",
  "block-scan-failed": "Part of the related block range could not be inspected.",
  "correlation-lookup-failed": "Settlement information could not be retrieved.",
  "settlement-not-found": "Settlement is not indexed yet. Retry after the batch is posted.",
  "invalid-settlement": "Settlement information could not be verified against the chains.",
  "bounded-search-exhausted": "No verified settlement mapping was available in the search window.",
};
let requests = 0, active = 0, exceeded = null;
const waiting = [];
// Bound aggregate RPC/explorer work and body sizes. The parent worker deadline
// also stops synchronous graph work and RPCs whose failures the engine handles.
async function boundedFetch(url, options = {}) {
  let cost = 1;
  if (typeof options.body === "string") {
    const payload = JSON.parse(options.body);
    if (Array.isArray(payload)) cost = payload.length;
  }
  requests += cost;
  if (requests > workerData.maxRequests) { exceeded = "rpc-limit"; throw new Error("RPC budget exceeded"); }
  if (active >= 8) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try {
    options.signal?.throwIfAborted();
    const response = await fetch(url, { ...options, redirect: "error" });
    const reader = response.body?.getReader(), chunks = [];
    let length = 0;
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16 * 1024 * 1024) {
        exceeded = "response-limit"; await reader.cancel(); throw new Error("Response budget exceeded");
      }
      chunks.push(chunk.value);
    }
    return new Response(chunks.length ? Buffer.concat(chunks) : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

async function main() {
  const { config, request } = workerData;
  for (const [chain, key] of [["L1", "l1"], ["L2", "l2"]]) {
    const expected = config["expected" + chain + "ChainId"];
    if (expected != null && BigInt(expected) !== BigInt(request.chainIds[key])) {
      throw Object.assign(new Error("Network mismatch"), { code: "network-mismatch" });
    }
  }
  let lastProgress = 0;
  const trace = await decodeCrossChainTrace({
    ...config, fetch: boundedFetch, scanConcurrency: 2,
    metadataBudget: () => ({
      timeoutMs: Math.max(0, workerData.deadline - Date.now() - 250),
      maxRequests: Math.max(0, workerData.maxRequests - requests),
    }),
    originChain: request.chain === "auto" ? undefined : request.chain.toUpperCase(),
    expectedL1ChainId: request.chainIds.l1, expectedL2ChainId: request.chainIds.l2,
    onDiagnostic: item => {
      if (Date.now() - lastProgress < 300) return;
      lastProgress = Date.now();
      const message = item.code === "search-progress" ? "Finding related transactions on both chains"
        : item.code === "settlement-validation" ? "Verifying settlement block hashes"
        : "Decoding transaction calls and matching chain crossings";
      parentPort.postMessage({ type: "progress", message });
    },
  }, request.hash);
  if (exceeded) throw Object.assign(new Error("Resource limit exceeded"), { code: exceeded });
  const model = buildFlowModel(trace);
  // Provider error text may contain private URLs or credentials. The public
  // model carries stable diagnostic codes and curated messages, never config,
  // Composer responses, raw provider failures, or the full engine result.
  const sanitize = view => {
    const issue = item => ({ code: item.code, frameId: item.frameId,
      message: reasons[item.code] || "Some execution evidence could not be verified." });
    view.unresolved = view.unresolved.map(issue);
    view.matchingNotes = (view.matchingNotes || []).map(issue);
    if (view.recordedView) sanitize(view.recordedView);
  };
  sanitize(model);
  const partial = model.unresolved.length > 0 || model.transactions.some(tx => !tx.traced) ||
    model.stats.matched + (model.stats.preparedResults || 0) < model.stats.crossings;
  const result = { apiVersion: 1, observedAt: new Date().toISOString(), partial, model };
  const json = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw Object.assign(new Error("Result limit exceeded"), { code: "result-limit" });
  parentPort.postMessage({ type: "result", json, partial });
}

main().catch(error => {
  const code = exceeded || (["network-mismatch", "result-limit"].includes(error.code) ? error.code : null) ||
    (/chain ID|configured chain/i.test(error.message) ? "network-mismatch"
      : /pending/i.test(error.message) ? "pending"
      : /not found on either chain/i.test(error.message) ? "not-found" : "decode-failed");
  parentPort.postMessage({ type: "error", code });
});
