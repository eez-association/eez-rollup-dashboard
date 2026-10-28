import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { keccak256, toHex } from 'viem';
import { setupIdentity, mainnetSetupKey, mainnetManifestKey } from '../src/lib/treasury/mainnetSetup.ts';
const network = JSON.parse(readFileSync('src/lib/treasury/mainnet-network.json'));
const { build } = JSON.parse(readFileSync('src/lib/treasury/current-build.json'));

const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-setup-completion-browser';
await mkdir(`${directory}/tmp`, { recursive: true });
process.env.TMPDIR = `${process.cwd()}/${directory}/tmp`;
const address = n => toHex(n, { size: 20 }), hash = s => keccak256(toHex(s));
const state = { version: 3, build, identity: setupIdentity(network), deployer: address(44), salt: hash('completion'), code: [],
  addresses: { safeL1: address(11), safeL2: address(12) }, completed: Array.from({length:6},(_,i)=>({hash:hash(`confirmed${i}`),chain:['l1','l2','l2','l1','l1','l1'][i],number:toHex(i+1),blockHash:hash(`block${i}`)})) };
const target = { l1: { rpc: 'http://127.0.0.1:1', front: 'http://127.0.0.1:2', explorer:'https://example.com' }, l2: { rpc: 'http://127.0.0.1:3', front: 'http://127.0.0.1:4', explorer:'https://example.com' }, fees: { l1: '1', l2: '1' } };
const manifest = { version: 1, environment: 'isolated-devnet', instance: hash(`${state.salt}:${state.addresses.safeL1}:${state.addresses.safeL2}`),
  l1: { ...target.l1, chainId: 31337, genesis: hash('l1') }, l2: { ...target.l2, chainId: 31338, genesis: hash('l2') },
  registry: address(1), manager: address(2), safeL1: address(11), safeL2: address(12), adapter: address(13), action: address(14), ownerLabels: {},
  code: [11, 12, 13, 14].map(n => ({ chain: n === 11 ? 'l1' : 'l2', address: address(n), hash: hash(n) })) };
const fixture = { state, target, manifest, wallet: state.deployer };
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected network request: ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/completion-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  return route.fallback();
});
const load = async (options = {}, saved = state, reset = true) => {
  await page.goto(`${origin}/completion-fixture`);
  await page.evaluate(async ({ fixture, saved, reset, keys }) => {
    if (reset) { localStorage.clear(); localStorage.setItem(keys.state, JSON.stringify(saved)); }
    const module = await import('/tests/fixtures/treasury-setup-completion-browser.tsx'); module.mount(fixture);
  }, { fixture: { ...fixture, ...options }, saved, reset, keys: { state: mainnetSetupKey, manifest: mainnetManifestKey } });
};
const savedManifest = () => page.evaluate(key => localStorage.getItem(key), mainnetManifestKey);
const controls = () => page.evaluate(() => { const c = window.completionTest; return { checks: c.checks, walletCalls: c.walletCalls, callbacks: c.callbacks, locks: c.locks }; });
const noSetup = async () => {
  for (const name of ['Set up your shared treasury', 'Setup complete', 'Ready to open your treasury'])
    assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Verify contracts and open treasury', exact: true }).count(), 0);
  assert.equal(await page.getByText(/transactions completed; 0 remaining/).count(), 0);
};
try {
  await load();
  if (process.env.EEZ_UI_EXPECT_MANUAL === '1') {
    await page.getByRole('button', { name: 'Verify contracts and open treasury', exact: true }).waitFor();
    assert.equal((await controls()).checks, 0); assert.equal(await savedManifest(), null);
    await page.screenshot({ path: `${directory}/before.png`, fullPage: true });
    passed.push('reproduced: completed setup waits for a manual verification click');
  } else {
    await page.getByRole('heading', { name: 'Shared treasury', exact: true }).waitFor(); await noSetup();
    assert.deepEqual(await controls(), { checks: 1, walletCalls: 0, callbacks: 1, locks: [true] });
    assert.deepEqual(JSON.parse(await savedManifest()), manifest);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), mainnetSetupKey), state);
    passed.push('completed setup verifies and opens automatically, preserving its journal');
    await load({}, state, false);
    await page.getByRole('heading', { name: 'Shared treasury', exact: true }).waitFor(); await noSetup();
    assert.equal((await controls()).checks, 0);
    passed.push('an already configured treasury opens directly after reload');

    await load({ failure: 'Allowance verification failed' });
    await page.getByRole('alert').filter({ hasText: 'Allowance verification failed' }).waitFor(); await noSetup();
    assert.equal(await savedManifest(), null);
    await page.waitForTimeout(4500); assert.equal((await controls()).checks, 1, 'failure must not trigger an automatic verification loop');
    await page.screenshot({ path: `${directory}/retry-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${directory}/retry-mobile.png`, fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => { window.completionTest.failure = ''; });
    await page.getByRole('button', { name: 'Retry verification', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared treasury', exact: true }).waitFor();
    assert.deepEqual(await controls(), { checks: 2, walletCalls: 0, callbacks: 1, locks: [true, true] });
    passed.push('failed checks preserve setup and allow an explicit retry without wallet requests');

    const pending = { ...state, completed: state.completed.slice(0,5), pending: { id: '5', chain: 'l1', sender: state.deployer, nonce: '0x1', data: '0x1234', hash: hash('confirmed'), outputs: [] } };
    await load({}, pending);
    await page.getByRole('heading', { name: 'Approve EEZ-X setup', exact: true }).waitFor();
    assert.equal((await controls()).checks, 0); assert.equal(await savedManifest(), null);
    await page.evaluate(() => { window.completionTest.confirm = true; });
    await page.getByRole('heading', { name: 'Shared treasury', exact: true }).waitFor();
    assert.deepEqual(await controls(), { checks: 1, walletCalls: 0, callbacks: 1, locks: [true] });
    passed.push('the final reconciled transaction triggers verification; pending work does not');

    await load({ deferred: true });
    await page.waitForFunction(() => !!window.completionTest.release); await noSetup();
    await page.getByRole('status').filter({ hasText: 'Verifying your treasury' }).waitFor();
    await page.screenshot({ path: `${directory}/opening-mobile.png`, fullPage: true });
    const held = await page.evaluate(async key => navigator.locks.request(key, { ifAvailable: true }, lock => !!lock), mainnetSetupKey);
    assert.equal(held, false, 'verification must hold the restart/setup lock');
    await page.evaluate(() => { window.completionTest.unmount(); window.completionTest.release(); });
    await page.waitForFunction(async key => !(await navigator.locks.query()).held?.some(lock => lock.name === key), mainnetSetupKey);
    assert.equal(await savedManifest(), null); assert.equal((await controls()).callbacks, 0);
    passed.push('leaving during verification cannot publish a stale manifest');
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ passed, mode: 'isolated React lifecycle with controlled verification; no chain or wallet writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
