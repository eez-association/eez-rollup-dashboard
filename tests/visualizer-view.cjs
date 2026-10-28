// Production-bundle UI checks. All wallet/RPC responses are mocked; never broadcast.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const hash = b => '0x' + b.repeat(32), address = b => '0x' + b.repeat(20);
const account = address('33'), registry = address('11'), manager = address('22');
const blocks = { l1: hash('a1'), l2: hash('a2') }, hashes = { l1: hash('b1'), l2: hash('b2') };
const numbers = { l1: '0x64', l2: '0x7' };
const transaction = side => ({ hash: hashes[side], from: account, to: side === 'l1' ? registry : manager,
  input: '0x', value: '0x0', blockNumber: numbers[side], blockHash: blocks[side], transactionIndex: '0x0' });
const records = ['l1', 'l2'].map(side => ({ id: side, type: 'cross-chain-call', direction: side === 'l1' ? 'l1-to-l2' : 'l2-to-l1',
  hash: hashes[side], status: 'confirmed', label: 'Test call on ' + side.toUpperCase(), timestamp: Date.now() }));

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(({ account, records }) => {
      localStorage.setItem('txHistory', JSON.stringify(records));
      window.ethereum = { isRabby: true, on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return '0x27d8';
        throw new Error('Unexpected wallet request: ' + method);
      } };
    }, { account, records });
    await page.route('**/*', route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path.endsWith('/config.json')) return route.fulfill({ json: { networkName: 'EEZ-X Devnet', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
        l1ContractAddress: registry, l2ContractAddress: manager, l1ExplorerUrl: 'https://l1.invalid', l2ExplorerUrl: 'https://l2.invalid' } });
      if (req.method() !== 'POST') return route.continue();
      const { method, params = [], id } = req.postDataJSON();
      assert(!/send|sign/i.test(method), 'Broadcast forbidden');
      const side = path.endsWith('l1') ? 'l1' : 'l2';
      requests.push({ side, method, params });
      let result = null;
      if (method === 'eth_chainId') result = side === 'l1' ? '0x27d8' : '0x1892';
      if (method === 'eth_blockNumber') result = numbers[side];
      if (method === 'eth_getBalance') result = side === 'l1' ? '0x2b6af52e5934220000' : '0x3cc04f96974000';
      if (method === 'eth_getTransactionByHash') result = params[0] === hashes[side] ? transaction(side) : null;
      if (method === 'eth_getTransactionReceipt') result = params[0] === hashes[side] ? {
        status: '0x1', gasUsed: '0x5208', blockHash: blocks[side], blockNumber: numbers[side], logs: [] } : null;
      if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
        const selector = params[0];
        if (selector === blocks[side] || selector === numbers[side] || selector === 'latest') result = {
          hash: blocks[side], number: numbers[side], parentHash: hash('dd'), timestamp: '0x65000000', gasUsed: '0x5208',
          gasLimit: '0xffffff', transactions: params[1] ? [transaction(side)] : [hashes[side]] };
      }
      if (method === 'eth_getLogs' || method === 'eez_getSettledL2RangesByL1Block') result = [];
      if (method === 'debug_traceTransaction') result = { type: 'CALL', from: account, to: side === 'l1' ? registry : manager, input: '0x', output: '0x', gas: '0x5208', gasUsed: '0x5208' };
      return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
    });
    await page.goto(origin + '/#/bridge');
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Rabby', exact: true }).click();
    const header = page.getByRole('banner');
    for (const width of [1920, 1440, 1280, 1024, 800, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 1080 });
      const wallet = header.getByRole('button', { name: /^Rabby(?: Wallet)? ·/ });
      const buttons = header.getByRole('group', { name: 'Network balances' }).getByRole('button');
      const walletSize = await wallet.boundingBox();
      const walletFont = await wallet.evaluate(el => getComputedStyle(el).fontSize);
      for (const button of await buttons.all()) {
        const box = await button.boundingBox();
        assert.equal(box.height, walletSize.height, 'balance and wallet heights differ at ' + width);
        assert.equal(await button.locator('span[id]').evaluate(el => getComputedStyle(el).fontSize), walletFont);
        assert(Math.abs(box.y + box.height / 2 - walletSize.y - walletSize.height / 2) < 1);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    await header.screenshot({ path: '/tmp/eez-header-matched-controls.png' });
    const history = page.getByRole('region', { name: 'Transaction history' });
    for (const side of ['l1', 'l2']) {
      const row = history.locator('li').filter({ hasText: 'Test call on ' + side.toUpperCase() });
      assert.equal(await row.getByRole('button').count(), 1);
      await row.getByRole('button', { name: 'View execution', exact: true }).click();
      await page.waitForFunction(({ hash, side }) => {
        const params = new URLSearchParams(location.hash.split('?')[1]);
        return params.get('mode') === 'inspect' && params.get('tx') === hash && params.get('chain') === side && params.has('tab');
      }, { hash: hashes[side], side });
      await page.getByRole('button', { name: '← Dashboard', exact: true }).click();
    }
    await page.goto(origin + '/#/visualizer');
    const modes = page.getByRole('navigation', { name: 'Visualizer modes' });
    assert.deepEqual(await modes.getByRole('button').allTextContents(), ['Live', 'Inspect']);
    assert.equal(await modes.getByRole('button', { name: 'Live', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('heading', { name: 'Latest Posted Batches', exact: true }).waitFor();
    await modes.getByRole('button', { name: 'Inspect', exact: true }).click();
    const form = page.getByRole('form', { name: 'Inspect execution' });
    const input = form.getByLabel('Transaction hash or block', { exact: true });
    async function lookup(value, kind, side) {
      await input.fill(value); await form.getByRole('button', { name: 'Inspect', exact: true }).click();
      await page.waitForFunction(({ value, kind, side }) => {
        const params = new URLSearchParams(location.hash.split('?')[1]);
        return params.get(kind) === value && params.get('chain') === side && params.has('tab');
      }, { value, kind, side });
      await page.getByRole('button', { name: 'Copy inspection link', exact: true }).waitFor();
    }
    await lookup(hashes.l2, 'tx', 'l2');
    await lookup('100', 'block', 'l1');
    await lookup(blocks.l2, 'block', 'l2');
    await page.reload(); await form.waitFor();
    assert.equal(await modes.getByRole('button', { name: 'Inspect', exact: true }).getAttribute('aria-current'), 'page');
    await form.getByRole('combobox', { name: 'Chain', exact: true }).selectOption('l2');
    await form.getByRole('button', { name: 'Latest block', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('block=latest') && location.hash.includes('chain=l2'));
    for (const legacy of [`mode=debug&tx=${hashes.l1}`, `mode=explorer&chain=l2&block=${blocks.l2}`]) {
      await page.goto(origin + '/#/visualizer?' + legacy);
      await page.waitForFunction(() => location.hash.includes('mode=inspect') && location.hash.includes('tab='));
      assert.equal(await modes.getByRole('button', { name: 'Inspect', exact: true }).getAttribute('aria-current'), 'page');
    }
    await page.goto(origin + '/#/visualizer?mode=live&batch=' + hashes.l1);
    await page.getByRole('button', { name: 'Copy inspection link', exact: true }).waitFor();
    assert.equal(await modes.getByRole('button', { name: 'Live', exact: true }).getAttribute('aria-current'), 'page');
    assert(locationHashHas(await page.evaluate(() => location.hash), 'batch', hashes.l1));
    await modes.getByRole('button', { name: 'Inspect', exact: true }).click();
    await input.fill(hash('ff')); await form.getByRole('button', { name: 'Inspect', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Block lookup failed' }).waitFor();
    for (const width of [1440, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 1080 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Inspect overflow at ' + width);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, matchingControlSizes: 8, singleHistoryAction: true, liveFirstAndDefault: true,
      unifiedTransactionAndBlockLookup: true, sourceChainPreserved: true, legacyLinks: true, shareLinksReload: true,
      liveBatchPreserved: true, lookupErrorsVisible: true, consoleErrors: 0, transactionsBroadcast: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
function locationHashHas(hash, key, value) { return new URLSearchParams(hash.split('?')[1]).get(key) === value; }
