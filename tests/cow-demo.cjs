// Run against a production preview. Demo API and all RPCs are mocked.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeEventTopics, encodeAbiParameters, parseAbi, encodeFunctionResult, keccak256, stringToHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const shortcut = 'Control+Alt+Shift+KeyT';

async function fixture(browser, { mismatch = false, unavailable = false, stale = false, wallet = false, changeDuringSign = false, lostResponse = false, rejectSwitch = false, reverted = false, faucetDelayed = false, mainnet = false, composer = 'detected', wrongNetwork = false, missingNetwork = false, missingL1Network = false, faucetFeeFailure = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [], errors = [];
  const signed = [], transactions = [], submitted = [], walletRequests = [];
  let approved = false;
  let faucetClaimed = false;
  let faucetChecks = 0;
  if (wallet) {
    await page.exposeFunction('recordWalletRequest', (method, params) => {
      walletRequests.push({ method, params });
      if (method === 'eth_signTypedData_v4') signed.push(JSON.parse(params[1]));
    });
    await page.exposeFunction('recordWalletTransaction', tx => {
      transactions.push(tx); if (tx.data === '0x4e71d92d') faucetClaimed = true; else approved = true;
    });
    await page.exposeFunction('composerDiscoveryResponse', (data, chain, mode) => {
      if (mode === 'not-detected') return '0x';
      if (mode === 'unavailable') throw new Error('Wallet RPC unavailable');
      return encodeFunctionResult({
        abi: parseAbi(['function composerInfo(bytes32 nonce) view returns (bytes32,uint256,bytes32,uint256,bytes)']),
        functionName: 'composerInfo',
        result: [keccak256(stringToHex('EEZ_COMPOSER_DISCOVERY')), 1n, '0x' + data.slice(10), BigInt(chain), stringToHex(JSON.stringify({
          version: 'test', supportedNetworks: { eezL1: mainnet ? 1 : 10200, eezL2: mode === 'mismatch' ? 999 : 6290 },
          eezContracts: { eezRegistryAddress: '0x' + '11'.repeat(20), eezL2Address: '0x' + '22'.repeat(20) },
        }))],
      });
    });
    await page.addInitScript(({ changeDuringSign, rejectSwitch, composer, wrongNetwork, missingNetwork, missingL1Network }) => {
      let account = '0x'+'88'.repeat(20), chain = rejectSwitch || wrongNetwork || missingNetwork ? '0x27d8' : '0x1892';
      const knownNetworks = new Set(missingNetwork ? ['0x27d8'] : ['0x27d8', '0x1892']);
      if (missingL1Network) knownNetworks.delete('0x27d8');
      window.rejectTestNetworkAdd = false;
      const listeners = {};
      let composerMode = composer;
      window.setTestComposer = value => { composerMode = value; };
      window.changeTestAccount = () => { account = '0x'+'99'.repeat(20); (listeners.accountsChanged || []).forEach(fn => fn([account])); };
      window.ethereum = { isMetaMask: true,
        on(event, fn) { (listeners[event] ||= []).push(fn); },
        removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter(x => x !== fn); },
        async request({ method, params }) {
          await window.recordWalletRequest(method, params);
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
          if (method === 'eth_chainId') return chain;
          if (method === 'eth_call' && params[0].to.toLowerCase() === '0x7ae2c80116976915a0ee9b7994e7bb12026087f8') {
            if (window.delayTestComposer && chain === '0x27d8') await new Promise(resolve => (window.testComposerWaiters ||= []).push(resolve));
            return window.composerDiscoveryResponse(params[0].data, chain, composerMode);
          }
          if (method === 'wallet_switchEthereumChain') {
            if (rejectSwitch) throw new Error('User rejected switch');
            if (window.rejectTestNetworkSwitch) throw { code: 4001, message: 'User rejected switch' };
            if (window.delayTestNetworkSwitch) await new Promise(resolve => { window.finishTestNetworkSwitch = resolve; });
            if (!knownNetworks.has(params[0].chainId)) throw { code: 4902, message: 'Unknown chain' };
            chain = params[0].chainId; (listeners.chainChanged || []).forEach(fn => fn(chain)); return null;
          }
          if (method === 'wallet_addEthereumChain') {
            if (window.rejectTestNetworkAdd) throw { code: 4001, message: 'User rejected network setup' };
            knownNetworks.add(params[0].chainId); return null;
          }
          if (method === 'eth_sendTransaction') {
            if (window.delayTestTransaction) await new Promise(resolve => { window.finishTestTransaction = resolve; });
            if (window.rejectTestTransaction) throw { code: 4001, message: 'User rejected transaction' };
            if (window.ambiguousTestTransaction) throw new Error('Wallet disconnected before returning a transaction hash');
            await window.recordWalletTransaction(params[0]);
            return '0x'+'aa'.repeat(32);
          }
          if (method === 'eth_signTypedData_v4') {
            if (changeDuringSign) { window.changeTestAccount(); await new Promise(resolve => setTimeout(resolve, 100)); }
            return '0x'+'bb'.repeat(65);
          }
          return null;
        },
      };
    }, { changeDuringSign, rejectSwitch, composer, wrongNetwork, missingNetwork, missingL1Network });
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.includes('cowdemo') || /CowLightDemo-.*\.js$/.test(path)) requests.push(path);
    if (path.endsWith('/cowdemo/api/config')) return route.fulfill({
      status: unavailable || stale ? 503 : 200,
      json: stale ? { status: 'deployment_required' }
        : { network: mainnet ? 'mainnet' : 'chiado', l2NativeSymbol: mainnet ? 'ETH' : 'XDAI', l1ChainId: mismatch || mainnet ? 1 : 10200, l2ChainId: mismatch ? 696990 : 6290,
          settlement: '0x'+'11'.repeat(20), vaultRelayer: '0x'+'22'.repeat(20), wethL2: '0x'+'33'.repeat(20), nativeWethL2: mainnet ? '0x'+'aa'.repeat(20) : null, bridgeL2: '0x'+'44'.repeat(20) },
    });
    if (path.endsWith('/cowdemo/api/tokens')) return route.fulfill({ json: { tokens: [
      { address: '0x'+'55'.repeat(20), pair: '0x'+'66'.repeat(20), symbol: 'ctUSD', name: 'Test USD', decimals: 18 },
      { address: '0x'+'12'.repeat(20), pair: '0x'+'34'.repeat(20), symbol: 'TEST', name: 'Second token', decimals: 18, wethReserve: '1000000000000000000' },
    ] } });
    if (path.endsWith('/cowdemo/api/wrapper')) {
      const token = new URL(request.url()).searchParams.get('token');
      return route.fulfill({ json: { token, wrapper: '0x'+'77'.repeat(20), deployed: token === '0x'+'55'.repeat(20) } });
    }
    if (path.endsWith('/cowdemo/api/allowance')) return route.fulfill({ json: { balance: '1000000000000000000', allowance: approved ? '1000000000000000' : '0' } });
    if (path.endsWith('/cowdemo/api/faucet')) {
      const delivered = faucetClaimed && (!faucetDelayed || ++faucetChecks > 2);
      return route.fulfill({ json: {
      address: '0x'+'ef'.repeat(20), owner: '0x'+'88'.repeat(20), tokenAmount: '10000000000000000', gasAmount: '200000000000000',
      cooldown: 86400, nextClaimAt: faucetClaimed ? Math.floor(Date.now()/1000)+86400 : 0, funded: true, eligible: !faucetClaimed,
      l2TokenBalance: delivered ? '1010000000000000000' : '1000000000000000000', l2GasBalance: delivered ? '1200000000000000' : '1000000000000000',
    } }); }
    if (path.endsWith('/cowdemo/api/balances')) return route.fulfill({ json: { selected: { balance: '1000000000000000000' } } });
    if (path.endsWith('/cowdemo/api/quote')) return route.fulfill({ json: { amountIn: new URL(request.url()).searchParams.get('amount'), amountOut: '100000000000000000', tokenDecimals: 18, tokenSymbol: 'ctUSD', priceImpactBps: 30, block: 1234, pair: '0x'+'66'.repeat(20) } });
    if (path.endsWith('/cowdemo/api/orders')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        const row = { ...body, id: 'test-order', signer: '0x'+'88'.repeat(20), receivedAt: Date.now()/1000, status: 'settled', quote: { tokenSymbol: 'ctUSD', tokenDecimals: 18 }, solverDebug: { state: 'settled', txHash: '0x'+'cc'.repeat(32), l1Tx: '0x'+'dd'.repeat(32), message: 'Canonical settlement confirmed. Consensus finality is not asserted.' } };
        submitted.push(row);
        return lostResponse ? route.abort() : route.fulfill({ status: 202, json: row });
      }
      return route.fulfill({ json: { orders: submitted } });
    }
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: 'EEZ test', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      l1ExplorerUrl: 'https://chiado.example', l2ExplorerUrl: 'https://rollup.example',
      l1FeesEnabled: faucetFeeFailure,
    } });
    if (request.method() !== 'POST') return route.continue();
    const { id, method } = request.postDataJSON();
    assert.ok(!/send|sign/i.test(method), 'never broadcasts or signs');
    if (faucetFeeFailure && method === 'eez_quoteFee') return route.fulfill({ json: { jsonrpc:'2.0', id,
      error:{ code:-32000, message:'Fee quote temporarily unavailable' } } });
    const result = method === 'eth_chainId' ? (path.endsWith('l1') ? mainnet ? '0x1' : '0x27d8' : '0x1892')
      : method === 'eth_gasPrice' ? '0xb2d05e00'
      : method === 'eth_maxPriorityFeePerGas' ? '0x3b9aca00'
      : method === 'eth_getBlockByNumber' ? { baseFeePerGas:'0x77359400', hash:'0x'+'ee'.repeat(32), number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : method === 'eth_getTransactionReceipt' ? { status: reverted ? '0x0' : '0x1', blockNumber:'0x10',blockHash:'0x'+'ee'.repeat(32),logs:faucetClaimed ? [{address:'0x'+'ef'.repeat(20),
          topics:encodeEventTopics({abi:parseAbi(['event Claimed(address indexed recipient, uint256 tokenAmount, uint256 gasAmount)']),eventName:'Claimed',args:{recipient:'0x'+'88'.repeat(20)}}),
          data:encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[10000000000000000n,200000000000000n])}] : [] }
      : method === 'eth_getLogs' ? [] : method === 'eth_getBalance' ? '0x0' : null;
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  const nav = page.getByRole('navigation', { name: 'Dashboard sections' });
  const cow = nav.getByRole('button', { name: 'CoW Light Demo', exact: true });
  const treasury = nav.getByRole('button', { name: 'Treasury Demo', exact: true });
  const toggle = async () => { await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press(shortcut); };
  const hidden = async () => { assert.equal(await cow.count(), 0); assert.equal(await treasury.count(), 0); };
  return { context, page, nav, cow, treasury, requests, errors, toggle, hidden, signed, transactions, submitted, walletRequests };
}

