import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { decodeFunctionData, toHex } from 'viem';
import { readFileSync } from 'node:fs';
const build = JSON.parse(readFileSync('src/lib/treasury/current-build.json')).build;
const release = JSON.parse(readFileSync(`src/lib/treasury/builds/${build}.json`));
const a = n => toHex(n, { size: 20 });
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen(); let browser;
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
  const mount = async (mode = 'test') => { await page.goto(`${origin}/paired`); await page.evaluate(async mode => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mount(mode), mode); };
  const faucet = chain => page.getByRole('region', { name: `${chain} Safe`, exact: true }).getByRole('button', { name: 'Get USDC from faucet', exact: true });
  await mount(); await faucet('l1').waitFor(); await faucet('l2').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Deploy Test USDC', exact: true }).count(), 0);
  await page.evaluate(() => { window.rejectNext = true; }); await faucet('l1').click();
  await page.getByRole('alert').getByText('User rejected transaction', { exact: true }).waitFor();
  assert.equal(sends.length, 0); assert(!(await faucet('l1').isDisabled()));
  for (const [chain, method, safe] of [['l1','claim',a(10)],['l2','claimOnL2',a(11)]]) {
    const before = sends.length; await faucet(chain).click();
    await page.getByText('Waiting for faucet confirmation…', { exact: true }).waitFor();
    assert.equal(sends.length, before + 1); assert.equal(sends.at(-1).to.toLowerCase(), a(30));
    const decoded = decodeFunctionData({ abi: release.contracts.TestUSDC.abi, data: sends.at(-1).data });
    assert.equal(decoded.functionName, method); assert.deepEqual(decoded.args.map(x => x.toLowerCase()), [safe]);
    assert.equal(await page.evaluate(() => window.switched), 'l1');
    await mount(); await faucet(chain).waitFor();
    assert(await faucet('l1').isDisabled()); assert(await faucet('l2').isDisabled()); assert.equal(sends.length, before + 1);
    await page.evaluate(() => { window.confirmFixture = true; });
    await page.getByText('1,000 test USDC received.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.refreshes), 1);
    await page.evaluate(() => { window.confirmFixture = false; });
  }
  // Presets follow the existing EEZ-X slider direction and preserve the exact total.
  const presets = page.getByRole('group', { name: 'EEZ-X share presets' });
  for (const [percent, fromL1] of [[25,'30000000'],[50,'20000000'],[75,'10000000']]) {
    await presets.getByRole('button', { name: `${percent}%`, exact: true }).click();
    assert.equal(await page.getByRole('slider').inputValue(), String(percent * 100));
    assert.equal(await page.getByTestId('l1-contribution').textContent(), fromL1);
  }
  await page.getByRole('button', { name: 'Review split', exact: true }).click();
  assert(await presets.getByRole('button', { name: '25%', exact: true }).isDisabled());
  assert(await faucet('l1').isDisabled());
  await page.getByRole('button', { name: 'Edit split', exact: true }).click();
  // An uncertain wallet response survives reload and never permits an automatic resend.
  await page.evaluate(() => { window.uncertainNext = true; }); await faucet('l1').click();
  await page.getByRole('alert').getByText('Wallet response lost', { exact: true }).waitFor();
  await mount(); await faucet('l1').waitFor(); assert(await faucet('l1').isDisabled()); assert.equal(sends.length, 2);
  for (const mode of ['real','ordinary-token']) { await mount(mode); await page.getByRole('heading', { name: 'l1 Safe', exact: true }).waitFor(); await page.waitForTimeout(150); assert.equal(await page.getByRole('button', { name: 'Get USDC from faucet', exact: true }).count(), 0); }
  await mount('setup'); await page.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /faucet|Deploy Test USDC|Claim 1,000/ }).count(), 0);
  await page.getByLabel('Chiado Safe address', { exact: true }).fill(a(10));
  await page.getByRole('button', { name: 'Start setup', exact: true }).click();
  await page.getByRole('alert').getByText('Fixture stopped before deployment', { exact: true }).waitFor(); assert.equal(sends.length, 2);
  await mount('unconfigured'); await page.getByText('Configure the treasury token before setting up your Safes.', { exact: true }).waitFor();
  await page.evaluate(async () => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mountLegacy());
  await page.getByRole('alert').getByText('This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS configured-token setup without claims; both Safe faucet wallet requests, cancellation/reload/uncertain-response locks, real-token exclusion and 25/50/75 presets (sandbox enabled)');
} finally { await browser?.close(); await server.close(); }
