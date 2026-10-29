// EEZ_UI_URL=http://127.0.0.1:8080/dashboard NODE_PATH=/path/to/node_modules node tests/wallet-startup.cjs
// Mocked configuration, RPCs and wallets. Never signs or broadcasts transactions.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8080/dashboard').replace(/\/$/, '');
const account = '0x' + '22'.repeat(20);
const oldHistory = [{ id: 'old-faucet', type: 'faucet', hash: null, status: 'confirmed',
  label: 'Previous funding transfer', gasUsed: null, timestamp: 1700000000000 }];

async function fixture(browser, injected) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  const errors = [], requests = [];
  let releaseConfig;
  const configGate = injected ? new Promise(resolve => { releaseConfig = resolve; }) : Promise.resolve();
  let configRequested = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ account, oldHistory, injected }) => {
    localStorage.setItem('txHistory', JSON.stringify(oldHistory));
    window.walletRequests = [];
    window.walletListeners = {};
    if (!injected) return;
    localStorage.setItem('walletConnected', 'true');
    localStorage.setItem('walletProvider', 'legacy:0');
    window.ethereum = {
      isRabby: true,
      on(event, listener) { window.walletListeners[event] = listener; },
      removeListener(event) { delete window.walletListeners[event]; },
      async request(request) {
        window.walletRequests.push(request);
        if (request.method === 'eth_accounts') return [account];
        if (request.method === 'eth_chainId') return '0x27d8';
        if (request.method === 'eth_call') return '0x';
        throw new Error('Unexpected wallet operation: ' + request.method);
      },
    };
  }, { account, oldHistory, injected });
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/config.json')) {
      configRequested = true;
      await configGate;
      return route.fulfill({ json: {
        l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2', l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
        // Old servers may still send these fields. They must not activate a signer or faucet.
        demoPrivateKey: '0x' + '1'.repeat(64), demoEnabled: true, faucetAddress: account,
      } });
    }
    if (path.startsWith('/shared/') || path === '/health') {
      requests.push({ path });
      return route.fulfill({ status: 404, body: '' });
    }
    if (request.method() !== 'POST') return route.continue();
    const payload = request.postDataJSON();
    requests.push({ path, ...payload });
    assert.ok(!/send|sign/i.test(payload.method), 'no signing or broadcasting');
    const result = payload.method === 'eth_getBlockByNumber'
      ? { number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : payload.method === 'eth_chainId' ? (path.endsWith('l1') ? '0x27d8' : '0x1892')
      : payload.method === 'eth_getBalance' ? '0xde0b6b3a7640000'
      : payload.method === 'eth_getLogs' ? [] : '0x1';
    return route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, result } });
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 5000;
  while (!configRequested && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(configRequested, 'runtime configuration was requested');
  // The app intentionally waits for config before mounting the header.
  if (!injected) await page.locator('header').waitFor();
  return { page, errors, requests, releaseConfig,
    async close() {
      assert.equal(requests.filter(r => r.path.startsWith('/shared/') || r.path === '/health').length, 0);
      assert.deepEqual(errors, []);
      await context.close();
    },
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const noWallet = await fixture(browser, false);
    assert.equal(await noWallet.page.getByRole('group', { name: 'Latest network blocks' }).count(), 0);
    await noWallet.page.clock.runFor(31000);
    await noWallet.page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().waitFor();
    assert.equal(noWallet.requests.filter(r => r.method === 'eth_getBalance').length, 0,
      'legacy demo configuration must not activate any signer or faucet balance polling');
    assert.equal(await noWallet.page.getByRole('button', { name: 'Request', exact: true }).count(), 0);
    await noWallet.page.getByText('Previous funding transfer', { exact: true }).waitFor();
    assert.deepEqual(await noWallet.page.evaluate(() => JSON.parse(localStorage.getItem('txHistory'))), oldHistory);
    await noWallet.close();

    const savedWallet = await fixture(browser, true);
    await savedWallet.page.clock.runFor(700);
    assert.deepEqual(await savedWallet.page.evaluate(() => window.walletRequests), [],
      'saved wallet reconnect waits for runtime config');
    savedWallet.releaseConfig();
    await savedWallet.page.getByRole('button', { name: /Rabby ·/ }).waitFor();
    assert.equal(await savedWallet.page.getByRole('button', { name: /Rabby ·/ }).locator('[data-wallet-logo="rabby"]').count(), 1);
    await savedWallet.page.getByText('Composer not detected', { exact: true }).waitFor();
    assert.deepEqual(await savedWallet.page.evaluate(() => window.walletRequests.map(r => r.method)),
      ['eth_accounts', 'eth_chainId', 'eth_chainId', 'eth_call', 'eth_chainId']);
    await savedWallet.page.clock.runFor(100);
    assert.equal(await savedWallet.page.evaluate(() => typeof window.walletListeners.accountsChanged), 'function');
    const nextAccount = '0x' + '33'.repeat(20);
    await savedWallet.page.evaluate(address => window.walletListeners.accountsChanged([address]), nextAccount);
    await savedWallet.page.getByRole('button', { name: /Rabby · 0x3333/ }).waitFor();
    await savedWallet.page.evaluate(() => window.walletListeners.accountsChanged([]));
    await savedWallet.page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().waitFor();
    assert.equal(await savedWallet.page.evaluate(() => localStorage.getItem('walletConnected')), null);
    await savedWallet.close();
    console.log(JSON.stringify({ passed: true, ignoredLegacySigner: true, noFaucet: true,
      savedWalletReconnect: true, accountChanges: true, existingHistoryPreserved: true, transactionsSent: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
