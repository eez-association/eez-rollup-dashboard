import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { getAddress, keccak256, toHex } from 'viem';
import { paymentTransaction } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-view-20261022/browser';
await mkdir(`${directory}/tmp`, { recursive: true }); process.env.TMPDIR = resolve(directory, 'tmp');
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const c = { version: 1, environment: 'dashboard-testnet', instance: hash('treasury-view'),
  safeL1: address(1), safeL2: address(2), registry: address(3), manager: address(4), adapter: address(5), action: address(6),
  code: [], ownerLabels: {}, l1: { chainId: 10200, rpc: 'l1', front: 'l1-front' }, l2: { chainId: 906969, rpc: 'l2', front: 'l2-front' },
  payments: { policy: address(11), alias: address(12), tokenL1: address(13), tokenL2: address(14), moduleL1: address(15), moduleL2: address(16),
    bridgeL1: address(17), bridgeL2: address(18), recipient: address(19), decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Test USDC',
    exactSplits: true, combinedL2: true, l1Initiation: true } };
const p = { source: 'l2', destination: 'l1', funding: 'split', fromL1: '22260000', amount: '40000000', recipient: address(19), epoch: '25' };
const intent = { version: 1, instance: c.instance, value: '0', nonce: '4', safeHash: safeTransactionHash(paymentTransaction(c, p, 4n)),
  data: '0x1234', sender: address(101), sourceNonce: '0x1', startBlock: '0x100', hash: hash('execution'), payment: p };
const f = { config: c, owners: [address(101), address(102)], intent, networkFlow: true, blockHash: hash('l2-block'),
  pending: { sender: address(101) }, postHash: hash('l1-post'), l1Hash: hash('l1-block') };
const settled = { kind: 'settled', hash: intent.hash, block: '262', detail: 'Settled on L1.', execution: { l2: intent.hash },
  contributions: { fromL1: p.fromL1, fromL2: '17740000' } };
