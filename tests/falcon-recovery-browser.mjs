import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { toHex } from 'viem';
import { fixture, origin } from './falcon/fixture.mjs';
import { crossChainDeployment as deployment } from '../src/lib/falcon/crossChainDeployment.ts';
import { createL1ControllerData } from '../src/lib/falcon/l1Controller.ts';
import { recoveryKey } from '../src/lib/falcon/recoveryJournal.ts';

const account = '0x1111111111111111111111111111111111111111';
const safe = '0x2222222222222222222222222222222222222222';
const publicKey = `0x${'ab'.repeat(897)}`, blockHash = `0x${'cd'.repeat(32)}`, cancellationHash = `0x${'ef'.repeat(32)}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const kind of ['funding', 'controller']) {
    const network = kind === 'funding' ? deployment.l1 : deployment.l2;
    let pendingNonce = 7;
    const f = await fixture(browser, { rpc: async ({ method, params, chain }) => {
      const side = BigInt(chain) === BigInt(deployment.l1.chainId) ? deployment.l1 : deployment.l2;
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? side.anchor.blockNumber + 10n : BigInt(params[0]);
        return { number: toHex(number), hash: number === side.anchor.blockNumber ? side.anchor.blockHash : blockHash,
          timestamp: '0x65000000', gasLimit: '0x1000000', gasUsed: '0x0', transactions: [] };
      }
      if (method === 'eth_getTransactionCount') return toHex(params[1] === 'pending' ? pendingNonce : 7);
      if (method === 'eth_getTransactionByHash') return { hash: cancellationHash, from: account, to: account, nonce: '0x7', value: '0x0', input: '0x',
        chainId: toHex(network.chainId), blockHash, blockNumber: toHex(network.anchor.blockNumber + 10n), transactionIndex: '0x0', type: '0x0',
        gas: '0x5208', gasPrice: '0x1', v: '0x1b', r: toHex(1n, { size: 32 }), s: toHex(1n, { size: 32 }) };
      if (method === 'eth_getTransactionReceipt') return { transactionHash: cancellationHash, from: account, to: account, status: '0x1', blockHash,
        blockNumber: toHex(network.anchor.blockNumber + 10n), transactionIndex: '0x0', type: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x1', cumulativeGasUsed: '0x5208', logs: [] };
    } });
    const key = recoveryKey(deployment, kind);
    const attempt = { version: 1, id: `unsent-${kind}`, kind, chainId: network.chainId, account, nonce: '7', publicKey,
      to: kind === 'funding' ? safe : deployment.l2.factory.address, value: kind === 'funding' ? '10' : '0',
      data: kind === 'funding' ? '0x' : createL1ControllerData(publicKey), ...(kind === 'funding' ? { controller: safe } : {}) };
    await f.open();
    await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify(attempt)), { key, attempt });
    await f.page.reload();
    if (kind === 'controller') await f.page.getByText('Earlier setup needs attention', { exact: true }).click();
    const recovery = f.page.getByRole('group', { name: kind === 'funding' ? 'Recover funding transaction' : 'Recover controller setup', exact: true });
    await recovery.waitFor();
    const clear = recovery.getByRole('button', { name: 'Check and clear unsent request', exact: true });
    assert(await clear.isDisabled(), 'clearing requires explicit acknowledgement');
    await recovery.getByRole('checkbox').check();
    pendingNonce = 8;
    await clear.click(); await f.page.locator('#safe-status').getByText(/nonce has pending or mined activity/).waitFor();
    assert(await f.page.evaluate(key => localStorage.getItem(key) !== null, key));
    pendingNonce = 7;
    if (kind === 'controller') await f.page.getByText('Earlier setup needs attention', { exact: true }).click();
    await clear.click();
    await f.page.waitForFunction(key => localStorage.getItem(key) === null, key);
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), key), null);
    if (kind === 'funding') {
      await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify({ ...attempt, id: 'cancelled-funding' })), { key, attempt });
      await f.page.reload(); await recovery.waitFor();
      await f.page.locator('#funding-recovery-hash').fill(cancellationHash);
      await recovery.getByRole('button', { name: 'Recover funding', exact: true }).click();
      await recovery.waitFor({ state: 'hidden' });
      await f.page.getByText(/it was not marked as funded/).waitFor();
      assert.equal(await f.page.evaluate(key => localStorage.getItem(key), key), null);
    }
    await f.close();
  }
  // A different tab can retire a cancelled/replaced request while this tab is
  // still observing its original hash. Its local busy state must follow storage.
  const f = await fixture(browser, { rpc: async ({ method }) => method === 'eth_getTransactionByHash' ? null : undefined });
  const key = recoveryKey(deployment, 'funding');
  const attempt = { version: 1, id: 'other-tab-funding', kind: 'funding', chainId: deployment.l1.chainId,
    account, to: safe, controller: safe, nonce: '7', value: '10', data: '0x', publicKey, hash: cancellationHash };
  await f.open();
  await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify(attempt)), { key, attempt });
  await f.page.reload();
  await f.page.getByText(/Funding tx ·/).waitFor();
  const other = await f.context.newPage(); await other.goto(origin + '/');
  await other.evaluate(key => localStorage.removeItem(key), key);
  await f.page.getByText(/Funding tx ·/).waitFor({ state: 'hidden' });
  assert.equal(await f.page.getByText('Waiting for funding confirmation. Checking automatically…', { exact: true }).count(), 0);
  await f.close();
} finally { await browser.close(); }
