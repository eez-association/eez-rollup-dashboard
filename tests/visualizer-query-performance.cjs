// Same fixed 50-batch workload for baseline/candidate. RPCs are mocked; no broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeAbiParameters, keccak256, toHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const baseline = process.env.EEZ_UI_PROFILE_BASELINE === '1';
const delay = Number(process.env.EEZ_UI_PROFILE_DELAY_MS ?? 0);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const registry = '0x' + '11'.repeat(20), manager = '0x' + '22'.repeat(20), account = '0x' + '33'.repeat(20);
const hex = n => '0x' + BigInt(n).toString(16);
const logs = Array.from({ length: 50 }, (_, i) => ({ address: registry,
  topics: [keccak256(toHex('BatchPosted(bytes32,uint64[])'))],
  data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64[]' }], [word(i), [4n]]),
  blockHash: word(1001 + i), blockNumber: hex(1001 + i), transactionHash: word(2001 + i), logIndex: '0x0' }));
const tx = (side, i) => ({ hash: word((side === 'l1' ? 2000 : 4000) + i), from: account,
  to: side === 'l1' ? registry : manager, input: '0x', value: '0x0', blockNumber: hex(1000 + i),
  blockHash: word((side === 'l1' ? 1000 : 3000) + i), transactionIndex: '0x0' });
const settlement = i => ({ l1BlockNumber: hex(1000 + i), l1BlockHash: word(1000 + i), l1TransactionHash: word(2000 + i),
  canonicalL2: true, l2Finalized: true, l2Blocks: [{ number: hex(1000 + i), hash: word(3000 + i) }] });

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), requests = [], errors = [];
  const controls = { holdBlocks: null, held: 0 };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/config.json')) return route.fulfill({ json: { l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2', l1ContractAddress: registry, l2ContractAddress: manager } });
    if (req.method() !== 'POST') return route.continue();
    const { method, params, id } = req.postDataJSON(), side = path.endsWith('l1') ? 'l1' : 'l2';
    assert(!/send|sign/i.test(method));
    requests.push({ side, method, params });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let result = null;
    if (method === 'eth_chainId') result = side === 'l1' ? '0x27d8' : '0x1892';
    if (method === 'eth_getCode') result = '0x';
    if (method === 'eth_blockNumber') result = hex(1050);
    if (method === 'eth_getLogs') result = logs.filter(log => BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(log.blockNumber) <= BigInt(params[0].toBlock));
    if (method === 'eez_getSettledL2RangesByL1Block') result = [settlement(Number(BigInt(params[0]) - 1000n))];
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') {
      if (method === 'eth_getBlockByHash' && controls.holdBlocks) { controls.held++; await controls.holdBlocks; }
      const i = method === 'eth_getBlockByHash' ? Number(BigInt(params[0]) - (side === 'l1' ? 1000n : 3000n)) : 50;
      result = { hash: tx(side, i).blockHash, number: hex(1000 + i), parentHash: word(0), timestamp: '0x65000000',
        gasUsed: '0x5208', gasLimit: '0xffffff', transactions: params[1] ? [tx(side, i)] : [tx(side, i).hash] };
    }
    if (method === 'eth_getTransactionReceipt') {
      const i = Number(BigInt(params[0]) - (side === 'l1' ? 2000n : 4000n));
      result = { status: i === 25 ? '0x0' : '0x1', gasUsed: '0x5208', blockHash: tx(side, i).blockHash,
        blockNumber: hex(1000 + i), logs: [] };
    }
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  return { page, requests, controls, errors, close: () => context.close() };
}
const coverage = page => page.getByRole('status').filter({ hasText: /Showing \d+ \/ 50 batches/ });
const waitCoverage = (page, count) => page.waitForFunction(count => [...document.querySelectorAll('[role="status"]')]
  .some(n => n.textContent.includes(`execution details loaded for ${count} / 50.`)), count);
