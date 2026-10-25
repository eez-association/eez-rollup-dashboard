import { readFileSync } from "node:fs";
import { transferAbi } from "../src/lib/treasury/transfers.ts";
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { getAddress, keccak256, toHex, decodeFunctionData } from 'viem';
import { paymentTransaction, paymentAbi } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-wallet-browser';
await mkdir(`${directory}/tmp`, { recursive: true }); process.env.TMPDIR = resolve(directory, 'tmp');
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const owners = [address(101), address(102)];
const config = { version: 1, environment: 'dashboard-testnet', instance: hash('wallet-ui'), safeL1: address(1), safeL2: address(2),
  registry: address(3), manager: address(4), adapter: address(5), action: address(6), code: [], ownerLabels: {},
  l1: { chainId: 10200, rpc: 'l1', front: 'l1-front' }, l2: { chainId: 906969, rpc: 'l2', front: 'l2-front' },
  payments: { policy: address(11), alias: address(12), tokenL1: address(13), tokenL2: address(14), moduleL1: address(15), moduleL2: address(16),
    bridgeL1: address(17), bridgeL2: address(18), recipient: address(19), decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Test USDC', version: 2 } };
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected network request: ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/wallet-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  return route.fallback();
});
const load = async (options = {}) => {
  await page.goto(`${origin}/wallet-fixture`);
  await page.evaluate(async f => { localStorage.clear(); const m = await import('/tests/fixtures/treasury-owners-browser.tsx'); m.mount(f); },
    { config, owners, blockHash: hash('block'), networkFlow: true, ...options });
  await page.getByTestId('shared-threshold').getByText('1 of 2 owners', { exact: true }).waitFor();
};
const selectWallet = (owner, chain) => page.evaluate(({ owner, chain }) => window.ownersTest.selectWallet(owner, chain), { owner, chain: toHex(config[chain].chainId) });
const start = page.getByLabel('Start from', { exact: true });
const sign = page.getByRole('button', { name: 'Sign approval', exact: true });
const submit = page.getByRole('button', { name: 'Submit Safe transaction', exact: true });
const review = () => page.getByRole('button', { name: 'Review payment', exact: true }).click();
const controls = () => page.evaluate(() => ({ switches: window.ownersTest.switches, signatures: window.ownersTest.signatures, prepared: window.ownersTest.prepared, writes: window.ownersTest.walletCalls }));
const state = values => page.evaluate(values => { Object.assign(window.ownersTest, values); }, values);
const waitQuorum = text => page.waitForFunction(text => document.querySelector('[data-testid="quorum"]')?.textContent === text, text);
try {
  for (const chain of ['l1', 'l2']) {
    await load({ chainId: toHex(config[chain].chainId) });
    assert.equal(await start.inputValue(), chain, 'new payments must start on the connected wallet network');
    assert.equal(await page.getByRole('button', { name: /^Switch to / }).count(), 0, 'there is no separate network-switch step');
    assert.deepEqual((await controls()).switches, []);
    await page.getByRole('slider', { name: 'EEZ-X share of payment' }).waitFor();
    assert.equal(await page.getByText('Enable custom splits', { exact: true }).count(), 0);
    assert.equal(await page.locator('#treasury-policy-update').count(), 0);
    if (chain === 'l1') await page.screenshot({ path: `${directory}/connected-chiado.png`, fullPage: true });
    await review(); await sign.click(); await waitQuorum('1 of 1 approvals');
    const c = await controls(); assert.deepEqual(c.switches, []); assert.equal(c.signatures.length, 1);
    assert.equal(c.signatures[0].chainId, String(config[chain].chainId));
    assert.equal(c.signatures[0].safe.toLowerCase(), config[chain === 'l1' ? 'safeL1' : 'safeL2'].toLowerCase());
  }
  passed.push('both initiating Safes follow the connected network; matching-network approvals request no switch');

  await load({ disconnected: true });
  await selectWallet(owners[0], 'l1');
  await page.waitForFunction(() => document.querySelector('#treasury-source').value === 'l1');
  await load({ disconnected: true });
  await start.selectOption('l2'); await selectWallet(owners[0], 'l1');
  assert.equal(await start.inputValue(), 'l2', 'explicit choice survives wallet connection');
  await review(); await sign.click(); await waitQuorum('1 of 1 approvals');
  assert.deepEqual((await controls()).switches, ['l2']);
  passed.push('late wallet connection picks a default without replacing an explicit Safe choice');

  for (const source of ['l1', 'l2']) {
    const other = source === 'l1' ? 'l2' : 'l1';
    await load({ chainId: toHex(config[other].chainId) }); await start.selectOption(source); await review();
    const reviewed = await page.getByTestId('safe-hash').textContent();
    await state({ switchMode: 'reject' }); await sign.click();
    await page.getByRole('alert').filter({ hasText: 'Wallet network change cancelled' }).waitFor();
    assert.equal((await controls()).signatures.length, 0); await waitQuorum('0 of 1 approvals');
    await state({ switchMode: 'noop' }); await sign.click();
    await page.getByRole('alert').filter({ hasText: 'Wallet is still on another network' }).waitFor();
    assert.equal((await controls()).signatures.length, 0);
    await state({ switchMode: 'accept' }); await sign.click(); await waitQuorum('1 of 1 approvals');
    assert.equal(await page.getByTestId('safe-hash').textContent(), reviewed);
    assert.equal((await controls()).signatures[0].chainId, String(config[source].chainId));
    await selectWallet(owners[0], other);
    assert.equal(await start.inputValue(), source, 'wallet changes cannot rewrite the reviewed Safe');
    await submit.click();
    await page.getByRole('alert').filter({ hasText: 'Fixture reached submission preparation' }).waitFor();
    assert.equal((await controls()).prepared[0].chainId, String(config[source].chainId));
    assert.deepEqual((await controls()).writes, []);
  }
  passed.push('approval and submission switch only to the reviewed Safe; rejected or ineffective switches never sign');

  await load({ chainId: toHex(config.l1.chainId) }); await start.selectOption('l2'); await review();
  await state({ switchMode: 'defer' }); await sign.click();
  await page.waitForFunction(() => !!window.ownersTest.releaseSwitch);
  await selectWallet(owners[1], 'l1');
  await page.evaluate(() => window.ownersTest.releaseSwitch());
  await page.getByRole('alert').filter({ hasText: 'wallet or reviewed action changed' }).waitFor();
  assert.equal((await controls()).signatures.length, 0);
  passed.push('an account change during the network prompt stops the pending approval');

  await load({ chainId: toHex(config.l1.chainId) }); await start.selectOption('l2'); await review();
  await state({ switchMode: 'defer' }); await sign.click();
  await page.waitForFunction(() => !!window.ownersTest.releaseSwitch);
  await state({ owners: [...owners, address(103)], threshold: 2 });
  await waitQuorum('0 of 2 approvals');
  await page.evaluate(() => window.ownersTest.releaseSwitch());
  await page.getByRole('alert').filter({ hasText: 'wallet or reviewed action changed' }).waitFor();
  assert.equal((await controls()).signatures.length, 0);
  passed.push('owner changes during the network prompt invalidate the review before signing');

  for (const source of ['l1', 'l2']) {
    const payment = { source, recipient: config.payments.recipient, destination: 'l2', epoch: '25', amount: '40000000', fromL1: '0' };
    const intent = { version: 1, instance: config.instance, value: '0', nonce: '4', sender: owners[0], sourceNonce: '0x1', startBlock: '0x106',
      l2StartBlock: '0x106', data: '0x1234', safeHash: safeTransactionHash(paymentTransaction(config, payment, 4n)), payment };
    await load({ chainId: toHex(config[source === 'l1' ? 'l2' : 'l1'].chainId), intent });
    assert.equal(await start.inputValue(), source); assert(await start.isDisabled());
    assert.deepEqual((await controls()).switches, []);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), `eez:treasury:submission:${config.instance}`), JSON.stringify(intent));
  }
  passed.push('restored submissions retain their source and journal without network prompts');
  await load({ chainId: toHex(config.l1.chainId), config: { ...config, payments: { ...config.payments, version: undefined, exactSplits: true, combinedL2: true, l1Initiation: false } } });
  assert.equal(await start.inputValue(), 'l2');
  await review(); await sign.click(); await waitQuorum('1 of 1 approvals');
  assert.deepEqual((await controls()).switches, ['l2']);
  passed.push('existing L2-only treasuries remain supported');
  await page.screenshot({ path: `${directory}/reviewed-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/reviewed-mobile.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1050 });
  const splitConfig = config;
  const slider = page.getByRole('slider', { name: 'EEZ-X share of payment' });
  const setSplit = async value => slider.fill(String(value));
  await load({ config: splitConfig });
  assert.equal(await page.locator('#treasury-funding').count(), 0);
  await slider.waitFor();
  await page.getByLabel('Amount (USDC)', { exact: true }).fill('40');
  await setSplit(7500);
  await page.screenshot({ path: `${directory}/split-desktop.png`, fullPage: true });
  await page.getByLabel('Start from', { exact: true }).selectOption('l1');
  await page.getByLabel('Recipient chain', { exact: true }).selectOption('l1');
  await setSplit(7500);
  await review(); await page.getByTestId('funding-preview').filter({ hasText: '10 from Chiado + 30 from EEZ-X' }).waitFor();
  assert(await slider.isDisabled()); await sign.click(); await waitQuorum('1 of 1 approvals');
  const signed = decodeFunctionData({ abi: paymentAbi, data: (await controls()).signatures[0].data });
  assert.equal(signed.functionName, 'paySplit'); assert.equal(signed.args.at(-1), 10_000_000n);
  passed.push('slider replaces funding selector, locks at review and signs the exact chosen contributions');
  await page.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await slider.focus(); await page.keyboard.press('Home'); assert.equal(await slider.inputValue(), '0');
  await page.keyboard.press('End'); assert.equal(await slider.inputValue(), '10000');
  await page.keyboard.press('ArrowLeft'); assert.equal(await slider.inputValue(), '9999');
  await setSplit(5000);
  await state({ balanceL1: 1 });
  await page.getByRole('status').filter({ hasText: 'Insufficient balance' }).waitFor();
  assert.equal(await slider.inputValue(), '5000', 'polling must not change a selected allocation');
  await review(); await page.getByRole('alert').filter({ hasText: 'Insufficient balance' }).waitFor();
  assert(await sign.isDisabled(), 'invalid split cannot collect approvals');
  passed.push('keyboard endpoints work; reduced capacity reports rejection without silently rebalancing');
  await load({ config: splitConfig });
  await page.getByLabel('Amount (USDC)', { exact: true }).fill('110');
  await page.getByLabel('Recipient chain', { exact: true }).selectOption('l1');
  await review(); await page.getByTestId('funding-preview').filter({ hasText: '100 from Chiado + 10 from EEZ-X' }).waitFor();
  await sign.click(); await waitQuorum('1 of 1 approvals');
  assert.equal(decodeFunctionData({ abi: paymentAbi, data: (await controls()).signatures[0].data }).args.at(-1), 100_000_000n);
  passed.push('default allocation preserves exactly 100 plus 10 rather than rounding the 110-USDC demo split');
  await page.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await setSplit(5000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/split-mobile.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const payment = { source: 'l2', recipient: config.payments.recipient, destination: 'l1', epoch: '25', amount: '40000000', fromL1: '12345678' };
  const intent = { version: 1, instance: config.instance, value: '0', nonce: '4', sender: owners[0], sourceNonce: '0x1', startBlock: '0x106',
    data: '0x1234', safeHash: safeTransactionHash(paymentTransaction(splitConfig, payment, 4n)), payment };
  await load({ config: splitConfig, intent });
  assert(await slider.isDisabled());
  await page.getByLabel('Safe contributions').getByText('12.345678 USDC', { exact: true }).waitFor();
  passed.push('restored custom contributions remain exact and locked; mobile layout has no overflow');
  await load({ chainId: toHex(config.l2.chainId), helperRuntime: JSON.parse(readFileSync('tests/fixtures/safe-multisend-call-only-130.json')).runtime });
  await state({ balanceL1: 427740000, balanceL2: 0 });
  await page.getByLabel('Payment type', { exact: true }).selectOption('transfer');
  assert.equal(await start.inputValue(), 'l1'); assert(await start.isDisabled());
  assert.equal(await page.getByLabel('Recipient address', { exact: true }).inputValue(), config.safeL2);
  assert.equal(await page.getByLabel('Recipient chain', { exact: true }).inputValue(), 'l2');
  assert.equal(await slider.count(), 0);
  await page.getByLabel('Amount (USDC)', { exact: true }).fill('427.74');
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await page.getByTestId('funding-preview').filter({ hasText: '427.74 from Chiado + 0 from EEZ-X' }).waitFor();
  await page.getByText(/Internal transfer: the payment budget and spending allowances stay unchanged/).waitFor();
  await sign.click(); await waitQuorum('1 of 1 approvals');
  const transfer = (await controls()).signatures[0];
  assert.equal(transfer.safe.toLowerCase(),config.safeL1.toLowerCase());
  assert.equal(decodeFunctionData({abi:transferAbi,data:transfer.data}).functionName,'multiSend');
  await submit.click(); await page.getByRole('alert').filter({hasText:'Fixture reached submission preparation'}).waitFor();
  assert.deepEqual((await controls()).switches,['l1']); assert.deepEqual((await controls()).writes,[]);
  await page.screenshot({path:`${directory}/transfer-review.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  passed.push('internal transfers fix the destination to the mirror Safe, disclose owner authority, allow the full balance and sign the bridge batch on Chiado');
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ passed, mode: 'controlled chain reads, wallet switches, approvals and submission preparation; no real wallet writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
