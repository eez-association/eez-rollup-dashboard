import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { getAddress, keccak256, toHex, encodeEventTopics, encodeAbiParameters } from 'viem';
import { TreasuryClient, safeAbi } from '../src/lib/treasury/client.ts';
import { ownerAddition } from '../src/lib/treasury/owners.ts';
import { safeTransactionHash, encodeSafeExecution } from '../src/lib/treasury/safeTransactions.ts';

const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-owners-browser';
await mkdir(`${directory}/tmp`, { recursive: true }); process.env.TMPDIR = resolve(directory, 'tmp');
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const owners = [address(101), address(102)], candidate = address(103), fourth = address(104);
const fixture = { owners, blockHash: hash('block'), orphanHash: hash('orphan'), config: {
  version: 1, environment: 'dashboard-testnet', instance: hash('shared-owners-ui'), safeL1: address(1), safeL2: address(2),
  registry: address(3), manager: address(4), adapter: address(5), action: address(6), code: [], ownerLabels: { [owners[0].toLowerCase()]: 'Deployment wallet', [address(999).toLowerCase()]: 'Deployment wallet' },
  l1: { chainId: 10200, rpc: 'l1', front: 'l1-front' }, l2: { chainId: 906969, rpc: 'l2', front: 'l2-front' },
  payments: { policy: address(11), alias: address(12), tokenL1: address(13), tokenL2: address(14), moduleL1: address(15), moduleL2: address(16),
    bridgeL1: address(17), bridgeL2: address(18), recipient: address(19), decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Test USDC', exactSplits: true, combinedL2: true, l1Initiation: true },
} };
const review = ownerAddition(new TreasuryClient(fixture.config), candidate, 2, { owners, threshold: 1, nonce: 4n, block: '0x105', fingerprint: 'owners' });
fixture.pending = { version: 1, instance: fixture.config.instance, candidate, threshold: 2, nonce: '4', safeHash: safeTransactionHash(review.transaction),
  sender: owners[0], sourceNonce: '0x1', startBlock: '0x105', data: encodeSafeExecution(review.transaction, '0x'), hash: hash('included') };
fixture.receipt = { status: '0x1', blockNumber: '0x106', blockHash: fixture.blockHash, logs: [{ address: fixture.config.safeL1,
  topics: [encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess' })[0], fixture.pending.safeHash], data: encodeAbiParameters([{ type: 'uint256' }], [0n]) }] };
const server = await createServer({ configFile: false, envFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, base: '/' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { errors.push(`Unexpected network request: ${url.pathname}`); return route.abort(); }
  if (url.pathname === '/owners-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  return route.fallback();
});
const load = async restore => {
  await page.goto(`${origin}/owners-fixture`);
  await page.evaluate(async f => { localStorage.clear(); const m = await import('/tests/fixtures/treasury-owners-browser.tsx'); m.mount(f); }, { ...fixture, restore });
};
const card = page.getByRole('region', { name: 'Shared owners', exact: true });
const waitText = (id, text) => page.waitForFunction(({ id, text }) => document.querySelector(`[data-testid="${id}"]`)?.textContent === text, { id, text });
const state = values => page.evaluate(values => { Object.assign(window.ownersTest, values); }, values);
const listed = async addresses => {
  assert.deepEqual(await card.locator('[data-owner]').evaluateAll(rows => rows.map(row => row.dataset.owner)), addresses.map(a => a.toLowerCase()));
};
try {
  await load(false);
  await waitText('shared-threshold', '1 of 2 owners'); await listed(owners);
  assert.equal(await card.getByText('Deployment wallet', { exact: true }).count(), 0, 'historical setup labels must not replace the current owner role');
  await card.locator(`[data-owner="${owners[0].toLowerCase()}"]`).getByText('Connected wallet', { exact: true }).waitFor();
  assert.equal(await card.locator(`[data-owner="${owners[1].toLowerCase()}"]`).getByText('Connected wallet', { exact: true }).count(), 0);
  passed.push('saved deployment labels do not imply extra authority or add a non-owner; only the active wallet is marked connected');
  await card.getByText('both Safes stay in sync automatically.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  await page.getByRole('button', { name: 'Sign approval', exact: true }).click();
  await waitText('quorum', '1 of 1 approvals');
  await waitText('shared-threshold', '1 of 2 owners');
  passed.push('shared threshold is separate from collected payment approvals');

  await state({ owners: [...owners, candidate], threshold: 2 });
  await waitText('shared-threshold', '2 of 3 owners'); await listed([...owners, candidate]);
  await waitText('quorum', '0 of 2 approvals');
  await page.getByText('Owners or Safe nonce changed. Review the action again; previous approvals were cleared.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Edit payment', exact: true }).count(), 0);
  passed.push('external owner/threshold changes update automatically and clear stale approvals');
  await page.screenshot({ path: `${directory}/shared-owners-desktop.png`, fullPage: true });

  await state({ unavailable: true });
  await card.getByRole('status').filter({ hasText: 'Showing the last verified list' }).waitFor();
  await listed([...owners, candidate]);
  assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).isDisabled(), true);
  await state({ unavailable: false });
  await card.getByRole('status').waitFor({ state: 'detached' });
  passed.push('failed owner reads retain a visibly stale list and recover without user intervention');

  await state({ owners: [...owners, candidate, fourth], threshold: 3, balanceFailure: true });
  await waitText('shared-threshold', '3 of 4 owners'); await listed([...owners, candidate, fourth]);
  await page.getByRole('alert').filter({ hasText: 'Controlled balance read failure' }).waitFor();
  assert.equal(await card.getByRole('status').count(), 0);
  await state({ balanceFailure: false });
  await page.getByRole('alert').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/shared-owners-mobile.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(await page.evaluate(() => window.ownersTest.walletCalls), []);
  passed.push('owner updates do not wait for balance reads; mobile layout fits');

  await page.setViewportSize({ width: 1440, height: 1050 });
  await load(true);
  await waitText('shared-threshold', '1 of 2 owners');
  await page.getByRole('heading', { name: 'Owner change in progress', exact: true }).waitFor();
  await listed(owners);
  const key = `eez:treasury:owners:${fixture.config.instance}`;
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), JSON.stringify(fixture.pending));
  await state({ holdNext: true });
  await page.waitForFunction(() => !!window.ownersTest.release);
  await state({ owners: [...owners, candidate], threshold: 2, receipt: 'included' });
  await page.getByRole('heading', { name: 'Owner change included', exact: true }).waitFor();
  await waitText('shared-threshold', '2 of 3 owners'); await listed([...owners, candidate]);
  await page.evaluate(() => window.ownersTest.release());
  // Let the abandoned snapshot complete and prove it cannot restore the old list.
  await page.waitForTimeout(100);
  await waitText('shared-threshold', '2 of 3 owners'); await listed([...owners, candidate]);
  passed.push('verified inclusion refreshes immediately despite an older in-flight poll; pending candidates are not shown early');

  await state({ owners, threshold: 1, receipt: 'orphan' });
  await page.getByRole('heading', { name: 'Owner change in progress', exact: true }).waitFor();
  await waitText('shared-threshold', '1 of 2 owners'); await listed(owners);
  assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).count(), 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), JSON.stringify(fixture.pending));
  passed.push('reorganized owner changes refresh the list and retain the unresolved request');
  assert.deepEqual(await page.evaluate(() => window.ownersTest.walletCalls), []);
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/browser-result.json`, JSON.stringify({ passed, mode: 'controlled RPCs and approval result; real snapshot, receipt verification and UI lifecycle; no chain or wallet writes' }, null, 2) + '\n');
  console.log(passed.join('\n'));
} finally { await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await server.close(); }
