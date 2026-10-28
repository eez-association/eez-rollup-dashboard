// Run against a built UI: EEZ_UI_URL=http://127.0.0.1:8080 node tests/bridge-readiness.cjs
// Requires Playwright + Chromium. All RPC/config responses are mocked; no transactions are sent.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const origin = process.env.EEZ_UI_URL || 'http://127.0.0.1:8080';
const bridge = { l1: '0x' + '11'.repeat(20), l2: '0x' + '22'.repeat(20) };
const manager = '0x' + '0'.repeat(24) + '33'.repeat(20);
const zero = '0x' + '0'.repeat(64);
const currentGetter = '0xb3f5aaab', legacyGetter = '0x481c6a75';
const missing = 'Bridge contract not deployed or not initialized';
const results = [];

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  const errors = [], writes = [], calls = [];
  const modes = { l1: 'ready', l2: 'ready', ...options.modes };
  let configRequested = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.ethereum = { isRabby: true, on() {}, removeListener() {}, async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + '77'.repeat(20)];
      if (method === 'eth_chainId') return '0x27d8';
      if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
      throw new Error('Unexpected wallet operation: ' + method);
    } };
    window.bridgeMissingMessages = [];
    new MutationObserver(() => {
      const text = document.body?.textContent || '';
      if (text.includes('Bridge contract not deployed or not initialized')) {
        window.bridgeMissingMessages.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/config.json')) {
      configRequested = true;
      if (options.configGate) await options.configGate.promise;
      return route.fulfill({ json: {
        networkName: 'EEZ-X Devnet',
        bridgeL1Address: bridge.l1, bridgeL2Address: bridge.l2,
        // Older demos used one address on both chains. Explicit per-chain
        // bindings must win when the pinned deployment exports different ones.
        demoBridgeAddress: bridge.l1,
        l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
        l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
        rollupId: '1',
      } });
    }
    if (pathname === '/shared/rollup.env') return route.fulfill({ status: 404, body: '' });
    if (request.method() !== 'POST') return route.continue();
    const payload = request.postDataJSON();
    const { id, method, params = [] } = payload;
    assert.ok(method, 'unexpected non-RPC POST');
    if (/send|sign/i.test(method)) {
      writes.push(method);
      return route.abort();
    }
    const chain = pathname.endsWith('l2') ? 'l2' : 'l1';
    const reply = result => route.fulfill({ json: { jsonrpc: '2.0', id, result } });
    const isBridgeCode = method === 'eth_getCode' && params[0] === bridge[chain];
    const isManager = method === 'eth_call' && params[0]?.to === bridge[chain]
      && [currentGetter, legacyGetter].includes(params[0]?.data);
    if (isBridgeCode || isManager) {
      calls.push({ chain, method, data: params[0]?.data });
      if (options.readGate) await options.readGate.promise;
      if (modes[chain] === 'rpc-error') {
        return route.fulfill({ json: { jsonrpc: '2.0', id,
          error: { code: -32000, message: 'RPC temporarily unavailable' } } });
      }
      if (isBridgeCode) return reply(modes[chain] === 'no-code' ? '0x' : '0x6000');
      if (params[0].data === currentGetter && options.getters?.[chain] === 'legacy-revert') {
        return route.fulfill({ json: { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } } });
      }
      if (params[0].data === currentGetter && options.getters?.[chain] === 'legacy-empty') return reply('0x');
      if (modes[chain] === 'zero-manager') return reply(zero);
      if (modes[chain] === 'empty-manager') return reply('0x');
      if (modes[chain] === 'malformed-manager') return reply('not-an-address');
      return reply(manager);
    }
    if (method === 'eth_chainId') return reply(chain === 'l1' ? '0x27d8' : '0x1892');
    if (method === 'eth_getCode') return reply('0x');
    if (method === 'eth_getLogs') return reply([]);
    if (method === 'eth_getBalance') return reply('0xde0b6b3a7640000');
    if (method === 'eth_getBlockByNumber') return reply({ number: '0x10',
      hash: '0x' + '44'.repeat(32), parentHash: '0x' + '55'.repeat(32),
      timestamp: '0x65000000', transactions: [], gasUsed: '0x0',
      gasLimit: '0x1c9c380', baseFeePerGas: '0x3b9aca00' });
    if (method === 'eth_call') return reply(zero);
    return reply('0x5208');
  });
  await page.goto(origin.replace(/\/$/, '') + '/#/bridge');
  const connect = async () => {
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
    await page.getByRole('button', { name: 'Rabby', exact: true }).first().click();
  };
  if (!options.configGate) await connect();
  return { page, modes, calls, connect, configRequested: () => configRequested,
    button: page.getByRole('button', { name: 'Bridge xDAI', exact: true }),
    async clean() {
      assert.deepEqual(writes, [], 'the test must never submit or sign a transaction');
      assert.deepEqual(errors, [], 'browser runtime errors');
      await context.close();
    } };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const configGate = gate(), readGate = gate();
    const f = await fixture(browser, { configGate, readGate });
    await until(f.configRequested, 'configuration request was not made');
    assert.equal(f.calls.length, 0, 'readiness must wait for configuration');
    configGate.release();
    await f.connect();
    await f.page.getByText('Checking bridge on L1…', { exact: true }).waitFor();
    await f.page.getByLabel('Bridge amount', { exact: true }).fill('0.001');
    assert.equal(await f.button.isDisabled(), true, 'unknown readiness must disable bridging');
    await until(() => f.calls.length >= 2, 'both configured bridges must be checked immediately');
    assert.equal(await f.page.getByText(missing, { exact: false }).count(), 0);
    const inFlight = f.calls.length;
    await f.page.clock.fastForward(20001);
    assert.equal(f.calls.length, inFlight, 'slow readiness checks must not overlap');
    readGate.release();
    await until(() => f.button.isEnabled(), 'ready bridge waited for the 10-second retry');
    assert.equal(await f.page.getByRole('group', { name: 'Source network' }).getByText('Chiado').count(), 1);
    await f.page.getByTitle('Swap direction').click();
    assert.equal(await f.page.getByRole('group', { name: 'Source network' }).getByText('EEZ-X Devnet').count(), 1);
    assert.equal(await f.page.getByLabel('Bridge wallet RPC').count(), 0);
    assert.deepEqual(await f.page.evaluate(() => window.bridgeMissingMessages), [],
      'a false missing-deployment warning appeared during startup');
    results.push('Delayed config/readiness: no false warning; disabled until ready; immediate check; no overlapping reads; both RPC directions');
    await f.clean();

    for (const getter of ['current', 'legacy-revert', 'legacy-empty']) {
      const f = await fixture(browser, { getters: { l1: getter } });
      await f.page.getByLabel('Bridge amount', { exact: true }).fill('0.001');
      await until(() => f.button.isEnabled(), getter + ' getter did not enable bridging');
      assert.deepEqual(f.calls.filter(c => c.chain === 'l1' && c.method === 'eth_call').map(c => c.data),
        getter === 'current' ? [currentGetter] : [currentGetter, legacyGetter]);
      assert.deepEqual(f.calls.filter(c => c.chain === 'l2' && c.method === 'eth_call').map(c => c.data), [currentGetter]);
      results.push(getter + ': getter order and mixed bridge versions accepted');
      await f.clean();
    }

    for (const mode of ['no-code', 'zero-manager', 'rpc-error', 'empty-manager', 'malformed-manager']) {
      const f = await fixture(browser, { modes: { l1: mode } });
      const isMissing = mode === 'no-code' || mode === 'zero-manager';
      const message = isMissing ? missing : 'Unable to check the bridge on L1. Retrying…';
      await f.page.getByText(message, { exact: false }).waitFor();
      await f.page.getByLabel('Bridge amount', { exact: true }).fill('0.001');
      assert.equal(await f.button.isDisabled(), true);
      if (!isMissing) assert.deepEqual(await f.page.evaluate(() => window.bridgeMissingMessages), []);
      f.modes.l1 = 'ready';
      await f.page.clock.fastForward(10001);
      await until(() => f.button.isEnabled(), mode + ' failed to recover after the retry');
      assert.equal(await f.page.getByText(missing, { exact: false }).count(), 0);
      const count = f.calls.length;
      await f.page.clock.fastForward(20001);
      assert.equal(f.calls.length, count, 'readiness polling should stop once both bridges are ready');
      results.push(mode + ': correct state, disabled action, retry recovery, polling stops');
      await f.clean();
    }

    const reverse = await fixture(browser, { modes: { l2: 'no-code' } });
    await reverse.page.getByTitle('Swap direction').click();
    await reverse.page.getByText(missing + ' on L2.', { exact: true }).waitFor();
    await reverse.page.getByLabel('Bridge amount', { exact: true }).fill('0.001');
    assert.equal(await reverse.button.isDisabled(), true);
    await reverse.page.getByTitle('Swap direction').click();
    await until(() => reverse.button.isEnabled(), 'L2 missing deployment incorrectly blocked ready L1');
    results.push('Direction changes display the correct chain readiness independently');
    await reverse.clean();
    console.log(JSON.stringify({ passed: results, transactionsSubmitted: 0 }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
