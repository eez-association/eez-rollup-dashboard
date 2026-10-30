import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, pad, stringToHex, toHex, zeroAddress } from 'viem';
import { falcon512padded } from '@noble/post-quantum/falcon.js';
import { crossChainDeployment as d } from '../src/lib/falcon/crossChainDeployment.ts';
import { l1ActionDigest, l1ControllerAbi, l1ControllerFactoryAbi } from '../src/lib/falcon/l1Action.ts';
import { managerAbi } from '../src/lib/falcon/l1Controller.ts';
import { safeFactoryAbi } from '../src/lib/falcon/safe.ts';
import { fromHex } from '../src/lib/falcon/falcon.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { fixture, origin } from './falcon/fixture.mjs';

const code = JSON.parse(readFileSync(new URL('./falcon/fixtures/deployed-code.json', import.meta.url), 'utf8'));
const account = '0x'+'88'.repeat(20), controller = '0x'+'11'.repeat(20), owner = '0x'+'22'.repeat(20), safe = '0x'+'33'.repeat(20);
const txHash = '0x'+'ab'.repeat(32), blockHash = '0x'+'cd'.repeat(32);
const blockNumber = d.l1.anchor.blockNumber + 100n;
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const [name, type] of [['Rabby','0x0'], ['MetaMask','0x2']]) {
    let publicKey, consumed = 0n, sent;
    const quotes = [], sends = [], walletCalls = [];
    let optionFailure = false;
    const f = await fixture(browser, { quote: async ([intent, options]) => {
      assert.deepEqual(options, { transactionTypes: [type] });
      assert.deepEqual(Object.keys(intent).sort(), ['data','from','to','value']);
      const resolved = { chainId: toHex(d.l2.chainId), data: intent.data.toLowerCase(), from: intent.from.toLowerCase(),
        gas: toHex(6_000_000n), nonce: '0x0', to: intent.to.toLowerCase(), type, value: '0x0' };
      const fees = type === '0x0' ? { gasPrice: '0x4' } : { maxFeePerGas: '0x4', maxPriorityFeePerGas: '0x1' };
      const quote = { version: 1, chainId: resolved.chainId, nonce: '0x0', expiresAt: toHex(Math.floor(Date.now()/1000)+30),
        options: [optionFailure ? { type, error: { code: 'quote_limit', message: 'Test admission limit' } }
          : { type, gas: resolved.gas, requestHash: keccak256(toHex(JSON.stringify(resolved))), estimatedFee: toHex(18_000_000n), ...fees }] };
      quotes.push({ quote, tx: { ...resolved, ...fees } });
      return { result: quote };
    } });
    const { page } = f;
    const signedAction = data => {
      const { args } = decodeFunctionData({ abi: l1ControllerAbi, data });
      const [target, payload, nonce, deadline, signature, key] = args;
      const action = { sourceChainId: BigInt(d.l2.chainId), destinationChainId: BigInt(d.l1.chainId), controller,
        eezL2: d.l2.manager, target, data: payload, nonce, deadline };
      const digest = l1ActionDigest(action);
      assert(falcon512padded.verify(fromHex(signature), fromHex(digest), fromHex(key)), 'actual browser Falcon signature verifies independently in Node');
      assert.equal(key.slice(2), publicKey);
      return { action, digest, signature };
    };
    await page.exposeFunction('falconWalletRpc', async ({ method, params, chain }) => {
      walletCalls.push({ method, params });
      if (method === 'eth_sendTransaction') {
        assert.deepEqual(params[0], quotes.at(-1).tx, 'send only the exact fresh SDK wallet fields');
        sent = signedAction(params[0].data);
        sends.push(params[0]); consumed++;
        return txHash;
      }
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? blockNumber : BigInt(params[0]);
        return { number: toHex(number), hash: number === 0n ? d.l2.anchor.blockHash : number === d.l1.anchor.blockNumber ? d.l1.anchor.blockHash : blockHash,
          timestamp: toHex(Math.floor(Date.now()/1000)), gasLimit: '0x1000000', gasUsed:'0x0', baseFeePerGas: '0x3', transactions: [] };
      }
      if (method === 'eth_blockNumber') return toHex(blockNumber);
      if (method === 'eth_getCode') return Object.values(code).find(c => same(c.address, params[0]))?.code ?? '0x';
      if (method === 'eth_getBalance') return toHex(10n**18n);
      if (method === 'eth_getTransactionCount') { assert.equal(params[1], 'pending'); return '0x0'; }
      if (method === 'eth_getTransactionReceipt') return { transactionHash: txHash, blockHash, blockNumber: toHex(blockNumber), transactionIndex: '0x0',
        from: account, to: controller, status:'0x1', type, gasUsed: toHex(5_500_000n), effectiveGasPrice: '0x4', cumulativeGasUsed: toHex(5_500_000n), logs: [{
          address: controller, topics: encodeEventTopics({ abi: l1ControllerAbi, eventName: 'CallExecuted', args: { digest: sent.digest, nonce: sent.action.nonce, target: sent.action.target } }),
          data: encodeAbiParameters([{type:'address'},{type:'bytes32'},{type:'bytes'}], [account, keccak256(sent.signature), pad(safe, {size:32})]),
          blockHash, blockNumber: toHex(blockNumber), transactionHash: txHash, transactionIndex: '0x0', logIndex:'0x0', removed: false,
        }] };
      if (method === 'eth_call') {
        const { to, data } = params[0];
        if (same(to, COMPOSER_DISCOVERY_ADDRESS)) {
          const { args } = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data });
          return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, args[0], BigInt(chain), stringToHex(JSON.stringify({
            version: 'isolated browser fixture', supportedNetworks: { eezL1: d.l1.chainId, eezL2: d.l2.chainId },
            eezContracts: { eezRegistryAddress: d.l1.registry, eezL2Address: d.l2.manager },
          }))] });
        }
        const abi = same(to, controller) ? l1ControllerAbi : same(to, d.l2.factory.address) ? l1ControllerFactoryAbi
          : same(to, d.l1.safe.factory.address) ? safeFactoryAbi : managerAbi;
        const { functionName } = decodeFunctionData({ abi, data });
        const values = { verifier: d.l2.verifier.address, eezL2: d.l2.manager, l1ChainId: BigInt(d.l1.chainId), controllers: controller,
          publicKeyHash: publicKey ? keccak256('0x'+publicKey) : toHex(0n, {size:32}), nonce: consumed,
          ROLLUP_ID: d.l2.rollupId, USE_GAS_LEFT: false, singleton: d.l1.safe.singleton.address, fallbackHandler: d.l1.safe.fallbackHandler.address,
          computeCrossChainProxyAddress: owner, safes: zeroAddress };
        const result = functionName === 'checkAuthorization' ? signedAction(data).digest
          : functionName === 'actionDigest' ? l1ActionDigest({ ...decodeAction(data), sourceChainId: BigInt(d.l2.chainId), destinationChainId: BigInt(d.l1.chainId), controller, eezL2: d.l2.manager })
          : values[functionName];
        assert.notEqual(result, undefined, `unexpected contract function ${functionName}`);
        return encodeFunctionResult({ abi, functionName, result });
      }
      throw new Error(`Unexpected wallet RPC ${method}`);
    });
    function decodeAction(data) {
      const { args: [target, payload, nonce, deadline] } = decodeFunctionData({ abi: l1ControllerAbi, data });
      return { target, data: payload, nonce, deadline };
    }
    await page.addInitScript(({ name, account, controller }) => {
      const listeners = new Map();
      const mock = window.falconWalletTest = { account, chain: '0x27d8', calls: [], holdRead: false, holdSend: false, release: null };
      mock.emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
      const provider = { isMetaMask: true, isRabby: name === 'Rabby',
        on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
        removeListener: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== fn)),
        request: async ({ method, params }) => {
          mock.calls.push({ method, params });
          if (method === 'eth_chainId') return mock.chain;
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [mock.account];
          if (method === 'wallet_switchEthereumChain') { mock.chain = params[0].chainId; mock.emit('chainChanged', mock.chain); return null; }
          if (/addEthereumChain|updateEthereumChain|sign/i.test(method)) throw new Error(`Unexpected wallet mutation ${method}`);
          if (mock.holdRead && method === 'eth_call' && params[0].to.toLowerCase() === controller.toLowerCase()) {
            mock.holdRead = false; await new Promise(resolve => { mock.release = resolve; });
          }
          if (mock.holdSend && method === 'eth_sendTransaction') {
            mock.holdSend = false; await new Promise(resolve => { mock.release = resolve; });
          }
          return window.falconWalletRpc({ method, params, chain: mock.chain });
        },
      };
      const detail = { info: { uuid: 'falcon-wallet-test', name, rdns: name === 'Rabby' ? 'io.rabby' : 'io.metamask' }, provider };
      window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
    }, { name, account, controller });
    await page.goto(origin + '/');
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await f.toggle(); await f.tab.click(); await page.locator('#generate').waitFor();
    await page.getByText(new RegExp(`Gas wallet · ${name}`)).waitFor();
    const status = text => page.waitForFunction(text => document.querySelector('#safe-status')?.textContent.includes(text), text);
    await page.locator('#generate').click();
    await page.waitForFunction(() => document.querySelector('#key-status')?.textContent.includes('Key generated'));
    publicKey = await page.getByTestId('public-key').inputValue();
    await page.locator('#safe-load').click(); await status('Controller ready');
    await page.locator('#safe-sign').click(); await status('Falcon signature ready');
    // A structured option failure never falls through to an unquoted send.
    optionFailure = true;
    await page.locator('#safe-send').click(); await status('quote_limit');
    assert.equal(sends.length, 0);
    optionFailure = false;
    // Account or chain events must invalidate pending reads, even after changing back.
    for (const event of ['accountsChanged', 'chainChanged']) {
      await page.evaluate(() => { window.falconWalletTest.holdRead = true; window.falconWalletTest.release = null; });
      await page.locator('#safe-send').click();
      await page.waitForFunction(() => !!window.falconWalletTest.release);
      await page.evaluate(event => {
        const w = window.falconWalletTest;
        w.emit(event, event === 'accountsChanged' ? ['0x'+'99'.repeat(20)] : '0x1');
        w.emit(event, event === 'accountsChanged' ? [w.account] : w.chain);
        w.release();
      }, event);
      await status('changed'); assert.equal(sends.length, 0);
    }
    await page.locator('#safe-estimate-fee').click(); await status('Fee estimated');
    assert.match(await page.locator('#safe-fee-quote').textContent(), /Estimated execution fee.*Maximum reservation/s);
    const quoted = quotes.length;
    if (name === 'Rabby') await page.evaluate(() => { window.falconWalletTest.holdSend = true; window.falconWalletTest.release = null; });
    await page.locator('#safe-send').click();
    if (name === 'Rabby') {
      await page.waitForFunction(() => !!window.falconWalletTest.release);
      await page.locator('#lock').click();
      await page.evaluate(() => window.falconWalletTest.release());
    }
    await status('L2 call confirmed');
    assert.equal(quotes.length, quoted+1, 'obtain a fresh quote immediately before send');
    assert.equal(sends.length, 1);
    assert(await page.locator(`a[href$="${txHash}"]`).count() > 0, 'retain the hash even if the Falcon key is switched during the prompt');
    const calls = await page.evaluate(() => window.falconWalletTest.calls);
    assert.equal(calls.filter(c => c.method === 'eth_requestAccounts').length, 1, 'the demo reuses the header connection');
    assert(calls.some(c => c.method === 'wallet_switchEthereumChain'));
    assert(!calls.some(c => /addEthereumChain|updateEthereumChain|sign/i.test(c.method)));
    assert(!walletCalls.some(c => c.method === 'eth_estimateGas'), 'the fee path must not estimate first');
    assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
    await f.close();
  }
  console.log('Falcon dashboard wallet checks passed for Rabby/legacy and MetaMask/EIP-1559 (mock RPC, real browser signatures; no live settlement).');
} finally { await browser.close(); }