module.exports = { fixture, origin };
if (require.main === module) (async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const f = await fixture(browser);
    await f.page.goto(origin + '/#/cow-demo');
    await f.nav.waitFor(); await f.hidden();
    assert.deepEqual(f.requests, [], 'hidden deep link does not load demo code or API');
    await f.toggle(); await f.treasury.waitFor(); await f.cow.waitFor();
    await f.cow.click();
    await f.page.getByRole('region', { name: 'Swap form' }).waitFor();
    assert.equal(await f.page.locator('iframe').count(), 0);
    assert.equal(await f.page.getByRole('region', { name: 'Transaction history', exact: true }).count(), 0);
    await f.page.reload();
    await f.page.getByRole('region', { name: 'Swap form' }).waitFor();
    await f.page.getByLabel(/You sell/).focus();
    await f.page.keyboard.press(shortcut);
    await f.cow.waitFor(); // Shortcut must not toggle while entering text.
    await f.page.getByRole('heading', { name: 'CoW Light', exact: true }).click();
    await f.page.keyboard.press(shortcut);
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.hidden();
    await f.page.evaluate(() => { location.hash = '#/cow-demo'; });
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    assert.deepEqual(f.errors, []);
    await f.context.close();

    for (const options of [{ mismatch: true }, { unavailable: true }, { stale: true }]) {
      const f = await fixture(browser, options);
      await f.page.goto(origin + '/#/cow-demo'); await f.nav.waitFor(); await f.hidden();
      await f.toggle(); await f.cow.click();
      await f.page.getByText(options.mismatch
        ? 'CoW Light is configured for a different network. It cannot be opened on this dashboard.'
        : options.stale ? 'CoW Light needs a verified deployment for the current network. Trading is disabled.'
        : 'CoW Light is not available for this network yet.', { exact: true }).waitFor();
      assert.equal(await f.page.locator('iframe').count(), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close();
    }
    console.log(JSON.stringify({ passed: true, hiddenTogether: true, guardedDeepLinks: true,
      sessionReload: true, nativeUI: true, wrongNetworkBlocked: true, unavailableHandled: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
