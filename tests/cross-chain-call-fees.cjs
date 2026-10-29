// Exercise the generic proxy/counter call path through the mounted application.
// RPC responses and wallet sends are mocked; no transactions are broadcast.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {fixture,until,target,eoa} = require('./cross-chain-calls.cjs');

(async () => {
  const browser = await chromium.launch({headless:true,chromiumSandbox: true});
  let scenarios = 0;
  try {
    for (const [chain,l2Chain] of [['0x27d8','0x1892'],['0x1','0xaa29e']]) for (const reverse of [false,true]) for (const walletName of ['Rabby','MetaMask']) for (const destination of [target,eoa]) {
      const f = await fixture(browser,{feesEnabled:true,walletName,chain,l2Chain});
      await f.select(destination,reverse);
      if (destination === eoa) await f.panel.getByLabel('Calldata',{exact:true}).fill('0x1234');
      await until(() => f.send.isEnabled(),'cross-chain call was not ready');
      await f.send.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1),'quoted call did not reach wallet');
      const quotes = f.requests.filter(request => request.method === 'eez_quoteFee');
      assert.equal(quotes.length,1);
      assert.equal(quotes[0].path,reverse ? '/composer/l2' : '/composer/l1');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      for (const [key,value] of Object.entries(quotes[0].params[0])) assert.equal(tx[key],value,key);
      const sourceChain = reverse ? l2Chain : chain;
      const legacy = walletName === 'Rabby' && sourceChain !== '0x1';
      assert.equal(tx.type,legacy ? '0x0' : '0x2');
      assert.equal(tx.walletChain,sourceChain);
      if (destination === eoa) assert.equal(tx.data,'0x1234');
      else assert(tx.data.startsWith(reverse ? '0x55241077' : '0xd09de08a'));
      assert.equal(tx.gasPrice,legacy ? '0xf' : undefined);
      assert.equal(tx.maxPriorityFeePerGas,legacy ? undefined : '0x5');
      assert.equal(tx.maxFeePerGas,legacy ? undefined : '0xf');
      assert.deepEqual(f.errors,[]);
      await f.context.close(); scenarios++;
    }
    // Treasury setup reaches this same bundled fee helper with a 32,068-byte
    // contract batch. Preserve every byte through both supported wallet formats.
    const batchSizedData = '0x' + 'ab'.repeat(32_068);
    for (const walletName of ['Rabby', 'MetaMask']) {
      const f = await fixture(browser, {feesEnabled:true, walletName, chain:'0x27d8', l2Chain:'0xdd6d9'});
      await f.select(eoa, true);
      await f.panel.getByLabel('Calldata', {exact:true}).fill(batchSizedData);
      await until(() => f.send.isEnabled(), 'large call was not ready');
      await f.send.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'large quoted call did not reach wallet');
      const quotes = f.requests.filter(request => request.method === 'eez_quoteFee');
      assert.equal(quotes.length, 1); assert.equal(quotes[0].params[0].data, batchSizedData);
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(tx.data, batchSizedData); assert.equal(tx.type, walletName === 'Rabby' ? '0x0' : '0x2');
      assert.equal(tx.walletChain, '0xdd6d9'); assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({passed:true,scenarios,realTransactionsBroadcast:0}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