const receiptTransactions = requests => new Set(requests.filter(r => r.method === 'eth_getTransactionReceipt').map(r => `${r.side}:${r.params[0]}`)).size;

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await fixture(browser), started = Date.now();
    await f.page.goto(origin + '/#/visualizer');
    await coverage(f.page).waitFor();
    const historyMs = Date.now() - started;
    await f.page.getByRole('button', { name: 'Copy inspection link', exact: true }).waitFor();
    const selectedMs = Date.now() - started;
    await waitCoverage(f.page, baseline ? 50 : 1);
    // Compare a fixed observation window, including the same live refreshes.
    const sampleMs = Number(process.env.EEZ_UI_PROFILE_SECONDS ?? 2) * 1000;
    await f.page.waitForTimeout(Math.max(200, sampleMs - (Date.now() - started)));
    const metrics = { baseline, delayMs: delay, historyMs, selectedMs, observedMs: Date.now() - started, requests: f.requests.length,
      receipts: f.requests.filter(r => r.method === 'eth_getTransactionReceipt').length,
      settlementLookups: f.requests.filter(r => r.method.startsWith('eez_get')).length };
    console.log(JSON.stringify(metrics));
    if (baseline) { await f.close(); return; }
    assert.equal(receiptTransactions(f.requests), 2, 'only the selected posting and sync transaction should be hydrated');
    assert.equal(metrics.settlementLookups, 1, 'inspection reuses the bound history observation');
    if (process.env.EEZ_UI_PROFILE_ONLY === '1') { assert.deepEqual(f.errors, []); await f.close(); return; }
    await f.page.getByRole('button', { name: `Inspect batch ${word(2025)}`, exact: true }).click();
    await waitCoverage(f.page, 2);
    assert.equal(receiptTransactions(f.requests), 4);
    await f.page.getByRole('combobox', { name: 'Settlement filter', exact: true }).selectOption('finalized');
    await f.page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(n => n.textContent.startsWith('Showing 50 / 50 batches')));
    assert.equal(receiptTransactions(f.requests), 4, 'settlement filtering does not inspect executions');
    await f.page.getByRole('combobox', { name: 'Execution filter', exact: true }).selectOption('failed');
    await waitCoverage(f.page, 50);
    assert.match(await coverage(f.page).innerText(), /Showing 1 \/ 50/);
    await f.page.getByRole('combobox', { name: 'Execution filter', exact: true }).selectOption('all');
    await f.page.getByRole('textbox', { name: 'Search batches', exact: true }).fill(word(2025));
    assert.match(await coverage(f.page).innerText(), /Showing 1 \/ 50/);
    for (const width of [390, 320]) {
      await f.page.setViewportSize({ width, height: 1000 });
      assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
    }
    assert.deepEqual(f.errors, []); await f.close();

    const paused = await fixture(browser);
    await paused.page.goto(origin + '/#/visualizer'); await waitCoverage(paused.page, 1);
    let release;
    paused.controls.holdBlocks = new Promise(resolve => { release = resolve; });
    await paused.page.getByRole('button', { name: 'Load all details', exact: true }).click();
    const deadline = Date.now() + 5000;
    while (paused.controls.held < 2 && Date.now() < deadline) await paused.page.waitForTimeout(20);
    assert.equal(paused.controls.held, 2, 'two bounded workers should start');
    await paused.page.getByRole('button', { name: 'Pause', exact: true }).click();
    paused.controls.holdBlocks = null; release();
    await waitCoverage(paused.page, 3); await paused.page.waitForTimeout(200);
    assert.equal(receiptTransactions(paused.requests), 6, 'Pause allows only the two already-owned inspections to finish');
    await paused.page.getByRole('button', { name: 'Resume', exact: true }).click();
    await waitCoverage(paused.page, 50);
    assert.deepEqual(paused.errors, []); await paused.close();
    console.log(JSON.stringify({ passed: true, selectedOnly: true, settlementFilter: true, executionFilter: true, search: true, pauseResume: true, broadcasts: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
