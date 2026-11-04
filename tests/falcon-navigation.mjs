import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture, origin } from './falcon/fixture.mjs';

const browser = await chromium.launch({ headless: true, chromiumSandbox: process.env.TREASURY_BROWSER_SANDBOX !== '0' });
try {
  const f = await fixture(browser);
  await f.page.goto(origin + '/');
  await f.nav.waitFor();
  await f.tab.waitFor();
  const chunks = () => f.requests.filter(r => /FalconDemo-.*\.js/.test(r.url));
  assert.equal(chunks().length, 0, 'visible navigation does not load Falcon cryptography until selected');
  assert.deepEqual(await f.nav.getByRole('button').allTextContents(), ['Bridge & Calls', 'Counter Demo', 'Treasury Demo', 'CoW Light Demo', 'Falcon Safe Demo']);
  await f.tab.click();
  await f.page.locator('#generate').waitFor();
  assert.equal(await f.page.locator('iframe').count(), 0);
  assert.equal(await f.page.getByRole('region', { name: 'Transaction history', exact: true }).count(), 0);
  assert.match(await f.page.title(), /Falcon Safe Demo/);
  assert.equal(chunks().length, 1);
  await f.page.locator('#generate').click();
  await f.page.waitForFunction(() => document.querySelector('#key-status').textContent.includes('Key generated'));
  await f.page.locator('body').click({ position: { x: 1, y: 1 } });
  await f.page.keyboard.press('Control+Alt+Shift+KeyT');
  assert(await f.page.getByTestId('public-key-hash').isVisible(), 'the former shortcut cannot hide the demo');
  await f.nav.getByRole('button', { name: 'CoW Light Demo', exact: true }).click();
  await f.page.getByText(/CoW Light needs a verified deployment/).waitFor();
  await f.page.goBack();
  await f.page.locator('#generate').waitFor();
  assert.equal(await f.page.getByTestId('public-key-hash').count(), 0, 'leaving the tab clears the plaintext key');
  await f.page.reload();
  await f.page.locator('#generate').waitFor();
  assert.deepEqual(await f.page.evaluate(() => Object.keys(sessionStorage)), []);
  for (const width of [320, 390, 1440]) {
    await f.page.setViewportSize({ width, height: 950 });
    await f.open();
    assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
  }
  await f.close();

  const fresh = await fixture(browser, { mismatch: true });
  await fresh.open();
  assert(await fresh.tab.isVisible(), 'direct links work in a fresh session');
  await fresh.page.getByText(/On-chain demo requires RollupX/).waitFor();
  assert.equal(await fresh.page.locator('#safe-load, #send-l2').count(), 0, 'mismatched networks cannot initiate contract actions');
  await fresh.page.locator('#generate').click();
  await fresh.page.waitForFunction(() => document.querySelector('#key-status').textContent.includes('Key generated'));
  const playground = fresh.page.locator('#signature-playground');
  assert.equal(await playground.getAttribute('open'), null, 'playground starts compact');
  assert.equal(await fresh.page.locator('#sign').isVisible(), false);
  const compactHeight = (await playground.boundingBox()).height;
  await playground.locator('summary').click();
  assert((await playground.boundingBox()).height > compactHeight, 'click expands the playground');
  await playground.locator('summary').click();
  assert.equal(await fresh.page.locator('#sign').isVisible(), false, 'click collapses it again');
  await playground.locator('summary').focus();
  await fresh.page.keyboard.press('Enter');
  await fresh.page.locator('#sign').click();
  await fresh.page.waitForFunction(() => document.querySelector('#signature-status').textContent.includes('Signature ready'));
  await fresh.page.locator('#verify').click();
  await fresh.page.waitForFunction(() => document.querySelector('#signature-status').dataset.result === 'valid');
  await fresh.close();
  console.log('Falcon public navigation, lazy loading, network gating, unmount and responsive checks passed.');
} finally { await browser.close(); }
