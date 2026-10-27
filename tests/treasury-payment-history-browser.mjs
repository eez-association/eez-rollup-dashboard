import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},base:'/'});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/history')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
  return route.continue();
});
const entry=n=>({id:String(n),kind:'preparation',recordedAt:`2026-10-27T12:00:0${n}Z`,detail:'Wallet request cancelled.',payment:{kind:'fixed',source:'l1',destination:'l2',amount:String(n*1000000),fromL1:'0',epoch:'1',recipient:'0x'+'11'.repeat(20)}});
try {
  await page.goto(origin+'/history');
  await page.evaluate(async entries=>(await import('/tests/fixtures/treasury-payment-history.tsx')).mount(entries),[entry(1),entry(2)]);
  const rows=page.getByTestId('history-entry'),toggle=row=>row.getByRole('button',{name:/payment details/});
  await rows.first().getByText('2 USDC → EEZ-X',{exact:true}).waitFor();
  assert.equal(await toggle(rows.nth(0)).getAttribute('aria-expanded'),'true');
  await toggle(rows.nth(1)).click();await toggle(rows.nth(0)).click();
  await page.evaluate(entries=>window.setHistoryEntries(entries),[entry(1),entry(2),entry(3)]);
  await rows.first().getByText('3 USDC → EEZ-X',{exact:true}).waitFor();
  assert.deepEqual(await rows.getByRole('button',{name:/payment details/}).evaluateAll(buttons=>buttons.map(b=>b.getAttribute('aria-expanded'))),['true','false','true']);
  await page.getByLabel('Filter history').selectOption('settled');assert.equal(await rows.count(),0);
  await page.evaluate(entries=>window.setHistoryEntries(entries),[entry(1),entry(2),entry(3),entry(4)]);
  await rows.first().getByText('4 USDC → EEZ-X',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Filter history').inputValue(),'all');
  for(const width of [390,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await mkdir('.runtime/local-validation/history-ux',{recursive:true});
  await page.screenshot({path:'.runtime/local-validation/history-ux/newest-expanded.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS newest-first history, automatic expansion, preserved older toggles, new-payment filter reset and mobile widths');
} finally {await browser.close();await server.close();}
