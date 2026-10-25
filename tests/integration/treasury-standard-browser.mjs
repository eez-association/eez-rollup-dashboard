import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { toHex } from 'viem';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { paymentState } from '../../src/lib/treasury/payments.ts';

export async function standardBrowser(f,c,directory) {
  const client=new TreasuryClient(c),before=await paymentState(client),requests=[];
  await f.send(f.network.l1,f.B.address,'0x',10n**18n);
  const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},base:'/'});
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  const browser=await chromium.launch({headless:true,chromiumSandbox: true});
  const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const accounts={A:f.A,B:f.B};
  await page.exposeFunction('liveWallet',async({label,chainId,method,params})=>{
    const chain=BigInt(chainId)===BigInt(c.l1.chainId)?'l1':'l2',owner=accounts[label];requests.push({label,chain,method});
    if(method==='wallet_switchEthereumChain')return true;
    if(method==='eth_signTypedData_v4'){
      const tx=JSON.parse(params[1]);assert.equal(BigInt(tx.domain.chainId),BigInt(c.l2.chainId));assert.equal(tx.domain.verifyingContract.toLowerCase(),c.safeL2.toLowerCase());
      return owner.signTypedData(tx);
    }
    if(method==='eth_sendTransaction'){
      assert.equal(chain,'l1');const tx=params[0];assert.equal(tx.from.toLowerCase(),owner.address.toLowerCase());assert.equal(tx.to.toLowerCase(),c.payments.safeL2Alias.toLowerCase());
      const raw=await owner.signTransaction({chainId:Number(BigInt(chainId)),to:tx.to,data:tx.data,nonce:Number(BigInt(tx.nonce)),gas:BigInt(tx.gas),value:BigInt(tx.value),type:'eip1559',maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas),maxFeePerGas:BigInt(tx.maxFeePerGas)});
      await f.rpc(c.l1.front,'eth_sendRawTransaction',[raw]);
      throw new Error('Controlled lost wallet response after real broadcast');
    }
    return f.rpc(c[chain].front,method,params??[]);
  });
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin && url.pathname==='/live-treasury')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
    const allowed=[origin,...['l1','l2'].flatMap(chain=>[new URL(c[chain].rpc).origin,new URL(c[chain].front).origin])];
    assert(allowed.includes(url.origin),'browser stays on isolated endpoints');
    if(url.origin===origin)return route.continue();
    if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}});
    const response=await fetch(url,{method:route.request().method(),headers:{'content-type':'application/json'},body:route.request().postData()??undefined});
    await route.fulfill({status:response.status,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:await response.text()});
  });
  const mount=async()=>{await page.goto(`${origin}/live-treasury`);await page.evaluate(async({config,addresses})=>{const m=await import('/tests/fixtures/treasury-live-browser.tsx');m.mount(config,addresses);},{config:c,addresses:{A:f.A.address,B:f.B.address}});};
  try {
    await mount();await f.until('shared owners in browser',async()=>await page.getByTestId('shared-threshold').textContent()==='2 of 2 owners');
    assert(!(await page.locator('#treasury-kind option').allTextContents()).some(text => /percentage|holdings/i.test(text)));
    assert.equal(await page.getByLabel('Percentage (%)', {exact:true}).count(),0);
    await page.getByLabel('Start from',{exact:true}).selectOption('l2');
    await page.getByLabel('Amount (USDC)',{exact:true}).fill('10');
    await page.getByLabel('Recipient chain',{exact:true}).selectOption('l2');
    const slider=page.getByRole('slider',{name:'EEZ-X share of payment'});
    await slider.fill('5000');
    await page.getByRole('button',{name:'Review payment',exact:true}).click();
    await page.getByRole('button',{name:'Sign approval',exact:true}).click();
    await f.until('first real browser signature',async()=>await page.getByTestId('quorum').textContent()==='1 of 2 approvals');
    await page.evaluate(()=>window.liveTreasury.select('B'));
    await page.getByRole('button',{name:'Sign approval',exact:true}).click();
    await f.until('second real browser signature',async()=>await page.getByTestId('quorum').textContent()==='2 of 2 approvals');
    await page.getByRole('button',{name:'Submit Safe transaction',exact:true}).click();
    await f.until('browser submission persisted',async()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null'),`eez:treasury:submission:${c.instance}`));
    await f.until('real Ethereum wallet broadcast',async()=>requests.some(x=>x.method==='eth_sendTransaction'));
    await mount();
    const intent=JSON.parse(await page.evaluate(key=>localStorage.getItem(key),`eez:treasury:submission:${c.instance}`));
    assert.equal(intent.submissionChain,'l1');assert.equal(intent.payment.source,'l2');
    const outcome=await f.until('browser recovery and settlement',async()=>{const o=await client.outcome(intent);assert.notEqual(o.kind,'rejected',o.detail);return o.kind==='settled'?o:false;},180);
    await page.getByRole('heading',{name:'Settled on Ethereum',exact:true}).waitFor();
    assert.deepEqual(outcome.contributions,{fromL1:'5000000',fromL2:'5000000'});
    assert.equal((await paymentState(client)).spent,before.spent+10_000_000n);
    assert.equal(requests.filter(x=>x.method==='eth_sendTransaction').length,1);
    assert.deepEqual(requests.filter(x=>x.method==='wallet_switchEthereumChain').map(x=>x.chain),['l2','l1']);
    assert.equal(await page.getByText('Ethereum submission',{exact:true}).count(),1);
    await page.getByTestId('history-entry').waitFor();
    await page.screenshot({path:resolve(directory,'standard-bridge-browser.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    f.evidence.lastSuccessfulL2Block=Number(outcome.block);
    f.evidence.standardBrowser={hash:outcome.hash,block:outcome.block,contributions:outcome.contributions,signingChain:'l2',submissionChain:'l1',reloadAndLostResponseRecovery:true,singleBroadcast:true,wallet:'Test EIP-1193 provider with genuine fixture signatures and real RPCs',requests};f.checkpoint();
  }catch(error){
    // A crashed renderer cannot provide a screenshot or DOM. Preserve the first
    // failure instead of replacing it with a diagnostic or cleanup exception.
    await page.screenshot({path:resolve(directory,'standard-browser-failure.png'),fullPage:true}).catch(()=>{});
    const body=await page.locator('body').innerText().catch(()=>'<browser unavailable>');
    console.error('Browser rehearsal failure:',error.message,body);throw error;
  }finally{
    await context.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});
    const cleanup=await Promise.allSettled([browser.close(),server.close()]);
    for(const result of cleanup)if(result.status==='rejected')console.error('Browser cleanup failed:',result.reason);
  }
}
