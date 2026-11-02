import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult, stringToHex, toHex, zeroAddress } from 'viem';
import { mainnetDeployment as d } from '../src/lib/falcon/crossChainDeployment.ts';
import { deploymentSetupPlan } from '../src/lib/falcon/sharedSetup.ts';
import { managerAbi } from '../src/lib/falcon/l1Controller.ts';
import { l1ControllerAbi, l1ControllerFactoryAbi } from '../src/lib/falcon/l1Action.ts';
import { safeFactoryAbi } from '../src/lib/falcon/safe.ts';
import { matchingDeployer } from '../src/lib/treasury/matchingSafes.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { deploymentCode } from './falcon/deploymentCode.ts';
import { fixture, origin } from './falcon/fixture.mjs';

const account = '0x'+'88'.repeat(20), other = '0x'+'99'.repeat(20), blockHash = '0x'+'ab'.repeat(32);
const controller = toHex(300, { size: 20 }), owner = toHex(301, { size: 20 });
const plan = deploymentSetupPlan(d), same = (a,b) => a.toLowerCase() === b.toLowerCase();
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
async function setup(name, { partial = false, wrongCode = false, receiptError = false, controllerExists = false } = {}) {
  const deployed = new Set(partial ? ['verifier'] : []), transactions = [], codes = Object.values(deploymentCode(d));
  let keyHash;
  const rpc = async ({ method, params = [], chain }) => {
    const network = BigInt(chain) === 1n ? d.l1 : d.l2;
    const height = network.anchor.blockNumber + 100n;
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_blockNumber') return toHex(height);
    if (method === 'eth_getBlockByNumber') return { number: params[0] === 'latest' ? toHex(height) : params[0],
      hash: params[0] === toHex(network.anchor.blockNumber) ? network.anchor.blockHash : blockHash,
      timestamp: '0x70000000', gasLimit: '0x2000000', gasUsed: '0x0', transactions: [] };
    if (method === 'eth_getCode') {
      const step = plan.find(s => same(s.address, params[0]));
      if (step) return wrongCode && step.id === 'verifier' ? '0x00' : deployed.has(step.id) ? step.runtime : '0x';
      return codes.find(c => same(c.address, params[0]))?.code ?? '0x';
    }
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getTransactionCount') return toHex(transactions.filter(t => t.tx.chainId === chain && same(t.tx.from, params[0])).length);
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_gasPrice') return '0x4';
    if (method === 'eth_estimateGas') return '0x200000';
    if (method === 'eth_sendTransaction') {
      const tx = params[0], step = plan.find(s => s.data === tx.data);
      assert(step); assert.equal(tx.to.toLowerCase(), matchingDeployer.toLowerCase());
      assert.equal(tx.chainId, toHex(d[step.chain].chainId)); assert.equal(tx.value, '0x0'); assert.equal(tx.gas, '0x200000');
      assert.equal(BigInt(tx.nonce), BigInt(transactions.filter(t => t.tx.chainId === chain && same(t.tx.from, tx.from)).length));
      assert.deepEqual(Object.keys(tx).sort(), ['chainId','data','from','gas','nonce','to','value']);
      const hash = toHex(BigInt(transactions.length + 1), { size: 32 });
      transactions.push({ hash, tx }); deployed.add(step.id); return hash;
    }
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
      if (method === 'eth_getTransactionReceipt' && receiptError) { receiptError = false; throw new Error('Temporary receipt RPC outage'); }
      const record = transactions.find(t => t.hash === params[0]); if (!record) return null;
      const { tx, hash } = record;
      const common = { from: tx.from, to: tx.to, blockHash, blockNumber: toHex(height), transactionIndex: '0x0', type: '0x0' };
      return method === 'eth_getTransactionByHash' ? { ...common, hash, nonce: tx.nonce, value: tx.value, input: tx.data, chainId: tx.chainId, gas: tx.gas, gasPrice: '0x4', v: '0x1b', r: toHex(1n,{size:32}), s: toHex(1n,{size:32}) }
        : { ...common, transactionHash: hash, status: '0x1', gasUsed: tx.gas, effectiveGasPrice: '0x4', cumulativeGasUsed: tx.gas, logs: [] };
    }
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (same(to, COMPOSER_DISCOVERY_ADDRESS)) {
        const { args } = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data });
        return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, args[0], BigInt(chain), stringToHex(JSON.stringify({
          version: 'isolated mainnet setup fixture', supportedNetworks: { eezL1: d.l1.chainId, eezL2: d.l2.chainId },
          eezContracts: { eezRegistryAddress: d.l1.registry, eezL2Address: d.l2.manager },
        }))] });
      }
      const abi = same(to, controller) ? l1ControllerAbi : same(to, d.l2.factory.address) ? l1ControllerFactoryAbi
        : same(to, d.l1.safe.factory.address) ? safeFactoryAbi : managerAbi;
      const { functionName, args } = decodeFunctionData({ abi, data });
      if (functionName === 'controllers') keyHash = args[0];
      const values = { ROLLUP_ID: 2n, USE_GAS_LEFT: false, controllers: controllerExists ? controller : zeroAddress,
        verifier: d.l2.verifier.address, eezL2: d.l2.manager, l1ChainId: 1n, publicKeyHash: keyHash, nonce: 0n,
        singleton: d.l1.safe.singleton.address, fallbackHandler: d.l1.safe.fallbackHandler.address,
        computeCrossChainProxyAddress: owner, safes: zeroAddress };
      assert.notEqual(values[functionName], undefined, functionName);
      return encodeFunctionResult({ abi, functionName, result: values[functionName] });
    }
    throw new Error(`Unexpected setup RPC ${method}`);
  };
  const f = await fixture(browser, { deployment: d, rpc });
  await f.page.exposeFunction('setupRpc', rpc);
  await f.page.addInitScript(({ account, name, l2 }) => {
    const listeners = new Map();
    const state = window.setupWallet = { account, chain: l2, calls: [], reject: false, lose: false, hold: false, release: null };
    state.emit = (event, value) => (listeners.get(event) ?? []).forEach(fn => fn(value));
    const provider = { isMetaMask: true, isRabby: name === 'Rabby',
      on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      removeListener: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter(f => f !== fn)),
      request: async ({ method, params }) => {
        state.calls.push({ method, params });
        if (method === 'eth_chainId') return state.chain;
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [state.account];
        if (method === 'wallet_switchEthereumChain') { state.chain = params[0].chainId; state.emit('chainChanged', state.chain); return null; }
        if (method === 'eth_sendTransaction') {
          if (state.reject) { state.reject = false; throw { code: 4001, message: 'User rejected transaction' }; }
          if (state.hold) { state.hold = false; await new Promise(resolve => { state.release = resolve; }); }
        }
        const result = await window.setupRpc({ method, params, chain: state.chain });
        if (method === 'eth_sendTransaction' && state.lose) { state.lose = false; throw new Error('Disconnected after broadcast'); }
        return result;
      },
    };
    const detail = { info: { uuid: 'falcon-setup-test', name, rdns: name === 'Rabby' ? 'io.rabby' : 'io.metamask' }, provider };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  }, { account, name, l2: toHex(d.l2.chainId) });
  await f.page.goto(origin + '/');
  await f.page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await f.page.getByRole('button', { name, exact: true }).click();
  await f.toggle(); await f.tab.click(); await f.page.locator('#generate').waitFor();
  const next = label => f.page.getByRole('button', { name: `Deploy ${label}`, exact: true });
  return { ...f, deployed, transactions, next };
}
try {
  for (const name of ['Rabby', 'MetaMask']) {
    const f = await setup(name, { controllerExists: true }), { page, next, transactions } = f;
    await next('Falcon verifier on RollupX').waitFor();
    assert.equal(transactions.length, 0); assert.equal(await page.getByTestId('public-key').count(), 0, 'shared setup needs no Falcon key');
    assert.equal(await page.evaluate(() => window.setupWallet.calls.filter(c => /^(eth_send|eth_sign|wallet_)/.test(c.method)).length), 0, 'opening does not prompt');
    await page.evaluate(() => { window.setupWallet.reject = true; }); await next('Falcon verifier on RollupX').click();
    await page.getByRole('alert').filter({ hasText: 'Setup cancelled in your wallet.' }).waitFor();
    assert.equal(transactions.length, 0);
    await next('Falcon verifier on RollupX').click(); await next('controller factory on RollupX').waitFor();
    assert.equal(transactions.length, 1);
    await page.reload(); await next('controller factory on RollupX').waitFor();
    assert.equal(transactions.length, 1, 'reload reuses verified shared infrastructure');
    await page.evaluate(() => { window.setupWallet.lose = true; }); await next('controller factory on RollupX').click();
    await page.getByRole('button', { name: 'Recover deployment', exact: true }).waitFor();
    assert.equal(transactions.length, 2);
    await page.reload(); await page.getByRole('button', { name: 'Recover deployment', exact: true }).waitFor();
    assert.equal(await page.locator('#falcon-deploy-shared').count(), 0, 'unknown broadcast blocks another deployment');
    await page.getByLabel('Transaction hash from wallet activity').fill(transactions[1].hash);
    await page.getByRole('button', { name: 'Recover deployment', exact: true }).click();
    await page.locator('#falcon-infrastructure').waitFor({ state: 'hidden' });
    assert.equal(transactions.length, 2, 'only L2 setup is required to access Safe choices');
    assert.equal(await page.getByTestId('public-key').count(), 0, 'L2 infrastructure needs no Falcon key');
    await page.locator('#generate').click();
    await page.getByRole('button', { name: 'Add to existing Safe', exact: true }).click();
    await page.getByLabel('L1 Safe address', { exact: true }).waitFor();
    assert.equal(await next('safe factory on Ethereum').count(), 0);
    assert.equal(transactions.length, 2, 'choosing an existing Safe never deploys its creation factory');
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await page.locator('#safe-create').click();
    await next('safe factory on Ethereum').waitFor();
    assert.equal(transactions.length, 2, 'choosing Create a Safe only opens the deployment review');
    await page.getByRole('button', { name: 'Back to Safe options', exact: true }).click();
    await page.getByRole('button', { name: 'Add to existing Safe', exact: true }).waitFor();
    await page.locator('#safe-create').click();
    if (name === 'MetaMask') await page.evaluate(() => { window.setupWallet.lose = true; });
    await next('safe factory on Ethereum').click();
    if (name === 'MetaMask') {
      await page.getByRole('button', { name: 'Recover deployment', exact: true }).waitFor();
      await page.reload();
      // The same pre-existing journal format covers L1 even though the initial
      // setup gate now inspects L2 only. Reload must not bypass unresolved sends.
      await page.getByRole('button', { name: 'Recover deployment', exact: true }).waitFor();
      assert.equal(await page.locator('#safe-create').count(), 0);
      assert.equal(transactions.length, 3);
      await page.getByLabel('Transaction hash from wallet activity').fill(transactions[2].hash);
      await page.getByRole('button', { name: 'Recover deployment', exact: true }).click();
    }
    await page.locator('#falcon-infrastructure').waitFor({ state: 'hidden' });
    assert.deepEqual(transactions.map(t => t.tx.chainId), [toHex(d.l2.chainId), toHex(d.l2.chainId), '0x1']);
    if (name === 'MetaMask') await page.locator('#generate').click();
    await page.locator('#safe-create').waitFor();
    assert.equal(transactions.length, 3, 'Safe creation requires a fresh explicit action after factory setup');
    assert(!f.requests.some(r => r.body && JSON.parse(r.body).method === 'eez_quoteFee'), 'no Falcon-authorized creation is prepared automatically');
    await f.close();
  }
  const partial = await setup('Rabby', { partial: true });
  await partial.next('controller factory on RollupX').waitFor();
  await partial.page.setViewportSize({ width: 390, height: 900 });
  assert(await partial.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await partial.page.screenshot({ path: '/tmp/falcon-mainnet-setup.png', fullPage: true });
  await partial.close();
  const incompatible = await setup('Rabby', { wrongCode: true });
  await incompatible.page.getByRole('alert').filter({ hasText: 'incompatible bytecode' }).waitFor();
  assert.equal(await incompatible.page.locator('#falcon-deploy-shared').count(), 0);
  assert.equal(incompatible.transactions.length, 0); await incompatible.close();

  const replaced = await setup('Rabby', { receiptError: true });
  await replaced.next('Falcon verifier on RollupX').click();
  await replaced.page.getByRole('alert').filter({ hasText: 'Temporary receipt RPC outage' }).waitFor();
  // A wallet speed-up keeps the original sender/nonce/calldata and has a new hash.
  replaced.transactions[0].hash = toHex(99n, { size: 32 });
  await replaced.page.getByLabel('Transaction hash from wallet activity').fill(replaced.transactions[0].hash);
  await replaced.page.getByRole('button', { name: 'Recover deployment', exact: true }).click();
  await replaced.next('controller factory on RollupX').waitFor();
  assert.equal(replaced.transactions.length, 1, 'recovering a replacement hash never resubmits');
  await replaced.close();

  const late = await setup('Rabby');
  await late.next('Falcon verifier on RollupX').waitFor();
  await late.page.evaluate(() => { window.setupWallet.hold = true; });
  await late.next('Falcon verifier on RollupX').click(); await late.page.waitForFunction(() => !!window.setupWallet.release);
  await late.page.evaluate(other => { const w = window.setupWallet; w.account = other; w.emit('accountsChanged', [other]); }, other);
  await late.page.waitForFunction(() => !document.querySelector('#falcon-deploy-shared')?.disabled);
  await late.page.evaluate(() => window.setupWallet.release());
  await late.page.waitForFunction(() => Object.keys(localStorage).some(key => key.includes(':infrastructure:') && JSON.parse(localStorage.getItem(key)).hash));
  await late.page.evaluate(account => { const w = window.setupWallet; w.account = account; w.emit('accountsChanged', [account]); }, account);
  await late.next('controller factory on RollupX').waitFor();
  assert.equal(late.transactions.length, 1, 'late hash stays with its original wallet and is reconciled without a resend');
  await late.close();
  console.log('Falcon wallet setup: both extensions, optional L1 factory, Safe choices, back navigation, rejection, partial deployment, incompatible code, L1/L2 uncertain broadcast recovery and late account-switch reply passed (mock RPC).');
} finally { await browser.close(); }
