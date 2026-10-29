const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await fixture(browser, { wallet: true });
    await f.page.route('**/cowdemo/api/wrapper?*', route => route.fulfill({ status: 400, json: { error: 'Wrapper prediction unavailable' } }));
    await f.page.route('**/cowdemo/api/balances?*', route => route.fulfill({ status: 400, json: { error: 'Buy balance unavailable' } }));
    await f.page.route('**/cowdemo/api/allowance?*', route => route.fulfill({ json: { balance: '10000000000000000', allowance: '0' } }));
    await f.page.goto(origin + '/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
    const form = f.page.getByRole('region', { name: 'Swap form' });
    await form.getByRole('button', { name: 'Connect wallet' }).click();
    await form.getByText('Balance: 0.01', { exact: true }).waitFor();
    await form.getByText('Wrapper prediction unavailable', { exact: false }).waitFor();
    assert.ok(await form.getByRole('button', { name: 'Get quote' }).isDisabled());
    assert.equal(f.transactions.length, 0);
    assert.deepEqual(f.errors, []);
    await f.context.close();
    console.log('Sell balance remains visible when wrapper and buy-balance reads fail; trading stays blocked.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
