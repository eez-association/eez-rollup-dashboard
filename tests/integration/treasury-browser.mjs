// Real RPCs, contracts and signatures. Only the wallet extension is replaced by
// a test EIP-1193 provider; its Node-side public keys never enter the app bundle.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex, encodeFunctionData, parseAbi } from 'viem';
const exec = promisify(execFile);

export async function browserScenario(f, session, directory) {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // Forward this isolated fixture's HTTP through Playwright's request client.
  // Host interface churn otherwise causes Chromium ERR_NETWORK_CHANGED even on
  // loopback. Responses still come from the actual Vite/RPC services, with no
  // synthetic results or retries (especially for transaction submission).
  let closing = false;
  const routeErrors = [];
  await context.route(`${new URL(session.url).origin}/**`, async route => {
    try {
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      if (!closing) await route.fulfill({ response });
    } catch (error) {
      if (!closing) {
        routeErrors.push(String(error));
        await route.abort().catch(() => {});
      }
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const baseNonce = BigInt(f.evidence.paymentInitialNonce || '0');
  const errors = [], calls = [], requestFailures = [];
  const accounts = { A: f.A, B: f.B, C: f.C, outsider: privateKeyToAccount(toHex(0xddddn, { size: 32 })) };
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('console', message => { if (message.type() === 'error') requestFailures.push({ console: message.text() }); });
  await page.exposeFunction('treasuryWalletRequest', async ({ label, chainId, method, params }) => {
    calls.push({ label, method });
    const chain = Number(BigInt(chainId)) === f.network.l1.chainId ? f.network.l1 : f.network.l2;
    const front = `${new URL(session.url).origin}/composer/${chain === f.network.l1 ? 'l1' : 'l2'}`;
    const owner = accounts[label];
    if (method === 'eth_signTypedData_v4') {
      assert.equal(params[0].toLowerCase(), owner.address.toLowerCase());
      const typed = JSON.parse(params[1]);
      assert.equal(BigInt(typed.domain.chainId), BigInt(chain.chainId));
      assert.equal(typed.domain.verifyingContract.toLowerCase(), (chain === f.network.l1 ? f.safeL1 : f.safeL2).toLowerCase());
      return owner.signTypedData(typed);
    }
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      assert.equal(tx.from.toLowerCase(), owner.address.toLowerCase());
      assert.equal(tx.to.toLowerCase(), (chain === f.network.l1 ? f.safeL1 : f.safeL2).toLowerCase());
      const raw = await owner.signTransaction({ chainId: Number(BigInt(chainId)), to: tx.to, data: tx.data,
        nonce: Number(BigInt(tx.nonce)), gas: BigInt(tx.gas), value: BigInt(tx.value), type: 'eip1559',
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), maxFeePerGas: BigInt(tx.maxFeePerGas) });
      return f.rpc(front, 'eth_sendRawTransaction', [raw]);
    }
    return f.rpc(front, method, params || []);
  });
  await page.addInitScript(({ addresses, l1Id }) => {
    let label = sessionStorage.getItem('test-owner') || 'A', chainId = sessionStorage.getItem('test-chain') || l1Id;
    const listeners = new Map();
    const emit = (name, arg) => { for (const fn of listeners.get(name) || []) fn(arg); };
    window.treasuryTestWallet = { rejectNextSignature: false, rejectNextSend: false, loseNextSendResponse: false,
      select(next) { label = next; sessionStorage.setItem('test-owner', next); emit('accountsChanged', [addresses[label]]); },
    };
    window.ethereum = {
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeListener(name, fn) { listeners.get(name)?.delete(fn); },
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addresses[label]];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; sessionStorage.setItem('test-chain', chainId); emit('chainChanged', chainId); return null; }
        if (method === 'eth_signTypedData_v4' && window.treasuryTestWallet.rejectNextSignature) {
          window.treasuryTestWallet.rejectNextSignature = false;
          throw Object.assign(new Error('User rejected signature'), { code: 4001 });
        }
        if (method === 'eth_sendTransaction' && window.treasuryTestWallet.rejectNextSend) {
          window.treasuryTestWallet.rejectNextSend = false;
          throw Object.assign(new Error('User rejected submission'), { code: 4001 });
        }
        const result = await window.treasuryWalletRequest({ label, chainId, method, params });
        if (method === 'eth_sendTransaction' && window.treasuryTestWallet.loseNextSendResponse) {
          window.treasuryTestWallet.loseNextSendResponse = false;
          throw new Error('Simulated lost wallet response after real broadcast');
        }
        return result;
      },
    };
  }, { addresses: Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.address])), l1Id: toHex(f.network.l1.chainId) });
  const ui = page.getByRole('region', { name: 'Connected treasury demo', exact: true });
  const ownerList = ui.getByRole('region', { name: 'Shared owners', exact: true });
  const select = label => page.evaluate(label => window.treasuryTestWallet.select(label), label);
  const waitText = (testId, text) => f.until(`UI ${testId} = ${text}`, async () => (await ui.getByTestId(testId).textContent()) === text);
  const waitNonce = expected => f.until('canonical Safe nonce', async () => BigInt(await f.rpc(f.network.l2.rpc, 'eth_call', [{ to: f.safeL2, data: encodeFunctionData({ abi: parseAbi(['function nonce() view returns (uint256)']), functionName: 'nonce' }) }, 'safe'])) === expected);
  const sign = async label => { await select(label); await ui.getByRole('button', { name: 'Sign approval', exact: true }).click(); };
  const admin = async command => {
    const { stdout } = await exec('node', ['scripts/treasury-owner.mjs', resolve(directory, 'ui-session.json'), command], { cwd: process.cwd(), timeout: 140_000 });
    return JSON.parse(stdout.trim());
  };
  try {
    await page.goto(session.url);
    await page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    assert.equal(await ui.count(), 0, 'devnet configuration does not bypass hidden navigation');
    await page.keyboard.press('Control+Alt+Shift+KeyT');
    await ui.waitFor();
    await page.getByRole('button', { name: 'Owner demo', exact: true }).click();
    await waitText('action-value', '0');
    await ownerList.locator('[data-owner]').nth(1).waitFor();
    assert.equal(await ownerList.locator('[data-owner]').count(), 2);
    await ui.getByRole('button', { name: 'Connect Browser Wallet', exact: true }).click();
    assert.equal(await ui.getByRole('button', { name: 'Switch to EEZ-X', exact: true }).count(), 0);
    await ui.getByLabel('New demonstration value').fill('42');
    await ui.getByRole('button', { name: 'Review action', exact: true }).click();
    await select('outsider');
    await f.until('outsider cannot sign', () => ui.getByRole('button', { name: 'Sign approval', exact: true }).isDisabled());
    await select('B');
    await page.evaluate(() => { window.treasuryTestWallet.rejectNextSignature = true; });
    await ui.getByRole('button', { name: 'Sign approval', exact: true }).click();
    await ui.getByRole('alert').filter({ hasText: 'User rejected signature' }).waitFor();
    await waitText('quorum', '0 of 2 approvals');
    await sign('B');
    await waitText('quorum', '1 of 2 approvals');
    assert(await ui.getByRole('button', { name: 'Owner approved', exact: true }).isDisabled());
    assert(await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).isDisabled());
    await ui.getByRole('button', { name: 'Edit action', exact: true }).click();
    await waitText('quorum', '0 of 2 approvals');
    await ui.getByRole('button', { name: 'Review action', exact: true }).click();
    await sign('B'); await waitText('quorum', '1 of 2 approvals');
    const addition = await admin('add-c');
    await ownerList.locator(`[data-owner="${f.C.address.toLowerCase()}"]`).waitFor();
    await waitText('shared-threshold', '2 of 3 owners');
    await waitText('quorum', '0 of 2 approvals');
    await ui.getByRole('button', { name: 'Review action', exact: true }).click();
    await sign('B'); await waitText('quorum', '1 of 2 approvals');
    await sign('C'); await waitText('quorum', '2 of 2 approvals');
    await page.evaluate(() => { window.treasuryTestWallet.rejectNextSend = true; });
    await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
    await ui.getByRole('alert').filter({ hasText: 'Wallet submission cancelled' }).waitFor();
    await waitText('quorum', '2 of 2 approvals');
    const safeHash = await ui.getByTestId('safe-hash').textContent();
    const fromBlock = await f.rpc(f.network.l1.rpc, 'eth_blockNumber');
    await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
    await ui.getByTestId('submitted-hash').waitFor();
    const hash = await ui.getByTestId('submitted-hash').getAttribute('data-hash');
    await page.reload();
    await ui.waitFor();
    await page.getByRole('button', { name: 'Owner demo', exact: true }).click();
    assert.equal(await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).count(), 0, 'reload reconciles without resubmitting');
    await ui.getByRole('heading', { name: 'Settled on Ethereum', exact: true }).waitFor({ timeout: 120_000 });
    await waitText('action-value', '42'); await waitNonce(baseNonce + 1n);
    assert(await ui.getByRole('button', { name: 'Review action', exact: true }).isEnabled());
    const receipt = await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [hash]);
    const l1Verification = await f.ownerVerificationOnL1({ hash: safeHash }, fromBlock);
    f.evidence.cases.push({ label: 'Browser B+C approval, submission and reload reconciliation', transaction: hash, safeHash,
      blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash, l1Verification, actionValue: '42', safeNonce: String(baseNonce + 1n) });
    f.evidence.ownerAddition = addition.transaction;
    f.checkpoint();
    await page.screenshot({ path: resolve(directory, 'treasury-connected-desktop.png'), fullPage: true });
    assert(await ui.getByRole('button', { name: 'Review action', exact: true }).isEnabled(), 'completed action unlocks automatically');
    await ui.getByLabel('New demonstration value').fill('99');
    await ui.getByRole('button', { name: 'Review action', exact: true }).click();
    await sign('B'); await waitText('quorum', '1 of 2 approvals');
    await sign('C'); await waitText('quorum', '2 of 2 approvals');
    const removal = await admin('remove-c');
    await waitText('shared-threshold', '2 of 2 owners');    await waitText('quorum', '0 of 2 approvals');
    assert.equal(await ownerList.locator(`[data-owner="${f.C.address.toLowerCase()}"]`).count(), 0);
    assert.equal(await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).count(), 0);
    await waitNonce(baseNonce + 1n); await waitText('action-value', '42');
    f.evidence.ownerRemoval = removal.transaction;
    await ui.getByLabel('New demonstration value').fill('43');
    await ui.getByRole('button', { name: 'Review action', exact: true }).click();
    await sign('A'); await waitText('quorum', '1 of 2 approvals');
    await sign('B'); await waitText('quorum', '2 of 2 approvals');
    const secondSafeHash = await ui.getByTestId('safe-hash').textContent();
    const secondFrom = await f.rpc(f.network.l1.rpc, 'eth_blockNumber');
    await page.evaluate(() => { window.treasuryTestWallet.loseNextSendResponse = true; });
    await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
    await ui.getByRole('heading', { name: 'Settled on Ethereum', exact: true }).waitFor({ timeout: 120_000 });
    await waitText('action-value', '43'); await waitNonce(baseNonce + 2n);
    const secondHash = await ui.getByTestId('submitted-hash').getAttribute('data-hash');
    assert.equal(await ui.getByRole('alert').filter({ hasText: 'Submission response uncertain' }).count(), 0, 'canonical recovery clears the uncertain response error');
    const secondReceipt = await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [secondHash]);
    const secondL1 = await f.ownerVerificationOnL1({ hash: secondSafeHash }, secondFrom);
    f.evidence.cases.push({ label: 'Browser A+B after removing C', transaction: secondHash, safeHash: secondSafeHash,
      blockNumber: Number(BigInt(secondReceipt.blockNumber)), blockHash: secondReceipt.blockHash, l1Verification: secondL1, actionValue: '43', safeNonce: String(baseNonce + 2n) });
    // The native Rust harness independently verifies the final safe prefix and attestation.
    f.evidence.lastSuccessfulL2Block = Number(BigInt(secondReceipt.blockNumber));
    await f.until('follower replays UI action', async () => {
      const safe = await f.rpc(f.network.follower, 'eth_getBlockByNumber', ['safe', false]);
      if (BigInt(safe.number) < BigInt(secondReceipt.blockNumber)) return false;
      const block = await f.rpc(f.network.follower, 'eth_getBlockByNumber', [secondReceipt.blockNumber, false]);
      assert.equal(block.hash, secondReceipt.blockHash);
      assert.equal(await f.read(f.network.follower, f.action, f.actionArtifact.abi, 'value', [], secondReceipt.blockNumber), 43n);
      assert.equal(await f.read(f.network.follower, f.safeL2, f.safeArtifact.abi, 'nonce', [], secondReceipt.blockNumber), baseNonce + 2n);
      return true;
    });
    const { invoiceBrowser } = await import('./treasury-invoice-browser.mjs');
    await invoiceBrowser(f, page, ui, waitText, directory);
    const { paymentBrowser } = await import('./treasury-payment-browser.mjs');
    await paymentBrowser(f, page, ui, sign, waitText, directory);
    const { historyBrowser } = await import("./treasury-history-browser.mjs");
    await historyBrowser(f, page, ui, directory);
    const { bidirectionalBrowser } = await import("./treasury-bidirectional-browser.mjs");
    await bidirectionalBrowser(f, page, ui, sign, waitText, session, directory);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
    }
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: resolve(directory, 'treasury-connected-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(routeErrors, [], 'all intercepted requests completed without retries');
    // Two owner actions, four L2-origin payments and one L1-origin payment.
    // Controlled invoice attempts use the fixture submitter outside the wallet.
    assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, 7, 'exactly one wallet send per reviewed action');
    assert(!calls.some(c => c.method === 'eth_estimateGas'), 'no ordinary estimateGas for cross-chain Safe signature checks');
    f.evidence.browserChecks = ['hidden navigation', 'live owners and threshold', 'network switch', 'non-owner blocked', 'wallet signature rejection',
      'duplicate approval blocked', 'incomplete quorum blocked', 'edit clears signatures', 'owner addition clears stale review', 'removal clears stale review',
      'EIP-712 approvals', 'one submission per action', 'wallet submission cancellation', 'reload reconciliation', 'lost-response recovery', 'canonical Safe success', 'independent follower', 'mobile layout'];
    f.evidence.wallet = 'Test EIP-1193 provider; genuine fixture-key signatures and real RPC submission. No wallet extension automation.';
    f.evidence.scenarioComplete = true; f.checkpoint();
    console.log('Connected treasury browser scenario passed');
  } catch (error) {
    console.error('Browser rehearsal failure:', error.stack || error);
    writeFileSync(resolve(directory, 'treasury-browser-requests.json'), JSON.stringify({ requestFailures, routeErrors }, null, 2) + '\n');
    await page.screenshot({ path: resolve(directory, 'treasury-browser-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    // Removing an active route can forward it while route.fetch is still in
    // flight. Close the browser instead; do not replay an intercepted RPC.
    closing = true;
    await browser.close();
  }
}
