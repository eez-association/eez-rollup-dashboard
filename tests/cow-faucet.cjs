const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');

async function open(browser, options = {}) {
  const f = await fixture(browser, { wallet: true, ...options });
  await f.page.goto(origin + '/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
  await f.page.getByRole('region', { name: 'Swap form' }).getByRole('button', { name: 'Connect wallet', exact: true }).click();
  f.faucet = f.page.getByRole('region', { name: 'Get test tokens' });
  return f;
}
const pendingCount = f => f.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('eez:cow:faucet:')).length);
const requestCount = (f, method) => f.walletRequests.filter(r => r.method === method).length;
async function switchToChiado(f) {
  await f.faucet.getByRole('button', { name: 'Switch to Chiado', exact: true }).click();
}
async function ready(f) {
  await f.faucet.getByText('Connected to Chiado. Click Get test tokens to open the transaction confirmation.', { exact: true }).waitFor();
}
async function close(f) { assert.deepEqual(f.errors, []); await f.context.close(); }

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    // Force the fast-click race: switching, Composer discovery and wallet confirmation
    // remain pending until the test explicitly releases each separate step.
    {
      const f = await open(browser);
      await f.page.evaluate(() => { window.delayTestNetworkSwitch = true; window.delayTestComposer = true; });
      await f.faucet.getByRole('button', { name: 'Switch to Chiado', exact: true }).evaluate(button => { button.click(); button.click(); });
      await f.page.waitForFunction(() => !!window.finishTestNetworkSwitch);
      assert.equal(requestCount(f, 'wallet_switchEthereumChain'), 1);
      assert.equal(requestCount(f, 'wallet_addEthereumChain'), 0, 'known networks are switched directly');
      assert.equal(requestCount(f, 'eth_sendTransaction'), 0);
      assert.ok(await f.page.getByRole('region', { name: 'Swap form' }).getByRole('button', { name: 'Get quote' }).isDisabled(),
        'swap actions stay locked while the faucet network switch is pending');
      await f.page.evaluate(() => { window.delayTestNetworkSwitch = false; window.finishTestNetworkSwitch(); });
      await f.page.waitForFunction(() => window.testComposerWaiters?.length > 0);
      const checking = f.faucet.getByRole('button', { name: 'Checking wallet RPC…', exact: true });
      await checking.waitFor(); assert.ok(await checking.isDisabled());
      await checking.evaluate(button => button.click());
      assert.equal(requestCount(f, 'eth_sendTransaction'), 0, 'an immediate click cannot bypass discovery');
      await f.page.evaluate(() => { window.delayTestComposer = false; window.testComposerWaiters.forEach(resolve => resolve()); });
      await ready(f);
      assert.equal(f.transactions.length, 0, 'network setup never claims automatically');
      await f.page.evaluate(() => { window.delayTestTransaction = true; });
      await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).evaluate(button => { button.click(); button.click(); });
      await f.page.waitForFunction(() => !!window.finishTestTransaction);
      assert.equal(requestCount(f, 'eth_sendTransaction'), 1, 'double-click opens one confirmation');
      assert.equal(f.transactions.length, 0, 'nothing is accepted before wallet approval');
      await f.faucet.getByText(/Confirm the faucet transaction in MetaMask/).waitFor();
      assert.ok(await f.faucet.getByRole('button', { name: 'Confirm in wallet…', exact: true }).isDisabled());
      await f.page.evaluate(() => { window.delayTestTransaction = false; window.finishTestTransaction(); });
      await f.faucet.getByText(/Received 0.01 ctWETH and 0.0002/).waitFor();
      assert.equal(f.transactions.length, 1); assert.equal(f.signed.length, 0);
      assert.equal(requestCount(f, 'wallet_switchEthereumChain'), 1, 'return switch requires another deliberate click');
      await f.faucet.getByRole('button', { name: 'Switch back to EEZ test', exact: true }).click();
      await f.page.waitForFunction(() => window.ethereum.request({ method: 'eth_chainId' }).then(chain => chain === '0x1892'));
      assert.equal(f.transactions.length, 1);
      await close(f);
    }
    {
      const f = await open(browser, { missingL1Network: true });
      await switchToChiado(f); await ready(f);
      const methods = f.walletRequests.filter(r => /^wallet_(switch|add)EthereumChain$/.test(r.method)).map(r => r.method);
      assert.deepEqual(methods, ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
      const added = f.walletRequests.find(r => r.method === 'wallet_addEthereumChain').params[0];
      assert.equal(added.chainId, '0x27d8');
      assert.deepEqual(added.rpcUrls, [origin.replace(/\/dashboard$/, '') + '/composer/l1']);
      assert.equal(f.transactions.length, 0); await close(f);
    }
    {
      const f = await open(browser);
      await f.page.evaluate(() => { window.rejectTestNetworkSwitch = true; });
      await switchToChiado(f);
      await f.faucet.getByText(/Network setup cancelled/).waitFor();
      assert.equal(requestCount(f, 'eth_sendTransaction'), 0); assert.equal(await pendingCount(f), 0);
      await f.page.evaluate(() => { window.rejectTestNetworkSwitch = false; });
      await switchToChiado(f); await ready(f);
      await f.page.evaluate(() => { window.rejectTestTransaction = true; });
      await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).click();
      await f.faucet.getByRole('alert').getByText(/Request cancelled in your wallet/).waitFor();
      assert.equal(f.transactions.length, 0); assert.equal(await pendingCount(f), 0);
      assert.equal(requestCount(f, 'eth_sendTransaction'), 1); await close(f);
    }
    for (const composer of ['not-detected', 'mismatch', 'unavailable']) {
      const f = await open(browser, { composer }); await switchToChiado(f);
      const notice = f.faucet.getByRole('region', { name: 'Wallet Composer connection' });
      await notice.getByText(composer === 'not-detected' ? 'Composer not detected' : composer === 'mismatch' ? 'Composer network mismatch' : 'Unable to verify RPC', { exact: true }).waitFor();
      assert.ok(await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).isDisabled());
      assert.equal(f.transactions.length, 0); assert.equal(await pendingCount(f), 0);
      if (composer === 'not-detected') {
        await notice.getByText('MetaMask RPC setup', { exact: true }).click();
        await notice.getByRole('button', { name: 'Copy RPC URL' }).waitFor();
        await f.page.evaluate(() => window.setTestComposer('detected'));
        await notice.getByRole('button', { name: 'Recheck wallet Composer connection' }).click(); await ready(f);
        // Silently changing the RPC must still be caught by a fresh claim-time check.
        await f.page.evaluate(() => window.setTestComposer('not-detected'));
        await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).click();
        await f.faucet.getByRole('alert').getByText(/Composer RPC in your wallet/).waitFor();
        assert.equal(requestCount(f, 'eth_sendTransaction'), 0); assert.equal(await pendingCount(f), 0);
      }
      await close(f);
    }
    {
      const f = await open(browser, { faucetFeeFailure: true }); await switchToChiado(f); await ready(f);
      await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).click();
      await f.faucet.getByRole('alert').getByText(/Fee quote temporarily unavailable/).waitFor();
      assert.equal(requestCount(f, 'eth_sendTransaction'), 0);
      assert.equal(await pendingCount(f), 0, 'fee preparation failure must not leave a stuck wallet request');
      assert.ok(await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).isEnabled());
      await close(f);
    }
    {
      const f = await open(browser); await switchToChiado(f); await ready(f);
      await f.page.evaluate(() => { window.ambiguousTestTransaction = true; });
      await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).click();
      await f.faucet.getByRole('button', { name: 'Clear unresolved wallet request' }).waitFor();
      assert.equal(await pendingCount(f), 1);
      await f.page.reload(); await f.faucet.getByRole('button', { name: 'Clear unresolved wallet request' }).waitFor();
      assert.equal(requestCount(f, 'eth_sendTransaction'), 1, 'an ambiguous request is never resent on reload');
      await close(f);
    }
    {
      const f = await open(browser, { faucetDelayed: true }); await switchToChiado(f); await ready(f);
      await f.faucet.getByRole('button', { name: 'Get test tokens', exact: true }).click();
      await f.faucet.getByText('Test-token request', { exact: false }).first().waitFor();
      await f.page.reload(); await f.faucet.getByText(/Received 0.01 ctWETH and 0.0002/).waitFor();
      assert.equal(f.transactions.length, 1);
      assert.equal(f.transactions[0].to, '0x' + 'ef'.repeat(20));
      assert.equal(f.transactions[0].data, '0x4e71d92d'); assert.equal(f.transactions[0].value, '0x0');
      const switched = f.walletRequests.findIndex(r => r.method === 'wallet_switchEthereumChain' && r.params[0].chainId === '0x27d8');
      const sent = f.walletRequests.findIndex(r => r.method === 'eth_sendTransaction');
      assert.ok(f.walletRequests.slice(switched + 1, sent).some(r => r.method === 'eth_call'), 'probe wallet after switching');
      assert.equal(f.signed.length, 0); await close(f);
    }
    console.log('Faucet: separate switch/claim, immediate clicks, double-clicks, delayed discovery, missing network, cancellation, fee failure, ambiguous submission and delivery recovery passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
