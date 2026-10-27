// Mocked EIP-6963 wallets and read RPCs. Never signs or broadcasts transactions.
// EEZ_UI_URL=http://127.0.0.1:18779/dashboard NODE_PATH=/path/to/playwright/node_modules node tests/composer-wallet.cjs
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeFunctionResult, parseAbi, keccak256, stringToHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:18779/dashboard').replace(/\/$/, '');
const discovery = '0x7Ae2c80116976915a0Ee9b7994e7Bb12026087f8';
const account = '0x' + '22'.repeat(20);
const registry = '0x' + '11'.repeat(20);
const l2 = '0x' + '33'.repeat(20);
const manager = '0x' + '44'.repeat(20);
const abi = parseAbi(['function composerInfo(bytes32 nonce) view returns (bytes32 marker, uint256 schemaVersion, bytes32 echoedNonce, uint256 sourceChainId, bytes info)']);
const marker = keccak256(stringToHex('EEZ_COMPOSER_DISCOVERY'));

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

async function fixture(browser, options = {}) {
  const l1Chain = options.mainnet ? '0x1' : '0x27d8';
  const l2Chain = options.mainnet ? '0x' + (696990).toString(16) : '0xdd6d9';
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [], rpcRequests = [];
  if (options.clock) await page.clock.install();
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('encodeComposer', ({ mode, nonce, chain }) => {
    const info = { version: '0.1.0', supportedNetworks: { eezL1: Number(BigInt(l1Chain)), eezL2: mode === 'mismatch' ? 6291 : Number(BigInt(l2Chain)) },
      eezContracts: { eezRegistryAddress: registry, eezL2Address: l2, eezRollupManagerAddress: manager } };
    return encodeFunctionResult({ abi, functionName: 'composerInfo', result: [marker, 1n, nonce, BigInt(chain), stringToHex(JSON.stringify(info))] });
  });
  await page.addInitScript(({ account, options, l1Chain }) => {
    window.walletCalls = [];
    window.walletModes = { Rabby: options.mode || 'detected', MetaMask: 'not-detected' };
    window.walletChains = { Rabby: options.chain || l1Chain, MetaMask: l1Chain };
    window.walletListeners = { Rabby: {}, MetaMask: {} };
    window.heldCalls = [];
    window.copiedURLs = [];
    navigator.clipboard.writeText = async text => { window.copiedURLs.push(text); };
    if (options.saved) {
      localStorage.setItem('walletConnected', 'true');
      localStorage.setItem('walletProvider', 'io.rabby');
    }
    const provider = name => ({
      isRabby: name === 'Rabby', isMetaMask: name === 'MetaMask',
      on(event, fn) { window.walletListeners[name][event] = fn; },
      removeListener(event, fn) { if (window.walletListeners[name][event] === fn) delete window.walletListeners[name][event]; },
      async request(request) {
        window.walletCalls.push({ name, ...request });
        const { method, params } = request;
        if (method === 'wallet_addEthereumChain') {
          if (options.savedSymbol && params[0].nativeCurrency.symbol !== options.savedSymbol) {
            throw Object.assign(new Error('nativeCurrency.symbol does not match currency symbol for a network the user already has added with the same chainId.'), { code: -32602 });
          }
          if (options.addMode === 'reject') throw Object.assign(new Error('Rejected'), { code: 4001 });
          if (options.addMode === 'held') await new Promise(resolve => { window.releaseNetworkAdd = resolve; });
          if (options.addMode === 'update') window.walletModes[name] = 'detected';
          return null;
        }
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_accounts'  || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') {
          if (window.walletModes[name] === 'chain-error') throw new Error('Cannot read wallet network');
          return window.walletChains[name];
        }
        if (method === 'eth_call') {
          const mode = window.walletModes[name];
          if (mode === 'not-detected') return '0x';
          if (mode === 'error') throw new Error('Wallet RPC is unavailable');
          if (mode === 'timeout') return new Promise(() => {});
          const answer = await window.encodeComposer({ mode, chain: window.walletChains[name], nonce: '0x' + params[0].data.slice(10) });
          if (mode === 'deferred') return new Promise(resolve => { window.heldCalls.push(() => resolve(answer)); });
          return answer;
        }
        throw new Error('Unexpected wallet operation: ' + method);
      },
    });
    window.ethereum = provider('Rabby');
    const metamask = provider('MetaMask');
    window.addEventListener('eip6963:requestProvider', () => {
      for (const [name, selected] of [['Rabby', window.ethereum], ['MetaMask', metamask]]) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: name, name, rdns: name === 'Rabby' ? 'io.rabby' : 'io.metamask' }, provider: selected },
        }));
      }
    });
  }, { account, options, l1Chain });
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: options.mainnet ? 'EEZ-X Mainnet' : 'EEZ-X Devnet', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: options.mainnet ? 'https://mainnet.eez.dev/composer/l1' : '/composer/l1',
      l2FrontUrl: options.mainnet ? 'https://mainnet.eez.dev/composer/l2' : '/composer/l2',
      l1ContractAddress: registry, l2ContractAddress: l2, rollupManagerAddress: manager,
    } });
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    rpcRequests.push({ path, ...body });
    assert.ok(!/send|sign/i.test(body.method), 'no broadcasts');
    const result = body.method === 'eth_chainId' ? (path.endsWith('l1') ? l1Chain : l2Chain)
      : body.method === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : body.method === 'eth_getBalance' ? '0xde0b6b3a7640000'
      : body.method === 'eth_getLogs' ? [] : '0x';
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('header').waitFor();
  if (options.clock) await page.clock.runFor(350);
  const menu = page.locator('header').getByRole('region', { name: 'Wallet Composer connection' });
  return { page, menu,
    async connect() {
      await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
      await page.getByRole('button', { name: 'Rabby', exact: true }).click();
      await page.getByRole('button', { name: /Rabby ·/ }).waitFor();
    },
    async openMenu() { await page.getByRole('button', { name: /(?:Rabby|MetaMask) ·/ }).click(); },
    async calls() { return page.evaluate(() => window.walletCalls.filter(call => call.method === 'eth_call')); },
    async close() {
      assert.deepEqual(errors, []);
      assert.equal(rpcRequests.filter(r => r.method === 'eth_call' && r.params?.[0]?.to?.toLowerCase() === discovery.toLowerCase()).length, 0, 'discovery never uses HTTP RPCs');
      assert.equal(await page.evaluate(() => window.walletCalls.filter(c => /send|sign/i.test(c.method)).length), 0);
      await context.close();
    },
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  let passed = 0;
  try {
    const connected = await fixture(browser);
    assert.equal((await connected.calls()).length, 0, 'does not probe before connecting');
    await connected.connect();
    await connected.openMenu();
    await connected.menu.getByText('Composer detected', { exact: true }).waitFor();
    assert.equal(await connected.menu.locator('code').count(), 0, 'detected Composer does not show its RPC URL');
    assert.equal(await connected.menu.getByRole('button', { name: 'Copy RPC URL' }).count(), 0);
    assert.doesNotMatch(await connected.menu.innerText(), /Composer 0\.1\.0|Checks wallet reads/);
    assert.equal((await connected.calls())[0].name, 'Rabby');
    const firstData = (await connected.calls())[0].params[0].data;
    await connected.menu.getByRole('button', { name: 'Recheck wallet Composer connection' }).click();
    await until(async () => (await connected.calls()).length === 2, 'manual recheck');
    assert.notEqual((await connected.calls())[1].params[0].data, firstData);
    await connected.page.evaluate(() => {
      window.walletChains.Rabby = '0xdd6d9';
      window.walletListeners.Rabby.chainChanged('0xdd6d9');
    });
    await connected.menu.getByText('EEZ-X Devnet', { exact: true }).waitFor();
    await until(async () => (await connected.calls()).length === 3, 'network change rechecks');
    await connected.page.evaluate(() => window.walletListeners.Rabby.accountsChanged(['0x' + '55'.repeat(20)]));
    await until(async () => (await connected.calls()).length === 4, 'account change rechecks');
    await connected.page.getByRole('button', { name: 'Reconnect Rabby', exact: true }).click();
    await until(async () => (await connected.calls()).length === 5, 'same-wallet reconnect rechecks');
    await connected.openMenu();
    await connected.menu.getByText('Composer detected', { exact: true }).waitFor();
    await connected.page.getByRole('button', { name: 'Switch to MetaMask', exact: true }).click();
    await connected.page.getByRole('button', { name: /MetaMask ·/ }).waitFor();
    await connected.page.getByText('Composer not detected', { exact: true }).waitFor();
    assert.equal((await connected.calls()).at(-1).name, 'MetaMask', 'selected wallet, not legacy window.ethereum');
    await connected.page.getByText('MetaMask RPC setup', { exact: true }).click();
    assert.equal(await connected.page.getByText('Rabby RPC setup', { exact: true }).count(), 0, 'Rabby setup is not shown for MetaMask');
    await connected.page.getByText(/Find Chiado \(chain ID 10200\)/).waitFor();
    await connected.page.evaluate(() => window.walletListeners.MetaMask.accountsChanged([]));
    await connected.page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().waitFor();
    assert.equal(await connected.page.getByText('Composer not detected', { exact: true }).count(), 0, 'disconnect clears status');
    await connected.close(); passed++;

    for (const addMode of ['update', 'unchanged', 'reject', 'held']) {
      const setup = await fixture(browser, { addMode });
      await setup.page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
      await setup.page.getByRole('button', { name: 'MetaMask', exact: true }).click();
      await setup.page.getByText('Composer not detected', { exact: true }).waitFor();
      await setup.page.getByRole('button', { name: 'Connect network', exact: true }).click();
      if (addMode === 'held') {
        await setup.page.getByRole('button', { name: 'Check your wallet…' }).waitFor();
        await setup.openMenu();
        assert.equal(await setup.menu.getByRole('button', { name: 'Check your wallet…' }).isDisabled(), true);
        await setup.page.evaluate(() => { window.walletListeners.MetaMask.accountsChanged([]); window.releaseNetworkAdd(); });
        await setup.page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().waitFor();
      } else if (addMode === 'update') {
        await until(async () => await setup.page.getByText('Composer not detected', { exact: true }).count() === 0, 'successful setup rechecks Composer');
        await setup.openMenu();
        await setup.menu.getByText('Composer detected', { exact: true }).waitFor();
      } else {
        await setup.page.getByText(addMode === 'reject' ? 'Network request cancelled. You can try again.'
          : 'Composer may be saved without being selected. If the warning remains, open the RPC setup instructions above, select the Composer URL as the network’s default RPC, save, then click Recheck.', { exact: true }).waitFor();
        await setup.page.getByText('Composer not detected', { exact: true }).waitFor();
      }
      const requests = await setup.page.evaluate(() => window.walletCalls.filter(call => call.method.startsWith('wallet_')));
      assert.equal(requests.length, ['reject', 'held'].includes(addMode) ? 1 : 2);
      assert.equal(requests[0].name, 'MetaMask', 'network request goes to selected wallet');
      assert.equal(requests[0].method, 'wallet_addEthereumChain');
      assert.equal(requests[0].params[0].chainId, '0x27d8');
      assert.deepEqual(requests[0].params[0].rpcUrls, [new URL('/composer/l1', origin).href]);
      await setup.close(); passed++;
    }

    for (const savedSymbol of ['XDAI', 'xDAI', 'OTHER']) {
      const setup = await fixture(browser, { addMode: 'update', savedSymbol });
      await setup.connect();
      await setup.page.evaluate(() => { window.walletModes.Rabby = 'not-detected'; window.dispatchEvent(new Event('focus')); });
      await setup.page.getByText('Composer not detected', { exact: true }).waitFor();
      await setup.page.getByRole('button', { name: 'Connect network', exact: true }).click();
      if (savedSymbol === 'OTHER') {
        await setup.page.getByText('Your saved network uses a different currency symbol. Edit its RPC URL in your wallet using the instructions above; keep its existing symbol.', { exact: true }).waitFor();
      } else {
        await until(async () => await setup.page.getByText('Composer not detected', { exact: true }).count() === 0, 'saved symbol accepted');
        await setup.openMenu();
        await setup.menu.getByText('Composer detected', { exact: true }).waitFor();
      }
      const adds = await setup.page.evaluate(() => window.walletCalls.filter(call => call.method === 'wallet_addEthereumChain'));
      assert.deepEqual(adds.map(call => call.params[0].nativeCurrency.symbol), savedSymbol === 'XDAI' ? ['XDAI'] : ['XDAI', 'xDAI']);
      assert.ok(adds.every(call => call.params[0].chainId === '0x27d8' && call.params[0].rpcUrls[0] === new URL('/composer/l1', origin).href));
      if (savedSymbol === 'OTHER') assert.equal(await setup.page.evaluate(() => window.walletCalls.filter(call => call.method === 'wallet_switchEthereumChain').length), 0);
      await setup.close(); passed++;
    }

    const restored = await fixture(browser, { saved: true, chain: '0xdd6d9' });
    await restored.page.getByRole('button', { name: /Rabby ·/ }).waitFor();
    await restored.openMenu();
    await restored.menu.getByText('Composer detected', { exact: true }).waitFor();
    await restored.menu.getByText('EEZ-X Devnet', { exact: true }).waitFor();
    await restored.close(); passed++;

    const focus = await fixture(browser, { mode: 'not-detected' });
    await focus.connect();
    await focus.page.getByText('Composer not detected', { exact: true }).waitFor();
    await focus.page.evaluate(() => { window.walletModes.Rabby = 'detected'; window.dispatchEvent(new Event('focus')); });
    await until(async () => (await focus.calls()).length === 2, 'focus checks same-chain RPC change');
    await focus.openMenu();
    await focus.menu.getByText('Composer detected', { exact: true }).waitFor();
    await focus.page.evaluate(() => { window.walletModes.Rabby = 'chain-error'; window.dispatchEvent(new Event('focus')); });
    await focus.menu.getByText('Unable to verify RPC', { exact: true }).waitFor();
    await focus.menu.getByRole('button', { name: 'Copy RPC URL' }).click();
    assert.equal((await focus.page.evaluate(() => window.copiedURLs)).at(-1), new URL('/composer/l1', origin).href, 'RPC setup remains available when eth_chainId fails');
    await focus.close(); passed++;

    for (const [mode, label] of [['mismatch', 'Composer network mismatch'], ['error', 'Unable to verify RPC']]) {
      const failed = await fixture(browser, { mode });
      await failed.connect();
      await failed.page.getByText(label, { exact: true }).waitFor();
      assert.equal(await failed.page.getByText('Composer detected', { exact: true }).count(), 0);
      await failed.openMenu();
      assert.equal(await failed.menu.locator('[role="status"] > span').first().evaluate((el, token) => {
        const expected = document.createElement('span');
        expected.style.color = `var(${token})`;
        el.append(expected);
        const matches = getComputedStyle(el).color === getComputedStyle(expected).color;
        expected.remove();
        return matches;
      }, mode === 'error' ? '--red' : '--yellow'), true, 'RPC failures use red; setup warnings use amber');
      await failed.menu.getByRole('button', { name: 'Copy RPC URL' }).click();
      assert.equal((await failed.page.evaluate(() => window.copiedURLs)).at(-1), new URL('/composer/l1', origin).href);
      await failed.close(); passed++;
    }

    const unsupported = await fixture(browser, { chain: '0x1' });
    await unsupported.connect();
    await unsupported.openMenu();
    await unsupported.menu.getByText('Select a dashboard network', { exact: true }).waitFor();
    assert.equal((await unsupported.calls()).length, 0);
    await unsupported.close(); passed++;

    const invalidChain = await fixture(browser, { chain: 'invalid' });
    await invalidChain.connect();
    await invalidChain.page.getByText('Unable to verify RPC', { exact: true }).waitFor();
    await invalidChain.openMenu();
    await invalidChain.menu.getByText('Unable to verify RPC', { exact: true }).waitFor();
    await invalidChain.close(); passed++;

    const stale = await fixture(browser, { mode: 'deferred' });
    await stale.connect();
    await until(() => stale.page.evaluate(() => window.heldCalls.length === 1), 'held old-wallet response');
    await stale.openMenu();
    await stale.page.getByRole('button', { name: 'Switch to MetaMask', exact: true }).click();
    await stale.page.getByText('Composer not detected', { exact: true }).waitFor();
    await stale.page.evaluate(() => window.heldCalls[0]());
    await stale.openMenu();
    await stale.menu.getByText('Composer not detected', { exact: true }).waitFor();
    assert.equal(await stale.menu.getByText('Composer detected', { exact: true }).count(), 0);
    await stale.close(); passed++;

    for (const change of ['account', 'chain']) {
      const late = await fixture(browser, { mode: 'deferred' });
      await late.connect();
      await until(() => late.page.evaluate(() => window.heldCalls.length === 1), 'held old-session response');
      await late.page.evaluate(change => {
        window.walletModes.Rabby = 'not-detected';
        if (change === 'account') window.walletListeners.Rabby.accountsChanged(['0x' + '66'.repeat(20)]);
        else {
          window.walletChains.Rabby = '0xdd6d9';
          window.walletListeners.Rabby.chainChanged('0xdd6d9');
        }
      }, change);
      await late.page.getByText('Composer not detected', { exact: true }).waitFor();
      await late.page.evaluate(() => window.heldCalls[0]());
      await late.openMenu();
      await late.menu.getByText('Composer not detected', { exact: true }).waitFor();
      assert.equal(await late.menu.getByText('Composer detected', { exact: true }).count(), 0);
      await late.close(); passed++;
    }

    const periodic = await fixture(browser, { clock: true });
    await periodic.connect();
    await periodic.openMenu();
    await periodic.menu.getByText('Composer detected', { exact: true }).waitFor();
    await periodic.page.evaluate(() => { window.walletModes.Rabby = 'not-detected'; });
    await periodic.page.clock.runFor(30100);
    await periodic.menu.getByText('Composer not detected', { exact: true }).waitFor();
    const countBeforeHidden = (await periodic.calls()).length;
    await periodic.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      window.dispatchEvent(new Event('focus'));
    });
    await periodic.page.clock.runFor(60000);
    assert.equal((await periodic.calls()).length, countBeforeHidden, 'hidden pages do not poll discovery');
    await periodic.page.evaluate(() => {
      window.walletModes.Rabby = 'detected';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await periodic.menu.getByText('Composer detected', { exact: true }).waitFor();
    await periodic.close(); passed++;

    const timeout = await fixture(browser, { mode: 'timeout', clock: true });
    await timeout.connect();
    await until(async () => (await timeout.calls()).length === 1, 'timeout probe started');
    await timeout.page.clock.runFor(8100);
    await timeout.page.getByText('Unable to verify RPC', { exact: true }).waitFor();
    await timeout.close(); passed++;

    const mobile = await fixture(browser, { mobile: true, mode: 'not-detected' });
    await mobile.connect();
    await mobile.page.getByText('Composer not detected', { exact: true }).waitFor();
    await mobile.openMenu();
    assert.equal(await mobile.menu.locator('ol').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 13), true, 'warning instructions use readable body text');
    await mobile.menu.getByRole('button', { name: 'Copy RPC URL' }).click();
    assert.equal((await mobile.page.evaluate(() => window.copiedURLs)).at(-1), new URL('/composer/l1', origin).href);
    const setup = await mobile.menu.locator('ol').innerText();
    assert.match(setup, /Open Rabby → Settings → Modify RPC URL/);
    assert.match(setup, /Chiado.*chain ID 10200/);
    assert.match(setup, /RPC URL.*Save/);
    assert.match(setup, /toggle is on/);
    assert.match(setup, /Recheck/);
    assert.doesNotMatch(await mobile.menu.innerText(), /Older Composers/);
    await mobile.menu.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 390px');
    await mobile.page.screenshot({ path: '/tmp/eez-composer-mobile.png', fullPage: false });
    await mobile.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined }));
    await mobile.menu.getByRole('button', { name: 'Copied', exact: true }).click();
    await mobile.menu.getByRole('button', { name: 'Select the URL to copy' }).waitFor();
    await mobile.page.evaluate(() => {
      window.walletChains.Rabby = '0xdd6d9';
      window.walletListeners.Rabby.chainChanged('0xdd6d9');
    });
    await until(async () => /EEZ-X Devnet.*chain ID 906969/.test(await mobile.menu.locator('ol').innerText()), 'Rabby setup updates for the L2 network');
    assert.equal(await mobile.menu.locator('code').innerText(), new URL('/composer/l2', origin).href);
    await mobile.close(); passed++;

    const mainnet = await fixture(browser, { mainnet: true, mode: 'not-detected' });
    await mainnet.connect();
    await mainnet.page.getByText('Composer not detected', { exact: true }).waitFor();
    await mainnet.page.getByText('Rabby RPC setup', { exact: true }).click();
    const notice = mainnet.page.getByRole('region', { name: 'Wallet Composer connection' });
    const mainnetSetup = await notice.locator('ol').innerText();
    assert.match(mainnetSetup, /Ethereum.*chain ID 1/);
    assert.match(mainnetSetup, /select Integrated Network, then Ethereum/);
    assert.doesNotMatch(mainnetSetup, /Custom Network|Chiado/);
    assert.equal(await notice.locator('code').innerText(), 'https://mainnet.eez.dev/composer/l1');
    await notice.getByRole('button', { name: 'Copy RPC URL' }).click();
    assert.deepEqual(await mainnet.page.evaluate(() => window.copiedURLs), ['https://mainnet.eez.dev/composer/l1']);
    await mainnet.page.evaluate(() => { window.walletModes.Rabby = 'detected'; });
    await notice.getByRole('button', { name: 'Recheck wallet Composer connection' }).click();
    await until(async () => await notice.count() === 0, 'setup notice disappears after successful discovery');
    await mainnet.openMenu();
    await mainnet.menu.getByText('Composer detected', { exact: true }).waitFor();
    assert.equal(await mainnet.menu.locator('code, ol').count(), 0);
    assert.doesNotMatch(await mainnet.menu.innerText(), /Composer 0\.1\.0|Checks wallet reads/);
    await mainnet.page.screenshot({ path: '/tmp/eez-composer-detected.png' });
    await mainnet.page.evaluate(chain => {
      window.walletModes.Rabby = 'not-detected';
      window.walletChains.Rabby = chain;
      window.walletListeners.Rabby.chainChanged(chain);
    }, '0x' + (696990).toString(16));
    await mainnet.menu.getByText('Composer not detected', { exact: true }).waitFor();
    assert.match(await mainnet.menu.locator('ol').innerText(), /EEZ-X Mainnet.*chain ID 696990/);
    assert.equal(await mainnet.menu.locator('code').innerText(), 'https://mainnet.eez.dev/composer/l2');
    await mainnet.close(); passed++;

    for (const mainnetProfile of [false, true]) {
      const mm = await fixture(browser, { mainnet: mainnetProfile, mobile: true });
      await mm.connect();
      await mm.openMenu();
      await mm.page.getByRole('button', { name: 'Switch to MetaMask', exact: true }).click();
      await mm.page.getByText('Composer not detected', { exact: true }).waitFor();
      await mm.page.getByText('MetaMask RPC setup', { exact: true }).click();
      const guidance = mm.page.getByRole('region', { name: 'Wallet Composer connection' });
      const steps = await guidance.locator('ol').innerText();
      assert.match(steps, /Open MetaMask.*Networks/);
      assert.match(steps, /On mobile.*Tokens/);
      assert.match(steps, mainnetProfile ? /Ethereum Mainnet.*chain ID 1/ : /Chiado.*chain ID 10200/);
      assert.match(steps, /three-dot menu.*Edit/);
      assert.match(steps, /Default RPC URL.*Add RPC URL/);
      assert.match(steps, /nickname EEZ Composer.*Save/);
      assert.match(steps, /Select the saved Composer URL.*default RPC.*save/);
      assert.match(steps, /Recheck/);
      assert.doesNotMatch(steps, /Rabby|Integrated Network|Modify RPC URL/);
      const front = mainnetProfile ? 'https://mainnet.eez.dev' : new URL(origin).origin;
      assert.equal(await guidance.locator('code').innerText(), front + '/composer/l1');
      await guidance.getByRole('button', { name: 'Copy RPC URL' }).click();
      assert.equal((await mm.page.evaluate(() => window.copiedURLs)).at(-1), front + '/composer/l1');
      assert.equal(await mm.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await mm.page.evaluate(chain => {
        window.walletChains.MetaMask = chain;
        window.walletListeners.MetaMask.chainChanged(chain);
      }, mainnetProfile ? '0x' + (696990).toString(16) : '0xdd6d9');
      const rollup = mainnetProfile ? 'EEZ-X Mainnet' : 'EEZ-X Devnet';
      const rollupId = mainnetProfile ? 696990 : 906969;
      await until(async () => await guidance.locator('code').textContent() === front + '/composer/l2', 'MetaMask RPC URL follows the selected network');
      if (!await guidance.locator('details').evaluate(el => el.open)) {
        await guidance.getByText('MetaMask RPC setup', { exact: true }).click();
      }
      assert.ok((await guidance.locator('ol').innerText()).replace(/\s+/g, ' ').includes(`Find ${rollup} (chain ID ${rollupId})`), 'MetaMask setup follows the selected network');
      assert.equal(await guidance.locator('code').innerText(), front + '/composer/l2');
      await mm.page.screenshot({ path: `/tmp/eez-metamask-${mainnetProfile ? 'mainnet' : 'devnet'}.png`, fullPage: false });
      await mm.page.evaluate(() => { window.walletModes.MetaMask = 'detected'; });
      await guidance.getByRole('button', { name: 'Recheck wallet Composer connection' }).click();
      await until(async () => await guidance.count() === 0, 'MetaMask setup disappears when Composer is detected');
      await mm.openMenu();
      await mm.menu.getByText('Composer detected', { exact: true }).waitFor();
      assert.equal(await mm.menu.locator('code, ol').count(), 0);
      assert.doesNotMatch(await mm.menu.innerText(), /RPC setup|Composer 0\.1\.0|Checks wallet reads/);
      await mm.close(); passed++;
    }
    console.log(JSON.stringify({ passed, selectedWallet: true, bothDirections: true, staleResponsesIgnored: true, transactionsSent: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
