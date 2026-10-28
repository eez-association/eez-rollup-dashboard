// Exercise the built dashboard and bundled viewer. RPCs are mocked; no broadcasts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

test('dashboard Debug imports nested traces in an isolated frame under the build base', { timeout: 60_000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const base = process.env.EEZ_UI_BASE_PATH || '/dashboard/';
  const { preview } = await import('vite');
  const server = await preview({
    configFile: false, root, base, build: { outDir: 'dist' },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const url = `${origin}${base}`;
    const errors = [], viewerRequests = [], externalRequests = [], methods = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.frame().url().includes('/quote-trace/')) viewerRequests.push(request);
    });
    await page.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.origin !== origin) {
        externalRequests.push(request.url());
        return route.abort();
      }
      if (target.pathname.endsWith('/config.json')) return route.fulfill({ json: {
        networkName: 'EEZ debug fixture', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
        l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      } });
      if (request.method() === 'POST') {
        const response = body => {
          methods.push(body.method);
          assert(!/send|sign/i.test(body.method), `unexpected broadcast: ${body.method}`);
          const result = body.method === 'eth_chainId' ? (target.pathname.endsWith('l2') ? '0x1892' : '0x27d8')
            : body.method === 'eth_getCode' ? '0x'
            : ['eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount'].includes(body.method) ? '0x0'
            : body.method === 'eth_getLogs' ? [] : null;
          return { jsonrpc: '2.0', id: body.id, result };
        };
        const body = request.postDataJSON();
        return route.fulfill({ json: Array.isArray(body) ? body.map(response) : response(body) });
      }
      return route.continue();
    });

    // Direct links and refresh work without a connected wallet.
    await page.goto(`${url}#/debug`);
    const frame = page.frameLocator('iframe[title="Cross-chain quote trace viewer"]');
    await frame.getByRole('heading', { name: 'Follow the call.' }).waitFor();
    assert.match(await page.title(), /^Quote Debugger/);
    const debug = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Debug', exact: true });
    assert.equal(await debug.getAttribute('aria-current'), 'page');
    assert.equal(await frame.locator('body > header').isVisible(), false);
    const element = page.locator('iframe');
    assert.equal(await element.getAttribute('sandbox'), 'allow-scripts allow-downloads');
    const content = await (await element.elementHandle()).contentFrame();
    assert.equal(await content.evaluate(() => {
      try { void parent.document; return false; } catch { return true; }
    }), true, 'the viewer must not access the dashboard DOM or wallet context');

    const examplePath = path.join(root, 'public/quote-trace/examples/nested-revert.json');
    const example = await fs.readFile(examplePath, 'utf8');
    await frame.locator('#file').setInputFiles(examplePath);
    await frame.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#quote-status').textContent(), 'Quote failed');
    assert.match(await frame.locator('#quote-errors').textContent(), /descendants are not supported/);
    await frame.locator('[data-frame="0"]').click();
    assert.match(await frame.locator('#frame-detail').textContent(), /Succeeded in simulation/);
    await frame.locator('[data-frame="1"]').click();
    assert.match(await frame.locator('#frame-detail').textContent(), /Failure inside a successful simulation/);
    await frame.locator('#expand').click();
    await frame.locator('[data-frame="5"]').click();
    assert.match(await frame.locator('#frame-detail').textContent(), /rolled back by an ancestor/);
    await frame.locator('#collapse').click();
    assert.equal(await frame.getByRole('treeitem').count(), 1);
    await frame.locator('#expand').click();
    assert.equal(await frame.getByRole('treeitem').count(), 6);
    const download = page.waitForEvent('download');
    await frame.locator('#download').click();
    const exported = await download;
    assert.equal(exported.suggestedFilename(), 'eez-quote-trace.json');
    assert.deepEqual(JSON.parse(await fs.readFile(await exported.path(), 'utf8')), JSON.parse(example));

    // Import errors stay inside the viewer and do not blank the dashboard.
    await frame.locator('#show-import').click();
    await frame.getByText('Paste JSON instead', { exact: true }).click();
    await frame.locator('#json').fill('{"result":{}}');
    await frame.locator('#load').click();
    await frame.locator('#error').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#workspace').isVisible(), false);
    assert.equal(await debug.isVisible(), true);
    await frame.locator('#json').fill(example);
    await frame.locator('#load').click();
    await frame.locator('#workspace').waitFor({ state: 'visible' });

    let actualExports = 0;
    if (process.env.EEZ_TEST_LOG_DIR) {
      const directory = path.join(process.env.EEZ_TEST_LOG_DIR, 'quote-traces');
      const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json'));
      assert(files.length > 0, 'expected real process exports');
      for (const file of files) {
        await frame.locator('#file').setInputFiles(path.join(directory, file));
        await frame.locator('#workspace').waitFor({ state: 'visible' });
        assert.equal(await frame.locator('#error').isVisible(), false, file);
        assert(await frame.getByRole('treeitem').count() > 0, file);
        actualExports++;
      }
    }
    const artifacts = path.join(root, 'test-results/quote-trace', base === '/' ? 'root' : 'dashboard');
    await fs.mkdir(artifacts, { recursive: true });
    await frame.locator('#tree').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await page.goBack();
    await frame.getByRole('heading', { name: 'Follow the call.' }).waitFor();
    assert.equal(await frame.locator('#workspace').isVisible(), false, 'imports are not persisted');
    await page.reload();
    await frame.getByRole('heading', { name: 'Follow the call.' }).waitFor();
    await nav.getByRole('button', { name: 'Visualizer', exact: true }).click();
    assert(new URL(page.url()).hash.startsWith('#/visualizer'));
    await debug.click();
    await frame.getByRole('heading', { name: 'Follow the call.' }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Debug', exact: true }).click();
    await frame.getByRole('heading', { name: 'Follow the call.' }).waitFor();
    await frame.locator('#file').setInputFiles(examplePath);
    await frame.locator('#workspace').waitFor({ state: 'visible' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const mobileFrame = await (await page.locator('iframe').elementHandle()).contentFrame();
    assert(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await frame.locator('#tree').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });

    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    assert(viewerRequests.every(request => request.method() === 'GET' &&
      ['index.html', 'model.js', 'viewer.js', 'style.css'].some(asset => new URL(request.url()).pathname.endsWith(`/${asset}`))),
    'imports must not trigger uploads or RPC calls');
    assert(!methods.some(method => /send|sign|eez_debugQuoteFee/.test(method)));
    console.log(JSON.stringify({ base, actualExports, broadcasts: 0, viewerUploads: 0 }));
  } finally {
    await browser?.close();
    await server.close();
  }
});
