// Mock RPCs and wallets; approval calldata is inspected without broadcasting.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until, account, token } = require('./bridge-gas-fees.cjs');

const estimates = f => f.rpcRequests.filter(r => r.method === 'eth_estimateGas' && r.path.startsWith('/composer/'));
const quotes = f => f.rpcRequests.filter(r => r.transaction);
const gasErrors = f => f.page.getByRole('alert').filter({ hasText: 'Gas estimation failed:' });
const success = { status: '0x1', blockNumber: '0x10', blockHash: '0x' + '55'.repeat(32), logs: [] };

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  let scenarios = 0;
  try {
    for (const reverse of [false, true]) for (const feesEnabled of [false, true]) for (const decimals of [6, 8, 18]) {
      const amount = decimals === 6 ? '1.234567' : decimals === 8 ? '0.00012345' : '1.234567890123456789';
      const raw = decimals === 6 ? 1234567n : decimals === 8 ? 12345n : 1234567890123456789n;
      // Cover both a new allowance and a partial allowance: approve the full
      // entered amount, not the difference or an unlimited amount.
      const options = { reverse, feesEnabled, decimals, amount, erc20: true, symbol: 'TOKEN',
        allowance: feesEnabled ? raw / 2n : 0n, approvalRequired: true, expandGas: false,
        estimateError: 'execution reverted' };
      const f = await fixture(browser, options);
      // Let the 400 ms estimation debounce elapse while asynchronous RPC reads settle.
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.equal(estimates(f).length, 0, 'Do not simulate a transfer with insufficient allowance');
      assert.equal(quotes(f).length, 0, 'Do not quote a transfer before approval');
      assert.equal(await gasErrors(f).count(), 0, 'Approval is an expected step, not an estimation error');
      assert.equal(await f.page.getByRole('region', { name: 'Quoted bridge fees' }).count(), 0);
      assert.equal(await f.button.isEnabled(), false);

      f.estimation.error = null;
      await f.page.getByRole('button', { name: 'Approve TOKEN', exact: true }).click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'Approval did not reach the wallet');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(tx.from.toLowerCase(), account);
      assert.equal(tx.to.toLowerCase(), token);
      assert.equal(tx.data.slice(0, 10), '0x095ea7b3');
      assert.equal(tx.data.slice(10, 74), '11'.repeat(20).padStart(64, '0'), 'Approve the source bridge');
      assert.equal(BigInt('0x' + tx.data.slice(74)), raw, 'Approve exactly the entered amount in token units');
      assert.equal(estimates(f).length, 0, 'Approval itself does not simulate the bridge transfer');

      options.allowance = raw;
      f.receipt.result = success;
      await f.page.getByRole('heading', { name: 'Approval confirmed', exact: true }).waitFor();
      await f.page.getByRole('button', { name: 'Done', exact: true }).click();
      await until(() => f.button.isEnabled(), 'Confirmed approval must resume transfer preparation');
      assert.equal(await f.page.getByLabel('Bridge amount', { exact: true }).inputValue(), amount);
      assert.ok(estimates(f).length > 0);
      if (feesEnabled) await until(() => quotes(f).length > 0, 'Confirmed approval must start the fee quote');
      else assert.equal(quotes(f).length, 0);

      const prepared = estimates(f).length;
      await f.page.getByLabel('Bridge amount', { exact: true }).fill('2');
      await f.page.getByRole('button', { name: 'Approve TOKEN', exact: true }).waitFor();
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.equal(estimates(f).length, prepared, 'A larger amount needs a new approval first');
      assert.equal(await gasErrors(f).count(), 0);
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 1, 'Amount edits do not submit an approval');
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      // A real execution failure after allowance is sufficient must stay visible.
      const f = await fixture(browser, { reverse, erc20: true, decimals: 8, amount: '0.00012345',
        allowance: 12345n, estimateError: 'execution reverted', expandGas: false });
      assert.equal(await gasErrors(f).count(), 1);
      assert.equal(await f.button.isEnabled(), false);
      assert.equal(await f.page.getByRole('button', { name: /^Approve / }).count(), 0);
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({ passed: true, scenarios, bothDirections: true, tokenDecimals: [6, 8, 18],
      exactApprovals: true, noEstimatesBeforeApproval: true, realErrorsPreserved: true, realTransactionsBroadcast: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
