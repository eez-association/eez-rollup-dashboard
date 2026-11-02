import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, toHex, zeroAddress } from 'viem';
import { fixture, origin } from './falcon/fixture.mjs';
import { crossChainDeployment as deployment } from '../src/lib/falcon/crossChainDeployment.ts';
import { createL1ControllerData } from '../src/lib/falcon/l1Controller.ts';
import { managerAbi } from '../src/lib/falcon/l1Controller.ts';
import { l1ControllerFactoryAbi } from '../src/lib/falcon/l1Action.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { recoveryKey, scopedRecoveryKey } from '../src/lib/falcon/recoveryJournal.ts';

import { createKeyPair } from '../src/lib/falcon/falcon.ts';
import { encryptKeystore } from '../src/lib/falcon/keystore.ts';

const account = '0x1111111111111111111111111111111111111111';
const safe = '0x2222222222222222222222222222222222222222';
const keys = createKeyPair(), password = 'recovery-browser-test';
const backup = Buffer.from(JSON.stringify(await encryptKeystore(keys, password)));
const deployedCode = JSON.parse(readFileSync(new URL('./falcon/fixtures/deployed-code.json', import.meta.url), 'utf8'));
const publicKey = `0x${Buffer.from(keys.publicKey).toString('hex')}`, blockHash = `0x${'cd'.repeat(32)}`, cancellationHash = `0x${'ef'.repeat(32)}`;

async function installWallet(f) {
  await f.page.addInitScript(({ account, chain }) => {
    const listeners = new Map();
    const mock = window.recoveryWallet = { account, calls: [] };
    mock.switchAccount = account => { mock.account = account; for (const fn of listeners.get('accountsChanged') ?? []) fn([account]); };
    const provider = { isMetaMask: true,
      on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      removeListener: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== fn)),
      request: async ({ method }) => {
        mock.calls.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [mock.account];
        if (method === 'eth_chainId') return chain;
        if (method === 'eth_getBalance') return '0x0';
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
    const detail = { info: { uuid: 'recovery-test', name: 'MetaMask', rdns: 'io.metamask' }, provider };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  }, { account, chain: toHex(deployment.l2.chainId) });
}
async function connect(f) {
  await f.page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await f.page.getByRole('button', { name: 'MetaMask', exact: true }).click();
}
async function restore(f) {
  await f.page.getByLabel('Encrypted key file', { exact: true }).setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: backup });
  await f.page.getByLabel('Remember this key in this browser', { exact: true }).uncheck();
  await f.page.getByLabel('Backup password', { exact: true }).fill(password);
  await f.page.locator('#restore').click();
  await f.page.waitForFunction(() => document.querySelector('#key-status')?.textContent.includes('Key restored'));
}
async function showRecovery(f, kind) {
  if (kind === 'controller') await f.page.getByText('Earlier setup needs attention', { exact: true }).click();
}

