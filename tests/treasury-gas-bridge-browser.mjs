// Full dashboard navigation; mocked RPCs and wallet, no real transactions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { keccak256, toHex } from 'viem';
import { setupIdentity } from '../src/lib/treasury/mainnetSetup.ts';
import { savedNetworkKey } from '../src/lib/treasury/savedNetwork.ts';

const read = path => JSON.parse(readFileSync(path));
const mainnet = read('src/lib/treasury/mainnet-network.json');
const profile = read('src/lib/treasury/paired-testnet-network.json');
const account = toHex(200n, { size: 20 }), hash = toHex(9n, { size: 32 });
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null }, base: '/' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
let activePage;
try {
  for (const kind of ['testnet', 'mainnet', 'rollupx']) {
    const testnet = kind === 'testnet';
    const network = testnet ? { ...mainnet, testnet: true, registry: profile.registry, manager: profile.manager, rollupId: profile.rollupId,
      chains: Object.fromEntries(['l1', 'l2'].map(chain => [chain, { chainId: profile.chains[chain].chainId, ...profile.chains[chain].checkpoint }])) } : kind === 'rollupx' ? read('src/lib/treasury/rollupx-mainnet-network.json') : mainnet;
    const state = { version: 3, creation: 'create-both', build: read('src/lib/treasury/current-build.json').build, identity: setupIdentity(network), salt: hash,
      deployer: account, addresses: { safeL1: toHex(10n, { size: 20 }) }, code: [], completed: [{ chain: 'l1', hash, blockHash: hash, number: '0x1' }] };
    const key = `eez:treasury:paired-setup:${setupIdentity(network)}`;
    const runtime = { networkName: 'EEZ-X', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2', l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      l1ContractAddress: network.registry, l2ContractAddress: network.manager, rollupId: String(network.rollupId),
      bridgeL1Address: testnet ? profile.bridges.l1.address : network.contracts.bridgeL1.address,
      bridgeL2Address: testnet ? profile.bridges.l2.address : network.contracts.bridgeL2.address,
      treasuryTokenAddress: toHex(30n, { size: 20 }), l1FeesEnabled: true, l2FeesEnabled: true };
    const selectionKey = testnet ? savedNetworkKey({
      l1: { rpc: origin + '/rpc/l1', front: origin + '/composer/l1', explorer: '' },
      l2: { rpc: origin + '/rpc/l2', front: origin + '/composer/l2', explorer: '' },
      fees: { l1: '100000000000000000', l2: '100000000000000000' },
    }, runtime.bridgeL1Address, runtime.bridgeL2Address, runtime.treasuryTokenAddress) : null;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(), errors = [];
    activePage = page;
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ account, key, state, chain, selectionKey, network }) => {
      localStorage.setItem(key, JSON.stringify(state)); localStorage.setItem('walletConnected', 'true'); localStorage.setItem('walletProvider', 'legacy:0');
      if (selectionKey) localStorage.setItem(selectionKey, JSON.stringify(network));
      sessionStorage.setItem('eez:treasury-demo:visible', '1');
      window.gasBridgeTest = { l2Gas: '0x0', walletOps: [] };
      window.ethereum = { isMetaMask: true, chain, on() {}, removeListener() {}, async request({ method, params }) {
        if (method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return this.chain;
        if (method === 'eth_call') return '0x';
        if (method.startsWith('wallet_') || /send|sign/.test(method)) {
          window.gasBridgeTest.walletOps.push({ method, params });
          if (method === 'wallet_switchEthereumChain') this.chain = params[0].chainId;
          if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
          return null;
        }
        if (method === 'eth_getTransactionCount') return '0x0';
        throw Error('Unexpected wallet request: ' + method);
      } };
    }, { account, key, state, chain: toHex(network.chains.l2.chainId), selectionKey, network });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'Fixture must not contact live services');
      if (url.pathname === '/gas-bridge') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
      if (url.pathname.endsWith('/config.json')) return route.fulfill({ json: runtime });
      if (request.method() !== 'POST') return route.continue();
      const payload = request.postDataJSON();
      if (Array.isArray(payload)) return route.fulfill({ json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Fixture supports individual RPC requests' } } });
      const { id, method, params = [] } = payload;
      assert(!/send|sign/i.test(method), 'No real broadcast');
      const reply = result => route.fulfill({ json: { jsonrpc: '2.0', id, result } });
      if (method === 'eth_chainId') return reply(toHex(network.chains[url.pathname.endsWith('l2') ? 'l2' : 'l1'].chainId));
      if (method === 'eth_getCode') return reply('0x6000');
      if (method === 'eth_getBalance') return reply('0xde0b6b3a7640000');
      if (method === 'eth_getTransactionCount') return reply('0x0');
      if (method === 'eth_getTransactionReceipt') return reply(null);
      if (method === 'eth_getLogs') return reply([]);
      if (method === 'eth_getBlockByNumber') return reply({ number: '0x10', hash, timestamp: '0x65000000', baseFeePerGas: '0x7', transactions: [] });
      if (method === 'eth_call') return reply(toHex(BigInt(network.registry), { size: 32 }));
      if (method === 'eth_estimateGas') return reply('0x186a0');
      if (method === 'eez_quoteFee') {
        const tx = { nonce: '0x0', gas: '0x186a0', ...params[0] };
        const canonical = JSON.stringify(Object.fromEntries(Object.keys(tx).sort().map(key => [key, tx[key].toLowerCase()])));
        return reply({ version: 1, chainId: tx.chainId, nonce: tx.nonce, expiresAt: toHex(Math.floor(Date.now() / 1000) + 30),
          options: [{ type: tx.type, gas: tx.gas, requestHash: keccak256(toHex(canonical)), estimatedFee: '0x186a0', maxFeePerGas: '0x3b9aca0e', maxPriorityFeePerGas: '0x3b9aca00' }] });
      }
      return reply('0x0');
    });
    await page.goto(origin + '/gas-bridge');
    await page.evaluate(async fixture => (await import('/tests/fixtures/treasury-gas-bridge.tsx')).mount(fixture), { network, state });
    await page.getByRole('button', { name: /MetaMask ·/ }).waitFor();
    // Seed an unrelated bridge draft, including another recipient and gas override.
    await page.getByTitle('Swap direction').click();
    await page.getByRole('button', { name: 'Change recipient', exact: true }).click();
    await page.getByLabel('Recipient address', { exact: true }).fill(toHex(99n, { size: 20 }));
    await page.getByLabel('Bridge amount', { exact: true }).fill('0.5');
    await page.getByText('Gas settings', { exact: true }).click();
    await page.getByLabel('Gas limit', { exact: true }).fill('500000');
    await page.getByRole('button', { name: 'Treasury Demo', exact: true }).click();
    await page.getByRole('button', { name: 'Bridge to L2', exact: true }).click();
    await page.getByRole('button', { name: 'Return to Safe setup', exact: true }).waitFor();
    assert.equal(await page.getByRole('group', { name: 'Source network', exact: true }).getAttribute('data-chain'), 'l1');
    assert.equal(await page.getByLabel('Bridge amount', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('Recipient address', { exact: true }).count(), 0);
    const symbol = testnet ? 'xDAI' : 'ETH';
    await page.getByRole('button', { name: 'Bridge ' + symbol, exact: true }).waitFor();
    await page.getByLabel('Bridge amount', { exact: true }).fill('0.01');
    await page.getByText('Gas settings', { exact: true }).click();
    assert.notEqual(await page.getByLabel('Gas limit', { exact: true }).inputValue(), '500000');
    assert.deepEqual(await page.evaluate(() => window.gasBridgeTest.walletOps), [], 'Navigation must not request a network switch or signature');
    await page.getByRole('button', { name: 'Return to Safe setup', exact: true }).click();
    assert.equal(await page.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('value'), '1');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), state);
    // Explicit bridge submission still follows the normal wallet flow; a pending transfer must not be overwritten.
    await page.getByRole('button', { name: 'Bridge to L2', exact: true }).click();
    await page.getByLabel('Bridge amount', { exact: true }).fill('0.01');
    const send = page.getByRole('button', { name: 'Bridge ' + symbol, exact: true });
    await send.click();
    await page.waitForFunction(() => window.gasBridgeTest.walletOps.some(op => op.method === 'eth_sendTransaction'));
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Return to Safe setup', exact: true }).click();
    await page.getByRole('button', { name: 'Bridge to L2', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'A bridge transfer is still unresolved.' }).waitFor();
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), state);
    assert.equal(await page.evaluate(() => window.gasBridgeTest.walletOps.filter(op => op.method === 'eth_sendTransaction').length), 1);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${kind} ${symbol}: correct route and recipient, no automatic wallet prompts, saved setup preserved, pending bridge protected`);
  }
} catch (error) {
  if (activePage && !activePage.isClosed()) console.error(await activePage.locator('body').innerText());
  throw error;
} finally { await browser.close(); await server.close(); }
