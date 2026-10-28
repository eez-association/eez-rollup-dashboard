// Bound concurrent treasury reads across history, balances and active payments.
// Identical in-flight reads share work; results are never cached across checks.
type Endpoint = { active: number; waiting: (() => void)[]; cooldown: number; reads: Map<string, Promise<unknown>> };
const endpoints = new Map<string, Endpoint>();
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const readOnly = (method: string) => /^(eth_get|eez_get|debug_trace)/.test(method)
  || ["eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eez_quoteFee", "net_version"].includes(method);

export async function treasuryRpc<T>(url: string, method: string, params: unknown[] = [], timeout = 12_000): Promise<T> {
  let endpoint = endpoints.get(url);
  if (!endpoint) { endpoint = { active: 0, waiting: [], cooldown: 0, reads: new Map() }; endpoints.set(url, endpoint); }
  const state = endpoint, canRetry = readOnly(method), key = JSON.stringify([method, params, timeout]);
  const pending = canRetry && state.reads.get(key);
  if (pending) return pending as Promise<T>;
  const request = (async () => {
    if (state.active >= 4) await new Promise<void>(resolve => state.waiting.push(resolve));
    else state.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        while (state.cooldown > Date.now()) {
          const delay = state.cooldown - Date.now();
          if (delay > 10_000) throw new Error("Treasury RPC is rate limited (429). Confirmation checks will retry automatically.");
          await wait(delay);
        }
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
        if (response.status === 429 && canRetry) {
          const retry = response.headers?.get("retry-after"), seconds = retry && Number(retry);
          const retryMs = retry ? (Number.isFinite(seconds) ? Number(seconds) * 1000 : Date.parse(retry) - Date.now()) : 2000;
          state.cooldown = Math.max(state.cooldown, Date.now() + (Number.isFinite(retryMs) ? Math.max(1000, retryMs) : 2000));
          await response.body?.cancel();
          if (attempt === 0) continue;
          throw new Error("Treasury RPC is rate limited (429). Confirmation checks will retry automatically.");
        }
        if (!response.ok) throw new Error(`Treasury RPC unavailable (${response.status})`);
        const body = await response.json();
        if (body.error) throw new Error(body.error.message || "Treasury RPC failed");
        return body.result as T;
      }
    } finally {
      const next = state.waiting.shift();
      if (next) next(); else state.active--;
    }
  })();
  if (!canRetry) return request;
  const shared = request.finally(() => state.reads.delete(key));
  state.reads.set(key, shared);
  return shared;
}
