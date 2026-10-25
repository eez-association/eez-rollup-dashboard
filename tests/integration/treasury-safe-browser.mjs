// Read-only smoke of the real dashboard and official Safe app. The injected
// provider exposes a public fixture address but cannot approve or submit.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { getAddress } from 'viem';
import { TreasuryClient, safeAbi } from '../../src/lib/treasury/client.ts';
const session = JSON.parse(readFileSync(process.argv[2]));
const directory = resolve(dirname(process.argv[2]), 'safe-app');
const c = session.treasury;
assert(c.safeAppUrl, 'Run treasury:safe check first');
const client = new TreasuryClient(c); await client.validate();
const snapshot = await client.snapshot();
const nonce = await client.read(c.l1.rpc, c.safeL1, safeAbi, 'nonce');
const labeled = name => getAddress(Object.entries(c.ownerLabels).find(([, label]) => label === name)[0]);
assert.equal(snapshot.owners.length, 2, 'smoke requires the initial A+B fixture');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const errors = [], unsafeRequests = [];
const record = { checkedAt: new Date().toISOString(), instance: c.instance, browser: 'Chromium / Playwright read-only provider', checks: [], walletExtensionRehearsal: 'pending' };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(session.url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
  const treasury = page.getByRole('region', { name: 'Connected treasury demo', exact: true });
  assert.equal(await treasury.count(), 0, 'fresh browser must keep the demo hidden');
  await page.keyboard.press('Control+Alt+Shift+KeyT');
  await treasury.waitFor();
  await treasury.getByText('2 of 2 owners required', { exact: false }).waitFor();
  assert.equal(await treasury.getByRole('link', { name: 'Open L1 Safe', exact: true }).getAttribute('href'), c.safeAppUrl);
  assert.equal(await treasury.getByTestId('global-spent').innerText(), '0');
  await page.screenshot({ path: resolve(directory, 'dashboard-ready.png'), fullPage: true });
  record.checks.push('hidden dashboard, real owner quorum, zero budget and exact L1 Safe link');
  console.log('Dashboard handoff checked');

  const safe = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  safe.setDefaultTimeout(15_000);
  safe.on('pageerror', error => errors.push(error.message));
  safe.on('console', event => { if (event.type() === 'error' && event.text().includes('Error connecting to the blockchain')) errors.push(event.text()); });
  await safe.exposeFunction('treasuryReadRPC', async ({ method, params }) => {
    const allowed = ['eth_call', 'eth_chainId', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getBlockByNumber',
      'eth_getBlockByHash', 'eth_blockNumber', 'eth_getLogs', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
      'eth_getTransactionByHash', 'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'net_version', 'web3_clientVersion'];
    assert(allowed.includes(method), `read-only provider forbids ${method}`);
    return client.rpc(c.l1.rpc, method, params || []);
  });
  await safe.exposeFunction('treasuryUnsafeRequest', method => unsafeRequests.push(method));
  await safe.addInitScript(({ owner }) => {
    const listeners = new Map();
    const provider = {
      isMetaMask: true, isConnected: () => true, _metamask: { isUnlocked: async () => true },
      on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      removeListener(name, callback) { listeners.get(name)?.delete(callback); },
      async request({ method, params }) {
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [owner];
        if (method === 'eth_chainId') return '0x539';
        if (['wallet_getPermissions', 'wallet_requestPermissions'].includes(method)) return [{ parentCapability: 'eth_accounts' }];
        if (['wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(method)) return null;
        if (/^(eth_send|eth_sign|personal_sign|wallet_send)/.test(method)) {
          await window.treasuryUnsafeRequest(method);
          throw Object.assign(new Error('Read-only smoke: approval disabled'), { code: 4001 });
        }
        return window.treasuryReadRPC({ method, params });
      },
    };
    window.ethereum = provider;
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider,
      info: { uuid: 'f574de1b-5f42-4346-97dd-466424b4b291', name: 'Rehearsal test provider', rdns: 'local.treasury.test',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' },
    } }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }, { owner: labeled('Owner A') });
  await safe.goto(c.safeAppUrl, { waitUntil: 'domcontentloaded' });
  await safe.getByText('Safe account nonce', { exact: true }).waitFor();
  await safe.waitForTimeout(1000); // React hydration and wallet discovery.
  const cookies = safe.getByRole('button', { name: 'Save settings', exact: true });
  if (await cookies.isVisible()) await cookies.click();
  await safe.screenshot({ path: resolve(directory, 'safe-owners.png'), fullPage: true });
  console.log('Official Safe owner screen checked');
  const manage = safe.getByRole('button', { name: 'Manage signers', exact: true });
  if (!await manage.isEnabled()) {
    await safe.getByText('Connect Wallet', { exact: true }).click();
    await safe.getByText('Rehearsal test provider', { exact: true }).click();
  }
  await manage.click();
  await safe.getByRole('button', { name: 'Add new signer', exact: true }).click();
  await safe.locator('input[name="owners.2.name"]').fill('Owner C');
  await safe.locator('input[name="owners.2.address"]').fill(labeled('Owner C'));
  await safe.getByRole('button', { name: 'Next', exact: true }).click();
  await safe.getByText('Confirm transaction', { exact: true }).waitFor();
  await safe.waitForTimeout(1500);
  const text = await safe.locator('body').innerText();
  assert(!text.includes('Error connecting to the blockchain'));
  writeFileSync(resolve(directory, 'safe-review.txt'), text);
  await safe.screenshot({ path: resolve(directory, 'safe-review.png'), fullPage: true });
  record.checks.push('official Safe owner screen and add-C transaction review, no signature or send');
  assert.deepEqual(unsafeRequests, []);
  assert.deepEqual(errors, []);
  const after = await client.snapshot();
  assert.deepEqual(after.owners, snapshot.owners); assert.equal(after.nonce, snapshot.nonce);
  assert.equal(await client.read(c.l1.rpc, c.safeL1, safeAbi, 'nonce'), nonce);
  record.checks.push('L1/L2 Safe nonces and owners unchanged');
  record.passed = true;
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  record.passed = false; record.error = String(error.stack || error); throw error;
} finally {
  writeFileSync(resolve(directory, 'browser-readiness.json'), JSON.stringify(record, null, 2)+'\n');
  await browser.close();
}
