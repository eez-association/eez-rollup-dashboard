// Run against a production preview. Demo API and all RPCs are mocked.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const shortcut = 'Control+Alt+Shift+KeyT';

async function fixture(browser, { mismatch = false, unavailable = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.includes('cowdemo') || /CowLightDemo-.*\.js$/.test(path)) requests.push(path);
    if (path.endsWith('/cowdemo/api/config')) return route.fulfill({
      status: unavailable ? 503 : 200,
      json: { l1ChainId: mismatch ? 1 : 10200, l2ChainId: mismatch ? 696990 : 6290 },
    });
    if (path.endsWith('/cowdemo/')) return route.fulfill({ contentType: 'text/html',
      body: '<html><body><h1>Trading fixture</h1><input aria-label="Amount"></body></html>' });
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: 'EEZ test', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
    } });
    if (request.method() !== 'POST') return route.continue();
    const { id, method } = request.postDataJSON();
    assert.ok(!/send|sign/i.test(method), 'never broadcasts or signs');
    const result = method === 'eth_chainId' ? (path.endsWith('l1') ? '0x27d8' : '0x1892')
      : method === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : method === 'eth_getLogs' ? [] : method === 'eth_getBalance' ? '0x0' : null;
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  const nav = page.getByRole('navigation', { name: 'Dashboard sections' });
  const cow = nav.getByRole('button', { name: 'CoW Light Demo', exact: true });
  const treasury = nav.getByRole('button', { name: 'Treasury Demo', exact: true });
  const toggle = async () => { await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press(shortcut); };
  const hidden = async () => { assert.equal(await cow.count(), 0); assert.equal(await treasury.count(), 0); };
  return { context, page, nav, cow, treasury, requests, errors, toggle, hidden };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await fixture(browser);
    await f.page.goto(origin + '/#/cow-demo');
    await f.nav.waitFor(); await f.hidden();
    assert.deepEqual(f.requests, [], 'hidden deep link does not load demo code or API');
    await f.toggle(); await f.treasury.waitFor(); await f.cow.waitFor();
    await f.cow.click();
    const frame = f.page.frameLocator('iframe[title="CoW Light trading"]');
    await frame.getByRole('heading', { name: 'Trading fixture' }).waitFor();
    assert.equal(await f.page.getByRole('region', { name: 'Transaction history', exact: true }).count(), 0);
    await f.page.reload();
    await frame.getByRole('heading', { name: 'Trading fixture' }).waitFor();
    await frame.getByRole('textbox', { name: 'Amount' }).focus();
    await f.page.keyboard.press(shortcut);
    await f.cow.waitFor(); // Shortcut must not toggle while entering text.
    await frame.locator('body').click({ position: { x: 1, y: 1 } });
    await f.page.keyboard.press(shortcut); // Works from inside the embedded UI.
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.hidden();
    await f.page.evaluate(() => { location.hash = '#/cow-demo'; });
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    assert.deepEqual(f.errors, []);
    await f.context.close();

    for (const options of [{ mismatch: true }, { unavailable: true }]) {
      const f = await fixture(browser, options);
      await f.page.goto(origin + '/#/cow-demo'); await f.nav.waitFor(); await f.hidden();
      await f.toggle(); await f.cow.click();
      await f.page.getByText(options.mismatch
        ? 'CoW Light is configured for a different network. It cannot be opened on this dashboard.'
        : 'CoW Light is not available for this network yet.', { exact: true }).waitFor();
      assert.equal(await f.page.locator('iframe').count(), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close();
    }
    console.log(JSON.stringify({ passed: true, hiddenTogether: true, guardedDeepLinks: true,
      sessionReload: true, iframeShortcut: true, wrongNetworkBlocked: true, unavailableHandled: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
