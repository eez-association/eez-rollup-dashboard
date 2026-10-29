import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { toHex } from 'viem';
const a = n => toHex(n, { size: 20 }), h = n => toHex(n, { size: 32 });
const config = { version: 1, environment: 'isolated-devnet', instance: h(1), safeL1: a(1), safeL2: a(2), registry: a(3), manager: a(4), adapter: a(5), code: [], ownerLabels: {},
  l1: { chainId: 10200, rpc: 'l1', front: 'l1-front' }, l2: { chainId: 906969, rpc: 'l2', front: 'l2-front' },
  payments: { version: 2, bridgeKind: 'standard', pair: { version: 2, policyL1: a(20), peerProxyL2: a(21) },
    policy: a(11), alias: a(12), safeL2Alias: a(22), tokenL1: a(13), tokenL2: a(14), moduleL1: a(15), moduleL2: a(16), bridgeL1: a(17), bridgeL2: a(18), recipient: a(19), decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Test USDC' } };
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const type2 = { gas: '0x5208', maxFeePerGas: toHex(1_235_000_000n), maxPriorityFeePerGas: toHex(125_000_000n) };
  for (const scenario of [
    { quoteFields: type2 },
    { quoteFields: { gas: '0x5208', gasPrice: toHex(2_000_000_000n) } },
    { quoteFields: type2, sendError: { code: 4001, message: 'User rejected request' }, cancelled: true },
    { quoteFields: type2, sendError: { code: -32603, data: { originalError: { code: '4001' } } }, cancelled: true },
    { quoteFields: type2, sendError: { message: 'Wallet response lost' }, recover: true },
  ]) {
    const { quoteFields } = scenario;
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url()); assert.equal(url.origin, origin);
      if (url.pathname === '/transfer') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
      return route.continue();
    });
    await page.clock.install();
    await page.goto(`${origin}/transfer`);
    const fixture = {
      config, owners: [a(101)], chainId: toHex(config.l1.chainId), blockHash: h(2), networkFlow: true, quoteFields, sendError: scenario.sendError,
      helperRuntime: JSON.parse(readFileSync('tests/fixtures/safe-multisend-call-only-130.json')).runtime,
    };
    await page.evaluate(async f => (await import('/tests/fixtures/treasury-owners-browser.tsx')).mount(f), fixture);
    await page.getByRole('button', { name: 'Review payment', exact: true }).and(page.locator(':enabled')).waitFor();
    await page.getByLabel('Payment type', { exact: true }).selectOption('transfer');
    await page.getByLabel('Amount (USDC)', { exact: true }).fill('200');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    const before = await page.evaluate(() => window.ownersTest.contractReads.length);
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await page.getByTestId('funding-preview').filter({ hasText: '200 from Chiado + 0 from EEZ-X' }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownersTest.contractReads)).slice(before).sort(), ['balanceOf', 'rollupId']);
    await page.getByRole('button', { name: 'Sign approval', exact: true }).click();
    await page.getByRole('button', { name: 'Owner approved', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
    const pendingKey = `eez:treasury:submission:${config.instance}`;
    if (scenario.cancelled) {
      await page.getByText('Wallet submission cancelled. You can submit again or edit the action.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(k => localStorage.getItem(k), pendingKey), null);
      assert(await page.getByRole('button', { name: 'Submit Safe transaction', exact: true }).isEnabled());
      await page.getByRole('button', { name: 'Edit transfer', exact: true }).click();
      assert(await page.getByLabel('Amount (USDC)', { exact: true }).isEnabled());
    } else if (scenario.recover) {
      await page.getByRole('alert').filter({ hasText: 'Submission response uncertain' }).waitFor();
      const intent = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), pendingKey);
      assert(intent && !intent.hash);
      // The request must also be recoverable after reopening the dashboard.
      await page.goto(`${origin}/transfer`);
      await page.evaluate(async f => (await import('/tests/fixtures/treasury-owners-browser.tsx')).mount(f), {
        ...fixture, intent, outcome: { kind: 'unknown', detail: 'No wallet transaction found' },
      });
      const recover = page.getByRole('button', { name: 'I cancelled this request in my wallet', exact: true });
      await recover.and(page.locator(':enabled')).waitFor();
      await page.evaluate(() => { window.ownersTest.transactionNonce = '0x2'; });
      await recover.click();
      await page.getByRole('alert').filter({ hasText: 'Transaction activity was detected' }).waitFor();
      assert(await page.evaluate(k => !!localStorage.getItem(k), pendingKey));
      await page.evaluate(() => { window.ownersTest.transactionNonce = '0x1'; });
      await recover.click();
      await page.getByText('Cancelled wallet request cleared. Review your action again before sending.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(k => localStorage.getItem(k), pendingKey), null);
      assert(await page.getByLabel('Amount (USDC)', { exact: true }).isEnabled());
      assert(await page.getByRole('button', { name: 'Review transfer', exact: true }).isEnabled());
      assert.deepEqual(await page.evaluate(() => window.ownersTest.submissions), []);
    } else {
      await page.getByText(quoteFields.gasPrice
        ? 'Gas price: 2.00 gwei · Max priority fee: Not applicable.'
        : 'Max gas price: 1.24 gwei · Max priority fee: 0.13 gwei.', { exact: true }).waitFor();
      const submission = await page.evaluate(() => window.ownersTest.submissions[0]);
      for (const [key, value] of Object.entries(quoteFields)) assert.equal(submission[key], value, 'formatting must not change submitted fees');
      assert.equal(await page.getByRole('button', { name: 'I cancelled this request in my wallet' }).count(), 0, 'hashed transactions stay tracked');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS paired transfer read counts, exact quoted fees, direct/wrapped wallet rejection, and guarded cancellation recovery after reload');
} finally { await browser.close(); await server.close(); }
