import { Worker } from "node:worker_threads";

export function workerRunner(config, { timeoutMs = 120000, maxRequests = 6000 } = {}) {
  return (request, progress) => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { config, request, maxRequests, deadline: Date.now() + timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 8 },
    });
    let settled = false, rejectJob;
    const promise = new Promise((resolve, reject) => {
      rejectJob = reject;
      worker.on("message", message => {
        if (settled) return;
        if (message.type === "progress") progress(message.message);
        else if (message.type === "result") { settled = true; resolve(message); }
        else if (message.type === "error") { settled = true; reject(Object.assign(new Error("Decode failed"), { code: message.code })); }
      });
      worker.on("error", () => { if (!settled) { settled = true; reject(new Error("Worker failed")); } });
      worker.on("exit", () => { if (!settled) { settled = true; reject(new Error("Worker exited without a result")); } });
    });
    const stop = code => {
      if (settled) return;
      settled = true; rejectJob(Object.assign(new Error(code), { code }));
      void worker.terminate();
    };
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    // Both success and failure release the worker and every outstanding RPC.
    const finished = promise.finally(async () => { clearTimeout(timeout); await worker.terminate(); });
    return { promise: finished, cancel: () => stop("cancelled") };
  };
}
