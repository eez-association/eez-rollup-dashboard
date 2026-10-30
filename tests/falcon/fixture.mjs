import assert from 'node:assert/strict';
import { toHex } from 'viem';
import { crossChainDeployment as defaultDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';

export const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
export const shortcut = 'Control+Alt+Shift+KeyT';
export const visibilityKey = 'eez:treasury-demo:visible';

/** Only static dashboard assets reach the preview server; all network data is isolated. */
export async function fixture(browser, { mismatch = false, feesEnabled = true, config = {}, quote, rpc, deployment = defaultDeployment } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const requests = [], errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    if (url.href === 'https://api.coinbase.com/v2/prices/ETH-USD/spot') {
      assert.equal(request.method(), 'GET'); assert.equal(request.postData(), null, 'price lookup carries no wallet or transaction data');
      return route.fulfill({ json: { data: { base: 'ETH', currency: 'USD', amount: '2000.00' } } });
    }
    assert.equal(url.origin, new URL(origin).origin, 'no external network access from the test dashboard');
    if (url.pathname.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: deployment.l2.chainName, l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      l1ExplorerUrl: deployment.l1.explorer, l2ExplorerUrl: deployment.l2.explorer,
      l1ContractAddress: deployment.l1.registry, l2ContractAddress: deployment.l2.manager,
      rollupId: deployment.l2.rollupId.toString(), l2FeesEnabled: feesEnabled, l2FeeMaxTotalWei: '100000000000000000', ...config,
    } });
    if (url.pathname.includes('/cowdemo/api/')) return route.fulfill({ status: 503, json: { status: 'deployment_required' } });
    if (request.method() !== 'POST') return route.continue();
    const { id, method, params } = request.postDataJSON();
    assert(!/^(eth_send|eth_sign|personal_sign|wallet_)/i.test(method), 'HTTP never signs or broadcasts');
    if (method === 'eez_quoteFee') {
      assert(quote, 'unexpected fee quote');
      assert(url.pathname.endsWith('/composer/l2'));
      return route.fulfill({ json: { jsonrpc: '2.0', id, ...await quote(params) } });
    }
    if (rpc) {
      try {
        const result = await rpc({ method, params, chain: toHex(url.pathname.endsWith('l1') ? deployment.l1.chainId : deployment.l2.chainId), path: url.pathname });
        if (result !== undefined) return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
      } catch (error) {
        return route.fulfill({ json: { jsonrpc: '2.0', id, error: { code: error.code ?? -32000, message: error.message } } });
      }
    }
    const result = method === 'eth_chainId' ? toHex(url.pathname.endsWith('l1') ? deployment.l1.chainId : mismatch ? 906969 : deployment.l2.chainId)
      : method === 'eth_getBlockByNumber' ? { number: '0x10', hash: '0x'+'ab'.repeat(32), timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1000000', transactions: [] }
      : method === 'eth_getLogs' ? [] : method === 'eth_getBalance' ? '0x0' : null;
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  const page = await context.newPage();
  const nav = page.getByRole('navigation', { name: 'Dashboard sections' });
  const tab = nav.getByRole('button', { name: 'Falcon Safe Demo', exact: true });
  const toggle = async () => {
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press(shortcut);
  };
  const open = async (target = page) => {
    await target.goto(origin + '/#/falcon-demo');
    await target.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    if (await target.evaluate(key => sessionStorage.getItem(key) !== '1', visibilityKey)) {
      await target.keyboard.press(shortcut);
      await target.getByRole('button', { name: 'Falcon Safe Demo', exact: true }).click();
    }
    await target.locator('#generate').waitFor();
  };
  const close = async () => { assert.deepEqual(errors, []); await context.close(); };
  return { context, page, nav, tab, toggle, open, close, requests, errors };
}
