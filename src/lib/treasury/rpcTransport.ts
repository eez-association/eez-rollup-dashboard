// Bound concurrent treasury reads across history, balances and active payments.
// Identical in-flight reads share work; results are never cached across checks.
type BatchRead = { method: string; params: unknown[]; resolve: (value: unknown) => void; reject: (error: unknown) => void };
type Endpoint = { active: number; waiting: (() => void)[]; cooldown: number; reads: Map<string, Promise<unknown>>;
  batches: Map<number, BatchRead[]>; batchUnsupported?: boolean };
const endpoints = new Map<string, Endpoint>();
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const readOnly = (method: string) => /^(eth_get|eez_get|debug_trace)/.test(method)
  || ["eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eez_quoteFee", "net_version"].includes(method);

function endpointFor(url: string) {
  let endpoint = endpoints.get(url);
  if (!endpoint) { endpoint = { active: 0, waiting: [], cooldown: 0, reads: new Map(), batches: new Map() }; endpoints.set(url, endpoint); }
  return endpoint;
}
const batchable = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getStorageAt', 'eth_call', 'eth_getBalance', 'eth_getTransactionCount']);
class BatchUnsupported extends Error {}
let batchId = 0;

/** Bound HTTP concurrency and preserve the existing read-only rate-limit backoff. */
async function post(url: string, payload: unknown, canRetry: boolean, timeout: number, batch = false): Promise<any> {
  const state = endpointFor(url);
  if (state.active >= 4) await new Promise<void>(resolve => state.waiting.push(resolve));
  else state.active++;
  try {
    for (let attempt = 0; ; attempt++) {
      while (state.cooldown > Date.now()) {
        const delay = state.cooldown - Date.now();
        if (delay > 10_000) throw new Error('Treasury RPC is rate limited (429). Confirmation checks will retry automatically.');
        await wait(delay);
      }
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
      if (response.status === 429 && canRetry) {
        const retry = response.headers?.get('retry-after'), seconds = retry && Number(retry);
        const retryMs = retry ? (Number.isFinite(seconds) ? Number(seconds) * 1000 : Date.parse(retry) - Date.now()) : 2000;
        state.cooldown = Math.max(state.cooldown, Date.now() + (Number.isFinite(retryMs) ? Math.max(1000, retryMs) : 2000));
        await response.body?.cancel();
        if (attempt === 0) continue;
        throw new Error('Treasury RPC is rate limited (429). Confirmation checks will retry automatically.');
      }
      if (batch && [400, 413, 415, 501].includes(response.status)) {
        await response.body?.cancel(); throw new BatchUnsupported();
      }
      if (!response.ok) throw new Error(`Treasury RPC unavailable (${response.status})`);
      const body = await response.json();
      if (batch && !Array.isArray(body) && [-32600, -32601].includes(body?.error?.code)) throw new BatchUnsupported();
      return body;
    }
  } finally {
    const next = state.waiting.shift();
    if (next) next(); else state.active--;
  }
}
function result(body: any) {
  if (body?.error) throw Object.assign(new Error(body.error.message || 'Treasury RPC failed'), { code: body.error.code });
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'result')) throw new Error('Treasury RPC returned an invalid response');
  return body.result;
}
const single = async (url: string, method: string, params: unknown[], timeout: number) =>
  result(await post(url, { jsonrpc: '2.0', id: 1, method, params }, readOnly(method), timeout));

async function flush(url: string, timeout: number, items: BatchRead[]) {
  const state = endpointFor(url);
  if (items.length === 1 || state.batchUnsupported) {
    await Promise.all(items.map(item => single(url, item.method, item.params, timeout).then(item.resolve, item.reject)));
    return;
  }
  const requests = items.map(item => ({ jsonrpc: '2.0', id: ++batchId, method: item.method, params: item.params }));
  try {
    const body = await post(url, requests, true, timeout, true);
    // Match by ID, never response order. Missing/duplicate IDs invalidate the whole envelope.
    if (!Array.isArray(body) || body.length !== items.length || new Set(body.map(item => item?.id)).size !== items.length
      || body.some(item => !requests.some(request => request.id === item?.id))) throw new Error('Treasury RPC returned an invalid batch response');
    const responses = new Map(body.map(item => [item.id, item]));
    items.forEach((item, i) => {
      try { item.resolve(result(responses.get(requests[i]!.id))); } catch (error) { item.reject(error); }
    });
  } catch (error) {
    if (error instanceof BatchUnsupported) {
      state.batchUnsupported = true;
      await Promise.all(items.map(item => single(url, item.method, item.params, timeout).then(item.resolve, item.reject)));
    } else items.forEach(item => item.reject(error));
  }
}
function queuedRead(url: string, method: string, params: unknown[], timeout: number) {
  const state = endpointFor(url);
  if (state.batchUnsupported) return single(url, method, params, timeout);
  return new Promise<unknown>((resolve, reject) => {
    let items = state.batches.get(timeout);
    if (!items) {
      items = []; state.batches.set(timeout, items);
      // One event-loop turn gathers independent reads; no polling results are cached.
      setTimeout(() => {
        const pending = state.batches.get(timeout)!;
        state.batches.delete(timeout);
        for (let i = 0; i < pending.length; i += 8) void flush(url, timeout, pending.slice(i, i + 8));
      }, 0);
    }
    items.push({ method, params, resolve, reject });
  });
}
function read<T>(url: string, method: string, params: unknown[], timeout: number, batch: boolean): Promise<T> {
  const state = endpointFor(url), canShare = readOnly(method), key = JSON.stringify([method, params, timeout]);
  const pending = canShare && state.reads.get(key);
  if (pending) return pending as Promise<T>;
  const request = batch && batchable.has(method) ? queuedRead(url, method, params, timeout) : single(url, method, params, timeout);
  if (!canShare) return request as Promise<T>;
  const shared = request.finally(() => state.reads.delete(key));
  state.reads.set(key, shared);
  return shared as Promise<T>;
}
export function treasuryRpc<T>(url: string, method: string, params: unknown[] = [], timeout = 12_000): Promise<T> {
  return read(url, method, params, timeout, false);
}
/** Standard read methods only: wallet sends, fee quotes and tracing remain individual requests. */
export function treasuryReadRpc<T>(url: string, method: string, params: unknown[] = [], timeout = 15_000): Promise<T> {
  return read(url, method, params, timeout, true);
}
