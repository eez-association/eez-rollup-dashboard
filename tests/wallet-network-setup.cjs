const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');

async function open(browser) {
  const f = await fixture(browser, { wallet: true, wrongNetwork: true });
  await f.page.goto(origin + '/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
  await f.page.getByRole('region', { name: 'Swap form' }).getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const prompt = f.page.getByRole('group', { name: 'EEZ test wallet connection', exact: true });
  await prompt.waitFor();
  return { ...f, prompt, connect: prompt.getByRole('button', { name: 'Switch to EEZ test', exact: true }) };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const changed = await open(browser);
    await changed.page.evaluate(() => {
      const original = window.ethereum.request.bind(window.ethereum);
      window.setupGates = [];
      window.ethereum.request = async args => {
        if (args.method === 'wallet_switchEthereumChain') await new Promise(resolve => window.setupGates.push(resolve));
        return original(args);
      };
    });
    await changed.connect.click();
    await changed.page.waitForFunction(() => window.setupGates.length === 1);
    await changed.page.evaluate(() => window.changeTestAccount());
    await changed.connect.click();
    await changed.page.waitForFunction(() => window.setupGates.length === 2);
    await changed.page.evaluate(() => window.setupGates[0]());
    assert.equal(await changed.prompt.getByRole('button', { name: 'Check your wallet…', exact: true }).isDisabled(), true);
    await changed.page.evaluate(() => window.setupGates[1]());
    await changed.prompt.waitFor({ state: 'hidden' });
    assert.equal(changed.transactions.length, 0);
    assert.deepEqual(changed.errors, []);
    await changed.context.close();

    const stalled = await open(browser);
    await stalled.page.clock.install();
    await stalled.page.evaluate(() => {
      const original = window.ethereum.request.bind(window.ethereum);
      let switched = false;
      window.stallSetupIdentity = true;
      window.setupIdentityPending = false;
      window.ethereum.request = async args => {
        if (args.method === 'wallet_switchEthereumChain') {
          const value = await original(args); switched = true; return value;
        }
        if (switched && window.stallSetupIdentity && args.method === 'eth_accounts') {
          window.setupIdentityPending = true;
          return new Promise(() => {});
        }
        return original(args);
      };
    });
    await stalled.connect.click();
    await stalled.page.waitForFunction(() => window.setupIdentityPending);
    await stalled.page.clock.fastForward(20_001);
    await stalled.prompt.getByText('Wallet RPC timed out. Check your wallet connection and try again.', { exact: true }).waitFor();
    await stalled.page.evaluate(() => { window.stallSetupIdentity = false; });
    await stalled.connect.click(); await stalled.prompt.waitFor({ state: 'hidden' });
    assert.equal(stalled.transactions.length, 0);
    assert.deepEqual(stalled.errors, []);
    await stalled.context.close();
    console.log('Network setup recovers after account changes and stalled identity reads without sending transactions.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
