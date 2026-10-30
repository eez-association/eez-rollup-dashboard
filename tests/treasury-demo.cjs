// Run against a production preview. All RPCs are mocked; never signs or broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const visibilityKey = 'eez:treasury-demo:visible';
const shortcut = 'Control+Alt+Shift+KeyT';

async function fixture(browser, blockedStorage = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const errors = [], methods = [], chunks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/TreasuryDemo-[^/]+\.js$/.test(request.url())) chunks.push(request.url()); });
  await page.clock.install();
  if (blockedStorage) await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  });
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: 'EEZ-X Devnet', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
    } });
    if (request.method() !== 'POST') return route.continue();
    const { id, method } = request.postDataJSON();
    methods.push(method);
    const result = method === 'eth_chainId' ? (path.endsWith('l1') ? '0x27d8' : '0x1892')
      : method === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : method === 'eth_getLogs' ? [] : method === 'eth_getBalance' ? '0x0' : null;
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  const treasury = page.getByText('Connect a configured paired treasury for this network.', { exact: true });
  const tab = page.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: 'Treasury Demo', exact: true });
  const toggle = async (keys = shortcut) => { await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press(keys); };
  const hidden = async () => {
    assert.equal(await tab.count(), 0);
    assert.equal(await treasury.count(), 0);
  };
  const close = async () => {
    assert.deepEqual(errors, []);
    assert.ok(methods.every(method => !/send|sign/i.test(method)), 'preview never sends or signs a transaction');
    await context.close();
  };
  return { page, context, treasury, tab, toggle, hidden, close, chunks };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await fixture(browser);
    await f.page.goto(origin + '/#/treasury-demo');
    await f.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await f.hidden();
    assert.equal(f.chunks.length, 0, 'hidden example is not loaded by a direct link');
    await f.page.evaluate(() => { location.hash = '#/counter-demo'; });
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.page.evaluate(() => { location.hash = '#/treasury-demo'; });
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    await f.toggle();
    await f.treasury.waitFor();
    assert.equal(await f.tab.getAttribute('aria-current'), 'page');
    assert.ok(f.chunks.length > 0);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), visibilityKey), '1');
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), visibilityKey), null);
    assert.equal(await f.page.getByRole('region', { name: 'Transaction history', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: 'Simulation', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: 'Get Test USDC', exact: true }).count(), 0);
    await f.page.reload(); await f.treasury.waitFor();
    for (const width of [1440, 390, 320]) {
      await f.page.setViewportSize({width,height:1100});
      assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await f.toggle();
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.hidden();
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), visibilityKey), null);
    await f.page.goBack();
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    await f.toggle('Meta+Alt+Shift+KeyT');
    await f.treasury.waitFor();

    const fresh = await fixture(browser);
    await fresh.page.goto(origin + '/#/treasury-demo');
    await fresh.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await fresh.hidden();
    assert.equal(fresh.chunks.length, 0, 'another browser session stays hidden');
    await fresh.close();
    await f.close();

    const blocked = await fixture(browser, true);
    await blocked.page.goto(origin + '/#/treasury-demo');
    await blocked.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await blocked.hidden();
    await blocked.toggle();
    await blocked.treasury.waitFor();
    await blocked.page.reload();
    await blocked.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await blocked.hidden();
    await blocked.close();
    console.log(JSON.stringify({ passed: true, hiddenByDefault: true, guardedDeepLinks: true, sessionVisibility: true,
      shortcutFiltering: true, blockedStorage: true, simulationRemoved: true, faucetHiddenOutsideChiado: true,
      responsiveWidths: 3, transactionsSent: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
