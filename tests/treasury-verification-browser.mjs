import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-verification-browser';
await mkdir(`${directory}/tmp`, { recursive: true });
process.env.TMPDIR = `${process.cwd()}/${directory}/tmp`;
const requests = [1, 2, 3].map(n => ({ build: 'ab'.repeat(32), chainId: n === 1 ? 10200 : 906969, transactionHash: `0x${String(n).repeat(64)}` }));
const key = 'eez:treasury:source-outbox';
const outbox = JSON.stringify({ sourceRequests: requests });
const delivered = [], errors = [], passed = [];
let unavailable = true, complete = false, sourceOnly = false, undiscovered = false;
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/verification-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  if (/\/jobs\/[a-f\d]{64}\/retry$/.test(url.pathname)) return route.fulfill({ status: 202, json: {} });
  if (url.pathname !== '/treasury-verification/jobs') return route.fallback();
  const request = route.request().postDataJSON(), index = requests.findIndex(r => r.transactionHash === request.transactionHash);
  assert(index >= 0); assert.deepEqual(request, requests[index]);
  delivered.push(index);
  if (unavailable && index === 0) return route.fulfill({ status: 400, json: { error: 'Wait for a successful canonical receipt' } });
  const status = undiscovered && index === 2 ? 'pending' : sourceOnly ? 'sourcify-verified' : complete || index < 2 ? 'verified' : 'pending';
  return route.fulfill({ json: { id: String(index + 1).repeat(64), status, contracts: undiscovered && index === 2 ? [] : [{ address: `0x${String(index + 1).repeat(40)}`, name: `Contract ${index + 1}`, status }] } });
});
try {
  await page.clock.install();
  await page.goto(`${origin}/verification-fixture`);
  await page.evaluate(async ({ key, outbox }) => {
    localStorage.setItem(key, outbox);
    const { mount } = await import('/tests/fixtures/treasury-verification-browser.tsx');
    window.unmountVerification = mount();
  }, { key, outbox });
  const details = page.getByLabel('Contract source verification');
  await details.locator('summary').filter({ hasText: 'Contract source verification will retry automatically' }).waitFor();
  assert.deepEqual(delivered, [0, 1, 2], 'an unavailable receipt must not block later verification requests');
  await details.locator('summary').click();
  await details.getByRole('link', { name: /Contract 2/ }).waitFor();
  await details.getByRole('link', { name: /Contract 3/ }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), outbox);
  passed.push('one rejected admission preserves its intent while later contracts are delivered and displayed');

  unavailable = false;
  await page.clock.fastForward(15_001);
  await details.locator('summary').filter({ hasText: 'Publishing to explorers · 2 of 3 verified' }).waitFor();
  assert.deepEqual(delivered, [0, 1, 2, 0, 1, 2]);
  assert.equal(await details.getByRole('status').count(), 0);
  passed.push('the automatic retry recovers the original request and clears the transient error');

  sourceOnly = true;
  await page.evaluate(() => window.dispatchEvent(new Event('treasury-source-request')));
  await details.locator('summary').filter({ hasText: /^Publishing to explorers · 0 of 3 verified$/ }).waitFor();
  assert.equal(await details.getByRole('link', { name: 'Exact source verified' }).count(), 3);
  assert.equal(await details.getByText('explorer publication pending', { exact: false }).count(), 3);
  passed.push('Sourcify matches do not falsely report completed explorer publication');

  await details.getByRole('button', { name: 'Retry source publication', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button:disabled'));
  undiscovered = true;
  await page.evaluate(() => window.dispatchEvent(new Event('treasury-source-request')));
  await details.locator('summary').filter({ hasText: /^Publishing to explorers · 0 of 2 verified$/ }).waitFor();
  passed.push('an unresolved deployment without discovered contracts is not reported as fully verified');

  sourceOnly = false; undiscovered = false;
  complete = true;
  await page.evaluate(() => window.dispatchEvent(new Event('treasury-source-request')));
  await details.locator('summary').filter({ hasText: /^Contract sources verified on explorers$/ }).waitFor();
  assert.equal(await details.locator('li').filter({ hasText: 'Verified on explorer' }).count(), 3);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), outbox);
  passed.push('all independent jobs can finish without losing the durable outbox');
  await page.evaluate(() => window.unmountVerification());
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ passed, scope: 'React source delivery with controlled HTTP responses; no chain or wallet writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
