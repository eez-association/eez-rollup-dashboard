const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser = await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    const f = await fixture(browser,{wallet:true,mainnet:true});
    let fail = true;
    await f.page.route('**/rpc/l2', route => {
      const body = route.request().postDataJSON();
      return fail && body.method === 'eth_gasPrice'
        ? route.fulfill({json:{jsonrpc:'2.0',id:body.id,error:{code:-32000,message:'Fee RPC unavailable'}}}) : route.fallback();
    });
    await f.page.goto(origin+'/'); await f.nav.waitFor(); await f.toggle(); await f.cow.click();
    const form = f.page.getByRole('region',{name:'Swap form'});
    await form.getByRole('button',{name:'Connect wallet'}).click();
    assert.equal(await form.getByRole('status',{name:'Wallet transaction fees'}).count(),0);
    await form.getByRole('button',{name:'Get quote'}).click();
    await form.getByRole('button',{name:'Approve sell amount'}).click();
    await form.getByRole('alert').getByText('Fee RPC unavailable',{exact:true}).waitFor();
    assert.equal(f.transactions.length,0,'failed fee lookup must not send a transaction');
    fail = false;
    await f.page.evaluate(() => {
      const request = window.ethereum.request.bind(window.ethereum);
      window.ethereum.request = async args => {
        if (args.method === 'eth_sendTransaction') await new Promise(resolve => { window.releaseFeeConfirmation = resolve; });
        return request(args);
      };
    });

    await form.getByRole('button',{name:'Approve sell amount'}).click();
    const summary = form.getByRole('status',{name:'Wallet transaction fees'});
    await summary.getByText('5 gwei',{exact:true}).waitFor();
    await summary.getByText('1 gwei',{exact:true}).waitFor();
    assert.equal(await summary.locator('input').count(),0);
    await f.page.waitForFunction(() => typeof window.releaseFeeConfirmation === 'function');
    await f.page.evaluate(() => window.releaseFeeConfirmation());
    await form.getByRole('button',{name:'Sign order'}).waitFor();
    const tx = f.transactions[0];
    assert.equal(tx.maxFeePerGas,'0x12a05f200');
    assert.equal(tx.maxPriorityFeePerGas,'0x3b9aca00');
    assert.equal(await form.getByRole('status',{name:'Wallet transaction fees'}).count(),0);
    assert.equal(await f.page.getByRole('region',{name:'Get test tokens'}).count(),0);
    assert.deepEqual(f.errors,[]);
    await f.context.close();
    console.log('Mainnet wallet fee values, RPC failure blocks sending, refresh and recovery passed.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