const browser = await chromium.launch({ headless: true, chromiumSandbox: process.env.TREASURY_BROWSER_SANDBOX !== '0',
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const kind of ['funding', 'controller']) {
    const network = kind === 'funding' ? deployment.l1 : deployment.l2;
    let pendingNonce = 7;
    const f = await fixture(browser, { rpc: async ({ method, params, chain }) => {
      const side = BigInt(chain) === BigInt(deployment.l1.chainId) ? deployment.l1 : deployment.l2;
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_blockNumber') return toHex(side.anchor.blockNumber + 10n);
      if (method === 'eth_getCode') return Object.values(deployedCode).find(item => item.address.toLowerCase() === params[0].toLowerCase())?.code ?? '0x';
      if (method === 'eth_call') {
        const { to, data } = params[0];
        if (to.toLowerCase() === COMPOSER_DISCOVERY_ADDRESS.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data });
          return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [
            COMPOSER_DISCOVERY_MARKER, 1n, args[0], BigInt(chain), toHex(JSON.stringify({ version: 'recovery fixture',
              supportedNetworks: { eezL1: deployment.l1.chainId, eezL2: deployment.l2.chainId },
              eezContracts: { eezRegistryAddress: deployment.l1.registry, eezL2Address: deployment.l2.manager } })),
          ] });
        }
        const abi = to.toLowerCase() === deployment.l2.factory.address.toLowerCase() ? l1ControllerFactoryAbi : managerAbi;
        const { functionName } = decodeFunctionData({ abi, data });
        const values = { verifier: deployment.l2.verifier.address, eezL2: deployment.l2.manager,
          l1ChainId: BigInt(deployment.l1.chainId), ROLLUP_ID: deployment.l2.rollupId, USE_GAS_LEFT: false, controllers: zeroAddress };
        return encodeFunctionResult({ abi, functionName, result: values[functionName] });
      }
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
    const legacyKey = recoveryKey(deployment, kind);
    const key = scopedRecoveryKey(legacyKey, { account, publicKey });
    const attempt = { version: 1, id: `unsent-${kind}`, kind, chainId: network.chainId, account, nonce: '7', publicKey,
      to: kind === 'funding' ? safe : deployment.l2.factory.address, value: kind === 'funding' ? '10' : '0',
      data: kind === 'funding' ? '0x' : createL1ControllerData(publicKey), ...(kind === 'funding' ? { controller: safe } : {}) };
    await installWallet(f); await f.open(); await connect(f);
    await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify(attempt)), { key: legacyKey, attempt });
    await f.page.reload();
    assert.equal(await f.page.locator('#funding-recovery-hash, #controller-recovery-hash').count(), 0, 'locked key hides recovery');
    await restore(f); await showRecovery(f, kind);
    const recovery = f.page.getByRole('group', { name: kind === 'funding' ? 'Recover funding transaction' : 'Recover controller setup', exact: true });
    await recovery.waitFor();
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), legacyKey), null, 'legacy record migrated');
    await f.page.evaluate(account => window.recoveryWallet.switchAccount(account), safe);
    await recovery.waitFor({ state: 'hidden' });
    assert(await f.page.evaluate(key => localStorage.getItem(key) !== null, key), 'other wallet preserves pending request');
    await f.page.evaluate(account => window.recoveryWallet.switchAccount(account), account);
    await showRecovery(f, kind); await recovery.waitFor();
    await f.page.locator('#lock').click();
    await recovery.waitFor({ state: 'hidden' });
    await f.page.locator('#generate').click();
    await f.page.waitForFunction(() => document.querySelector('#key-status')?.textContent.includes('Key generated'));
    assert.equal(await f.page.locator('#funding-recovery-hash, #controller-recovery-hash').count(), 0, 'other key hides recovery');
    await f.page.locator('#lock').click();
    await restore(f); await showRecovery(f, kind); await recovery.waitFor();
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
      await f.page.reload(); await restore(f); await recovery.waitFor();
      await f.page.locator('#funding-recovery-hash').fill(cancellationHash);
      await recovery.getByRole('button', { name: 'Recover funding', exact: true }).click();
      await recovery.waitFor({ state: 'hidden' });
      await f.page.getByText(/it was not marked as funded/).waitFor();
      assert.equal(await f.page.evaluate(key => localStorage.getItem(key), key), null);
    }
    // Wallet replacements must remain recoverable even when the original hash
    // was saved successfully. Merely polling that dropped hash cannot finish.
    await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify({
      ...attempt, id: `known-${attempt.kind}`, hash: '0x' + 'aa'.repeat(32),
    })), { key, attempt });
    await f.page.reload(); await restore(f);
    if (kind === 'funding') await f.page.getByText('Funding recovery', { exact: true }).click();
    else await showRecovery(f, kind);
    await recovery.waitFor();
    assert.equal(await recovery.getByRole('button', { name: 'Check and clear unsent request', exact: true }).count(), 0,
      'a recorded hash cannot be cleared as an unsent transaction');
    await f.page.locator(kind === 'funding' ? '#funding-recovery-hash' : '#controller-recovery-hash').fill(cancellationHash);
    await recovery.getByRole('button', { name: kind === 'funding' ? 'Recover funding' : 'Recover controller setup', exact: true }).click();
    await f.page.waitForFunction(key => localStorage.getItem(key) === null, key);
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(await f.page.evaluate(() => window.recoveryWallet.calls.filter(method => /eth_send|eth_sign/.test(method)).length), 0);
    await f.close();
  }
  // A different tab can retire a cancelled/replaced request while this tab is
  // still observing its original hash. Its local busy state must follow storage.
  const f = await fixture(browser, { rpc: async ({ method }) => method === 'eth_getTransactionByHash' ? null : undefined });
  const key = scopedRecoveryKey(recoveryKey(deployment, 'funding'), { account, publicKey });
  const attempt = { version: 1, id: 'other-tab-funding', kind: 'funding', chainId: deployment.l1.chainId,
    account, to: safe, controller: safe, nonce: '7', value: '10', data: '0x', publicKey, hash: cancellationHash };
  await installWallet(f); await f.open(); await connect(f);
  await f.page.evaluate(({ key, attempt }) => localStorage.setItem(key, JSON.stringify(attempt)), { key, attempt });
  await f.page.reload(); await restore(f);
  await f.page.getByText(/Funding tx ·/).waitFor();
  const other = await f.context.newPage(); await other.goto(origin + '/');
  await other.evaluate(key => localStorage.removeItem(key), key);
  await f.page.getByText(/Funding tx ·/).waitFor({ state: 'hidden' });
  assert.equal(await f.page.getByText('Waiting for funding confirmation. Checking automatically…', { exact: true }).count(), 0);
  await f.close();
} finally { await browser.close(); }
