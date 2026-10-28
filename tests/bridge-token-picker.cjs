// EEZ_UI_URL=http://127.0.0.1:8083/dashboard NODE_PATH=<playwright modules> node tests/bridge-token-picker.cjs
// All configuration, wallet, explorer, and RPC responses are mocked. Never broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard';
const addr = c => '0x' + c.repeat(40);
const account = addr('2'), l1Token = addr('7'), l2Token = addr('8'), bridge = addr('1');
const dai = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const text = s => word(32) + BigInt(s.length).toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');
const meta = (address, chainId, symbol) => ({ address, chainId, symbol, name: symbol + ' token', decimals: 18 });

async function fixture(browser, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], calls = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ account, l1Token, l2Token, disconnected }) => {
    localStorage.setItem('bridgeRecentTokens', JSON.stringify([
      {address: l1Token, chainId: 10200, symbol: 'CHI', name: 'Chiado token', decimals: 18},
      {address: l2Token, chainId: 6290, symbol: 'ROLL', name: 'Rollup token', decimals: 18},
      {address: '0x' + '9'.repeat(40), symbol: 'OLD', name: 'Legacy token', decimals: 18},
    ]));
    if (!disconnected) {
      localStorage.setItem('walletConnected', 'true'); localStorage.setItem('walletProvider', 'legacy:0');
    }
    window.ethereum = { isRabby: true, on() {}, removeListener() {}, async request({method}) {
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0x27d8';
      throw new Error('Unexpected wallet operation: ' + method);
    }};
  }, {account, l1Token, l2Token, disconnected: !!options.disconnected});
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/config.json')) return route.fulfill({json: {
      networkName: 'EEZ-X Devnet', l1NetworkName: options.name || '',
      l1NetworkLogoUrl: options.logo || '',
      l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2', l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      demoBridgeAddress: bridge, l1ExplorerApiUrl: options.indexL1 ? '/tokens-l1' : '',
      l2ExplorerApiUrl: '/tokens-l2', tokenListUrl: options.custom ? '/tokens.json' : '',
    }});
    if (path === '/tokens.json') return route.fulfill({json: options.badList ? {} : { tokens: [
      meta(l1Token, 10200, 'CHI'), meta(l2Token, 6290, 'ROLL'), meta(addr('a'), 1, 'MAIN'),
      {...meta(addr('b'), 10200, 'INVALID'), decimals: -1},
    ]}});
    if (path.includes('/api/v2/addresses/')) {
      calls.push({path, method: 'token-balances'});
      if (options.delayL1 && path.startsWith('/tokens-l1')) await new Promise(r => setTimeout(r, 250));
      const isL1 = path.startsWith('/tokens-l1'), token = isL1 ? l1Token : l2Token;
      const item = (address, type, symbol, decimals='18', value=word(1)) => ({token: {address_hash: address, type, symbol, name: symbol + ' token', decimals}, value: BigInt(value).toString()});
      return route.fulfill({json: [item(token, 'ERC-20', isL1 ? 'CHI' : 'ROLL', '18', word(10n**18n)),
        item(addr('6'), 'ERC-20', 'INDEX', '18', word(10n**18n)),
        item(addr('c'), 'ERC-721', 'NFT'), item(addr('d'), 'ERC-20', 'EMPTY', '18', word(0)),
        item(addr('e'), 'ERC-20', 'NO_DECIMALS', null)]});
    }
    if (path.startsWith('/tokens-l2/api')) return route.fulfill({json: {status:'0',result:[]}});
    if (request.method() !== 'POST') return route.continue();
    const { id, method, params = [] } = request.postDataJSON(); calls.push({path, method, params});
    if (/send|sign/i.test(method)) { writes.push(method); return route.abort(); }
    const reply = result => route.fulfill({json: {jsonrpc: '2.0', id, result}});
    if (method === 'eth_chainId') return reply(path.endsWith('l1') ? options.chain || '0x27d8' : '0x1892');
    if (method === 'eth_getCode') return reply('0x6000');
    if (method === 'eth_getBalance') return reply(word(10n**19n));
    if (method === 'eth_getBlockByNumber') return reply({number:'0x10',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[],baseFeePerGas:'0x7',gasUsed:'0x0',gasLimit:'0x1c9c380'});
    if (method === 'eth_getLogs') return reply([]);
    if (method === 'eth_call') {
      const tx = params[0], selector = tx.data.slice(0,10);
      if (['0xb3f5aaab', '0x481c6a75'].includes(selector)) return reply('0x' + addr('3').slice(2).padStart(64,'0'));
      if (selector === '0x313ce567') return reply(word(18));
      if (selector === '0x95d89b41') return reply(text(tx.to.toLowerCase() === l2Token ? 'ROLL' : tx.to.toLowerCase() === dai.toLowerCase() ? 'DAI' : 'CHI'));
      if (selector === '0x06fdde03') return reply(text('Verified token'));
      if (selector === '0x70a08231') return reply(word([l1Token,l2Token,dai.toLowerCase()].includes(tx.to.toLowerCase()) ? 10n**18n : 0));
      return reply(word(0));
    }
    return reply('0x0');
  });
  await page.goto(origin + '/#/bridge');
  const panel = page.getByRole('region', {name:'Bridge transfers',exact:true});
  await panel.getByRole('group', {name:'Source network'}).getByText(options.name || (options.chain === '0x1' ? 'Ethereum' : options.chain === '0x539' ? 'L1 network (1337)' : 'Chiado'),{exact:true}).waitFor();
  if (!options.disconnected) await page.getByRole('button',{name:/Rabby ·/}).waitFor();
  await panel.getByRole('button', {name:/^Choose bridge asset on/}).first().click();
  await panel.getByRole('button', {name:'ERC20',exact:true}).click();
  return {page, panel, context, calls, errors, writes, async close() {assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);await context.close();}};
}
async function browse(f, filter) {
  await f.panel.getByRole('button',{name:'Browse tokens',exact:true}).click();
  await f.panel.getByRole('group',{name:'Token sources'}).getByRole('button',{name:filter,exact:true}).click();
  await f.panel.getByText('Loading tokens…',{exact:true}).waitFor({state:'hidden'});
}
(async () => {
  const browser = await chromium.launch({headless:true,chromiumSandbox: true});
  let f = await fixture(browser,{chain:'0x1'});
  await browse(f,'Known');
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),8);
  await f.panel.getByLabel('Search tokens').fill('dai');
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
  await f.panel.getByRole('button',{name:'Select DAI '+dai,exact:true}).click();
  assert.equal(await f.panel.getByLabel('Token address',{exact:true}).inputValue(),dai);
  await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('DAI',{exact:true}).waitFor();
  await browse(f,'Your tokens'); await f.panel.getByLabel('Search tokens').fill('');
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
  for (const width of [320,390,1440]) {
    await f.page.setViewportSize({width,height:900});
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'picker overflow at '+width);
    const tiny=await f.panel.evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.children.length===0&&el.textContent.trim()&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
    assert.deepEqual(tiny,[], 'Expanded token picker text below 12px at '+width);
  }
  assert.ok(f.calls.some(c=>c.path==='/rpc/l1' && c.method==='eth_call' && c.params[0].data.startsWith('0x70a08231')));
  await f.close();

  f = await fixture(browser); await browse(f,'Known');
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),0); // Never reuse mainnet catalog on Chiado.
  await f.panel.getByRole('button',{name:'Recent',exact:true}).click();
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
  assert.equal(await f.panel.getByRole('button',{name:'Select CHI '+l1Token,exact:true}).count(),1);
  await f.panel.getByTitle('Swap direction').click();
  await f.panel.getByRole('button',{name:'Select ROLL '+l2Token,exact:true}).waitFor();
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
  assert.equal(await f.panel.getByRole('button',{name:/Select OLD/}).count(),0);
  await f.close();

  f = await fixture(browser,{custom:true,indexL1:true}); await browse(f,'Known');
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
  await f.panel.getByRole('button',{name:'Your tokens',exact:true}).click();
  assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),2); // Includes an index-only token; excludes NFT, zero, missing decimals.
  assert.equal(await f.panel.getByRole('button',{name:'Select INDEX '+addr('6'),exact:true}).count(),1);
  await f.panel.getByTitle('Swap direction').click();
  await f.panel.getByRole('button',{name:'Select ROLL '+l2Token,exact:true}).waitFor();
  assert.equal(await f.panel.getByRole('button',{name:/Select CHI/}).count(),0);
  await f.panel.getByRole('button',{name:'Select INDEX '+addr('6'),exact:true}).click();
  assert.equal(await f.panel.getByLabel('Token address',{exact:true}).inputValue(),addr('6'));
  await f.close();

  f = await fixture(browser,{custom:true,badList:true}); await browse(f,'Known');
  await f.panel.getByText('The configured list is unavailable.',{exact:false}).waitFor();
  await f.panel.getByLabel('Token address',{exact:true}).fill(l1Token);
  await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('CHI',{exact:true}).waitFor();
  await f.close();

  f = await fixture(browser,{indexL1:true,delayL1:true});
  await f.panel.getByRole('button',{name:'Browse tokens',exact:true}).click();
  await f.panel.getByTitle('Swap direction').click();
  await f.panel.getByRole('button',{name:'Select ROLL '+l2Token,exact:true}).waitFor();
  await f.page.waitForTimeout(350);
  assert.equal(await f.panel.getByRole('button',{name:/Select CHI/}).count(),0);
  await f.close();

  f = await fixture(browser,{chain:'0x539',name:'Custom deployment',disconnected:true});
  assert.equal(await f.panel.getByRole('group',{name:'Source network'}).getByRole('img').count(),0);
  await browse(f,'Your tokens'); await f.panel.getByText('Connect your wallet to see token balances.',{exact:true}).waitFor();
  await f.close();
  f = await fixture(browser,{chain:'0x539'}); await f.close();
  await browser.close();
  console.log(JSON.stringify({passed:true,scenarios:7,chainScopedCatalog:true,sourceRpcBalances:true,indexedWalletTokens:true,manualEntry:true,staleResponsesIgnored:true,networkIdentityAndOverrides:true,realTransactionsBroadcast:0}));
})().catch(e => {console.error(e);process.exit(1)});
