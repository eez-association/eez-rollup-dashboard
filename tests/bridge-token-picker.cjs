// EEZ_UI_URL=http://127.0.0.1:8083/dashboard NODE_PATH=<playwright modules> node tests/bridge-token-picker.cjs
// All configuration, wallet, explorer, and RPC responses are mocked. Never broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { toFunctionSelector } = require('viem');
const fs = require('node:fs');
const factoryBundle = fs.readdirSync('src/lib/treasury/builds').map(f => JSON.parse(fs.readFileSync('src/lib/treasury/builds/'+f))).find(b => b.contracts.Bridge);
const bridgeRuntime = factoryBundle.contracts.Bridge.runtime;
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
    if (!localStorage.getItem('bridgeRecentTokens')) localStorage.setItem('bridgeRecentTokens', JSON.stringify([
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
    if (method === 'eth_getCode') return reply(params[0].toLowerCase() === bridge ? bridgeRuntime : '0x');
    if (method === 'eth_getBalance') return reply(word(10n**19n));
    if (method === 'eth_getBlockByNumber') return reply({number:'0x10',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[],baseFeePerGas:'0x7',gasUsed:'0x0',gasLimit:'0x1c9c380'});
    if (method === 'eth_getLogs') return reply([]);
    if (method === 'eth_call') {
      const tx = params[0], selector = tx.data.slice(0,10);
      if (selector === toFunctionSelector('rollupId()')) return reply(word(path.endsWith('l1') ? 0 : 2));
      if (selector === toFunctionSelector('wrappedTokenInfo(address)')) return reply(options.wrapped && path.endsWith('l1')
        ? '0x'+l2Token.slice(2).padStart(64,'0')+word(2).slice(2) : word(0)+word(0).slice(2));
      if (selector === toFunctionSelector('getWrappedToken(address,uint64)')) return reply(word(0));
      if (tx.to.toLowerCase() === addr('0')) return reply('0x');
      if (tx.to.toLowerCase() === addr('5')) await new Promise(r => setTimeout(r, 500));
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
  return {page, panel, context, calls, errors, writes, async close() {assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);await context.close();}};
}
async function open(f) {
  await f.panel.getByRole('button', {name:/^Choose bridge asset on/}).first().click();
}
async function saved(f, symbol, address) {
  await f.panel.getByRole('button', {name:`Select ${symbol} ${address}`,exact:true}).waitFor();
}
(async () => {
  const browser = await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    let f = await fixture(browser);
    const choices = f.panel.getByRole('group',{name:'Bridge asset choices',exact:true});
    assert.match(await choices.getByRole('button',{name:/^Select /}).first().getAttribute('aria-label'), /native token$/);
    await saved(f,'CHI',l1Token);
    assert.equal(await choices.getByRole('button',{name:/Select OLD|Select ROLL/}).count(),0);
    assert(await f.panel.getByLabel('Search tokens').evaluate(el => el === document.activeElement));
    await f.panel.getByLabel('Search tokens').fill('chiado');
    await saved(f,'CHI',l1Token);
    await f.panel.getByRole('button',{name:'Select CHI '+l1Token,exact:true}).click();
    await f.panel.getByText('Chiado',{exact:true}).first().waitFor();
    await f.panel.getByText('Proxy',{exact:true}).waitFor();
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).click();
    await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('CHI',{exact:true}).waitFor();
    assert(await f.panel.getByRole('button',{name:/^Choose bridge asset on/}).first().evaluate(el => el === document.activeElement));
    await open(f);
    for (const width of [320,390,1440]) {
      await f.page.setViewportSize({width,height:900});
      assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'picker overflow at '+width);
      await f.page.screenshot({path:`/tmp/bridge-token-picker-${width}.png`,fullPage:true});
    }
    await f.page.keyboard.press('Escape');
    await f.panel.getByTitle('Swap direction').click(); await open(f);
    await saved(f,'ROLL',l2Token);
    await f.panel.getByText('This token will be deployed when it is first bridged to this network.',{exact:true}).waitFor();
    const storedPair = await f.page.evaluate(address => JSON.parse(localStorage.getItem('bridgeRecentTokens')).find(t => t.address === address).counterpart, l1Token);
    await saved(f,'CHI',storedPair.address);
    const proxyRow=f.panel.getByRole('button',{name:'Select CHI '+storedPair.address,exact:true});
    await proxyRow.getByText('Proxy',{exact:true}).waitFor();
    await proxyRow.getByText('Chiado',{exact:true}).waitFor();
    assert.equal(await proxyRow.locator('code').first().getAttribute('title'),l1Token);
    assert.equal(await proxyRow.locator('code').last().getAttribute('title'),storedPair.address);
    assert.equal(storedPair.chainId,6290);
    for(const width of [320,390,1440]) {
      await f.page.setViewportSize({width,height:900});
      assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'proxy row overflow at '+width);
      await f.page.screenshot({path:`/tmp/bridge-token-origin-${width}.png`,fullPage:true});
    }
    await f.close();

    // Empty native-first list; name search can discover catalog tokens.
    f = await fixture(browser,{chain:'0x1'});
    await f.panel.getByText('No saved tokens yet.',{exact:false}).waitFor();
    assert.equal(await f.panel.getByRole('button',{name:/^Select /}).count(),1);
    await f.panel.getByLabel('Search tokens').fill('dai');
    await f.panel.getByRole('button',{name:'Add DAI '+dai,exact:true}).click();
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).click();
    await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('DAI',{exact:true}).waitFor();
    await open(f); await saved(f,'DAI',dai); await f.close();

    // Pasted addresses are previewed, then persist after explicit selection and reload.
    f = await fixture(browser,{disconnected:true,custom:true,badList:true});
    const custom = addr('4');
    await f.panel.getByLabel('Search tokens').fill('  '+custom+'  ');
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).waitFor();
    assert.equal(await f.page.evaluate(address => JSON.parse(localStorage.getItem('bridgeRecentTokens')).some(t=>t.address===address),custom),false);
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).click();
    await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('CHI',{exact:true}).waitFor();
    await f.page.reload(); await open(f); await saved(f,'CHI',custom);
    const restored=f.panel.getByRole('button',{name:'Select CHI '+custom,exact:true});
    await restored.getByText('Chiado',{exact:true}).waitFor();
    assert.equal(await restored.getByText('Proxy',{exact:true}).count(),0);
    await f.panel.getByRole('button',{name:'Select CHI '+custom,exact:true}).click();
    await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('CHI',{exact:true}).waitFor();
    await open(f);
    await f.panel.getByRole('button',{name:/^Select .* native token$/}).click();
    assert.equal(await f.panel.getByRole('group',{name:'Bridge asset choices'}).count(),0);
    await open(f);
    assert.equal(await f.page.evaluate(address => JSON.parse(localStorage.getItem('bridgeRecentTokens')).filter(t=>t.address===address).length,custom),1);
    await f.panel.getByLabel('Search tokens').fill('0x123');
    await f.panel.getByText('Enter a complete token contract address.',{exact:true}).waitFor();
    await f.panel.getByLabel('Search tokens').fill(addr('0'));
    await f.panel.getByText('Couldn’t add this token.',{exact:false}).waitFor();
    assert.equal(await f.panel.getByRole('button',{name:'Add token & select'}).count(),0);
    await f.panel.getByLabel('Search tokens').fill(addr('5'));
    await f.page.waitForTimeout(300);
    await f.panel.getByLabel('Search tokens').fill('nothing matches');
    await f.page.waitForTimeout(700);
    assert.equal(await f.panel.getByRole('button',{name:'Add token & select'}).count(),0);
    await f.close();

    // Saved source records must recover when the counterpart was lost or its bridge changed.
    for (const staleBridge of [false,true]) {
      f = await fixture(browser);
      await f.page.evaluate(({original,counterpart,staleBridge})=>{
        localStorage.setItem('bridgeRecentTokens',JSON.stringify([
          {address:original,chainId:10200,name:'Chiado token',symbol:'CHI',decimals:18,bridgeAddress:'0x'+'1'.repeat(40),counterpart:{address:counterpart,chainId:6290}},
          ...(staleBridge?[{address:counterpart,chainId:6290,name:'Old counterpart',symbol:'CHI',decimals:18,bridgeAddress:'0x'+'9'.repeat(40)}]:[]),
        ]));
      },{original:l1Token,counterpart:l2Token,staleBridge});
      await f.page.reload();await open(f);
      await f.panel.getByRole('button',{name:'Select CHI '+l1Token,exact:true}).click();
      await f.panel.getByRole('button',{name:'Add token & select',exact:true}).click();
      await f.panel.getByLabel('Bridge amount',{exact:true}).locator('..').getByText('CHI',{exact:true}).waitFor();
      const repaired=await f.page.evaluate(address=>JSON.parse(localStorage.getItem('bridgeRecentTokens')).find(t=>t.address===address),l1Token);
      assert.notEqual(repaired.counterpart.address,l2Token);
      await f.close();
    }

    // Importing a wrapped token follows its on-chain origin, not the selected network.
    f=await fixture(browser,{wrapped:true});
    await f.panel.getByLabel('Search tokens').fill(addr('4'));
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).waitFor();
    await f.panel.getByText('EEZ-X Devnet',{exact:true}).first().waitFor();
    await f.panel.getByRole('group',{name:'Bridge asset choices',exact:true}).getByText('Chiado',{exact:true}).waitFor();
    await f.panel.getByRole('button',{name:'Add token & select',exact:true}).click();
    await open(f);
    const wrappedRow=f.panel.getByRole('button',{name:'Select CHI '+addr('4'),exact:true});
    await wrappedRow.getByText('Proxy',{exact:true}).waitFor();
    assert.equal(await wrappedRow.locator('code').first().getAttribute('title'),l2Token);
    await f.close();

    // Corrupt local storage does not break the bridge.
    f = await fixture(browser);
    await f.page.evaluate(()=>localStorage.setItem('bridgeRecentTokens','{"bad":true}'));
    await f.page.reload(); await open(f);
    await f.panel.getByText('No saved tokens yet.',{exact:false}).waitFor();
    await f.close();
    console.log(JSON.stringify({passed:true,nativeFirst:true,localPersistence:true,pairedImports:true,undeployedCounterparts:true,chainScoped:true,addressPreview:true,nameSearch:true,invalidAndStaleLookups:true,keyboard:true,widths:[320,390,1440],realTransactionsBroadcast:0}));
  } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exit(1)});
