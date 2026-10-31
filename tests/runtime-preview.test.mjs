import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { preview } from 'vite';

test('production preview serves browser config and preserves exact upstream RPC paths and queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eez-preview-')), requests = [];
  const upstream = createServer(async (req, res) => {
    requests.push(req.url); for await (const _ of req) { /* Drain the JSON request. */ }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x27d8' }));
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const old = process.env.EEZ_UI_RUNTIME_CONFIG, oldBase = process.env.EEZ_UI_BASE_PATH;
  let server;
  try {
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), '<p>Built preview fixture</p>');
    const origin = `http://127.0.0.1:${upstream.address().port}`, runtime = join(root, 'config.json');
    const browser = { networkName: 'local fixture', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2' };
    await writeFile(runtime, JSON.stringify({ browser, proxy: { l1Rpc: `${origin}/nested/rpc`, l2Rpc: `${origin}/?token=public-fixture`, l1Front: `${origin}/composer/l1`, l2Front: `${origin}/composer/l2` } }));
    process.env.EEZ_UI_RUNTIME_CONFIG = runtime; process.env.EEZ_UI_BASE_PATH = '/dashboard/';
    server = await preview({ root, configFile: resolve('vite.config.ts'), envFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const path of ['/config.json', '/dashboard/config.json']) assert.deepEqual(await (await fetch(base + path)).json(), browser);
    for (const path of ['/rpc/l1', '/rpc/l2', '/composer/l1', '/composer/l2']) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      assert.equal(r.status, 200); assert.equal((await r.json()).result, '0x27d8');
    }
    assert.deepEqual(requests, ['/nested/rpc', '/?token=public-fixture', '/composer/l1', '/composer/l2']);
    await writeFile(runtime, JSON.stringify({ browser: { ...browser, networkName: 'updated fixture' } }));
    assert.equal((await (await fetch(base + '/dashboard/config.json')).json()).networkName, 'updated fixture');
  } finally {
    await server?.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    if (old === undefined) delete process.env.EEZ_UI_RUNTIME_CONFIG; else process.env.EEZ_UI_RUNTIME_CONFIG = old;
    if (oldBase === undefined) delete process.env.EEZ_UI_BASE_PATH; else process.env.EEZ_UI_BASE_PATH = oldBase;
    await rm(root, { recursive: true, force: true });
  }
});

test('CoW API aliases preserve paths under root, dashboard, and custom preview bases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eez-cow-preview-'));
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const keys = ['EEZ_UI_RUNTIME_CONFIG', 'EEZ_UI_BASE_PATH', 'EEZ_UI_COW_UPSTREAM'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server;
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), '<p>SPA fallback must never reach the API client</p>');
    const runtime = join(root, 'config.json');
    await writeFile(runtime, JSON.stringify({ browser: {}, proxy: {} }));
    process.env.EEZ_UI_RUNTIME_CONFIG = runtime;
    process.env.EEZ_UI_COW_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    for (const basePath of ['/', '/dashboard/', '/custom/']) {
      process.env.EEZ_UI_BASE_PATH = basePath;
      server = await preview({ root, configFile: resolve('vite.config.ts'), envFile: false,
        preview: { host: '127.0.0.1', port: 0, strictPort: true } });
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      for (const prefix of new Set([basePath + 'cowdemo', '/cowdemo', '/dashboard/cowdemo'])) {
        const response = await fetch(`${origin}${prefix}/api/quote?token=fixture`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await response.json(), { path: '/api/quote?token=fixture' });
      }
      await server.close(); server = undefined;
    }
  } finally {
    await server?.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
