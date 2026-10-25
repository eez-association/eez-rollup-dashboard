// Read-only smoke against the normal dashboard. Public addresses are chosen by
// the injected provider; every signature/submission is blocked, with no keys.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { getAddress, keccak256, toHex, decodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem';
import { sharedDeploymentKey, sharedManifestKey, previousWalletFundingKey } from '../src/lib/treasury/deployment.ts';
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8080/dashboard').replace(/\/$/, '');
const directory = process.env.EEZ_UI_EVIDENCE || '.runtime/treasury-flexible-setup';
const accounts = ['0x000000000000000000000000000000000000a11c', '0x000000000000000000000000000000000000b0b1'].map(address => getAddress(address));
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
const errors = [], methods = [], chunks = [], walletCalls = [];
await page.exposeFunction('recordTreasuryReadonlyCall', method => walletCalls.push(method));
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/\/TreasuryDemo-[^/]+\.js$/.test(request.url())) chunks.push(request.url()); });
await context.route('**/*', async route => {
  if (route.request().method() === 'POST') {
    const body = route.request().postDataJSON();
    if (body?.method) {
      methods.push(body.method);
      if (/send|sign|anvil_|evm_|wallet_/i.test(body.method)) {
        errors.push(`Unexpected write RPC: ${body.method}`); await route.abort(); return;
      }
    }
  }
  // Read-only traffic still reaches the served dashboard and RPCs. Using the
  // request client avoids unrelated host interface changes cancelling Chromium
  // loopback requests; no transport retry is enabled.
  if (new URL(route.request().url()).origin === new URL(origin).origin)
    await route.fulfill({ response: await route.fetch({ maxRetries: 0, maxRedirects: 0 }) });
  else await route.fallback();
});
await page.addInitScript(accounts => {
  let owner = sessionStorage.getItem('readonly-wallet') || accounts[0];
  const listeners = new Map();
  window.treasuryReadonlySelect = next => { owner = next; sessionStorage.setItem('readonly-wallet', owner); for (const fn of listeners.get('accountsChanged') || []) fn([owner]); };
  window.ethereum = {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeListener(name, fn) { listeners.get(name)?.delete(fn); },
    async request({ method, params = [] }) {
      await window.recordTreasuryReadonlyCall(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x27d8';
      if (!/^eth_(call|get[A-Z]|blockNumber)/.test(method)) throw new Error(`Read-only provider blocked ${method}`);
      const r = await fetch('/composer/l1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json());
      if (r.error) throw new Error(r.error.message); return r.result;
    },
  };
}, accounts);
const journal = () => page.evaluate(key => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }, sharedDeploymentKey);
try {
  // Controlled read-only contract responses exercise the shared-reuse UI; the
  // separate Anvil scenario validates these bindings against actual contracts.
  const profile = JSON.parse(await readFile(new URL('../src/lib/treasury/shared-network.json', import.meta.url)));
  const runtime = await fetch(`${origin}/config.json`).then(response => response.json());
  let tokenBalance = 0n;
  const artifacts = JSON.parse(await readFile('src/lib/treasury/deployment-artifacts.json', 'utf8')).contracts;
  const existingSafe = getAddress(toHex(9901, { size: 20 })), existingSingleton = getAddress(toHex(9902, { size: 20 }));
  const shared = Object.fromEntries(['tokenL1', 'tokenL2', 'bridgeL1', 'bridgeL2'].map((key, i) => [key, getAddress(toHex(9001 + i, { size: 20 }))]));
  const rpcUrl = new URL(runtime.l1RpcUrl, origin);
  const headResult = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['safe', false] }) }).then(r => r.json());
  assert(headResult.result); const registrationBlock = headResult.result;
  const topic = keccak256(toHex('TreasuryInfrastructureRegistered(address,address,address)'));
  const log = { address: shared.tokenL1, topics: [topic, ...[shared.tokenL1, shared.bridgeL1, shared.bridgeL2].map(a => toHex(BigInt(a), { size: 32 }))], data: '0x',
    blockNumber: registrationBlock.number, blockHash: registrationBlock.hash, transactionHash: keccak256(toHex('read-only shared registration')), logIndex: '0x0' };
  const sharedRpc = async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); let result;
    const safeTarget = (body.method === 'eth_call' ? body.params[0].to : body.params[0])?.toLowerCase?.();
    if (['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(body.method) && [existingSafe.toLowerCase(), existingSingleton.toLowerCase()].includes(safeTarget)) {
      if (body.method === 'eth_getCode') result = artifacts[safeTarget === existingSafe.toLowerCase() ? 'SafeProxy' : 'Safe'].runtime;
      else if (body.method === 'eth_getStorageAt') result = body.params[1] === '0x0' ? toHex(BigInt(existingSingleton), { size: 32 }) : toHex(0n, { size: 32 });
      else {
        const { functionName } = decodeFunctionData({ abi: artifacts.Safe.abi, data: body.params[0].data });
        result = encodeFunctionResult({ abi: artifacts.Safe.abi, functionName, result: { VERSION: '1.4.1', getOwners: accounts, getThreshold: 2n, nonce: 0n, getModulesPaginated: [[], getAddress(toHex(1, { size: 20 }))] }[functionName] });
      }
    } else if (body.method === 'eth_getLogs' && body.params[0].topics?.[0] === topic) {
      const filter = body.params[0];
      result = filter.blockHash ? filter.blockHash === log.blockHash ? [log] : []
        : BigInt(filter.fromBlock) <= BigInt(log.blockNumber) && BigInt(filter.toBlock) >= BigInt(log.blockNumber) ? [log] : [];
    } else {
      const target = body.method === 'eth_getCode' ? body.params[0] : body.method === 'eth_call' ? body.params[0].to : '';
      const entry = Object.entries(shared).find(([, a]) => a.toLowerCase() === target?.toLowerCase());
      if (!entry) return route.fallback();
      const [key] = entry, contract = artifacts[key === 'tokenL1' ? 'SharedTestUSDC' : key === 'tokenL2' ? 'WrappedToken' : 'SharedTreasuryBridge'];
      if (body.method === 'eth_getCode') result = contract.runtime;
      else {
        const { functionName } = decodeFunctionData({ abi: contract.abi, data: body.params[0].data });
        const l1 = key.endsWith('L1');
        const value = { manager: l1 ? profile.registry : profile.manager, canonicalToken: shared.tokenL1, rollupId: l1 ? 0n : 1n, treasuryRollupId: 1n,
          admin: zeroAddress, canonicalBridgeAddress: l1 ? shared.bridgeL2 : shared.bridgeL1, bridgeL1: shared.bridgeL1, bridgeL2: shared.bridgeL2,
          getWrappedToken: shared.tokenL2, wrappedTokenInfo: [shared.tokenL1, 0n], BRIDGE: shared.bridgeL2, decimals: 6, balanceOf: tokenBalance, allowance: 0n, claimed: false }[functionName];
        assert.notEqual(value, undefined, functionName);
        result = encodeFunctionResult({ abi: contract.abi, functionName, result: value });
      }
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  };
  await context.route('**/*', sharedRpc);
  await page.goto(`${origin}/#/treasury-demo`);
  await page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
  const region = page.getByRole('region', { name: 'Shared treasury setup', exact: true });
  const setupHistory = page.getByRole('region', { name: 'Transaction history', exact: true });
  assert.equal(await region.count(), 0); assert.equal(chunks.length, 0, 'direct URLs must not load the hidden treasury');
  await page.keyboard.press('Control+Alt+Shift+KeyT'); await region.waitFor();
  await region.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  await region.getByRole('status').waitFor({ state: 'detached' });
  assert.equal(await journal(), null, 'opening setup must not choose a deployer');
  await region.getByText('Keeps its current owners and approval threshold.', { exact: true }).waitFor();
  assert(await region.getByRole('button', { name: 'Start setup', exact: true }).count() === 0);
  assert.equal(await region.getByRole('combobox', { name: 'Chiado Safe', exact: true }).count(), 0);
  assert.equal(await region.getByText(/300 Test USDC|150 shared|Deployment wallet|Reused Safe infrastructure/).count(), 0, 'Safe selection contains ownership choices, not funding or infrastructure panels');
  await region.getByRole('button', { name: 'Connect Browser Wallet', exact: true }).click();
  await region.getByRole('button', { name: 'Connect Browser Wallet', exact: true }).waitFor({ state: 'detached' });
  await region.getByLabel('Chiado Safe address', { exact: true }).fill(existingSafe);
  await region.getByRole('button', { name: 'Start setup', exact: true }).click();
  await region.getByRole('heading', { name: 'Deployment 0 / 5', exact: true }).waitFor();
  assert.equal((await journal()).deployer, accounts[0]);
  assert.ok(await region.getByRole('button', { name: 'Approve next deployment step', exact: true }).isDisabled(), 'unfunded selected wallet cannot submit');
  const salt = (await journal()).salt;
  await page.evaluate(next => window.treasuryReadonlySelect(next), accounts[1]);
  await region.getByText('Reconnect the recorded deployment wallet', { exact: false }).waitFor();
  assert.equal((await journal()).deployer, accounts[0]); assert.equal((await journal()).salt, salt);
  await page.reload(); await region.getByRole('heading', { name: 'Deployment 0 / 5', exact: true }).waitFor();
  assert.equal((await journal()).salt, salt);
  await page.getByRole('group', { name: 'Network balances', exact: true }).waitFor();
  await region.getByRole('button', { name: 'Change setup', exact: true }).click();
  await region.getByLabel('Chiado Safe address', { exact: true }).fill(accounts[0]);
  await region.getByLabel('EEZ-X Safe', { exact: true }).selectOption('existing');
  await region.getByLabel('Existing EEZ-X Safe address').fill(accounts[1]);
  await region.getByText("Its current owners must approve using the Chiado Safe’s owners.", { exact: false }).waitFor();
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/existing-safe-choices.png`, fullPage: true });
  await region.getByRole('button', { name: 'Start setup', exact: true }).click();
  await region.getByRole('alert').getByText('This address is not a supported Safe proxy', { exact: false }).waitFor();
  assert.equal(await journal(), null, 'a rejected import must not start deployment');
  await region.getByLabel('EEZ-X Safe', { exact: true }).selectOption('new');
  await region.getByLabel('Chiado Safe address', { exact: true }).fill(existingSafe);
  await region.getByRole('button', { name: 'Start setup', exact: true }).click();
  await region.getByRole('heading', { name: 'Deployment 0 / 5', exact: true }).waitFor();
  const saved = await journal(); assert.equal(saved.deployer, accounts[1]); assert.notEqual(saved.salt, salt);
  assert.equal(saved.pending, undefined); assert.deepEqual(saved.transactions, []);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), sharedManifestKey), null);
  assert.equal(await region.getByRole('alert').count(), 0);
  await page.screenshot({ path: `${directory}/deploy-safe-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/deploy-safe-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Synthetic old journal, in this isolated browser context only. No wallet or
  // shared-chain transaction is created; real receipt migration is tested on Anvil.
  const old = { ...saved, version: 2, bidirectional: undefined, reuse: {}, addresses: { singletonL1: getAddress(toHex(909, { size: 20 })) },
    completed: ['singletonL1'], transactions: [keccak256(toHex('confirmed setup fixture'))] };
  delete old.bidirectional; delete old.simplification; delete old.grouping; delete old.shared; delete old.asset; delete old.fundingSkipped;
  await page.evaluate(({ key, old }) => localStorage.setItem(key, JSON.stringify(old)), { key: sharedDeploymentKey, old });
  await page.reload(); await region.getByRole('heading', { name: 'Deployment 1 / 6', exact: true }).waitFor();
  const migrated = await journal();
  assert.equal(migrated.version, 8); assert.deepEqual(migrated.transactions, old.transactions);
  assert.equal(migrated.salt, old.salt); assert.equal(migrated.deployer, old.deployer);
  assert.equal(migrated.addresses.singletonL1, old.addresses.singletonL1);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `${previousWalletFundingKey}:${old.salt}`), old);
  await region.getByRole('heading', { name: 'Create your Chiado Safe', exact: true }).waitFor();
  const stepContext = region.getByLabel('About this step', { exact: true });
  assert.equal(await stepContext.getByText('300 Test USDC', { exact: true }).count(), 0, 'creation does not fund or mint tokens');
  assert.equal(await region.getByText('Reused Safe infrastructure', { exact: true }).count(), 0);
  assert.equal(await region.getByText('Deployment wallet', { exact: true }).count(), 0);
  assert.equal(await region.getByText('100 Test USDC', { exact: true }).count(), 0, 'spending limits belong to the spending setup step');
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `${directory}/shared-setup-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/shared-setup-mobile.png`, fullPage: true });
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(widths[0] <= widths[1], `Mobile page overflows: ${widths}`);
  assert.ok(walletCalls.includes('eth_requestAccounts') && walletCalls.includes('eth_chainId'));
  assert.ok(walletCalls.every(m => !/send|sign/i.test(m))); assert.deepEqual(errors, []);
  // Later-stage presentation only: synthetic confirmed prefixes in this test
  // browser. The read-only provider still rejects every send/sign request.
  const phaseIds = ['singletonL1', 'contractsBatchL1', 'contractsBatchL2', 'fundingBatchL1', 'budgetBatchL2', 'configureL1'];
  for (const [index, title, amounts] of [
    [3, 'Connect Safe owner verification', []],
    [4, 'Set the shared budget', ['150 Test USDC', '100 Test USDC']],
    [5, 'Approve Chiado spending', ['100 Test USDC']],
  ]) {
    const staged = { ...migrated, completed: phaseIds.slice(0, index),
      transactions: phaseIds.slice(0, index).map((id, i) => migrated.transactions[i] ?? keccak256(toHex(`presentation ${id}`))) };
    await page.evaluate(({ key, staged }) => localStorage.setItem(key, JSON.stringify(staged)), { key: sharedDeploymentKey, staged });
    await page.reload();
    await region.getByRole('heading', { name: title, exact: true }).waitFor();
    const context = region.getByLabel('About this step', { exact: true });
    for (const amount of amounts) await context.getByText(amount, { exact: true }).waitFor();
    if (index >= 4) await context.getByText('Limits reset every ten minutes and apply to payments through this treasury policy.', { exact: true }).waitFor();
    assert.equal(await region.getByText(/450 Test USDC from your wallet|Your wallet needs|Skip funding|Open test token faucet/).count(), 0);
    assert.equal(await region.getByText('Deployment wallet', { exact: true }).count(), 0);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: `${directory}/step-${phaseIds[index]}-mobile.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  const pending = { ...old, pending: { id: 'factoryL1', chain: 'l1', sender: old.deployer, nonce: '0x1', data: '0x6000' } };
  await page.evaluate(({ key, pending }) => localStorage.setItem(key, JSON.stringify(pending)), { key: sharedDeploymentKey, pending });
  await page.reload(); await region.getByRole('heading', { name: 'Deployment 1 / 31', exact: true }).waitFor();
  await region.getByText('Waiting for the wallet transaction…', { exact: true }).waitFor();
  assert.equal(await region.getByText('Recover transaction', { exact: true }).count(), 0);
  assert.equal(await region.getByLabel('Transaction hash from wallet activity', { exact: true }).count(), 0);
  assert.equal(await region.getByRole('button', { name: 'Verify wallet transaction', exact: true }).count(), 0);
  assert.deepEqual(await journal(), pending, 'unresolved old request must keep its original plan and calldata');
  assert.equal(await region.getByRole('button', { name: 'Approve next deployment step', exact: true }).count(), 0);
  const management = page.getByRole('region', { name: 'Treasury setup management', exact: true });
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).waitFor();
  assert(await management.getByRole('button', { name: 'Start new treasury', exact: true }).isDisabled());
  assert.equal(await management.getByText('Resolve the pending setup transaction before starting a new treasury.', { exact: true }).count(), 0);
  assert.equal(await management.getByText('Choose new or existing Safes with your connected wallet. Existing funds stay in their Safes.', { exact: true }).count(), 0);
  assert.deepEqual(await journal(), pending);
  const knownPending = { ...pending, pending: { ...pending.pending, hash: keccak256(toHex('unconfirmed wallet transaction')) } };
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: sharedDeploymentKey, saved: knownPending });
  await page.reload();
  await region.getByRole('status').filter({ hasText: 'Checking transaction…' }).waitFor();
  assert.equal(await region.getByText('Tracking confirmation automatically.', { exact: false }).count(), 0);
  assert.equal(await region.getByLabel('Transaction hash from wallet activity', { exact: true }).count(), 0);
  assert.equal(await setupHistory.locator(`a[href$="/tx/${knownPending.pending.hash}"]`).evaluate(link => link.href),
    new URL(`${runtime.l1ExplorerUrl.replace(/\/$/, '')}/tx/${knownPending.pending.hash}`, origin).href);
  assert.deepEqual(await journal(), knownPending);
  await page.screenshot({ path: `${directory}/automatic-tracking-mobile.png`, fullPage: true });
  const l2Pending = { ...old,
    addresses: { ...old.addresses, factoryL1: getAddress(toHex(910, { size: 20 })), safeL1: getAddress(toHex(911, { size: 20 })) },
    completed: ['singletonL1', 'factoryL1', 'safeL1'],
    transactions: [...old.transactions, keccak256(toHex('fixture factory')), keccak256(toHex('fixture Safe'))],
    pending: { ...knownPending.pending, id: 'singletonL2', chain: 'l2', hash: keccak256(toHex('unconfirmed L2 transaction')) } };
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: sharedDeploymentKey, saved: l2Pending });
  await page.reload();
  const l2ExplorerLink = setupHistory.locator(`a[href$="/tx/${l2Pending.pending.hash}"]`);
  await l2ExplorerLink.waitFor();
  assert.equal(await l2ExplorerLink.evaluate(link => link.href),
    new URL(`${runtime.l2ExplorerUrl.replace(/\/$/, '')}/tx/${l2Pending.pending.hash}`, origin).href);
  assert.equal(await l2ExplorerLink.getAttribute('target'), '_blank');
  assert.deepEqual(await journal(), l2Pending);
  assert.deepEqual(await setupHistory.locator('li').evaluateAll(rows => rows.map(row => row.dataset.txHash)), [...l2Pending.transactions, l2Pending.pending.hash]);
  // History fixtures affect only this isolated read-only browser, never the saved
  // user's journal. Inclusion, finality and uncertainty are distinct outcomes.
  const historyBlocks = l2Pending.transactions.map((_, i) => ({ number: toHex(1280 + i), hash: keccak256(toHex(`history block ${i}`)), timestamp: registrationBlock.timestamp }));
  let historyOffline = false;
  const historyRpc = async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); let result;
    const i = body.method === 'eth_getTransactionReceipt' ? l2Pending.transactions.indexOf(body.params[0]) : -1;
    if (i >= 0) {
      if (historyOffline && i === 0) return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'History RPC unavailable' } } });
      result = { status: i === 1 ? '0x0' : '0x1', blockNumber: historyBlocks[i].number, blockHash: historyBlocks[i].hash };
    } else if (body.method === 'eth_getBlockByNumber') {
      if (body.params[0] === 'finalized') result = historyBlocks[0];
      else result = historyBlocks.find(block => block.number === body.params[0]);
      if (!result) return route.fallback();
    } else return route.fallback();
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  };
  await page.route('**/*', historyRpc);
  await setupHistory.locator('li[data-status="finalized"]').waitFor();
  await setupHistory.locator('li[data-status="included"]').waitFor();
  await setupHistory.locator('li[data-status="failed"]').waitFor();
  await setupHistory.locator('li[data-status="pending"]').waitFor();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: `${directory}/transaction-history-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/transaction-history-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  historyOffline = true;
  await setupHistory.locator('li[data-status="unavailable"]').waitFor();
  assert.deepEqual(await journal(), l2Pending, 'history never updates or discards setup progress');
  await page.unroute('**/*', historyRpc);
  // Controlled read-only RPC fixture: the wallet lost its response, but the
  // saved sender/nonce is discoverable in a current canonical block. No shared state changes.
  const discoveredHash = keccak256(toHex('automatically discovered transaction'));
  const trackingRpc = async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    let result;
    if (body?.method === 'eth_getBlockByNumber' && ['latest', '0x400'].includes(body.params[0])) result = { ...registrationBlock, number: '0x400', hash: keccak256(toHex('tracking head')) };
    else if (body?.method === 'eth_getTransactionCount' && body.params[0].toLowerCase() === pending.pending.sender.toLowerCase() && /^0x/.test(body.params[1]))
      result = BigInt(body.params[1]) >= 1022n ? '0x2' : '0x1';
    else if (body?.method === 'eth_getBlockByNumber' && body.params[1] === true && body.params[0] === '0x3fe')
      result = { number: '0x3fe', hash: keccak256(toHex('tracking transaction block')), transactions: [{ hash: discoveredHash, from: pending.pending.sender,
        nonce: pending.pending.nonce, input: pending.pending.data, to: null, value: '0x0' }] };
    else if (body?.method === 'eth_getTransactionReceipt' && body.params[0] === discoveredHash) result = null;
    else return route.fallback();
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  };
  await page.route('**/*', trackingRpc);
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: sharedDeploymentKey, saved: pending });
  await page.reload();
  await page.waitForFunction(({ key, hash }) => JSON.parse(localStorage.getItem(key))?.pending?.hash === hash, { key: sharedDeploymentKey, hash: discoveredHash });
  assert.deepEqual(await journal(), { ...pending, pending: { ...pending.pending, hash: discoveredHash } });
  await setupHistory.locator(`a[href$="/tx/${discoveredHash}"]`).waitFor();
  assert.equal(await region.getByLabel('Transaction hash from wallet activity', { exact: true }).count(), 0);
  await page.unroute('**/*', trackingRpc);
  await page.reload();
  await region.getByRole('status').filter({ hasText: 'Checking transaction…' }).waitFor();
  assert.equal(await region.getByText('Tracking confirmation automatically.', { exact: false }).count(), 0);
  assert.equal((await journal()).pending.hash, discoveredHash, 'discovered hash survives reload');
  await page.evaluate(({ key, old }) => localStorage.setItem(key, JSON.stringify(old)), { key: sharedDeploymentKey, old });
  await page.reload(); await region.getByRole('heading', { name: 'Deployment 1 / 6', exact: true }).waitFor();
  await page.getByRole('group', { name: 'Network balances', exact: true }).waitFor();
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).waitFor();
  const beforeRestart = await journal();
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.restoreTreasuryStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(k, v) { if (k === key) throw new DOMException('Setup storage unavailable', 'QuotaExceededError'); return original.call(this, k, v); };
  }, sharedDeploymentKey);
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).click();
  await management.getByRole('alert').filter({ hasText: 'Setup storage unavailable' }).waitFor();
  assert.deepEqual(await journal(), beforeRestart);
  await page.evaluate(() => window.restoreTreasuryStorage());
  const secondTab = await context.newPage();
  await secondTab.goto(`${origin}/#/treasury-demo`);
  await secondTab.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
  await secondTab.keyboard.press('Control+Alt+Shift+KeyT');
  const otherSetup = secondTab.getByRole('region', { name: 'Shared treasury setup', exact: true });
  await otherSetup.getByRole('heading', { name: 'Deployment 1 / 6', exact: true }).waitFor();
  await secondTab.evaluate(key => { void navigator.locks.request(key, () => new Promise(resolve => { window.releaseTreasuryLock = resolve; })); }, sharedDeploymentKey);
  await secondTab.waitForFunction(() => typeof window.releaseTreasuryLock === 'function');
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).click();
  await management.getByRole('alert').filter({ hasText: 'Another treasury action is running' }).waitFor();
  assert.deepEqual(await journal(), beforeRestart);
  await secondTab.evaluate(() => window.releaseTreasuryLock());
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).click();
  await region.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await journal(), null, 'restart returns to the chooser before creating a new plan');
  assert.equal(await region.getByRole('button', { name: 'Connect Browser Wallet', exact: true }).count(), 0, 'the wallet stays connected');
  assert.equal(await page.getByText(/Archived treasuries|Download archive/).count(), 0);
  assert.equal(await management.count(), 0, 'the restart action disappears in the chooser');
  await otherSetup.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await secondTab.evaluate(key => localStorage.getItem(key), sharedDeploymentKey), '');
  await secondTab.close();
  await region.getByLabel('EEZ-X Safe', { exact: true }).selectOption('existing');
  assert.equal(await region.getByLabel('Chiado Safe address', { exact: true }).count(), 1);
  assert.equal(await region.getByLabel('Existing EEZ-X Safe address').count(), 1);
  await page.reload(); await region.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await journal(), null);
  await page.getByRole('group', { name: 'Network balances', exact: true }).waitFor();
  const setupHeading = region.getByRole('heading', { name: 'Set up your shared treasury', exact: true });
  assert(await setupHeading.evaluate(node => document.activeElement === node), 'focus moves to the setup heading');
  await page.keyboard.press('Tab');
  const focusStyle = await page.evaluate(() => {
    const node = document.activeElement, style = getComputedStyle(node);
    return { tag: node.tagName, width: style.outlineWidth, color: style.outlineColor, visible: node.matches(':focus-visible') };
  });
  assert.equal(focusStyle.visible, true); assert.equal(focusStyle.width, '2px'); assert.equal(focusStyle.color, 'rgb(59, 229, 126)');
  const badgeStyle = await region.getByText('Shared testnet', { exact: true }).evaluate(node => ({ font: getComputedStyle(node).fontSize, color: getComputedStyle(node).color }));
  assert.equal(badgeStyle.font, '12px'); assert.equal(badgeStyle.color, 'rgb(154, 163, 179)');
  const chainColors = await Promise.all(['l1', 'l2'].map(chain => region.locator(`label[data-chain="${chain}"]`).evaluate(node => getComputedStyle(node).color)));
  assert.deepEqual(chainColors, ['rgb(155, 166, 214)', 'rgb(181, 163, 238)']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await region.getByRole('button', { name: 'Start setup', exact: true }).evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `${directory}/chooser-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${directory}/chooser-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('group', { name: 'Network balances', exact: true }).waitFor();
  await region.getByLabel('Chiado Safe address', { exact: true }).fill(existingSafe);
  await region.getByRole('button', { name: 'Start setup', exact: true }).click();
  await region.getByRole('heading', { name: 'Deployment 0 / 5', exact: true }).waitFor();
  const restarted = await journal();
  assert.equal(restarted.deployer, beforeRestart.deployer); assert.notEqual(restarted.salt, beforeRestart.salt);
  assert.deepEqual(restarted.completed, []); assert.deepEqual(restarted.transactions, []); assert.equal(restarted.reuse.l1.address, existingSafe); assert.equal(restarted.reuse.l1.threshold, 2);
  assert.equal(restarted.pending, undefined); assert.equal(restarted.review, undefined); assert.equal(restarted.addresses.safeL1, existingSafe);
  assert.ok(walletCalls.every(m => !/send|sign/i.test(m))); assert.deepEqual(errors, []);
  // Synthetic completed manifest exercises selection/restart, not a claim of
  // deployed contracts. Its fake application addresses cannot pass live signing.
  const completed = { ...beforeRestart, addresses: { ...beforeRestart.addresses, safeL1: getAddress(toHex(901, { size: 20 })), safeL2: getAddress(toHex(902, { size: 20 })) },
    completed: [...phaseIds] };
  completed.transactions = [beforeRestart.transactions[0], ...completed.completed.slice(1).map(id => keccak256(toHex(id)))];
  const manifest = { version: 1, environment: 'dashboard-testnet', instance: keccak256(toHex(`${completed.salt}:${completed.addresses.safeL1}:${completed.addresses.safeL2}`)),
    l1: { chainId: 10200, rpc: new URL(runtime.l1RpcUrl, origin).href, checkpoint: profile.chains.l1.checkpoint },
    l2: { chainId: 906969, rpc: new URL(runtime.l2RpcUrl, origin).href, front: new URL(runtime.l2FrontUrl, origin).href, checkpoint: profile.chains.l2.checkpoint },
    fees: { maxTotalWei: runtime.l2FeeMaxTotalWei }, registry: profile.registry, manager: profile.manager,
    safeL1: completed.addresses.safeL1, safeL2: completed.addresses.safeL2, adapter: getAddress(toHex(903, { size: 20 })), action: getAddress(toHex(904, { size: 20 })), ownerLabels: {},
    protocol: ['l1', 'l2'].map(chain => ({ chain, proxy: profile.chains[chain].protocol.proxy, implementation: profile.chains[chain].protocol.implementation })) };
  manifest.code = [901, 902, 903, 904].map(id => ({ chain: id === 901 ? 'l1' : 'l2', address: getAddress(toHex(id, { size: 20 })), hash: keccak256(toHex(id)) }));
  for (const chain of ['l1', 'l2']) {
    const p = profile.chains[chain].protocol;
    manifest.code.push({ chain, address: p.proxy, hash: p.proxyCodeHash }, { chain, address: p.implementation, hash: p.implementationCodeHash });
  }
  const historyKey = `eez:treasury:history:${manifest.instance}`;
  const history = JSON.stringify({ version: 1, instance: manifest.instance, entries: [] });
  await page.evaluate(({ key, completed, manifestKey, manifest, historyKey, history }) => {
    localStorage.setItem(key, JSON.stringify(completed)); localStorage.setItem(manifestKey, JSON.stringify(manifest)); localStorage.setItem(historyKey, history);
  }, { key: sharedDeploymentKey, completed, manifestKey: sharedManifestKey, manifest, historyKey, history });
  await page.reload();
  const live = page.getByRole('region', { name: 'Connected treasury demo', exact: true }); await live.waitFor();
  await page.getByRole('group', { name: 'Network balances', exact: true }).waitFor();
  for (const prefix of ['submission', 'owners']) {
    const key = `eez:treasury:${prefix}:${manifest.instance}`;
    await page.evaluate(key => localStorage.setItem(key, '{}'), key);
    await management.getByRole('status').filter({ hasText: prefix === 'submission' ? 'Finish the current payment' : 'Finish the owner change' }).waitFor();
    assert(await management.getByRole('button', { name: 'Start new treasury', exact: true }).isDisabled());
    await page.evaluate(key => localStorage.removeItem(key), key);
  }
  await management.getByRole('status').waitFor({ state: 'detached' });
  await management.getByRole('button', { name: 'Start new treasury', exact: true }).click();
  await region.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await journal(), null);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), sharedManifestKey), manifest);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), historyKey), history);
  assert.equal(await page.getByText(/Archived treasuries|Download archive/).count(), 0);
  await page.reload(); await region.getByRole('heading', { name: 'Choose your Safes', exact: true }).waitFor();
  assert.equal(await live.count(), 0, 'the previous manifest cannot reopen after reload');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), historyKey), history);
  assert.ok(walletCalls.every(m => !/send|sign/i.test(m))); assert.deepEqual(errors, []);
  await region.getByLabel('Chiado Safe address', { exact: true }).fill(existingSafe);
  await region.getByRole('button', { name: 'Start setup', exact: true }).click();
  await region.getByRole('heading', { name: 'Deployment 0 / 5', exact: true }).waitFor();
  const reusedShared = await journal();
  assert.deepEqual(Object.fromEntries(Object.keys(shared).map(k => [k, reusedShared.addresses[k]])), shared);
  assert(reusedShared.asset.binding, 'shared infrastructure persists across reload');
  const sharedPrepared = reusedShared;
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: sharedDeploymentKey, saved: sharedPrepared });
  await page.reload(); await region.getByRole('heading', { name: 'Prepare your Chiado Safe', exact: true }).waitFor();
  const sharedDetails = region.getByRole('region', { name: 'Prepare cross-chain payments', exact: true });
  await sharedDetails.getByText('Deploy alias lookup', { exact: true }).waitFor();
  await sharedDetails.getByText('Deploy official allowance module', { exact: true }).waitFor();
  assert.equal(await sharedDetails.getByText(/Receive 450|Create shared Test USDC|claim/i).count(), 0);
  assert.equal(await sharedDetails.getByText(/Create shared Test USDC|Create the shared Chiado bridge|Deploy Chiado bridge/).count(), 0);
  await region.getByText('Reconnect the recorded deployment wallet', { exact: false }).waitFor({ state: 'detached' });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `${directory}/shared-infrastructure-reused-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(walletCalls.every(m => !/send|sign/i.test(m))); assert.deepEqual(errors, []);
  // Resume a version-6 setup at its old approval step. The migration happens
  // automatically without a skip control, a wallet prompt or token reads.
  const fundingState = { ...structuredClone(sharedPrepared.fundingSkipped.source), completed: phaseIds.slice(1, 3),
    transactions: phaseIds.slice(1, 3).map(id => keccak256(toHex(`funding display ${id}`))) };
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: sharedDeploymentKey, saved: fundingState });
  await page.reload(); await region.getByRole('heading', { name: 'Connect Safe owner verification', exact: true }).waitFor();
  const noFunding = await journal();
  assert.equal(noFunding.version, 8);
  for (const field of ['completed', 'transactions', 'addresses', 'salt', 'deployer']) assert.deepEqual(noFunding[field], fundingState[field]);
  assert.equal(await region.getByText(/450 Test USDC from your wallet|Your wallet needs|Skip funding|Open test token faucet/).count(), 0);
  await page.reload(); await region.getByRole('heading', { name: 'Connect Safe owner verification', exact: true }).waitFor();
  assert.deepEqual(await journal(), noFunding);
  assert.ok(walletCalls.every(m => !/send|sign/i.test(m)), 'removing funding needs no wallet signature or transaction');
  await page.screenshot({ path: `${directory}/no-funding-mobile.png`, fullPage: true });
  await context.unroute('**/*', sharedRpc);
  const result = { checkedAt: new Date().toISOString(), accounts, url: origin, chains: [10200, 906969], steps: 5, existingL1SafeRequired: true, ownersPreserved: true, noFundingInSetup: true, noImplicitMintOrClaim: true, removingFundingPreservesSetup: true,
    sharedInfrastructureReused: true, sharedReuseUsesMockedReadonlyRpc: true, hiddenUntilShortcut: true, realNetworkChecks: true, wallet: 'read-only injected provider; no extension or private key',
    selectedWallet: true, immutableSelectionAfterReview: true, choicesOnBothChains: true, invalidImportRejected: true,
    zeroGasStopsSubmission: true, noSubmission: true, reload: true, sameWalletRestart: true, restartOpensSafeChooser: true, noArchiveControls: true, selectionStorageFailurePreservedSetup: true, pendingRestartBlocked: true, crossTabLock: true, otherTabFollowedRestart: true, completedTreasuryRestart: true, paymentAndOwnerRestartBlocked: true, previousManifestIgnoredAfterReload: true, keyboardFocus: focusStyle, badgeStyle, chainColors, reducedMotion: true, contextualSetupDetails: true, connectionAndBudgetSteps: true, confirmedJournalPreserved: true, pendingJournalUnchanged: true, automaticPendingStatus: true, chainExplorerLinks: true, orderedSetupHistory: true, historyInclusionFinalityAndFailure: true, historyDowngradesUnavailableRPC: true, manualRecoveryRemoved: true, discoveredHashPersisted: true, discoveryUsesMockedReadonlyRpc: true, mobileWidth: widths,
    methods: [...new Set(methods)], walletMethods: [...new Set(walletCalls)] };
  await writeFile(`${directory}/shared-browser.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ url: page.url(), alerts: await page.getByRole('alert').allTextContents(), status: await page.getByRole('status').allTextContents() }));
  throw failure;
} finally { try { await context.unrouteAll({ behavior: 'wait' }); } finally { await browser.close(); } }
