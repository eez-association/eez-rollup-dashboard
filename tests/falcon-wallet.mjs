import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, pad, stringToHex, toHex, zeroAddress } from 'viem';
import { falcon512padded } from '@noble/post-quantum/falcon.js';
import { crossChainDeployments } from '../src/lib/falcon/crossChainDeployment.ts';
import { l1ActionDigest, l1ControllerAbi, l1ControllerFactoryAbi } from '../src/lib/falcon/l1Action.ts';
import { managerAbi } from '../src/lib/falcon/l1Controller.ts';
import { safeFactoryAbi, safeAbi } from '../src/lib/falcon/safe.ts';
import { fromHex } from '../src/lib/falcon/falcon.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { fixture, origin } from './falcon/fixture.mjs';

const devnetCode = JSON.parse(readFileSync(new URL('./falcon/fixtures/deployed-code.json', import.meta.url), 'utf8'));
const testnetCode = JSON.parse(readFileSync(new URL('./falcon/fixtures/testnet-deployed-code.json', import.meta.url), 'utf8'));
const account = '0x'+'88'.repeat(20), controller = '0x'+'11'.repeat(20), owner = '0x'+'22'.repeat(20), safe = '0x'+'33'.repeat(20);
const txHash = '0x'+'ab'.repeat(32), blockHash = '0x'+'cd'.repeat(32);
const revertedCreationHash = '0x'+'ac'.repeat(32);
const controllerTxHash = '0x'+'c1'.repeat(32);
const oldFundingHash = '0x'+'f0'.repeat(32);
const settlementHash = '0x'+'ee'.repeat(32), l1BlockHash = '0x'+'ef'.repeat(32), fundingHash = '0x'+'fa'.repeat(32);
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const d of crossChainDeployments) for (const [name, type] of [['Rabby','0x0'], ['MetaMask','0x2']]) for (const missingNetwork of [false, true]) {
    const blockNumber = d.l1.anchor.blockNumber + 100n;
    const code = d.l2.chainId === 699169 ? { ...devnetCode, ...testnetCode } : devnetCode;
    let publicKey, publicKeyHashForReads, consumed = 0n, sent;
    let holdSettlement = d.l2.chainId === 699169 && name === 'MetaMask' && !missingNetwork;
    const needsController = d.l2.chainId === 699169 && missingNetwork;
    let controllerReady = !needsController;
    const controllerSends = [];
    let failFirstReceipt = missingNetwork && name === 'MetaMask';
    const quotes = [], sends = [], walletCalls = [], observationCalls = [], fundingSends = [];
    let safeBalance = 0n, mockRpc;
    let optionFailure = false;
    let revertNextCreation = false;
    const f = await fixture(browser, { deployment: d, rpc: async request => { observationCalls.push(request); return mockRpc(request); }, quote: async ([intent, options]) => {
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
    mockRpc = async ({ method, params, chain }) => {
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_getLogs') return [];
      if (method === 'eth_getTransactionBySenderAndNonce') return name === 'MetaMask' && controllerSends.length ? { hash: controllerTxHash } : null;
      if (method === 'eez_getSettlementByL2Block' && holdSettlement) return null;
      if (method === 'eez_getSettlementByL2Block') return { canonicalL2: true, l1BlockNumber: toHex(blockNumber), l1BlockHash, l1TransactionHash: settlementHash, l2Blocks: [{ hash: blockHash, number: toHex(blockNumber) }] };
      if (method === 'eth_sendTransaction' && same(params[0].to, d.l2.factory.address)) {
        assert.equal(decodeFunctionData({ abi: l1ControllerFactoryAbi, data: params[0].data }).functionName, 'createController');
        controllerReady = true; controllerSends.push(params[0]); return controllerTxHash;
      }
      if (method === 'eth_sendTransaction' && same(params[0].to, safe)) {
        assert.equal(params[0].chainId, toHex(d.l1.chainId)); assert.equal(params[0].data, '0x');
        fundingSends.push(params[0]); return fundingHash;
      }
      if (method === 'eth_sendTransaction') {
        assert.deepEqual(params[0], quotes.at(-1).tx, 'send only the exact fresh SDK wallet fields');
        sent = signedAction(params[0].data);
        sends.push(params[0]);
        if (revertNextCreation) { revertNextCreation = false; return revertedCreationHash; }
        consumed++;
        return txHash;
      }
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? blockNumber : BigInt(params[0]);
        return { number: toHex(number), hash: number === 0n ? d.l2.anchor.blockHash : number === d.l1.anchor.blockNumber ? d.l1.anchor.blockHash : BigInt(chain) === BigInt(d.l1.chainId) ? l1BlockHash : blockHash,
          timestamp: toHex(Math.floor(Date.now()/1000)), gasLimit: '0x1000000', gasUsed:'0x0', baseFeePerGas: '0x3', transactions: [] };
      }
      if (method === 'eth_blockNumber') return toHex(blockNumber);
      if (method === 'eth_getCode' && same(params[0], safe)) return testnetCode.safeProxy.code;
      if (method === 'eth_getStorageAt') return params[1].startsWith('0x4a204f') ? toHex(0n, {size:32}) : pad(d.l1.safe.fallbackHandler.address, {size:32});
      if (method === 'eth_estimateGas') return toHex(25000n);
      if (method === 'eth_gasPrice') return toHex(BigInt(chain) === BigInt(d.l1.chainId) ? 7n : 1000000000n);
      if (method === 'eth_getCode') return Object.values(code).find(c => same(c.address, params[0]))?.code ?? '0x';
      if (method === 'eth_getBalance') return toHex(same(params[0], safe) ? safeBalance : 10n**18n);
      if (method === 'eth_getTransactionCount') { assert.equal(params[1], 'pending'); return BigInt(chain) === BigInt(d.l1.chainId) ? '0x1' : '0x0'; }
      if (method === 'eth_getTransactionByHash' && [fundingHash, oldFundingHash].includes(params[0])) return { hash: params[0], from: account, to: safe, value: fundingSends[0].value, input: '0x', chainId: toHex(d.l1.chainId), blockHash: l1BlockHash, blockNumber: toHex(blockNumber), type: '0x0', nonce: params[0] === oldFundingHash ? '0x0' : fundingSends[0].nonce, gas: '0x7530', gasPrice: '0x3b9aca00', transactionIndex: '0x0', v: '0x1b', r: toHex(1n,{size:32}), s: toHex(1n,{size:32}) };
      if (method === 'eth_getTransactionByHash' && params[0] === controllerTxHash) return { hash: controllerTxHash, from: account, to: d.l2.factory.address, value: '0x0', input: controllerSends[0].data,
        chainId: toHex(d.l2.chainId), blockHash, blockNumber: toHex(blockNumber), type: '0x0', nonce: controllerSends[0].nonce, gas: controllerSends[0].gas, gasPrice: '0x4', transactionIndex: '0x0', v: '0x1b', r: toHex(1n,{size:32}), s: toHex(1n,{size:32}) };
      if (method === 'eth_getTransactionReceipt' && params[0] === controllerTxHash) return { transactionHash: controllerTxHash, blockHash, blockNumber: toHex(blockNumber), transactionIndex: '0x0', from: account, to: d.l2.factory.address, status: '0x1', type, gasUsed: '0x7530', effectiveGasPrice: '0x4', cumulativeGasUsed: '0x7530', logs: [] };
      if (method === 'eth_getTransactionReceipt' && [settlementHash, fundingHash].includes(params[0])) {
        if (params[0] === fundingHash) safeBalance = BigInt(fundingSends[0].value);
        return { transactionHash: params[0], blockHash: l1BlockHash, blockNumber: toHex(blockNumber), transactionIndex: '0x0', from: account, to: params[0] === fundingHash ? safe : d.l1.registry, status: '0x1', type: '0x0', gasUsed: '0x7530', effectiveGasPrice: '0x3b9aca00', cumulativeGasUsed: '0x7530', logs: [] };
      }
      if (method === 'eth_getTransactionReceipt' && params[0] === revertedCreationHash) return {
        transactionHash: revertedCreationHash, blockHash, blockNumber: toHex(blockNumber), transactionIndex: '0x0',
        from: account, to: controller, status: '0x0', type, gasUsed: '0x5208', effectiveGasPrice: '0x4', cumulativeGasUsed: '0x5208', logs: [],
      };
      if (method === 'eth_getTransactionReceipt' && failFirstReceipt) { failFirstReceipt = false; throw new Error('Temporary receipt RPC error'); }
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
          : same(to, d.l1.safe.factory.address) ? safeFactoryAbi : same(to, safe) ? safeAbi : managerAbi;
        const { functionName, args: readArgs } = decodeFunctionData({ abi, data });
        if (functionName === 'controllers') publicKeyHashForReads = readArgs[0];
        const values = { verifier: d.l2.verifier.address, eezL2: d.l2.manager, l1ChainId: BigInt(d.l1.chainId), controllers: controllerReady ? controller : zeroAddress,
          publicKeyHash: publicKeyHashForReads ?? (publicKey ? keccak256('0x'+publicKey) : toHex(0n, {size:32})), nonce: same(to, safe) ? 0n : consumed,
          ROLLUP_ID: d.l2.rollupId, USE_GAS_LEFT: false, singleton: d.l1.safe.singleton.address, fallbackHandler: d.l1.safe.fallbackHandler.address,
          computeCrossChainProxyAddress: owner, safes: consumed > 0n ? safe : zeroAddress,
          masterCopy: d.l1.safe.singleton.address, VERSION: '1.4.1', getOwners: [owner], getThreshold: 1n,
          getModulesPaginated: [[], '0x'+'0'.repeat(39)+'1'], authorizedProxies: [true, controller, d.l2.rollupId], getTransactionHash: keccak256('0x1234') };
        const result = functionName === 'checkAuthorization' ? signedAction(data).digest
          : functionName === 'actionDigest' ? l1ActionDigest({ ...decodeAction(data), sourceChainId: BigInt(d.l2.chainId), destinationChainId: BigInt(d.l1.chainId), controller, eezL2: d.l2.manager })
          : values[functionName];
        assert.notEqual(result, undefined, `unexpected contract function ${functionName}`);
        return encodeFunctionResult({ abi, functionName, result });
      }
      throw new Error(`Unexpected wallet RPC ${method}`);
    };
    await page.exposeFunction('falconWalletRpc', request => {
      walletCalls.push(request);
      assert(!request.method.startsWith('eez_'), 'custom settlement RPC must never go through the wallet');
      return mockRpc(request);
    });
    function decodeAction(data) {
      const { args: [target, payload, nonce, deadline] } = decodeFunctionData({ abi: l1ControllerAbi, data });
      return { target, data: payload, nonce, deadline };
    }
    await page.addInitScript(({ name, account, controller, missingNetwork, l2Chain }) => {
      const listeners = new Map();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedSafeAddress = value; } } });
      const mock = window.falconWalletTest = { account, chain: '0x27d8', calls: [], holdRead: false, holdSend: false, release: null, pendingChainEvent: null,
        knownChains: missingNetwork ? ['0x27d8'] : ['0x27d8', l2Chain], rejectAdd: false, rejectNextSend: false, loseNextSendReply: false };
      mock.emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
      const provider = { isMetaMask: true, isRabby: name === 'Rabby',
        on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
        removeListener: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== fn)),
        request: async ({ method, params }) => {
          mock.calls.push({ method, params });
          if (method === 'eth_chainId') return mock.chain;
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            // Extensions may acknowledge a switch before delivering chainChanged.
            if (mock.pendingChainEvent) { const chain = mock.pendingChainEvent; mock.pendingChainEvent = null; mock.emit('chainChanged', chain); }
            return [mock.account];
          }
          if (method === 'wallet_switchEthereumChain') {
            if (!mock.knownChains.includes(params[0].chainId)) throw name === 'MetaMask'
              ? { code: -32603, data: { originalError: { code: 4902, message: 'Unknown chain' } } }
              : { code: 4902, message: 'Unknown chain' };
            mock.chain = params[0].chainId;
            if (name === 'MetaMask') mock.pendingChainEvent = mock.chain;
            else mock.emit('chainChanged', mock.chain);
            return null;
          }
          if (method === 'wallet_addEthereumChain') {
            if (mock.rejectAdd) throw { code: 4001, message: 'User rejected adding network' };
            mock.knownChains.push(params[0].chainId); return null;
          }
          if (/addEthereumChain|updateEthereumChain|sign/i.test(method)) throw new Error(`Unexpected wallet mutation ${method}`);
          if (method === 'eth_sendTransaction' && mock.rejectNextSend) {
            mock.rejectNextSend = false; throw { code: 4001, message: 'User rejected transaction' };
          }
          if (mock.holdRead && method === 'eth_call' && params[0].to.toLowerCase() === controller.toLowerCase()) {
            mock.holdRead = false; await new Promise(resolve => { mock.release = resolve; });
          }
          if (mock.holdSend && method === 'eth_sendTransaction') {
            mock.holdSend = false; await new Promise(resolve => { mock.release = resolve; });
          }
          const result = await window.falconWalletRpc({ method, params, chain: mock.chain });
          if (method === 'eth_sendTransaction' && mock.loseNextSendReply) { mock.loseNextSendReply = false; throw new Error('Wallet connection interrupted after submission'); }
          return result;
        },
      };
      const detail = { info: { uuid: 'falcon-wallet-test', name, rdns: name === 'Rabby' ? 'io.rabby' : 'io.metamask' }, provider };
      window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
    }, { name, account, controller, missingNetwork, l2Chain: toHex(d.l2.chainId) });
    await page.goto(origin + '/');
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await f.toggle(); await f.tab.click(); await page.locator('#generate').waitFor();
    await page.getByText(new RegExp(`Gas wallet · ${name}`)).waitFor();
    const status = text => page.waitForFunction(text => document.querySelector('#safe-status')?.textContent.includes(text), text);
    const setup = page.getByRole('group', { name: `${d.l2.chainName} wallet connection`, exact: true });
    const connectNetwork = setup.getByRole('button');
    await connectNetwork.waitFor();
    assert.equal(await page.evaluate(() => window.falconWalletTest.calls.filter(c => /wallet_(switch|add)EthereumChain/.test(c.method)).length), 0, 'entering the demo never opens a wallet prompt');
    if (missingNetwork) {
      await page.evaluate(() => { window.falconWalletTest.rejectAdd = true; });
      await connectNetwork.click();
      await setup.getByText(/Network setup cancelled/).waitFor();
      assert.equal(sends.length, 0);
      await page.evaluate(() => { window.falconWalletTest.rejectAdd = false; });
    }
    await connectNetwork.click();
    await page.waitForFunction(chain => window.falconWalletTest.chain === chain, toHex(d.l2.chainId));
    await setup.waitFor({ state: 'hidden' });
    if (missingNetwork) {
      const added = await page.evaluate(() => window.falconWalletTest.calls.filter(c => c.method === 'wallet_addEthereumChain').at(-1).params[0]);
      assert.deepEqual(added, { chainId: toHex(d.l2.chainId), chainName: d.l2.chainName,
        rpcUrls: [new URL('/composer/l2', origin).href], nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 }, blockExplorerUrls: [d.l2.explorer] });
    }
    assert.equal(sends.length, 0, 'network setup never sends a transaction');
    await page.locator('#generate').click();
    await page.waitForFunction(() => document.querySelector('#key-status')?.textContent.includes('Key generated'));
    publicKey = await page.getByTestId('public-key').inputValue();
    await status(needsController ? 'No Safe exists' : 'Controller ready');
    assert.equal(await page.locator('#safe-load').count(), 0, 'key installation automatically loads the Safe');
    assert.equal(sends.length + controllerSends.length, 0, 'automatic loading never creates or sends a transaction');
    assert.match(await page.locator('#safe-status').textContent(), needsController ? /No Safe exists/ : /Controller ready/, 'late switch events must not break Safe loading');
    assert.equal(await page.locator('#safe-balance, #safe-nonce, #safe-sign, #safe-send').count(), 0, 'before creation show one Create Safe action, not empty balances or signing steps');
    await page.getByRole('button', { name: 'Create Safe', exact: true }).waitFor();
    // A structured option failure never falls through to an unquoted send.
    optionFailure = true;
    if (needsController) {
      await page.evaluate(() => { const w = window.falconWalletTest; w.loseNextSendReply = true; w.holdSend = true; w.release = null; });
      await page.locator('#safe-create').click();
      await page.waitForFunction(() => !!window.falconWalletTest.release);
      assert.equal(await page.locator('#controller-recovery-hash').count(), 0, 'normal wallet approval never shows a recovery textbox');
      await page.evaluate(() => window.falconWalletTest.release());
      if (name === 'Rabby') {
        await page.getByText('Earlier setup needs attention', { exact: true }).waitFor();
        assert.equal(await page.locator('#controller-recovery-hash').isVisible(), false, 'unresolved recovery starts collapsed');
        await page.getByText('Earlier setup needs attention', { exact: true }).click();
        const recovery = page.getByRole('group', { name: 'Recover controller setup', exact: true });
        assert.equal(controllerSends.length, 1);
        assert.equal(await page.locator('#safe-create').isDisabled(), true, 'unknown setup submission blocks another controller');
        await page.locator('#controller-recovery-hash').fill(controllerTxHash);
        await recovery.getByRole('button', { name: 'Recover controller setup', exact: true }).click();
      }
      await status('Safe setup confirmed');
      assert.equal(controllerSends.length, 1, 'recovery never creates another controller');
      assert.equal(await page.locator('#controller-recovery-hash').count(), 0);
    }
    await page.locator('#safe-create').click(); await status('quote_limit');
    assert.equal(sends.length, 0);
    optionFailure = false;
    // Account or chain events must invalidate pending reads, even after changing back.
    for (const event of ['accountsChanged', 'chainChanged']) {
      await page.evaluate(() => { window.falconWalletTest.holdRead = true; window.falconWalletTest.release = null; });
      await page.locator('#safe-create').click();
      await page.waitForFunction(() => !!window.falconWalletTest.release);
      await page.evaluate(event => {
        const w = window.falconWalletTest;
        w.emit(event, event === 'accountsChanged' ? ['0x'+'99'.repeat(20)] : '0x1');
        w.emit(event, event === 'accountsChanged' ? [w.account] : w.chain);
        w.release();
      }, event);
      await status('changed'); assert.equal(sends.length, 0);
    }
    if (name === 'MetaMask' && !missingNetwork) {
      revertNextCreation = true;
      await page.locator('#safe-create').click(); await status('Transaction reverted');
      assert.equal(sends.length, 1);
      assert.equal(consumed, 0n, 'reverted creation does not consume the controller nonce');
      assert.equal(await page.locator('#safe-create').isEnabled(), true, 'canonical revert allows an explicit retry');
      assert.equal(await page.locator('#safe-source-tx').getAttribute('href'), `${d.l2.explorer}/tx/${revertedCreationHash}`);
    }
    const attemptsBeforeSuccess = sends.length;
    const quoted = quotes.length;
    if (name === 'Rabby') await page.evaluate(() => { window.falconWalletTest.holdSend = true; window.falconWalletTest.release = null; });
    await page.locator('#safe-create').click();
    if (name === 'Rabby') {
      await page.waitForFunction(() => !!window.falconWalletTest.release);
      await page.locator('#lock').click();
      await page.evaluate(() => window.falconWalletTest.release());
    }
    if (holdSettlement) {
      const deadline = Date.now() + 10000;
      while (!observationCalls.some(call => call.method === 'eez_getSettlementByL2Block') && Date.now() < deadline) await page.waitForTimeout(25);
      assert(observationCalls.some(call => call.method === 'eez_getSettlementByL2Block'));
      assert.equal(await page.locator('#safe-send-heading').count(), 0, 'send form stays hidden before confirmed L1 execution');
      holdSettlement = false;
    }
    await status('Safe created on');
    assert.equal(await page.locator('#safe-check-source, #safe-check-l1, #safe-replay').count(), 0);
    assert(observationCalls.some(call => call.method === 'eez_getSettlementByL2Block' && call.path.endsWith('/composer/l2')));
    assert(walletCalls.every(call => call.method !== 'eez_getSettlementByL2Block'));
    assert.equal(quotes.length, quoted+1, 'obtain a fresh quote immediately before send');
    assert.equal(sends.length, attemptsBeforeSuccess + 1, 'explicit retry sends one fresh creation transaction');
    assert.equal(await page.locator('#safe-trace').getAttribute('href'), `#/visualizer?mode=trace&chain=l2&tx=${txHash}`);
    assert.equal(await page.locator('#safe-trace').getAttribute('target'), '_blank', 'trace must preserve the active Falcon session');
    assert(await page.locator(`a[href$="${txHash}"]`).count() > 0, 'retain the hash even if the Falcon key is switched during the prompt');
    const calls = await page.evaluate(() => window.falconWalletTest.calls);
    assert.equal(calls.filter(c => c.method === 'eth_requestAccounts').length, 1, 'the demo reuses the header connection');
    assert(calls.some(c => c.method === 'wallet_switchEthereumChain'));
    assert.equal(calls.filter(c => c.method === 'wallet_addEthereumChain').length, missingNetwork ? 2 : 0, 'known networks are not re-added');
    assert(!calls.some(c => /updateEthereumChain|sign/i.test(c.method)));
    assert.equal(walletCalls.filter(c => c.method === 'eth_estimateGas').length, needsController ? 1 : 0, 'only first-time controller setup uses wallet gas estimation');
    assert.equal(controllerSends.length, needsController ? 1 : 0);
    assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, attemptsBeforeSuccess + 1 + controllerSends.length);
    assert(calls.filter(c => c.method === 'wallet_switchEthereumChain').every(c => c.params[0].chainId === toHex(d.l2.chainId)), 'Safe reads and confirmation must not switch the wallet to L1');
    if (name === 'MetaMask' && d.l2.chainId === 699169) {
      assert.equal(await page.locator('#safe-balance').textContent(), '0');
      await page.locator('#safe-recipient').fill('0x'+'99'.repeat(20));
      await page.locator('#safe-sign').click(); await status('Safe balance is too low');
      assert.equal(await page.evaluate(() => window.falconWalletTest.chain), toHex(d.l2.chainId));
      assert.equal(await setup.count(), 0);
      assert.equal(await page.locator('#safe-fund-amount').inputValue(), '0.01');
      await page.locator('#safe-fund-amount').fill('0.02');
      await page.evaluate(() => { window.falconWalletTest.rejectNextSend = true; });
      await page.locator('#safe-fund').click();
      await page.getByRole('status').filter({ hasText: 'Funding cancelled in your wallet.' }).waitFor();
      assert.equal(fundingSends.length, 0, 'cancelled funding never broadcasts');
      if (!missingNetwork) await page.evaluate(() => { window.falconWalletTest.loseNextSendReply = true; });
      await page.locator('#safe-fund').click();
      if (!missingNetwork) {
        const recovery = page.getByRole('group', { name: 'Recover funding transaction', exact: true });
        await recovery.waitFor();
        await page.locator('#funding-recovery-hash').fill(oldFundingHash);
        await recovery.getByRole('button', { name: 'Recover funding', exact: true }).click();
        await status('does not match the recorded');
        assert.equal(fundingSends.length, 1, 'an older identical transfer cannot clear the current attempt');
        // A fresh demo has neither an unlocked key nor a loaded Safe. The
        // durable recovery controls must still be available there and on reload.
        const reopened = await f.context.newPage();
        await f.open(reopened);
        const restored = reopened.getByRole('group', { name: 'Recover funding transaction', exact: true });
        await restored.waitFor();
        assert.equal(await reopened.getByTestId('public-key').count(), 0);
        await reopened.reload(); await restored.waitFor();
        assert.equal(fundingSends.length, 1, 'reload restores recovery without another send');
        await reopened.close();
        assert(await page.locator('#safe-fund').isDisabled(), 'ambiguous funding must not be resent');
        await page.locator('#funding-recovery-hash').fill(fundingHash);
        await recovery.getByRole('button', { name: 'Recover funding', exact: true }).click();
      }
      await page.getByRole('status').filter({ hasText: 'Safe funded with 0.02' }).waitFor();
      assert.equal(fundingSends.length, 1);
      assert.equal(BigInt(fundingSends[0].value), 20000000000000000n);
      assert.equal(fundingSends[0].to.toLowerCase(), safe.toLowerCase());
      assert.equal(await page.locator('#safe-balance').textContent(), '0.02');
      assert.match(await page.getByTestId('falcon-wallet-l1-balance').textContent(), /xDAI/);
      assert.match(await page.getByTestId('falcon-wallet-l2-balance').textContent(), /xDAI/);
      assert.equal(await page.evaluate(() => window.falconWalletTest.chain), toHex(d.l1.chainId), 'funding was sent on L1');
      assert.equal(await setup.count(), 0, 'funding must not bring back setup for an already confirmed L2 network');
      await page.screenshot({ path: '/tmp/falcon-safe-funded.png', fullPage: true });
      await page.getByRole('button', {name:'Copy Safe address',exact:true}).click();
      assert.equal(await page.evaluate(() => window.copiedSafeAddress), safe);
      assert.equal(await page.locator('#safe-load').count(), 0, 'loaded account replaces onboarding');
      assert.equal(await page.locator('#safe-estimate-fee, #safe-l1-trace').count(), 0);
      await page.locator('#safe-sign').click(); await status('Falcon signature ready');
      await page.locator('#safe-fee-total').waitFor();
      await page.waitForFunction(() => !document.querySelector('#safe-send').disabled);
      await page.getByRole('heading', { name: 'Your Safe account', exact: true }).hover();
      await page.waitForTimeout(250); // Let button color transitions settle for the visual capture.
      await page.screenshot({ path: '/tmp/falcon-safe-signed.png', fullPage: true });
      assert.equal(await page.evaluate(() => window.falconWalletTest.chain), toHex(d.l2.chainId), 'signing switches to the existing network when needed');
      assert.equal(await setup.count(), 0);
      await page.locator('#safe-data-options > summary').click();
      await page.locator('#safe-data').fill('0xdeadbeef');
      await page.locator('#safe-amount').fill('0');
      assert(await page.locator('#safe-send').isDisabled(), 'data edits invalidate the old authorization');
      assert.equal(await page.locator('#safe-fee-total').count(), 0);
      await page.evaluate(() => {
        let state = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange')); state = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
        delete document.visibilityState;
      });
      assert.equal(await page.getByTestId('public-key').inputValue(), publicKey, 'backgrounding alone keeps the unlocked key');
      await page.locator('#safe-sign').click(); await status('Falcon signature ready');
      await page.locator('#safe-fee-total').waitFor();
      const outer = decodeFunctionData({abi:l1ControllerAbi,data:quotes.at(-1).tx.data});
      const inner = decodeFunctionData({abi:safeAbi,data:outer.args[1]});
      assert.equal(inner.args[1],0n); assert.equal(inner.args[2],'0xdeadbeef');
      assert.match(await page.getByTestId('cost-actual').textContent(), /¢/);
      assert.equal(await page.getByTestId('cost-without-eez').textContent(), '0.55¢');
      assert(!f.requests.some(request => request.url.startsWith('https://api.coinbase.com/')), 'xDAI costs must not fetch or multiply by ETH/USD');
      await page.screenshot({path:'/tmp/falcon-account-transaction.png',fullPage:true});
      await page.setViewportSize({width:390,height:900});
      await page.screenshot({path:'/tmp/falcon-account-mobile.png',fullPage:true});
      const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1
          || el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')
          .slice(0, 20).map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: el.getBoundingClientRect().right,
            width: el.clientWidth, scrollWidth: el.scrollWidth, text: el.textContent.slice(0, 70) })) }));
      assert(overflow.scrollWidth <= overflow.width, `account and calldata fit on mobile: ${JSON.stringify(overflow)}`);
      await page.setViewportSize({width:1440,height:1000});
      if (!missingNetwork) {
        await page.locator('#backup-options input[name="password"]').fill('test-falcon-backup-123');
        await page.locator('#backup-options input[name="confirmation"]').fill('test-falcon-backup-123');
        await page.locator('#remember').click();
        await page.waitForFunction(() => document.querySelector('#key-status').dataset.result === 'valid');
        await page.reload(); await page.locator('#unlock-saved').waitFor();
        assert.equal(await page.getByTestId('public-key-hash').count(), 0, 'reload clearly locks the key');
        await page.getByLabel('Saved key password',{exact:true}).fill('test-falcon-backup-123');
        await page.locator('#unlock-saved').click();
        await page.waitForFunction(() => document.querySelector('#key-status').textContent.includes('Saved key unlocked'));
        assert.equal(await page.getByTestId('public-key').inputValue(),publicKey);
        await page.getByText(new RegExp(`Gas wallet · ${name}`)).waitFor();
        await status('Safe loaded');
        assert.equal(await page.locator('#safe-load').count(), 0);
        await page.locator('#safe-recipient').fill('0x'+'99'.repeat(20));
        await page.locator('#safe-sign').click(); await status('Falcon signature ready');
        await page.locator('#safe-fee-total').waitFor();
      }
      await page.evaluate(() => {
        const w = window.falconWalletTest;
        w.knownChains = ['0x27d8']; w.chain = '0x27d8'; w.emit('chainChanged', w.chain);
      });
      await page.locator('#safe-recipient').fill('0x'+'77'.repeat(20));
      await page.locator('#safe-sign').click(); await status('is not in your wallet');
      await setup.getByRole('button', { name: `Add ${d.l2.chainName}`, exact: true }).waitFor();
      assert.equal(sends.length, attemptsBeforeSuccess + 1, 'missing-network recovery must not send another Safe transaction');
    }
    await f.close();
  }
  console.log('Falcon dashboard wallet checks passed on both networks for Rabby/legacy and MetaMask/EIP-1559 (mock RPC, real browser signatures; no live settlement).');
} finally { await browser.close(); }
