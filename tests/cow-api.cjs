const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    for (const recovery of ['manual', 'automatic', 'focus']) {
      const f = await fixture(browser);
      await f.page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.cowCacheModes = [];
        window.fetch = (input, init) => {
          const request = new Request(input, init);
          if (request.url.includes('/cowdemo/api/')) window.cowCacheModes.push(request.cache);
          return original(input, init);
        };
      });
      const endpoint = '**/cowdemo/api/config';
      await f.page.route(endpoint, route => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!DOCTYPE html><title>EEZ Dashboard</title>',
      }));
      await f.page.goto(origin + '/');
      await f.nav.waitFor(); await f.toggle(); await f.cow.click();
      await f.page.getByText('CoW Light service is unavailable for this dashboard. Please try again later.', { exact: true }).waitFor();
      assert.equal(await f.page.getByRole('region', { name: 'Swap form' }).count(), 0);
      await f.page.unroute(endpoint);
      if (recovery === 'manual') await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
      if (recovery === 'focus') await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await f.page.getByRole('region', { name: 'Swap form' }).waitFor();
      assert.deepEqual(f.errors, []);
      assert.equal(f.transactions.length, 0);
      assert.equal(f.signed.length, 0);
      const modes = await f.page.evaluate(() => window.cowCacheModes);
      assert.ok(modes.length > 0 && modes.every(mode => mode === 'no-store'), 'availability checks bypass cached HTML responses');
      await f.context.close();
    }
    console.log('HTML API fallback recovers via Retry, automatically, and on focus without wallet transactions or signatures.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
