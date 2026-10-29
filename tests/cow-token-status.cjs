const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser=await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    const f=await fixture(browser);
    let unavailable=true;
    await f.page.clock.install();
    await f.page.route('**/cowdemo/api/wrapper?*',route=>{
      const token=new URL(route.request().url()).searchParams.get('token');
      return unavailable && token==='0x'+'55'.repeat(20)
        ? route.fulfill({status:503,json:{error:'RPC unavailable'}}) : route.fallback();
    });
    await f.page.goto(origin+'/');await f.nav.waitFor();await f.toggle();await f.cow.click();
    const catalog=f.page.getByRole('region',{name:'Available tokens'});
    const first=catalog.getByRole('listitem').filter({has:f.page.getByRole('button',{name:'Select ctUSD',exact:true})});
    const second=catalog.getByRole('listitem').filter({has:f.page.getByRole('button',{name:'Select TEST',exact:true})});
    await first.getByText('Unavailable',{exact:true}).waitFor();
    await second.getByText('Not bridged',{exact:true}).waitFor();
    assert.equal(await first.getByText('Not bridged',{exact:true}).count(),0);
    unavailable=false;await f.page.clock.fastForward(61000);
    await first.getByText('Bridged',{exact:true}).waitFor();
    assert.equal(await catalog.getByText(/Uniswap V2 pair|Catalog reserve/).count(),0);
    assert.ok((await first.boundingBox()).height < 100);
    await catalog.getByLabel('Search tokens').fill('second');
    await second.getByText('Not bridged',{exact:true}).waitFor();
    await catalog.getByLabel('Search tokens').fill('');
    await first.getByText('Bridged',{exact:true}).waitFor();
    await f.page.setViewportSize({width:390,height:844});
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(f.errors,[]);await f.context.close();
    console.log('Token bridge badges: deployed, undeployed, failed lookup, refresh, search retention and mobile passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