const server = await createServer({ configFile: false, envFile: false, cacheDir: resolve(directory, 'node_modules/.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], passed = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => requests.push({ url: request.url(), failure: request.failure() }));
page.on('response', response => { if (response.status() >= 400) requests.push({ url: response.url(), status: response.status() }); });
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected request ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/view-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  return route.fallback();
});
async function load(restore = true, source = 'l2', destination = 'l1', network = c, override) {
  const payment = override ?? { ...p, source, destination };
  const scenario = { ...f, config: network, executionHash: intent.hash, intent: { ...intent, instance: network.instance, payment,
    hash: source === 'l1' ? hash('l1-origin') : intent.hash,
    safeHash: safeTransactionHash(paymentTransaction(network, payment, 4n)), ...(source === 'l1' ? { l2StartBlock: '0x100' } : {}) } };
  await page.goto(`${origin}/view-fixture`);
  await page.evaluate(async ({ f, restore }) => {
    localStorage.clear();
    const { config } = await import('/src/config.ts'); config.l1Explorer = 'https://l1.example'; config.l2Explorer = 'https://l2.example';
    const { mount } = await import('/tests/fixtures/treasury-owners-browser.tsx'); mount({ ...f, intent: restore ? f.intent : undefined });
    const { TreasuryClient } = await import('/src/lib/treasury/client.ts');
    window.ownersTest.result = { kind: 'pending', hash: f.intent.hash, detail: 'Waiting for settlement.' };
    TreasuryClient.prototype.outcome = async () => { if (window.ownersTest.outcomeFailure) throw new Error('Outcome temporarily unavailable'); return window.ownersTest.result; };
    const rpc = TreasuryClient.prototype.rpc;
    TreasuryClient.prototype.rpc = async function (url, method, args) {
      if (method === 'eez_getSettlementByL2Block') {
        if (window.ownersTest.indexFailure) throw new Error('Index unavailable');
        return { canonicalL2: true, l1BlockNumber: '0x200', l1BlockHash: f.l1Hash, l1TransactionHash: f.postHash,
          l2Blocks: [{ number: '0x106', hash: f.blockHash }] };
      }
      if (method === 'eth_getTransactionReceipt' && args[0] === f.executionHash) return { status: '0x1', blockNumber: '0x106', blockHash: f.blockHash };
      if (method === 'eth_getTransactionReceipt' && args[0] === f.postHash) return { status: '0x1', transactionHash: f.postHash, blockNumber: '0x200', blockHash: f.l1Hash };
      if (method === 'eth_getBlockByNumber' && url === 'l1' && args[0] === '0x200') return { number: '0x200', hash: f.l1Hash };
      return rpc.call(this, url, method, args);
    };
  }, { f: scenario, restore });
}
const state = values => page.evaluate(values => Object.assign(window.ownersTest, values), values);
const key = `eez:treasury:submission:${c.instance}`;
try {
  await load();
  await page.getByTestId('shared-threshold').filter({ hasText: '1 of 2 owners' }).waitFor();
  assert(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
  assert(await page.evaluate(key => !!localStorage.getItem(key), key));
  await state({ result: settled });
  await page.getByRole('heading', { name: 'Settled on Chiado', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled(), false, 'a verified payment must unlock the form without New payment');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, 'completed payment no longer blocks restart');
  const historyKey = `eez:treasury:history:${c.instance}`;
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).entries.length, historyKey), 1);
  passed.push('completion archives the identity, releases restart and unlocks editing without a new-payment action');
  const safe = page.getByRole('region', { name: 'Chiado Safe funds', exact: true });
  const link = safe.getByRole('link', { name: `Chiado Safe ${c.safeL1}`, exact: true });
  assert.equal(await link.getAttribute('href'), `https://l1.example/address/${c.safeL1}`);
  assert((await link.textContent()).length < 30);
  await safe.getByRole('button', { name: 'Copy Chiado Safe address', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), c.safeL1);
  assert.equal(await safe.getByText('Explorer ↗', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Treasury details', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Inspect execution', exact: true }).count(), 0);
  const shared = page.getByRole('region', { name: 'Shared owners', exact: true });
  await shared.getByLabel('New owner address', { exact: true }).waitFor();
  passed.push('Safe addresses are compact explorer links with icon copy, and owner management sits within Shared owners');
  const status = page.getByRole('region', { name: 'Safe transaction status', exact: true });
  await status.getByRole('figure', { name: 'Payment flow', exact: true }).waitFor();
  const expected = { 'Chiado payment transaction': `https://l1.example/tx/${f.postHash}`, 'EEZ-X Safe transaction': `https://l2.example/tx/${intent.hash}`,
    'Chiado settlement transaction': `https://l1.example/tx/${f.postHash}`, 'Chiado #512': 'https://l1.example/block/512', 'EEZ-X #262': 'https://l2.example/block/262' };
  for (const [name, url] of Object.entries(expected)) {
    await page.waitForFunction(({ name, url }) => [...document.querySelectorAll('a')].some(a => a.textContent === name && a.href === url), { name, url });
  }
  await status.locator('svg > path').first().waitFor({ state: 'attached' });
  assert.equal(await status.locator('svg > path').count(), 5, 'authorization, fork and merge connectors are drawn');
  await status.getByText('22.26 USDC', { exact: true }).waitFor(); await status.getByText('17.74 USDC', { exact: true }).waitFor();
  passed.push('settled diagram explains both funding legs and links actual execution transactions plus settlement evidence');
  const history = page.getByRole('region', { name: 'Payment history', exact: true });
  await history.locator('a[href="https://l1.example/tx/' + f.postHash + '"]').waitFor();
  assert.equal(await history.locator('a[href="https://l1.example/tx/' + f.postHash + '"]').count(), 1, 'collapsed history includes the Chiado settlement transaction');
  assert.equal(await history.locator('a[href="https://l2.example/tx/' + intent.hash + '"]').count(), 1);
  await history.getByRole('link', { name: 'Chiado #512', exact: true }).waitFor();
  await history.getByRole('link', { name: 'EEZ-X #262', exact: true }).waitFor();
  assert.match(await history.locator('[aria-label="Actual funding split"]').textContent(), /Chiado 22.26 USDCEEZ-X 17.74 USDC/);
  assert(!/\bL[12]\b/.test(await status.innerText()), 'the payment flow uses network names');
  assert.equal(await status.getByText(/Safe calls are included/).count(), 0);
  passed.push('collapsed history shows both execution chains, both blocks, and verified contributions');
  await history.getByRole('button', { name: 'Show payment details', exact: true }).click();
  await history.getByRole('figure', { name: 'Payment flow', exact: true }).waitFor();
  assert.equal(await history.locator('[data-testid="history-entry"][data-status="settled"]').count(), 1);
  passed.push('payment history uses transaction rows with expandable payment flow');
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await status.screenshot({ path: `${directory}/flow-desktop.png` });
  await history.screenshot({ path: `${directory}/history-desktop.png` });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fits ${width}px`);
    const copy = await safe.getByRole('button', { name: 'Copy Chiado Safe address', exact: true }).boundingBox();
    const addressBox = await link.boundingBox(); assert(Math.abs(copy.y + copy.height / 2 - addressBox.y - addressBox.height / 2) < 3, 'address and copy stay on one line');
  }
  await page.screenshot({ path: `${directory}/mobile.png`, fullPage: true });
  await status.screenshot({ path: `${directory}/flow-mobile.png` });
  passed.push('desktop and 390/320px layouts fit without horizontal scrolling');
  await state({ result: { kind: 'pending', hash: intent.hash, detail: 'Settlement changed; rechecking.' } });
  await page.waitForFunction(key => !!localStorage.getItem(key), key);
  assert(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
  await state({ result: settled });
  await page.waitForFunction(key => localStorage.getItem(key) === null, key);
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Edit payment', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Submit Safe transaction', exact: true }).isDisabled(), true, 'fresh review needs fresh approvals');
  assert.deepEqual(await page.evaluate(() => window.ownersTest.walletCalls), []);
  passed.push('reorg observations restore the pending lock; next review clears stale approvals and never auto-submits');
  await load();
  await state({ result: settled });
  await page.waitForFunction(key => localStorage.getItem(key) === null, key);
  await state({ outcomeFailure: true });
  await page.waitForFunction(key => !!localStorage.getItem(key), key);
  assert(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
  assert.equal(await history.locator('[data-status="settled"]').count(), 0);
  await state({ outcomeFailure: false });
  await page.waitForFunction(key => localStorage.getItem(key) === null, key);
  passed.push('RPC uncertainty restores the unresolved request and removes stale success labels');

  await page.setViewportSize({ width: 1440, height: 1100 });
  await load(true, 'l1', 'l2');
  await state({ result: { ...settled, hash: hash('l1-origin'), sourceBlock: '500', execution: { l1: hash('l1-origin'), l2: intent.hash } } });
  await status.getByRole('link', { name: 'Chiado Safe transaction', exact: true }).waitFor();
  assert.equal(await status.getByRole('link', { name: 'Chiado Safe transaction', exact: true }).getAttribute('href'), `https://l1.example/tx/${hash('l1-origin')}`);
  assert.equal(await status.getByRole('link', { name: 'Chiado payment transaction', exact: true }).getAttribute('href'), `https://l1.example/tx/${hash('l1-origin')}`);
  await status.getByText('Bridge to EEZ-X recipient', { exact: true }).waitFor();
  await status.getByText('Your Chiado Safe checked its owners’ signatures.', { exact: true }).waitFor();
  await status.getByRole('link', { name: 'EEZ-X #262', exact: true }).waitFor();
  await history.locator('a[href="https://l1.example/tx/' + hash('l1-origin') + '"]').waitFor();
  await history.locator('a[href="https://l1.example/tx/' + f.postHash + '"]').waitFor();
  await history.locator('a[href="https://l2.example/tx/' + intent.hash + '"]').waitFor();
  await history.getByRole('link', { name: 'Chiado #500', exact: true }).waitFor();
  await history.getByRole('link', { name: 'Chiado #512', exact: true }).waitFor();
  await history.getByRole('link', { name: 'EEZ-X #262', exact: true }).waitFor();
  await status.screenshot({ path: `${directory}/flow-reverse.png` });
  passed.push('reverse route links the L1 Safe source transaction separately from L1 settlement and explains L2 delivery');

  await state({ indexFailure: true });
  await history.getByText('Chiado settlement link unavailable', { exact: true }).waitFor();
  assert.equal(await history.locator('a[href="https://l1.example/tx/' + f.postHash + '"]').count(), 0);
  assert.equal(await history.locator('[data-status="settled"]').count(), 1, 'optional index failure does not change payment acceptance');
  assert.equal(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled(), false);
  await state({ indexFailure: false });
  await history.locator('a[href="https://l1.example/tx/' + f.postHash + '"]').waitFor();
  passed.push('index failure withholds settlement links without blocking verified payment; links recover automatically');

  await load();
  await state({ result: { ...settled, contributions: { fromL1: '0', fromL2: '40000000' } } });
  await status.getByText('Not used for this payment', { exact: true }).waitFor();
  assert.equal(await status.getByRole('link', { name: 'Chiado payment transaction', exact: true }).count(), 0);
  await history.locator('[aria-label="Actual funding split"]').filter({ hasText: 'Chiado 0 USDC' }).waitFor();
  passed.push('an unused Safe shows zero contribution and no invented payment execution');

  await load();
  await page.evaluate(key => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) { if (name === key && window.ownersTest.refuseClear) throw new Error('Controlled storage failure'); return remove.call(this, name); };
    window.ownersTest.refuseClear = true;
  }, key);
  await state({ result: settled });
  await page.getByRole('alert').filter({ hasText: 'Controlled storage failure' }).waitFor();
  assert(await page.evaluate(key => !!localStorage.getItem(key), key));
  assert(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
  await state({ refuseClear: false });
  await page.waitForFunction(key => localStorage.getItem(key) === null, key);
  passed.push('failed pending-slot cleanup leaves the request locked and recoverable');

  await load();
  const other = { ...intent, sourceNonce: '0x2' };
  await page.evaluate(({ key, other }) => localStorage.setItem(key, JSON.stringify(other)), { key, other });
  await state({ result: settled });
  await page.getByRole('alert').filter({ hasText: 'Another payment is being tracked' }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), JSON.stringify(other));
  assert(await page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
  passed.push('completion cannot remove or overwrite a different request saved by another tab');
  const ethereum = { ...c, environment: 'ethereum-mainnet', instance: hash('ethereum-view'),
    l1: { ...c.l1, chainId: 1, explorer: 'https://etherscan.io' },
    l2: { ...c.l2, chainId: 700001, explorer: 'https://eez-mainnet.example/explorer' },
    payments: { ...c.payments, assetLabel: 'USDC' } };
  await load(true, 'l2', 'l1', ethereum);
  await state({ result: settled });
  await page.getByRole('heading', { name: 'Settled on Ethereum', exact: true }).waitFor();
  const ethereumSafe = page.getByRole('region', { name: 'Ethereum Safe funds', exact: true });
  assert.equal(await ethereumSafe.getByRole('link', { name: `Ethereum Safe ${c.safeL1}` }).getAttribute('href'), `https://etherscan.io/address/${c.safeL1}`);
  await history.getByRole('link', { name: 'Ethereum #512', exact: true }).waitFor();
  assert.equal(await history.getByRole('link', { name: 'Ethereum #512', exact: true }).getAttribute('href'), 'https://etherscan.io/block/512');
  assert.equal(await history.getByRole('link', { name: 'EEZ-X #262', exact: true }).getAttribute('href'), 'https://eez-mainnet.example/explorer/block/262');
  assert(!(await page.getByRole('region', { name: 'Connected treasury demo' }).innerText()).includes('Chiado'));
  await page.screenshot({ path: `${directory}/ethereum.png`, fullPage: true });
  passed.push('Ethereum manifests use their own Safe, payment and block explorer links without Chiado labels');
  const moved = {kind:'transfer',source:'l1',destination:'l2',recipient:c.safeL2,funding:'local',amount:'427740000',epoch:'25',rollupId:'1'};
  await load(true,'l1','l2',c,moved);
  await state({result:{...settled,hash:hash('l1-origin'),sourceBlock:'513',execution:{l1:hash('l1-origin'),l2:intent.hash},contributions:{fromL1:moved.amount,fromL2:'0'}}});
  const transferFlow=page.getByRole('figure',{name:'Transfer flow'}).first();
  await transferFlow.getByText('Received 427.74 USDC',{exact:true}).waitFor();
  assert.equal(await transferFlow.getByText('Shared budget checked',{exact:true}).count(),0);
  await transferFlow.getByText('Funds stayed within your treasury. Payment budgets and allowances were unchanged.',{exact:true}).waitFor();
  await page.getByText('Transfer between Safes',{exact:true}).waitFor();
  assert.equal(await transferFlow.getByRole('link',{name:'Safe transaction',exact:true}).getAttribute('href'),`https://l1.example/tx/${hash('l1-origin')}`);
  assert.equal(await transferFlow.getByRole('link',{name:'EEZ-X delivery transaction',exact:true}).getAttribute('href'),`https://l2.example/tx/${intent.hash}`);
  await page.setViewportSize({width:1440,height:1100}); await page.screenshot({path:`${directory}/transfer-complete.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${directory}/transfer-mobile.png`,fullPage:true});
  passed.push('completed internal transfers show the source, bridge and receiving Safe with both transaction links and unchanged payment budgets');
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ passed, mode: 'controlled outcomes and RPCs; real React, history persistence and settlement-link checks; no blockchain writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} catch (error) {
  await writeFile(`${directory}/failure.json`, JSON.stringify({ error: String(error), passed, errors, requests }, null, 2) + '\n');
  throw error;
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
