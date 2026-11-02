import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mainnetSetupKey } from '../src/lib/treasury/mainnetSetup.ts';
const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0,watch:null},base:'/'});
await server.listen();let browser;
try {
  browser=await chromium.launch({headless:true,chromiumSandbox:true});
  const page=await browser.newPage(),errors=[],origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin);
    if(url.pathname==='/rollupx')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
    if(request.method()==='POST') {
      assert(url.pathname.endsWith('/treasury-verification/jobs'));
      assert.equal(request.postDataJSON().chainId===1||request.postDataJSON().chainId===696991,true);
      return route.fulfill({json:{id:'fixture',status:'verified',contracts:[]}});
    }
    return route.continue();
  });
  await page.goto(origin+'/rollupx');
  await page.evaluate(async key=>{localStorage.setItem(key,'retain previous network journal');await(await import('/tests/fixtures/treasury-rollupx.tsx')).mount();},mainnetSetupKey);
  await page.getByRole('status').filter({hasText:'USDC has not been provisioned on RollupX.'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start setup',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>window.rollupxTest.walletCalls),0);
  await page.evaluate(()=>{window.rollupxTest.error='';});
  await page.getByRole('button',{name:'Check again',exact:true}).click();
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  await page.getByRole('button',{name:'Start setup',exact:true}).click();
  await page.getByRole('alert').getByText('Fixture stopped before any deployment',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.rollupxTest.selected),696991);
  assert.equal(await page.evaluate(()=>window.rollupxTest.walletCalls),0);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),mainnetSetupKey),'retain previous network journal');
  assert.deepEqual(errors,[]);
  console.log('PASS RollupX selection, provisioning gate, retry, old-network journal isolation and no wallet prompts');
} finally {await browser?.close();await server.close();}
