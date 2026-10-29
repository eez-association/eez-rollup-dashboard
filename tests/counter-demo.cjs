// Every RPC and wallet submission is mocked. Never broadcast a real transaction.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin=(process.env.EEZ_UI_URL||'http://127.0.0.1:8083/dashboard').replace(/\/$/,'');
const addr=b=>'0x'+b.repeat(20), account=addr('22'), l1Counter=addr('77'), l2Counter=addr('88');
const managers={l1:addr('11'),l2:addr('33')},proxies={l1:addr('aa'),l2:addr('cc')};
const counters={l1:l1Counter,l2:l2Counter},names={l1:'Chiado',l2:'EEZ-X Devnet'},chainIds={l1:'0x27d8',l2:'0x1892'};
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
async function fixture(browser,options={}){
 const context=await browser.newContext(),page=await context.newPage();
 const requests=[],errors=[],model={counts:{l1:10n,l2:3n},deployed:{l1:!options.empty,l2:!options.empty},proxyDeployed:{l1:!options.noProxy,l2:!options.noProxy},
  failed:false,receiptReady:true,estimateError:null,codeError:!!options.codeError,missingChain:options.missingChain||null,countDelay:false,pendingReads:[]};
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(({account,counters,proxies,empty,invalidL1})=>{
  if(!localStorage.getItem('counterFixture')){
   if(!empty){localStorage.setItem('counterAddress',counters.l2);localStorage.setItem('counterAddressL1',counters.l1);}
   localStorage.setItem('crossChainProxies',JSON.stringify({[counters.l2]:proxies.l1}));
   localStorage.setItem('crossChainProxiesL2',JSON.stringify({[counters.l1]:proxies.l2}));
   if(invalidL1)localStorage.setItem('counterAddressL1','bad');
   localStorage.setItem('counterFixture','1');
  }
  window.walletRequests=[];window.currentChain='0x27d8';window.rejectSwitch=false;window.signatureHeld=false;
  window.ethereum={isRabby:true,on(){},removeListener(){},async request({method,params}){
   if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
   if(method==='eth_chainId')return window.currentChain;
   if(method==='wallet_addEthereumChain')return null;
   if(method==='wallet_switchEthereumChain'){if(window.rejectSwitch)throw new Error('User rejected switch');window.currentChain=params[0].chainId;return null;}
   if(method==='eth_sendTransaction'){
    const n=window.walletRequests.length+1;window.walletRequests.push({...params[0],walletChain:window.currentChain});
    if(window.signatureHeld)await new Promise(resolve=>window.releaseSignature=resolve);
    return '0x'+n.toString(16).padStart(64,'0');
   }
   throw new Error('Unexpected wallet method '+method);
  }};
 },{account,counters,proxies,empty:!!options.empty,invalidL1:!!options.invalidL1});
 await page.route('**/*',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path.endsWith('/config.json'))return route.fulfill({json:{networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',l1FrontUrl:'/composer/l1',l2FrontUrl:'/composer/l2',l1ContractAddress:managers.l1,l2ContractAddress:managers.l2,rollupId:'1',l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
  if(req.method()!=='POST')return route.continue();
  const {method,params=[],id}=req.postDataJSON();assert(!/send|sign/i.test(method),'RPC broadcast forbidden');requests.push({path,method,params});
  const chain=path.endsWith('l1')?'l1':'l2',other=chain==='l1'?'l2':'l1';
  const reply=result=>route.fulfill({json:{jsonrpc:'2.0',id,result}}),err=message=>route.fulfill({json:{jsonrpc:'2.0',id,error:{code:3,message}}});
  if(method==='eth_chainId')return reply(chainIds[chain]);
  if(method==='eth_getBalance')return reply('0x3635c9adc5dea00000');
  if(method==='eth_getBlockByNumber')return reply({number:'0x10',timestamp:'0x65000000',gasUsed:'0x0',gasLimit:'0x1c9c380',baseFeePerGas:'0x7',transactions:[]});
  if(method==='eth_call'){
   const {to,data}=params[0];
   if(data.startsWith('0xeb20c0aa')){
    assert.equal(to,managers[chain]);assert.equal('0x'+data.slice(34,74),counters[other]);assert.equal(BigInt('0x'+data.slice(-64)),chain==='l1'?1n:0n);
    return reply('0x'+proxies[chain].slice(2).padStart(64,'0'));
   }
   if(data==='0xa87d942c'||data==='0x06661abd'){
    const result=model.deployed[chain]&&to===counters[chain]?word(model.counts[chain]):'0x';
    if(model.countDelay)await new Promise(resolve=>model.pendingReads.push(resolve));
    return reply(result);
   }
   return reply('0x');
  }
  if(method==='eth_getCode'){
   if(model.codeError)return err('Read RPC temporarily unavailable');
   if(chain===model.missingChain)return reply('0x');
   return reply(params[0]===counters[chain]&&model.deployed[chain]||params[0]===proxies[chain]&&model.proxyDeployed[chain]?'0x6000':'0x');
  }
  if(method==='eth_estimateGas'){
   if(model.estimateError)return err(model.estimateError);
   const tx=params[0];
   if(path.startsWith('/composer/'))assert.equal(tx.to,proxies[chain]);
   else assert(!tx.to||tx.to===counters[chain]||tx.to===managers[chain]);
   assert.equal(tx.from,account);assert(!('gas' in tx));assert(!('gasLimit' in tx));
   return reply('0x671af');
  }
  if(method==='eth_getTransactionReceipt'){
   if(!model.receiptReady)return reply(null);
   const tx=await page.evaluate(n=>window.walletRequests[n-1],Number(BigInt(params[0])));
   if(!tx)return reply(null);
   assert.equal(tx.walletChain,chainIds[chain],'receipt must be polled on the submission chain');
   if(model.failed)return reply({status:'0x0',blockNumber:'0x10',logs:[]});
   // Apply each successful mock transaction only once.
   if(!tx.applied){
    await page.evaluate(n=>{window.walletRequests[n-1].applied=true;},Number(BigInt(params[0])));
    if(!tx.to){model.deployed[chain]=true;model.counts[chain]=0n;}
    else if(tx.to===managers[chain])model.proxyDeployed[chain]=true;
    else if(tx.to===proxies[chain])model.counts[other]++;
    else if(tx.to===counters[chain])model.counts[chain]++;
   }
   return reply({status:'0x1',blockNumber:'0x10',logs:[],...(!tx.to?{contractAddress:counters[chain]}:{})});
  }
  if(method==='eth_getTransactionByHash')return reply(null);
  if(method==='eth_gasPrice'||method==='eth_maxPriorityFeePerGas')return reply('0x3b9aca00');
  if(method==='eth_getLogs'||method==='eez_getSettledL2RangesByL1Block')return reply([]);
  return reply(null);
 });
 await page.goto(origin+'/#/counter-demo');
 await page.getByRole('button',{name:'Connect Wallet',exact:true}).click();await page.getByRole('button',{name:'Rabby',exact:true}).click();
 const left=page.getByRole('region',{name:'Counter demo',exact:true}),right=page.getByRole('region',{name:'Counter cross-chain calls',exact:true});
 const choose=async chain=>left.getByRole('button',{name:names[chain],exact:true}).click();
 const value=chain=>left.getByRole('group',{name:`Counter value on ${names[chain]}`,exact:true});
 const send=right.getByRole('button',{name:'Send Cross-Chain Transaction',exact:true}),dialog=page.getByRole('dialog');
 const finish=async title=>{await dialog.getByRole('heading',{name:title,exact:true}).waitFor();await dialog.getByRole('button',{name:'Done',exact:true}).click();};
 return {context,page,left,right,choose,value,send,dialog,finish,requests,errors,model};
}
async function until(check,message){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error(message);
}
(async()=>{
 const browser=await chromium.launch({headless:true,chromiumSandbox: true});let scenarios=0;
 try {
  for(const destination of ['l2','l1']){
   const f=await fixture(browser),source=destination==='l1'?'l2':'l1';
   if(destination==='l1')await f.choose(destination);
   await f.value(destination).getByText(destination==='l1'?'10':'3',{exact:true}).waitFor();await f.send.click({trial:true});
   const route=f.right.getByRole('group',{name:'Call route',exact:true});
   assert((await route.getByRole('group',{name:'Source proxy',exact:true}).getByRole('link').getAttribute('href')).includes(`https://${source}.invalid/address/${proxies[source]}`));
   assert((await route.getByRole('group',{name:'Destination',exact:true}).getByRole('link').getAttribute('href')).includes(`https://${destination}.invalid/address/${counters[destination]}`));
   assert.equal(await f.right.getByLabel('Gas limit',{exact:true}).isVisible(),false);
   await f.send.click();await f.finish('Cross-chain call confirmed');
   await f.value(destination).getByText(destination==='l1'?'11':'4',{exact:true}).waitFor();
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);assert.equal(tx.walletChain,chainIds[source]);assert.equal(tx.to,proxies[source]);assert.equal(tx.data,'0xd09de08a');assert.equal(tx.gas,'0x671af');assert.equal(tx.gasLimit,tx.gas);
   const estimate=f.requests.filter(r=>r.method==='eth_estimateGas');assert(estimate.length && estimate.every(r=>r.path===`/composer/${source}`));
   const history=await f.page.evaluate(()=>JSON.parse(localStorage.getItem('txHistory'))[0]);assert.equal(history.direction,source==='l1'?'l1-to-l2':'l2-to-l1');assert.equal(history.hash,hash(1));assert.equal(history.status,'confirmed');
   // Read functions use the destination read RPC and require no wallet submission.
   await f.right.getByRole('button',{name:/Read \(2\)/}).click();await f.right.getByRole('button',{name:'Call',exact:true}).click();
   await f.right.getByText('Result',{exact:true}).waitFor();
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),1);
   const l=await f.left.boundingBox(),r=await f.right.boundingBox();assert(Math.abs(l.y-r.y)<1);assert(r.x>=l.x+l.width);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const chain of ['l1','l2']){
   const f=await fixture(browser,{empty:true});if(chain==='l1')await f.choose(chain);
   await f.left.getByRole('button',{name:'Deploy counter',exact:true}).click();await f.finish('Counter deployed');
   await f.value(chain).getByText('0',{exact:true}).waitFor();
   const deploy=await f.page.evaluate(()=>window.walletRequests[0]);assert(!('to' in deploy));assert.equal(deploy.walletChain,chainIds[chain]);assert(deploy.data.startsWith('0x60806040'));assert.equal(deploy.gas,deploy.gasLimit);
   const estimate=f.requests.find(r=>r.method==='eth_estimateGas'&&!r.params[0].to);assert(estimate);assert.equal(estimate.path,`/rpc/${chain}`);
   assert.equal(await f.page.evaluate(key=>localStorage.getItem(key),chain==='l1'?'counterAddressL1':'counterAddress'),counters[chain]);
   await f.left.getByRole('button',{name:'Increment (+1)',exact:true}).click();await f.finish('Counter incremented');
   await f.value(chain).getByText('1',{exact:true}).waitFor();
   const increment=await f.page.evaluate(()=>window.walletRequests[1]);assert.equal(increment.to,counters[chain]);assert.equal(increment.data,'0xd09de08a');assert.equal(increment.walletChain,chainIds[chain]);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const destination of ['l1','l2']){
   const source=destination==='l1'?'l2':'l1',f=await fixture(browser,{noProxy:true});if(destination==='l1')await f.choose(destination);
   await f.right.getByRole('button',{name:`Create proxy on ${names[source]}`,exact:true}).click();await f.finish('Proxy created');await f.send.click({trial:true});
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);assert.equal(tx.to,managers[source]);assert.equal(tx.walletChain,chainIds[source]);assert.equal(tx.data.slice(0,10),'0xa7587c62');assert.equal(BigInt('0x'+tx.data.slice(-64)),source==='l1'?1n:0n);
   const stored=await f.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),source==='l1'?'crossChainProxies':'crossChainProxiesL2');assert.equal(stored[counters[destination]],proxies[source]);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.value('l2').getByText('3',{exact:true}).waitFor();await f.choose('l1');await f.value('l1').getByText('10',{exact:true}).waitFor();
   await f.left.getByRole('button',{name:'Clear',exact:true}).click();assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddressL1')),null);
   assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddress')),l2Counter);
   await f.choose('l2');assert.equal(await f.left.getByLabel('Counter address on EEZ-X Devnet',{exact:true}).inputValue(),l2Counter);
   await f.page.reload();await f.value('l2').getByText('3',{exact:true}).waitFor();
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const action of ['increment','deploy']){
   const f=await fixture(browser,{empty:action==='deploy'});if(action==='increment')await f.value('l2').getByText('3',{exact:true}).waitFor();
   f.model.failed=true;await f.left.getByRole('button',{name:action==='deploy'?'Deploy counter':'Increment (+1)',exact:true}).click();
   await f.dialog.getByRole('heading',{name:'Counter transaction failed',exact:true}).waitFor();await f.dialog.getByRole('alert').getByText('Transaction reverted on EEZ-X Devnet',{exact:true}).waitFor();
   if(action==='deploy')assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddress')),null);
   else await f.value('l2').getByText('3',{exact:true}).waitFor();
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.value('l2').getByText('3',{exact:true}).waitFor();f.model.receiptReady=false;
   await f.send.click({trial:true});await f.left.getByRole('button',{name:'Increment (+1)',exact:true}).click();await f.dialog.getByRole('heading',{name:'Waiting for confirmation',exact:true}).waitFor();
   await f.dialog.getByRole('button',{name:'Close',exact:true}).click();assert(await f.left.getByRole('button',{name:'Chiado',exact:true}).isDisabled());assert(await f.right.getByRole('button',{name:'Sending...',exact:true}).isDisabled());
   f.model.receiptReady=true;await f.finish('Counter incremented');await f.value('l2').getByText('4',{exact:true}).waitFor();
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.send.click({trial:true});f.model.estimateError='execution reverted: counter denied';
   await f.choose('l1');await f.right.getByText('Transaction will revert:',{exact:false}).waitFor();assert(await f.right.getByRole('button',{name:'Transaction Will Revert',exact:true}).isDisabled());
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.send.click({trial:true});f.model.codeError=true;
   await f.choose('l1');await f.right.getByRole('alert').getByText('Read RPC temporarily unavailable',{exact:true}).waitFor();assert.equal(await f.send.count(),0);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.choose('l1');await f.send.click({trial:true});await f.page.evaluate(()=>window.rejectSwitch=true);await f.send.click();
   await f.dialog.getByRole('heading',{name:'Cross-chain call failed',exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser,{missingChain:'l1'});await f.value('l2').getByText('3',{exact:true}).waitFor();
   await f.choose('l1');await until(async()=>await f.left.getByLabel('Counter address on Chiado',{exact:true}).inputValue()==='','wiped L1 counter was not cleared');
   assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddressL1')),null);assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddress')),l2Counter);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser,{codeError:true});await f.value('l2').getByText('3',{exact:true}).waitFor();await f.choose('l1');await f.value('l1').getByText('10',{exact:true}).waitFor();
   assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddressL1')),l1Counter);assert.equal(await f.page.evaluate(()=>localStorage.getItem('counterAddress')),l2Counter);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.value('l2').getByText('3',{exact:true}).waitFor();f.model.countDelay=true;
   await f.left.getByRole('button',{name:'Refresh',exact:true}).click();await until(()=>f.model.pendingReads.length>0,'delayed counter read missing');
   await f.left.getByLabel('Counter address on EEZ-X Devnet',{exact:true}).fill('');f.model.countDelay=false;f.model.pendingReads.forEach(release=>release());
   await f.page.waitForTimeout(100);await f.value('l2').getByText('—',{exact:true}).waitFor();assert.equal(await f.send.count(),0,'old count cannot enable calls for a cleared counter');
   await f.left.getByLabel('Counter address on EEZ-X Devnet',{exact:true}).fill(l2Counter);await f.value('l2').getByText('3',{exact:true}).waitFor();
   const large=2n**255n;f.model.counts.l2=large;await f.left.getByRole('button',{name:'Refresh',exact:true}).click();await f.value('l2').getByText(large.toLocaleString('en-US'),{exact:true}).waitFor();
   await f.page.setViewportSize({width:320,height:1080});assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.send.click({trial:true});
   for(const width of [1920,1440,1280,1100,1024,800,640,390,320]){
    await f.page.setViewportSize({width,height:1100});assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
    const tiny=await f.left.evaluate(root=>[...root.querySelectorAll('*')].filter(el=>!el.children.length&&el.textContent.trim()&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
    assert.deepEqual(tiny,[], 'Counter demo labels below 12px at '+width);
    const l=await f.left.boundingBox(),r=await f.right.boundingBox();
    if(width>1000){assert(Math.abs(l.y-r.y)<1);assert(Math.abs(l.width/r.width-2/3)<.02);}
    else assert(r.y>=l.y+l.height);
    if(width===1440)await f.page.screenshot({path:'/tmp/eez-counter-demo-desktop.png',fullPage:true});
    if(width===390)await f.page.screenshot({path:'/tmp/eez-counter-demo-mobile.png',fullPage:true});
   }
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  console.log(JSON.stringify({passed:true,scenarios,bothCounterNetworks:true,bothCallDirections:true,sourceComposerEstimation:true,independentCounterCaches:true,legacyL2CachePreserved:true,wipedCacheChainScoped:true,rpcErrorsPreserveCaches:true,staleReadsIgnored:true,uint256Precision:true,deploymentOmitsTo:true,failedReceiptsRejected:true,pendingModalCloseKeepsPolling:true,destinationReads:true,historyDirections:true,responsiveWidths:9,transactionsBroadcast:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
