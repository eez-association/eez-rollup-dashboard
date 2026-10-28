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
  await page.exposeFunction('readWalletNonce', () => toHex(sends.length));
  await page.exposeFunction('recordWalletSend', request => { sends.push(request); return toHex(sends.length, { size: 32 }); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url()); assert.equal(url.origin, origin);
    if (url.pathname === '/paired') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  const mount = async (mode = 'test') => { await page.goto(`${origin}/paired`); await page.evaluate(async mode => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mount(mode), mode); };
  const faucet = chain => page.getByRole('region', { name: `${chain} Safe`, exact: true }).getByRole('button', { name: 'Get USDC', exact: true });
  await mount(); await faucet('l1').waitFor(); await faucet('l2').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Deploy Test USDC', exact: true }).count(), 0);
  await page.evaluate(() => { window.rejectNext = true; }); await faucet('l1').click();
  await page.getByRole('alert').getByText('User rejected transaction', { exact: true }).waitFor();
  assert.equal(sends.length, 0); assert(!(await faucet('l1').isDisabled()));
  for (const [chain, method, safe] of [['l1','claim',a(10)],['l2','claimOnL2',a(11)]]) {
    const before = sends.length; await faucet(chain).click();
    await page.getByRole('region', { name: `${chain} Safe`, exact: true }).getByText('Waiting for faucet confirmation…', { exact: true }).waitFor();
    assert.equal(sends.length, before + 1); assert.equal(sends.at(-1).to.toLowerCase(), a(30));
    const decoded = decodeFunctionData({ abi: release.contracts.TestUSDC.abi, data: sends.at(-1).data });
    assert.equal(decoded.functionName, method); assert.deepEqual(decoded.args.map(x => x.toLowerCase()), [safe]);
    assert.equal(await page.evaluate(() => window.switched), 'l1');
    assert(await faucet(chain).isDisabled());
    if (chain === 'l1') {
      assert(!(await faucet('l2').isDisabled()), 'The other Safe remains available while this claim is pending');
      assert(!(await page.getByRole('slider').isDisabled()), 'A claim must not lock the payment form');
    }
  }
  assert.equal(sends[0].nonce, '0x0'); assert.equal(sends[1].nonce, '0x1');
  await mount(); await faucet('l1').waitFor();
  assert(await faucet('l1').isDisabled()); assert(await faucet('l2').isDisabled()); assert.equal(sends.length, 2);
  await page.evaluate(() => { window.confirmFixture = true; window.failTracking = 'l1'; });
  await page.waitForFunction(() => window.refreshes === 1);
  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="l2 Safe"] button')].find(button => button.textContent === 'Get USDC')?.disabled);
  assert(await faucet('l1').isDisabled()); assert(!(await faucet('l2').isDisabled()));
  await page.getByRole('alert').filter({ hasText: 'L1 faucet: Temporary claim RPC failure' }).waitFor();
  await page.evaluate(() => { window.failTracking = ''; });
  await page.waitForFunction(() => window.refreshes === 2);
  assert.equal(await page.getByText('1,000 test USDC received.', { exact: true }).count(), 0);
  await page.evaluate(() => { window.confirmFixture = false; });
  // Presets follow the existing EEZ-X slider direction and preserve the exact total.
  const presets = page.getByRole('group', { name: 'EEZ-X share presets' });
  assert.equal(await presets.getByText('EEZ-X share', { exact: true }).count(), 0);
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
  for (const mode of ['real','ordinary-token']) { await mount(mode); await page.getByRole('heading', { name: 'l1 Safe', exact: true }).waitFor(); await page.waitForTimeout(150); assert.equal(await page.getByRole('button', { name: 'Get USDC', exact: true }).count(), 0); }
  await page.evaluate(() => localStorage.clear());
  await mount('flaky-token');
  await page.getByRole('alert').filter({ hasText: 'Temporary token RPC failure' }).waitFor();
  await faucet('l1').waitFor(); assert.equal(await page.getByRole('alert').count(), 0);
  // Cancel a request queued behind another tab before opening any wallet prompt.
  await page.evaluate(({instance,token}) => {
    const key = `eez:treasury:safe-faucet:${instance}:${token}`;
    void navigator.locks.request(key, () => new Promise(resolve => { window.releaseFaucetLock = resolve; }));
  }, {instance:a(99),token:a(30)});
  await page.waitForFunction(() => !!window.releaseFaucetLock);
  await faucet('l1').click(); await page.evaluate(() => { window.unmountFixture(); window.releaseFaucetLock(); });
  await page.waitForTimeout(100); assert.equal(sends.length, 2);
  await mount(); await faucet('l1').waitFor();
  await page.evaluate(() => { window.holdPreparation = true; }); await faucet('l1').click();
  await page.waitForFunction(() => !!window.releasePreparation);
  await page.evaluate(() => { window.unmountFixture(); window.releasePreparation(); });
  await page.waitForTimeout(100); assert.equal(sends.length, 2, 'Leaving during preparation must not open a stale wallet prompt');
  await mount('setup'); await page.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /faucet|Deploy Test USDC|Claim 1,000/ }).count(), 0);
  await page.getByRole('button',{name:'Use an existing Safe',exact:true}).click(); await page.getByLabel('Chiado Safe address', { exact: true }).fill(a(10));
  await page.getByRole('button', { name: 'Start setup', exact: true }).click();
  await page.getByRole('alert').getByText('Fixture stopped before deployment', { exact: true }).waitFor(); assert.equal(sends.length, 2);
  await mount('unconfigured'); await page.getByText('Configure the treasury token before setting up your Safes.', { exact: true }).waitFor();
  await page.evaluate(async () => (await import('/tests/fixtures/treasury-paired-asset.tsx')).mountLegacy());
  await page.getByRole('alert').getByText('This dashboard supports only paired policies and normal bridges. Configure a new paired treasury.', { exact: true }).waitFor();
  await page.evaluate(() => localStorage.clear());
  await mount(); await faucet('l1').waitFor();
  await faucet('l1').click(); await faucet('l2').click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent === 'Get USDC').length === 2
    && [...document.querySelectorAll('button')].filter(b => b.textContent === 'Get USDC').every(b => b.disabled));
  await page.evaluate(() => { window.confirmFixture = true; });
  await page.waitForFunction(() => window.refreshes === 1
    && [...document.querySelectorAll('button')].filter(b => b.textContent === 'Get USDC').every(b => !b.disabled));
  assert.equal(await page.evaluate(() => window.refreshes), 1, 'two claims confirmed together need only one dashboard refresh');
  assert.deepEqual(errors, []);
  console.log('PASS configured-token setup without claims; both Safe faucet wallet requests, cancellation/reload/uncertain-response locks, real-token exclusion and 25/50/75 presets (sandbox enabled)');
} finally { await browser?.close(); await server.close(); }
