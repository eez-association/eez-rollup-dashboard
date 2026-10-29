const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser = await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    const f=await fixture(browser,{wallet:true});
    ['settled','submitted','failed','expired'].forEach((state,index)=>f.submitted.push({id:`history-${index}`,signer:'0x'+'88'.repeat(20),receivedAt:1793272675-index*60,status:state,
      order:{sellAmount:'1000000000000000',buyAmount:'97000000000000000',receiver:'0x'+'88'.repeat(20)},quote:{tokenSymbol:'ctUSD',tokenDecimals:18},
      solverDebug:{state,...(index===0?{settlement:'0x'+'cc'.repeat(32),l1Tx:'0x'+'dd'.repeat(32),settlementBlock:78540,l1Block:23745591}:{}),...(state==='failed'?{error:'Pool quote could not be executed.'}:{})}}));
    await f.page.goto(origin+'/');await f.nav.waitFor();await f.toggle();await f.cow.click();
    await f.page.getByRole('region',{name:'Swap form'}).getByRole('button',{name:'Connect wallet'}).click();
    const history=f.page.getByRole('region',{name:'Swap activity'});
    await history.getByText('4 swaps',{exact:true}).waitFor();
    assert.equal(await history.getByTestId('swap-history-entry').count(),4);
    await history.getByRole('button',{name:'Hide swap details'}).click();
    await history.getByRole('button',{name:'Show swap details'}).first().click();
    await history.getByText('Swap settlement',{exact:true}).waitFor();
    await history.getByText('Signed minimum, not the measured output',{exact:true}).waitFor();
    assert.equal(await history.getByRole('link',{name:'Inspect execution'}).count(),1);
    for(const outcome of ['pending','failed','expired','settled']){
      await history.getByLabel('Filter history').selectOption(outcome);
      assert.equal(await history.getByTestId('swap-history-entry').count(),1);
      assert.equal(await history.getByTestId('swap-history-entry').getAttribute('data-status'),outcome);
    }
    await history.getByLabel('Filter history').selectOption('all');
    await f.page.screenshot({path:'.runtime/cow-history-desktop.png',fullPage:true});
    await f.page.setViewportSize({width:390,height:844});
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await f.page.screenshot({path:'.runtime/cow-history-mobile.png',fullPage:true});
    assert.deepEqual(f.errors,[]);await f.context.close();

    const main=await fixture(browser,{mainnet:true});
    await main.page.goto(origin+'/');await main.nav.waitFor();await main.toggle();await main.cow.click();
    await main.page.getByRole('region',{name:'Swap form'}).getByText('Bridged WETH',{exact:true}).waitFor();
    assert.equal(await main.page.getByText('Wrap native ETH',{exact:true}).count(),0);
    assert.equal(await main.page.getByRole('region',{name:'Get test tokens'}).count(),0);
    assert.deepEqual(main.errors,[]);await main.context.close();
    console.log('Swap history rows, filters, expanded flow, evidence links, mobile layout and mainnet WETH guards passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
