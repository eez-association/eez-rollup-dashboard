// Controlled RPC snapshots isolate UI call counts. Real signature recovery and
// Safe execution are covered by the unit and paired-EVM integration tests.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {toHex,decodeFunctionData} from 'viem';
import {paymentAbi} from '../src/lib/treasury/payments.ts';
const a=n=>toHex(n,{size:20}),h=n=>toHex(n,{size:32});
const config={version:1,environment:'isolated-devnet',instance:h(1),safeL1:a(1),safeL2:a(2),registry:a(3),manager:a(4),adapter:a(5),code:[],
  l1:{chainId:10200,rpc:'l1',front:'l1-front'},l2:{chainId:699069,rpc:'l2',front:'l2-front'},
  payments:{version:2,bridgeKind:'standard',pair:{version:1,policyL1:a(20),peerProxyL2:a(21)},policy:a(11),alias:a(12),safeL2Alias:a(22),tokenL1:a(13),tokenL2:a(14),moduleL1:a(15),moduleL2:a(16),bridgeL1:a(17),bridgeL2:a(18),recipient:a(19),decimals:6,period:600,globalLimit:'150000000',assetLabel:'Test USDC'}};
const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},base:'/'});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
try{
  for(const pairVersion of [1,2]) for(const source of ['l1','l2']){
    const selected={...config,payments:{...config.payments,pair:{...config.payments.pair,version:pairVersion}}};
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/sign')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
      return route.continue();
    });
    await page.goto(origin+'/sign');
    await page.evaluate(async f=>(await import('/tests/fixtures/treasury-owners-browser.tsx')).mount(f),{config:selected,owners:[a(101),a(102)],blockHash:h(2),chainId:toHex(config[source].chainId)});
    await page.getByRole('button',{name:'Review payment',exact:true}).click();
    await page.getByTestId('funding-preview').waitFor();
    if(pairVersion===2){
      await page.getByText('No time expiry. Balances and spending limits are checked when this payment executes.',{exact:true}).waitFor();
      const reads=await page.evaluate(()=>{window.ownersTest.timestamp='0x3cf0';return window.ownersTest.reads;});
      await page.clock.fastForward(6000);
      await page.waitForFunction(n=>window.ownersTest.reads>n,reads);
      await page.getByRole('button',{name:'Edit payment',exact:true}).waitFor();
    }
    await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
    const before=await page.evaluate(()=>{window.ownersTest.balanceFailure=true;return window.ownersTest.reads;});
    await page.getByRole('button',{name:'Sign approval',exact:true}).click();
    await page.getByRole('button',{name:'Owner approved',exact:true}).waitFor();
    const result=await page.evaluate(()=>({reads:window.ownersTest.reads,approvals:window.ownersTest.approvals,signatures:window.ownersTest.signatures}));
    assert.equal(result.reads,before,'signing does not refresh the Safe snapshot');assert.equal(result.approvals,1);
    assert.equal(result.signatures[0].chainId,String(config[source].chainId));
    assert.equal(decodeFunctionData({abi:paymentAbi,data:result.signatures[0].data}).args[3],pairVersion===2?0n:25n);
    assert.equal(await page.getByRole('alert').count(),0,'no redundant balance read can interrupt signing');
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS both policy versions and signing domains, no-expiry review across reset: no repeated Safe snapshot or balance sweep around owner approval');
}finally{await browser.close();await server.close();}
