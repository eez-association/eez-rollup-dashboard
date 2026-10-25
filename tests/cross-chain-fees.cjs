// Browser integration with mocked RPC and selected wallets. No real broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until, RAW_GAS, token, recipient } = require('./bridge-gas-fees.cjs');

const feePanel = f => f.page.getByRole('region', { name: 'Bridge transfers' }).getByRole('region', { name: 'Quoted bridge fees' });
async function displayedFees(f, price, priority) {
  const panel = feePanel(f);
  await until(async () => await panel.getByLabel('Gas Price (Gwei)', { exact:true }).inputValue() === price, 'quoted gas price did not update');
  assert.equal(await panel.getByLabel('Max Priority Fee (Gwei)', { exact:true }).inputValue(), priority);
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  let scenarios = 0;
  try {
    for (const reverse of [false, true]) for (const multipleWallets of [false, true]) for (const erc20 of [false, true]) for (const walletNonce of ['0x0', '0x00', 0]) {
      const f = await fixture(browser, { reverse, feesEnabled: true, multipleWallets, erc20, walletNonce, expandGas: false });
      await displayedFees(f, '9.000000007', multipleWallets ? '9' : '');
      assert.equal(await feePanel(f).isVisible(), true, 'quoted values must be visible with Gas settings collapsed');
      assert.equal(await f.page.getByLabel('Gas limit', { exact:true }).isVisible(), false);
      await f.page.getByRole('status').filter({ hasText: 'App fee cap:' }).waitFor();
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'quoted transaction never reached selected wallet');
      const sent = await f.page.evaluate(() => ({ tx: window.walletRequests[0], wallets: window.walletSenders }));
      assert.deepEqual(sent.wallets, [multipleWallets ? 'MetaMask' : 'Rabby']);
      assert.equal(sent.tx.gas, '0x' + RAW_GAS.toString(16));
      if (multipleWallets) {
        assert.equal(BigInt(sent.tx.maxPriorityFeePerGas), 9_000_000_000n);
        assert.equal(BigInt(sent.tx.maxFeePerGas), 9_000_000_007n);
        assert.equal(sent.tx.gasPrice, undefined);
      } else {
        assert.equal(BigInt(sent.tx.gasPrice), 9_000_000_007n);
        assert.equal(sent.tx.maxFeePerGas, undefined);
        assert.equal(sent.tx.maxPriorityFeePerGas, undefined);
      }
      assert.equal(sent.tx.nonce, '0x0');
      assert.equal(sent.tx.type, multipleWallets ? '0x2' : '0x0');
      const quotes = f.rpcRequests.filter(r => r.transaction);
      assert.equal(quotes.length, 2, 'preview and final submission each obtain a quote');
      assert.ok(quotes.every(quote => quote.path === (reverse ? '/composer/l2' : '/composer/l1')));
      assert.equal(sent.tx.chainId, reverse ? '0x1892' : '0x27d8');
      for (const [field, value] of Object.entries(quotes.at(-1).transaction)) assert.equal(sent.tx[field], value);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const erc20 of [false, true]) for (const multipleWallets of [false, true]) {
      const f = await fixture(browser, { chain: '0x1', l2Chain: '0xaa29e', reverse, erc20, multipleWallets, feesEnabled: true, destination: recipient });
      const guidance = f.page.getByRole('note', { name: 'Wallet fee guidance' });
      assert.equal(await guidance.isVisible(), true);
      assert.equal((await guidance.textContent()).includes('Site suggested'), !reverse);
      await displayedFees(f, '9.000000007', reverse && !multipleWallets ? '' : '9');
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'mainnet bridge did not reach selected wallet');
      const sent = await f.page.evaluate(() => ({ tx: window.walletRequests[0], wallets: window.walletSenders }));
      const legacy = reverse && !multipleWallets;
      assert.deepEqual(sent.wallets, [multipleWallets ? 'MetaMask' : 'Rabby']);
      assert.equal(sent.tx.chainId, reverse ? '0xaa29e' : '0x1');
      assert.equal(sent.tx.type, legacy ? '0x0' : '0x2');
      assert.equal(sent.tx.gas, '0x' + RAW_GAS.toString(16));
      assert.equal(sent.tx.to, '0x' + '11'.repeat(20));
      assert.equal(BigInt(sent.tx.value), erc20 ? 0n : 1_000_000_000_000_000n);
      assert.ok(sent.tx.data.startsWith(erc20 ? '0xd2c2fa0f' : '0x5d81310b'), 'must submit a bridge call');
      assert.ok(sent.tx.data.endsWith(recipient.slice(2)), 'must preserve the requested bridge recipient');
      if (legacy) {
        assert.equal(BigInt(sent.tx.gasPrice), 9_000_000_007n);
        assert.equal(sent.tx.maxFeePerGas, undefined);
        assert.equal(sent.tx.maxPriorityFeePerGas, undefined);
      } else {
        assert.equal(BigInt(sent.tx.maxPriorityFeePerGas), 9_000_000_000n);
        assert.equal(BigInt(sent.tx.maxFeePerGas), 9_000_000_007n);
        assert.equal(sent.tx.gasPrice, undefined);
      }
      const quotes = f.rpcRequests.filter(r => r.transaction);
      assert.equal(quotes.length, 2);
      assert.ok(quotes.every(quote => quote.path === (reverse ? '/composer/l2' : '/composer/l1')));
      for (const [field, value] of Object.entries(quotes.at(-1).transaction)) assert.equal(sent.tx[field], value);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const options of [{ quoteFailure: true }, { feeCeiling: '1' }]) {
      const f = await fixture(browser, { reverse, feesEnabled: true, ...options });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: options.quoteFailure ? 'quote_unavailable' : 'app limit' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const walletNonce of [1, '0x01']) {
      const f = await fixture(browser, { reverse, feesEnabled: true, multipleWallets: true, walletNonce });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Wallet nonce changed' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      // Enabling one direction must not enable fees on the other chain.
      const f = await fixture(browser, { chain: '0x1', reverse, l1FeesEnabled: reverse, l2FeesEnabled: !reverse });
      assert.equal(await f.page.getByRole('status').filter({ hasText: 'App fee cap:' }).count(), 0);
      assert.equal(await f.page.getByRole('note', { name: 'Wallet fee guidance' }).count(), 0);
      assert.equal(await feePanel(f).count(), 0);
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'disabled direction did not submit');
      assert.equal(f.rpcRequests.filter(r => r.transaction).length, 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      const caps = reverse ? {l1FeeCeiling:'1'} : {l2FeeCeiling:'1'};
      const f = await fixture(browser, { reverse, l1FeesEnabled:true, l2FeesEnabled:true, ...caps });
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'other chain fee cap incorrectly blocked signing');
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      const f = await fixture(browser, { reverse, feesEnabled:true, nativeBalance:'1000000000000000000' });
      await f.page.getByRole('button', {name:'MAX',exact:true}).click();
      await until(async () => await f.page.getByLabel('Bridge amount',{exact:true}).inputValue() === '0.9', 'MAX must reserve source fee cap');
      await until(() => f.button.isEnabled(), 'MAX amount did not get a fresh estimate');
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'MAX did not submit');
      assert.equal(BigInt((await f.page.evaluate(() => window.walletRequests[0])).value), 900000000000000000n);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      // An ERC-20 approval remains an ordinary source-chain transaction.
      const f = await fixture(browser, { reverse, feesEnabled:true, erc20:true, allowance:'0', approvalRequired:true });
      await f.page.getByRole('button', {name:'Approve ???',exact:true}).click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'token approval did not submit');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(tx.to, token);
      assert.ok(tx.data.startsWith('0x095ea7b3'));
      assert.equal(f.rpcRequests.filter(r => r.transaction).length, 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    {
      // Final fees can change after the preview. Keep the exact submitted quote
      // visible in both the card and the modal while the wallet waits for approval.
      const f = await fixture(browser, { chain:'0x1', feesEnabled:true, holdWallet:true, expandGas:false, clock:true });
      await displayedFees(f, '9.000000007', '9');
      f.feeQuote.gasPrice = '30000000000'; f.feeQuote.priorityFee = '11000000000';
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'wallet confirmation did not open');
      await displayedFees(f, '30', '11');
      const dialog = f.page.getByRole('dialog');
      assert.equal(await dialog.getByLabel('Gas Price (Gwei)', {exact:true}).inputValue(), '30');
      assert.equal(await dialog.getByLabel('Max Priority Fee (Gwei)', {exact:true}).inputValue(), '11');
      const count = f.rpcRequests.filter(r => r.transaction).length;
      await f.page.clock.fastForward(35_000);
      await displayedFees(f, '30', '11');
      assert.equal(f.rpcRequests.filter(r => r.transaction).length, count, 'do not requote while the wallet is open');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(BigInt(tx.maxFeePerGas), 30_000_000_000n);
      assert.equal(BigInt(tx.maxPriorityFeePerGas), 11_000_000_000n);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    {
      const f = await fixture(browser, { chain:'0x1', feesEnabled:true, expandGas:false, clock:true });
      await displayedFees(f, '9.000000007', '9');
      await f.page.clock.fastForward(31_000);
      await feePanel(f).getByText('Quote expired. Refresh fees before copying.', {exact:true}).waitFor();
      await displayedFees(f, '', '');
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    {
      const f = await fixture(browser, { chain:'0x1', feesEnabled:true, expandGas:false, quoteFailure:true });
      await feePanel(f).getByText('Fee quote unavailable:', {exact:false}).waitFor();
      await displayedFees(f, '', '');
      f.feeQuote.failure = false;
      f.feeQuote.gasPrice = '12345678901'; f.feeQuote.priorityFee = '123456789';
      await feePanel(f).getByRole('button', {name:'Refresh fees',exact:true}).click();
      await displayedFees(f, '12.345678901', '0.123456789');
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    {
      const f = await fixture(browser, { chain:'0x1', l2Chain:'0xaa29e', l1FeesEnabled:true, l2FeesEnabled:true, expandGas:false });
      await displayedFees(f, '9.000000007', '9');
      const count = f.rpcRequests.filter(r => r.transaction).length;
      let release;
      f.feeQuote.gasPrice = '15000000000'; f.feeQuote.priorityFee = '5000000000';
      f.feeQuote.hold = new Promise(resolve => { release = resolve; });
      await feePanel(f).getByRole('button', {name:'Refresh fees',exact:true}).click();
      await until(() => f.rpcRequests.filter(r => r.transaction).length === count + 1, 'delayed quote did not start');
      f.feeQuote.hold = null;
      f.feeQuote.gasPrice = '20000000000'; f.feeQuote.priorityFee = '7000000000';
      await f.page.getByLabel('Bridge amount', {exact:true}).fill('0.002');
      await displayedFees(f, '20', '7');
      release();
      await f.page.waitForTimeout(100);
      await displayedFees(f, '20', '7');
      assert.equal(BigInt(f.rpcRequests.filter(r => r.transaction).at(-1).transaction.value), 2_000_000_000_000_000n);
      await f.page.getByTitle('Swap direction').click();
      await displayedFees(f, '20', '');
      assert.equal(f.rpcRequests.filter(r => r.transaction).at(-1).path, '/composer/l2');
      assert.equal(await feePanel(f).getByLabel('Max Priority Fee (Gwei)', {exact:true}).getAttribute('placeholder'), 'Not used for legacy transactions');
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({ passed: true, scenarios, realTransactionsBroadcast: 0, selectedWallets: ['Rabby', 'MetaMask'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
