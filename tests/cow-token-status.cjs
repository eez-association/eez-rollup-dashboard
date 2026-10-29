const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, origin } = require('./cow-demo.cjs');
(async () => {
  const browser=await chromium.launch({headless:true,chromiumSandbox:true});
  try {
    const f=await fixture(browser);
    await f.page.route('**/cowdemo/api/tokens', route => route.fulfill({json:{tokens:[
      {address:'0x'+'55'.repeat(20),pair:'0x'+'66'.repeat(20),symbol:'ctUSD',name:'Test USD',decimals:18},
      {address:'0x'+'12'.repeat(20),pair:'0x'+'34'.repeat(20),symbol:'TEST',name:'Second token',decimals:18,wethReserve:'1000000000000000000'},
      {address:'0x'+'13'.repeat(20),pair:'0x'+'34'.repeat(20),symbol:'LOW',name:'Below threshold',decimals:18,wethReserve:'9999999999999999'},
      {address:'0x'+'14'.repeat(20),pair:'0x'+'34'.repeat(20),symbol:'EDGE',name:'At threshold',decimals:18,wethReserve:'10000000000000000'},
    ]}}));
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
    assert.equal(await catalog.getByText(/Uniswap V2 pair/).count(),0);
    await first.getByText('WETH reserve unknown',{exact:true}).waitFor();
    await second.getByText('Reserve: 1 WETH',{exact:true}).waitFor();
    await catalog.getByText('Reserve: 0.01 WETH',{exact:true}).waitFor();
    assert.equal(await catalog.getByRole('button',{name:'Select LOW',exact:true}).count(),0);
    const selector=f.page.getByLabel('You receive', {exact:false});
    assert.equal(await selector.locator('option').filter({hasText:'LOW'}).count(),0);
    assert.equal(await selector.locator('option').filter({hasText:'EDGE'}).count(),1);
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
