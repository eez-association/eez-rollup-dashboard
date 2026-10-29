// Built-app integration: Composer and verified explorer responses are mocked.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

test('direct fee simulation decodes verified calls, explains parent reverts, and retains raw evidence', { timeout: 60_000 }, async () => {
  const { parseAbi, encodeFunctionData, encodeErrorResult, encodeAbiParameters } = await import('viem');
  const root = path.resolve(__dirname, '..'), base = process.env.EEZ_UI_BASE_PATH || '/dashboard/';
  const { preview } = await import('vite');
  const server = await preview({ configFile: false, root, base, build: { outDir: 'dist' }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const address = byte => '0x' + byte.repeat(20), bytes = hex => ({ hex, length: (hex.length - 2) / 2, truncated: false });
  const caller = address('11'), settlement = address('22'), implementation = address('33'), missing = address('44');
  const abi = parseAbi(['function settle((address token, uint256 amount)[] orders) returns (uint256 total)', 'error BadToken(address token)']);
  const calldata = encodeFunctionData({ abi, functionName: 'settle', args: [[{ token: missing, amount: 269284500080243954226n }]] });
  const document = JSON.parse(await fs.readFile(path.join(root, 'public/quote-trace/examples/nested-revert.json'), 'utf8'));
  document.id = 'dashboard-quote';
  const trace = document.result.diagnostics.trace, original = trace.runs[0];
  const call = { ...original.frames[0], chainId: trace.context.l2ChainId, from: caller, to: settlement, codeAddress: settlement,
    crossChain: false, status: 'success', input: bytes(calldata), output: bytes(encodeAbiParameters([{ type: 'uint256' }], [269284500080243954226n])) };
  original.frames = [
    { ...call, id: 0, parentId: null, status: 'revert', output: bytes(encodeErrorResult({ abi, errorName: 'BadToken', args: [missing] })) },
    { ...call, id: 1, parentId: 0, kind: 'CREATE2', to: address('55'), codeAddress: address('55'), input: { hex: '0x1234', length: 10, truncated: true } },
    { ...call, id: 2, parentId: 0, kind: 'DELEGATECALL', codeAddress: implementation },
    { ...call, id: 3, parentId: 0, to: missing, codeAddress: missing, input: bytes('0xa9059cbb' + '00'.repeat(64)), output: bytes('0x'), gasUsed: '0x0' },
  ];
  trace.runs = [original]; trace.truncated = true; trace.omittedFrames = 0; trace.omittedRuns = 0;
  const requests = [], explorerAddresses = [], errors = [], broadcasts = [];
  let browser, mode = 'success';
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'only configured endpoints should be contacted');
      if (url.pathname.endsWith('/config.json')) return route.fulfill({ json: {
        networkName: 'Quote test', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2', l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
        l1ExplorerApiUrl: `${origin}/l1-explorer`, l2ExplorerApiUrl: `${origin}/explorer`,
      } });
      if (url.pathname.endsWith('/explorer/api') || url.pathname.endsWith('/l1-explorer/api')) {
        assert.equal(request.method(), 'GET');
        const address = url.searchParams.get('address'); explorerAddresses.push(address);
        const name = address === settlement ? 'VerifiedSettlement' : address === implementation ? 'VerifiedLibrary' : undefined;
        return route.fulfill({ json: { status: '1', result: [{ ContractName: name, SourceCode: name ? 'contract Verified {}' : '', ABI: name ? JSON.stringify(abi) : 'Contract source code not verified' }] } });
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.method === 'eez_debugQuoteFee') {
          requests.push({ path: url.pathname, body });
          if (mode === 'error') return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'This Composer does not support call tracing' } } });
          if (mode === 'pending') {
            await new Promise(resolve => setTimeout(resolve, 300));
            return route.fulfill({ json: { ...document, id: body.id } }).catch(() => {});
          }
          return route.fulfill({ json: { ...document, id: body.id } });
        }
        const reply = item => {
          if (/send|sign/i.test(item.method)) broadcasts.push(item.method);
          return { jsonrpc: '2.0', id: item.id, result: item.method === 'eth_chainId'
            ? url.pathname.endsWith('l2') ? trace.context.l2ChainId : trace.context.l1ChainId
            : item.method === 'eth_getCode' || item.method === 'eth_call' ? '0x'
            : ['eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount'].includes(item.method) ? '0x0'
            : item.method === 'eth_getLogs' ? [] : null };
        };
        return route.fulfill({ json: Array.isArray(body) ? body.map(reply) : reply(body) });
      }
      return route.continue();
    });
    await page.goto(`${origin}${base}#/debug`);
    const frame = page.frameLocator('iframe[title="Cross-chain quote trace viewer"]');
    const submit = page.getByRole('button', { name: 'Simulate fee quote', exact: true });
    await page.getByLabel('From address', { exact: true }).fill(caller);
    await page.getByLabel('To address', { exact: true }).fill(settlement);
    await page.getByLabel('Calldata', { exact: true }).fill('0x1');
    await submit.click();
    await page.getByRole('alert').filter({ hasText: 'complete hex bytes' }).waitFor();
    assert.equal(requests.length, 0);
    await page.getByLabel('Calldata', { exact: true }).fill(calldata);
    await page.getByLabel('Value in wei').fill('123');
    await page.getByLabel('Transaction format').selectOption('0x0');
    await submit.click();
    await frame.locator('#workspace').waitFor({ state: 'visible' });
    await frame.locator('#decoding-status').filter({ hasText: '2 verified contract ABIs loaded' }).waitFor();
    await frame.locator('[data-frame="0"]').filter({ hasText: 'VerifiedSettlement.settle' }).waitFor();
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/composer/l2');
    assert.equal(requests[0].body.params[0].data, calldata);
    assert.equal(requests[0].body.params[0].value, '0x7b');
    assert.deepEqual(requests[0].body.params[1], { trace: 'calls', transactionTypes: ['0x0'] });
    assert.equal(await page.locator('#quote-form').isVisible(), false);
    assert.match(await frame.locator('#failure-summary').textContent(), /No child revert or halt is recorded/);
    assert.match(await frame.locator('#failure-summary').textContent(), /#3 returned no data/);
    assert.match(await frame.locator('#warning').textContent(), /no calls or runs omitted/);
    assert.match(await frame.locator('#warning').textContent(), /call #1: constructor input shortened/);
    assert.match(await frame.locator('[data-frame="0"]').textContent(), /VerifiedSettlement.settle/);
    assert.match(await frame.locator('#frame-detail').textContent(), /BadToken\(address\)/);
    assert.match(await frame.locator('#frame-detail').textContent(), /269284500080243954226/);
    await frame.locator('[data-frame="2"]').click();
    assert.match(await frame.locator('#frame-detail').textContent(), /VerifiedLibrary/);
    assert.match(await frame.locator('#frame-detail').textContent(), /rolled back by an ancestor/);
    assert(explorerAddresses.includes(implementation));
    await frame.getByRole('button', { name: 'Inspect last child #3' }).click();
    assert.equal(await frame.locator('#frame-id').textContent(), '#3');
    assert.match(await frame.locator('#frame-detail').textContent(), /Verified ABI unavailable/);
    await frame.locator('#search').fill('VerifiedLibrary');
    assert.equal(await frame.getByRole('treeitem').count(), 2);
    await frame.locator('#search').fill('');
    const download = page.waitForEvent('download'); await frame.locator('#download').click();
    assert.deepEqual(JSON.parse(await fs.readFile(await (await download).path(), 'utf8')), document, 'decoded metadata must not rewrite execution evidence');

    // Untyped window messages cannot load a trace after the private-port handshake.
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'load', text: '{}' }, '*'));
    assert.equal(await frame.locator('#workspace').isVisible(), true);

    const artifacts = path.join(root, 'test-results/quote-debug-form', base === '/' ? 'root' : 'dashboard');
    await fs.mkdir(artifacts, { recursive: true });
    await frame.locator('[data-frame="0"]').click();
    await page.screenshot({ path: path.join(artifacts, 'decoded-desktop.png'), fullPage: true });

    mode = 'error';
    await page.getByRole('button', { name: /Simulate a transaction/ }).click();
    await page.getByLabel('Source chain', { exact: true }).selectOption('l1');
    await submit.click();
    await page.getByRole('alert').filter({ hasText: 'does not support call tracing' }).waitFor();
    assert.equal(requests.at(-1).path, '/composer/l1');
    assert.equal(await frame.locator('#workspace').isVisible(), false);

    mode = 'pending';
    let pending = page.waitForRequest(request => request.method() === 'POST' && request.postDataJSON()?.method === 'eez_debugQuoteFee');
    await submit.click(); await pending;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await frame.locator('#workspace').isVisible(), false, 'cancelled responses must not replace the display');

    pending = page.waitForRequest(request => request.method() === 'POST' && request.postDataJSON()?.method === 'eez_debugQuoteFee');
    await submit.click(); await pending;
    const imported = structuredClone(document);
    imported.result.diagnostics.options[0].error.details.message = 'Imported trace wins';
    await frame.locator('#file').setInputFiles({ name: 'newer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await frame.locator('#workspace').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    assert.match(await frame.locator('#quote-errors').textContent(), /Imported trace wins/);

    // Hostile explorer text is displayed literally; truncated bytes stay raw.
    await page.route('**/explorer/api?*', route => {
      explorerAddresses.push(new URL(route.request().url()).searchParams.get('address'));
      return route.fulfill({ json: { status: '1', result: [{
      SourceCode: 'contract Verified {}', ContractName: '<img src=x onerror="window.compromised=true">', ABI: JSON.stringify(abi),
    }] } }); });
    mode = 'success';
    await page.getByRole('button', { name: /Simulate a transaction/ }).click();
    await page.getByLabel('Source chain', { exact: true }).selectOption('l2');
    await submit.click();
    await frame.locator('#decoding-status').filter({ hasText: 'verified contract ABIs loaded' }).waitFor();
    await frame.locator('[data-frame="0"]').filter({ hasText: '<img src=x' }).waitFor();
    await frame.locator('[data-frame="0"]').click();
    assert.match(await frame.locator('#frame-detail').textContent(), /<img src=x/);
    assert.equal(await frame.locator('#frame-detail img').count(), 0);
    assert.equal(await page.evaluate(() => window.compromised), undefined);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const content = await (await page.locator('iframe').elementHandle()).contentFrame();
    assert(await content.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(artifacts, 'decoded-mobile.png'), fullPage: true });

    // Discovery failure leaves a wallet development default. It must not be
    // accepted as evidence that this explorer belongs to an imported chain.
    await page.route('**/rpc/l2', route => {
      const respond = body => body.method === 'eth_chainId'
        ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Node unavailable' } }
        : { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_getLogs' ? [] : '0x0' };
      const body = route.request().postDataJSON();
      return route.fulfill({ json: Array.isArray(body) ? body.map(respond) : respond(body) });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#quote-form button[type="submit"]')?.disabled === false);
    const before = explorerAddresses.length;
    const unknownNetwork = structuredClone(document);
    unknownNetwork.result.diagnostics.trace.context.l2ChainId = '0xa455';
    unknownNetwork.result.diagnostics.trace.runs[0].chainId = '0xa455';
    for (const call of unknownNetwork.result.diagnostics.trace.runs[0].frames) call.chainId = '0xa455';
    await frame.locator('#file').setInputFiles({ name: 'unknown-network.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unknownNetwork)) });
    await frame.locator('#decoding-status').filter({ hasText: '0 verified contract ABIs loaded' }).waitFor();
    assert.equal(explorerAddresses.length, before, 'failed discovery must not use the default chain ID for ABI lookup');
    assert.deepEqual(errors, []); assert.deepEqual(broadcasts, []);
  } finally { await browser?.close(); await server.close(); }
});
