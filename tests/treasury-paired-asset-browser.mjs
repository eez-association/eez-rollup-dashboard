import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { decodeFunctionData, toHex } from 'viem';
import { readFileSync } from 'node:fs';
const build = JSON.parse(readFileSync('src/lib/treasury/current-build.json')).build;
const release = JSON.parse(readFileSync(`src/lib/treasury/builds/${build}.json`));
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage(), sends = [], errors = [], origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('recordWalletSend', request => { sends.push(request); return toHex(sends.length, { size: 32 }); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url()); assert.equal(url.origin, origin);
    if (url.pathname === '/paired') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  const mount = async () => { await page.goto(`${origin}/paired`); await page.evaluate(async () => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mount()); };
  await mount();
  const loaded = await page.evaluate(async () => {
    const m = await import('/src/lib/treasury/release.ts'); const current = await m.loadTreasuryArtifacts();
    const failures = [];
    for (const saved of [{}, { build: '026c1f779c5c3bed2cc56f91707bb7b9eca67c240ef7cfd47ca83017cb868df1' }]) {
      try { await m.loadTreasuryArtifacts(saved); } catch (e) { failures.push(e.message); }
    }
    return { contracts: Object.keys(current.contracts), failures };
  });
  assert(loaded.contracts.includes('PairedTreasuryPolicy')); assert(!loaded.contracts.includes('SharedTreasuryBridge'));
  assert.equal(loaded.failures.length, 2); assert(loaded.failures.every(x => x.includes('retired')));
  await page.getByRole('button', { name: 'Deploy Test USDC', exact: true }).click();
  await page.getByText('Waiting for the recorded transaction and canonical confirmation. Do not submit it again.').waitFor();
  assert.equal(sends.length, 1); assert(sends[0].data.startsWith(release.contracts.TestUSDC.bytecode));
  await mount();
  assert(await page.getByRole('button', { name: 'Deploy Test USDC', exact: true }).isDisabled()); assert.equal(sends.length, 1);
  await page.evaluate(() => { window.confirmFixture = true; });
  await page.getByText('Amount: 1,000 Test USDC', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Amount (Test USDC)', { exact: true }).count(), 0);
  await page.evaluate(() => { window.confirmFixture = false; });
  const recipient = '0x0000000000000000000000000000000000000099';
  await page.getByLabel('Recipient address', { exact: true }).fill(recipient);
  await page.getByLabel('Destination network', { exact: true }).selectOption('l2');
  await page.getByRole('button', { name: 'Claim 1,000 Test USDC', exact: true }).click();
  await page.getByText('Waiting for the recorded transaction and canonical confirmation. Do not submit it again.').waitFor();
  assert.equal(sends.length, 2);
  const call = decodeFunctionData({ abi: release.contracts.TestUSDC.abi, data: sends[1].data });
  assert.equal(call.functionName, 'claimOnL2'); assert.equal(call.args[0].toLowerCase(), recipient);
  await mount(); await page.getByRole('button', { name: 'Claim 1,000 Test USDC', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Claim 1,000 Test USDC', exact: true }).isDisabled());
  assert.equal(await page.getByLabel('Recipient address', { exact: true }).inputValue(), recipient); assert.equal(sends.length, 2);
  await page.evaluate(async () => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mountLegacy());
  await page.getByRole('alert').getByText('This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign approval', exact: true }).count(), 0); assert.equal(sends.length, 2);
  assert.deepEqual(errors, []);
  console.log('PASS current release only, genuine TestUSDC calldata, fixed claims, and pending deployment/claim reload locks (sandbox enabled)');
} finally { await browser?.close(); await server.close(); }
