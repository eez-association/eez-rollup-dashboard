const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
const { decodeFunctionData, erc20Abi } = require('viem');

async function open(browser, options = {}) {
  const f = await fixture(browser, { wallet: true, ...options });
  await f.page.goto(origin + '/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
  const form = f.page.getByRole('region', { name: 'Swap form' });
  await form.getByRole('button', { name: 'Connect wallet' }).click();
  await form.getByRole('button', { name: 'Get quote' }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Connect Wallet', exact: true }).count(), 0, 'tab connects the shared dashboard wallet');
  await form.getByRole('button', { name: 'Get quote' }).click();
  await form.getByRole('button', { name: 'Approve sell amount' }).click();
  await form.getByRole('button', { name: 'Sign order' }).waitFor();
  const tx = f.transactions[0];
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  assert.equal(tx.from, '0x'+'88'.repeat(20));
  assert.equal(decoded.functionName, 'approve'); assert.equal(decoded.args[1], 1000000000000000n);
  return { ...f, form };
}
(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await open(browser);
    const catalog = f.page.getByRole('region', { name: 'Available tokens' });
    await catalog.getByLabel('Search tokens').fill('second');
    assert.equal(await catalog.getByRole('button', { name: 'Select ctUSD' }).count(), 0);
    await catalog.getByRole('button', { name: 'Select TEST', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    assert.equal(await f.page.getByLabel(/You receive/).inputValue(), '0x'+'12'.repeat(20));
    await f.form.getByRole('button', { name: 'Get quote' }).waitFor();
    assert.equal(await f.form.getByText('Minimum received', { exact: true }).count(), 0, 'token change clears the previous quote');
    await catalog.getByLabel('Search tokens').fill('no-matches');
    await catalog.getByRole('button', { name: 'Clear search' }).click();
    await f.page.getByLabel(/You receive/).selectOption('0x'+'55'.repeat(20));
    assert.equal(await catalog.getByRole('button', { name: 'Select ctUSD', exact: true }).getAttribute('aria-pressed'), 'true');
    await f.form.getByRole('button', { name: 'Get quote' }).click();
    await f.form.getByRole('button', { name: 'Sign order' }).waitFor();
    await f.page.getByLabel('Maximum slippage (%)').fill('1');
    await f.page.getByLabel('Maximum slippage (%)').fill('3');
    await f.form.getByRole('button', { name: 'Sign order' }).click();
    await f.page.getByText('settled', { exact: true }).waitFor();
    assert.equal(f.signed.length, 1); assert.equal(f.submitted.length, 1);
    assert.equal(f.signed[0].message.buyAmount, '97000000000000000');
    assert.equal(f.signed[0].message.receiver, '0x'+'88'.repeat(20));
    assert.equal(f.signed[0].domain.chainId, 6290);
    await f.page.reload(); await f.page.getByText('settled', { exact: true }).waitFor();
    assert.equal(f.submitted.length, 1, 'reload does not submit another order');
    await f.page.screenshot({ path: '.runtime/cow-native-desktop.png', fullPage: true });
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile does not overflow');
    await f.page.screenshot({ path: '.runtime/cow-native-mobile.png', fullPage: true });
    assert.deepEqual(f.errors, []); await f.context.close();

    const changed = await open(browser, { changeDuringSign: true });
    await changed.form.getByRole('button', { name: 'Sign order' }).click();
    await changed.page.getByText('Wallet or swap selection changed. Review the swap again.').waitFor();
    assert.equal(changed.submitted.length, 0, 'account changes during signing prevent submission');
    await changed.context.close();

    const lost = await open(browser, { lostResponse: true });
    await lost.form.getByRole('button', { name: 'Sign order' }).click();
    await lost.page.getByText('settled', { exact: true }).waitFor();
    await lost.page.reload(); await lost.page.getByText('settled', { exact: true }).waitFor();
    assert.equal(lost.submitted.length, 1, 'lost submission response is reconciled without reposting');
    await lost.context.close();

    for (const options of [{ rejectSwitch: true }, { reverted: true }]) {
      const f = await fixture(browser, { wallet: true, ...options });
      await f.page.goto(origin + '/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
      const form = f.page.getByRole('region', { name: 'Swap form' });
      await form.getByRole('button', { name: 'Connect wallet' }).click();
      await form.getByRole('button', { name: 'Get quote' }).click();
      await form.getByRole('button', { name: 'Approve sell amount' }).click();
      await f.page.getByText(options.rejectSwitch ? 'Network switch cancelled.' : 'Transaction reverted.', { exact: true }).waitFor();
      assert.equal(f.signed.length, 0); assert.equal(f.submitted.length, 0);
      if (options.rejectSwitch) assert.equal(f.transactions.length, 0);
      await f.context.close();
    }
    const expired = await open(browser);
    await expired.page.clock.install(); await expired.page.clock.fastForward(61000);
    await expired.form.getByRole('button', { name: 'Get quote' }).waitFor();
    assert.equal(expired.signed.length, 0);
    await expired.context.close();
    console.log('Native swap: shared wallet, bounded approval, signing, account-change guard, reload, ambiguous response and mobile layout passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
