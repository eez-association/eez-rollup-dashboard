import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { VerificationWorker, loadBuilds, loadAdditionalSources, publicJob } from './worker.mjs';
import { blockscoutApiUrl } from './network.mjs';
// The existing dashboard config is the sole network authority. No user-supplied
// URLs, compiler inputs, private keys or new .env settings are accepted.
const dashboard = process.argv[2] ?? 'http://127.0.0.1:8080';
const directory = resolve(process.argv[3] ?? '/data');
let worker, starting = false, admitting = 0;
async function start() {
  if (worker || starting) return; starting = true;
  try {
    const response = await fetch(`${dashboard}/config.json`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Dashboard configuration unavailable');
    const c = await response.json(), networks = {};
    for (const chain of ['l1','l2']) {
      const rpc = new URL(c[`${chain}RpcUrl`], dashboard).href;
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(10_000) });
      const r = await response.json(); if (r.error || !r.result) throw new Error('Cannot identify verification network');
      // Etherscan API keys are not required: Ethereum uses public Blockscout.
      networks[Number(BigInt(r.result))] = { rpc, explorerApi: BigInt(r.result) === 1n ? 'https://eth.blockscout.com/api' : blockscoutApiUrl(c[`${chain}ExplorerApiUrl`], c[`${chain}ExplorerUrl`], dashboard) };
    }
    worker = new VerificationWorker({ directory, builds: loadBuilds('verification/builds'), additionalSources: loadAdditionalSources('verification/supplemental'), networks });
    console.log('Treasury source verification ready');
  } catch { console.error('Treasury verification is waiting for dashboard network configuration'); }
  finally { starting = false; }
}
const server = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.url === '/healthz') return send(worker ? 200 : 503, { ready: !!worker });
  if (!worker) return send(503, { error: 'Verification is starting; submissions will retry automatically' });
  try {
    if (req.method === 'POST' && req.url === '/jobs') {
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Expected JSON' });
      let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2048) return send(413, { error: 'Request too large' }); }
      if (admitting >= 4) return send(429, { error: 'Verification is busy; retry shortly' });
      admitting++;
      try { return send(202, publicJob(await worker.admit(JSON.parse(data)))); }
      finally { admitting--; }
    }
    const retry = /^\/jobs\/([a-f\d]{64})\/retry$/.exec(req.url ?? '');
    if (req.method === 'POST' && retry) return send(202, publicJob(worker.retry(retry[1])));
    const match = /^\/jobs\/([a-f\d]{64})$/.exec(req.url ?? '');
    if (req.method === 'GET' && match) { const job = worker.jobs.get(match[1]); return send(job ? 200 : 404, job ? publicJob(job) : { error: 'Unknown job' }); }
    return send(404, { error: 'Unknown verification operation' });
  } catch (e) { send(400, { error: e.message }); }
});
server.listen(18081, '127.0.0.1');
await start();
const timer = setInterval(() => { if (!worker) void start(); else void worker.tick().catch(() => console.error('Verification queue write failed; retained jobs will retry')); }, 2000);
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { clearInterval(timer); server.close(); });
