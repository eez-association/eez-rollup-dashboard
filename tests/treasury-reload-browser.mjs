import assert from'node:assert/strict';import{mkdirSync}from'node:fs';import{createServer}from'vite';import react from'@vitejs/plugin-react';import{chromium}from'playwright';import{reloadFixture}from'./fixtures/treasury-reload.mjs';
const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},base:'/'});await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true,chromiumSandbox:true});
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{const u=new URL(route.request().url());assert.equal(u.origin,origin);if(u.pathname==='/reload')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});if(route.request().method()==='POST')return route.fulfill({json:{jsonrpc:'2.0',id:1,result:null}});return route.continue();});
async function mount(extra={}){const f=reloadFixture(origin);await page.goto(origin+'/reload');await page.evaluate(async f=>{localStorage.clear();for(const[k,v]of f.entries)localStorage.setItem(k,v);await(await import('/tests/fixtures/treasury-owners-browser.tsx')).mount(f);},{...f,holdValidation:true,holdNetwork:true,...extra});return f;}
try{
 const f=await mount();
 const safe=page.getByRole('region',{name:'Chiado Safe funds',exact:true});
 await safe.waitFor();await safe.getByText('300',{exact:false}).first().waitFor();
 assert(await page.getByRole('button',{name:'Review payment',exact:true}).isDisabled(),'balances must not authorize payment while validation is pending');
 assert.deepEqual(await page.evaluate(()=>window.ownersTest.walletCalls),[]);
 await page.evaluate(()=>window.ownersTest.releaseValidation());
 await page.waitForTimeout(150);
 assert(await page.getByRole('button',{name:'Review payment',exact:true}).isDisabled(),'network readiness must include both validations');
 assert.deepEqual(await page.evaluate(()=>window.ownersTest.walletCalls),[]);
 await page.evaluate(()=>window.ownersTest.releaseNetwork());
 await page.getByRole('button',{name:'Review payment',exact:true}).and(page.locator(':enabled')).waitFor();
 assert.equal(await page.getByRole('region',{name:'Setup transaction history',exact:true}).count(),0);
 await page.getByRole('button',{name:'Review payment',exact:true}).click();
 await page.getByRole('button',{name:'Edit payment',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).isDisabled(),false);
 assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).salt,f.key),f.state.salt);
 await mount();await safe.getByText('300',{exact:false}).first().waitFor();
 await page.evaluate(()=>{window.ownersTest.validationFailure=true;window.ownersTest.releaseValidation();});
 await page.getByRole('alert').filter({hasText:'Controlled validation failure'}).first().waitFor();
 assert(await page.getByRole('button',{name:'Review payment',exact:true}).isDisabled());
 await page.evaluate(()=>{window.ownersTest.networkFailure=true;window.ownersTest.releaseNetwork();});
 await page.getByRole('alert').filter({hasText:'Controlled network failure'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Review payment',exact:true}).count(),0);
 // A queued owner review must never outlive the validated screen.
 await mount();await safe.getByText('300',{exact:false}).first().waitFor();
 await page.getByLabel('New owner address',{exact:true}).fill('0x00000000000000000000000000000000000000AA');
 await page.getByRole('button',{name:'Review owner addition',exact:true}).click();
 await page.evaluate(()=>{window.ownersTest.unmount();window.ownersTest.releaseNetwork();window.ownersTest.releaseValidation();});
 await page.waitForTimeout(150);
 assert.deepEqual(await page.evaluate(()=>window.ownersTest.walletCalls),[],'late validation cannot open a wallet after unmount');
 assert.equal(await page.locator('#root').innerText(),'');
 // Changes to the manifest must invalidate a queued action even if the Safe
 // addresses (and therefore the instance ID) stay the same.
 const edited=await mount();await safe.getByText('300',{exact:false}).first().waitFor();
 await page.getByLabel('New owner address',{exact:true}).fill('0x00000000000000000000000000000000000000AA');
 await page.getByRole('button',{name:'Review owner addition',exact:true}).click();
 await page.evaluate(key=>{const m=JSON.parse(localStorage.getItem(key+':manifest'));m.payments.recipient='0x0000000000000000000000000000000000000022';localStorage.setItem(key+':manifest',JSON.stringify(m));window.ownersTest.releaseNetwork();window.ownersTest.releaseValidation();},edited.key);
 await page.getByRole('alert').filter({hasText:'The selected treasury changed'}).first().waitFor();
 assert.deepEqual(await page.evaluate(()=>window.ownersTest.walletCalls),[]);
 // A cached network cannot keep the old treasury selected if live identity changed.
 const changed=await mount();await safe.getByText('300',{exact:false}).first().waitFor();
 await page.evaluate(network=>{window.ownersTest.networkResult={...network,source:'changed-network-identity'};window.ownersTest.releaseNetwork();},changed.network);
 await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
 assert.equal(await safe.count(),0);
 assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).salt,changed.key),changed.state.salt);
 assert.deepEqual(await page.evaluate(()=>window.ownersTest.walletCalls),[]);
 // A balance outage preserves an independently successful owner observation.
 await mount({balanceFailure:true});
 await page.getByRole('alert').filter({hasText:'Controlled balance read failure'}).first().waitFor();
 await page.getByTestId('shared-threshold').filter({hasText:'1 of 1'}).waitFor();
 assert(await page.getByRole('button',{name:'Review payment',exact:true}).isDisabled());
 assert.deepEqual(errors,[]);
 mkdirSync('.runtime/treasury-rpc-review',{recursive:true});
 console.log('PASS saved Safe shell and fresh balances appear before validations; approval waits for both checks; failures block actions and preserve journals');
}catch(e){console.error(await page.getByRole('alert').allTextContents());console.error(await page.getByRole('button').allTextContents());throw e;}finally{await browser.close();await server.close();}
