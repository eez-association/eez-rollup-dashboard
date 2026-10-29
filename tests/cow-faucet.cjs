const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser=await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    const f=await fixture(browser,{wallet:true,faucetDelayed:true});
    await f.page.goto(origin+'/');await f.nav.waitFor();await f.toggle();await f.cow.click();
    const form=f.page.getByRole('region',{name:'Swap form'});
    await form.getByRole('button',{name:'Connect wallet'}).click();
    await form.getByText('ctWETH',{exact:true}).waitFor();
    const faucet=f.page.getByRole('region',{name:'Get test tokens'});
    await faucet.getByRole('button',{name:'Get test tokens',exact:true}).click();
    await faucet.getByText('Test-token request', {exact:false}).first().waitFor();
    await f.page.reload();
    await faucet.getByText(/Received 0.01 ctWETH and 0.0002/).waitFor();
    assert.equal(f.transactions.length,1);
    assert.equal(f.transactions[0].to,'0x'+'ef'.repeat(20));
    assert.equal(f.transactions[0].data,'0x4e71d92d');
    assert.equal(f.transactions[0].value,'0x0');
    assert.equal(f.signed.length,0);
    assert.ok(await faucet.getByRole('button',{name:'Get test tokens',exact:true}).isDisabled());
    await f.page.reload();await faucet.getByText(/Available again/).waitFor();
    assert.equal(f.transactions.length,1,'reload does not request more tokens');
    assert.deepEqual(f.errors,[]);await f.context.close();
    console.log('Faucet shared wallet, Chiado switch, exact claim, canonical receipt, observed L2 balances, cooldown and reload passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
