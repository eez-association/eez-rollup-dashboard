import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { getAddress, toHex, keccak256, decodeFunctionData, parseAbi } from 'viem';
const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-faucet-amounts-20261021/browser';
await mkdir(`${directory}/tmp`, { recursive: true }); process.env.TMPDIR = resolve(directory, 'tmp');
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const fixture = { owner: address(100), faucet: address(110), hash: hash('request'), asset: { tokenL1: address(101), tokenL2: address(102), bridgeL1: address(103), bridgeL2: address(104), tokenCodeHash: hash('token') } };
// This fixture tests explicit reload recovery; HMR reconnects must not reload it mid-assertion.
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false }, base: '/' });
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(18000);
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected external request ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/faucet-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  return route.fallback();
});
const amount = page.getByLabel('Amount (Test USDC)', { exact: true }), recipient = page.getByLabel('Recipient address', { exact: true });
const network = page.getByLabel('Destination network', { exact: true });
const prepare = page.getByRole('button', { name: 'Prepare faucet', exact: true });
const request = page.getByRole('button', { name: 'Request Test USDC', exact: true });
const load = async options => {
  await page.goto(`${origin}/faucet-fixture`);
  await page.evaluate(async f => { localStorage.clear(); const m = await import('/tests/fixtures/treasury-faucet-browser.tsx'); m.mount(f); }, { ...fixture, ...options });
  await page.waitForFunction(() => document.querySelector('#faucet-recipient')?.value.length === 42);
};
const state = values => page.evaluate(values => Object.assign(window.faucetTest, values), values);
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem(window.faucetTest.key)));
const controls = () => page.evaluate(() => ({ writes: window.faucetTest.writes, prepared: window.faucetTest.prepared, switches: window.faucetTest.switches }));
const waitEnabled = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Request Test USDC' && !b.disabled));
try {
  await load({ unfunded: fixture.owner });
  await amount.fill('42.123456'); await network.selectOption('l2');
  await prepare.click();
  await page.getByRole('alert').filter({ hasText: 'The submitting wallet needs test xDAI on Chiado' }).waitFor();
  assert.equal((await controls()).writes.length, 0);
  const payer = address(112);
  await page.evaluate(account => window.faucetTest.selectWallet(account, '0x27d8'), payer);
  await page.waitForFunction(() => !document.querySelector('#faucet-recipient').disabled);
  assert.equal(await recipient.inputValue(), fixture.owner, 'switching the payer must retain the account receiving tokens');
  assert.equal(await amount.inputValue(), '42.123456'); assert.equal(await network.inputValue(), 'l2');
  await prepare.click(); await waitEnabled(); await request.click();
  await page.getByRole('status').filter({ hasText: '42.123456 Test USDC delivered on EEZ-X' }).waitFor();
  const sponsored = (await controls()).writes;
  assert.equal(sponsored.length, 2);
  assert(sponsored.every(tx => tx.from === payer), 'only the funded connected wallet signs and pays');
  assert.deepEqual(decodeFunctionData({ abi: parseAbi(['function request(address recipient,uint256 amount,bool onL2)']), data: sponsored[1].data }).args,
    [fixture.owner, 42123456n, true]);
  await recipient.fill(address(113)); await amount.fill('7.5'); await network.selectOption('l1');
  await page.evaluate(account => window.faucetTest.selectWallet(account, '0x27d8'), address(114));
  await page.waitForFunction(() => !document.querySelector('#faucet-recipient').disabled);
  assert.equal(await recipient.inputValue(), address(113)); assert.equal(await amount.inputValue(), '7.5'); assert.equal(await network.inputValue(), 'l1');
  assert.equal((await controls()).writes.length, 2, 'a wallet switch never submits a request');
  passed.push('a funded wallet can claim for the original unfunded recipient; wallet switches preserve entered amount, recipient and destination without submitting');

  await load(); assert.equal(await amount.inputValue(), '450'); assert.equal(await recipient.inputValue(), fixture.owner);
  await amount.fill('1000.123456'); await recipient.fill(address(105)); await network.selectOption('l2');
  await prepare.click(); await waitEnabled();
  let journal = await saved();
  assert.equal(journal.faucetRequests[1].amount, '1000123456'); assert.equal(journal.faucetRequests[1].recipient, address(105));
  assert.equal(journal.faucetRequests[1].destination, 'l2'); assert.equal((await controls()).writes.length, 1);
  assert.equal(await page.getByText(/delivered on/).count(), 0, 'initialization does not claim delivery');
  await request.click(); await page.getByRole('status').filter({ hasText: '1000.123456 Test USDC delivered on EEZ-X' }).waitFor();
  journal = await saved(); assert.equal(journal.completed.length, 2); assert.equal((await controls()).writes.length, 2);
  assert.equal((await controls()).prepared[1].quoted, true);
  const call = decodeFunctionData({ abi: parseAbi(['function request(address recipient,uint256 amount,bool onL2)']), data: (await controls()).writes[1].data });
  assert.deepEqual(call.args, [address(105), 1000123456n, true]);
  await amount.fill('0.000001'); await network.selectOption('l1'); await recipient.fill(address(106));
  await request.click(); await page.getByRole('status').filter({ hasText: '0.000001 Test USDC delivered on Chiado' }).waitFor();
  assert.equal((await controls()).prepared[2].quoted, false); assert.equal((await controls()).switches, 0);
  assert(await request.isEnabled());
  passed.push('first preparation preserves selection, exact fractional and >450 requests reach both destinations, repeats remain enabled without balance reads');
  const ready = await saved();
  await amount.fill('2500.123456'); await network.selectOption('l2'); await recipient.fill(address(107));
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${directory}/mobile.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const bad of ['0', '-1', '0.0000001', '1e6']) { await amount.fill(bad); assert(await request.isDisabled()); }
  await amount.fill('1'); await recipient.fill('0x1234'); assert(await request.isDisabled());
  await page.getByRole('button', { name: 'Use connected wallet' }).click(); assert.equal(await recipient.inputValue(), fixture.owner);
  passed.push('invalid precision, amount and recipient cannot submit; mobile fits the viewport');

  await load({ saved: ready, receipt: false }); await amount.fill('750.123456'); await recipient.fill(address(108)); await network.selectOption('l2');
  await request.click(); await page.getByRole('status').filter({ hasText: 'Request pending' }).waitFor();
  const pending = await saved(); await load({ saved: pending, receipt: false });
  assert.equal(await amount.inputValue(), '750.123456'); assert.equal(await recipient.inputValue(), address(108)); assert.equal(await network.inputValue(), 'l2');
  assert(await amount.isDisabled()); assert.equal(await request.count(), 0); assert.deepEqual(await saved(), pending);
  passed.push('reload restores and locks the exact pending amount, recipient and destination without resubmitting');
  await page.evaluate(account => window.faucetTest.selectWallet(account, '0x27d8'), address(115));
  await page.waitForFunction(() => !document.querySelector('#faucet-recipient').disabled);
  await recipient.fill(address(116)); await amount.fill('12'); await network.selectOption('l1');
  await page.evaluate(account => window.faucetTest.selectWallet(account, '0x27d8'), fixture.owner);
  await page.getByRole('status').filter({ hasText: 'Request pending' }).waitFor();
  assert.equal(await recipient.inputValue(), address(108)); assert.equal(await amount.inputValue(), '750.123456'); assert.equal(await network.inputValue(), 'l2');
  assert(await amount.isDisabled()); assert.deepEqual(await saved(), pending);
  assert.equal((await controls()).writes.length, 0);
  passed.push('returning to a wallet with an unresolved request restores its exact locked selection, leaving its journal untouched');


  await load({ saved: ready }); await state({ sendMode: 'reject' }); await request.click();
  await page.getByRole('alert').filter({ hasText: 'User rejected request' }).waitFor(); assert.equal((await saved()).pending, undefined);
  await state({ sendMode: 'uncertain' }); await request.click();
  await page.getByRole('alert').filter({ hasText: 'Wallet connection interrupted' }).waitFor(); assert((await saved()).pending);
  assert.equal(await request.count(), 0);
  passed.push('wallet cancellation permits retry; uncertain submission remains pending and blocks duplicates');

  await load({ saved: ready, chainId: '0xdd6d9' }); await state({ switchMode: 'noop' }); await request.click();
  await page.getByRole('alert').filter({ hasText: 'Wallet is still on another network' }).waitFor(); assert.equal((await controls()).writes.length, 0);
  await state({ switchMode: 'defer' }); await request.click(); await page.waitForFunction(() => !!window.faucetTest.releaseSwitch);
  await page.evaluate(account => { window.faucetTest.selectWallet(account, '0xdd6d9'); window.faucetTest.releaseSwitch(); }, address(111));
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'Waiting for wallet…'));
  assert.equal((await controls()).writes.length, 0);
  passed.push('ineffective network switch and account change during preparation never submit');
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ passed, evidence: 'mocked RPC and wallet; production React, amount parser and request plan; no public writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
