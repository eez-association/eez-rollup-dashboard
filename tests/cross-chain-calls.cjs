// All wallet submissions and RPC responses are mocked. Never broadcast a real transaction.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { keccak256, toHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const addr = b => '0x'+b.repeat(20), hash = '0x'+'44'.repeat(32);
const account=addr('22'), target=addr('77'), eoa=addr('88'), fresh=addr('99'), registry=addr('11'), manager=addr('33');
const forward={ [target]:addr('55'), [eoa]:addr('aa') }, reverse={ [target]:addr('66'), [eoa]:addr('cc') };
const proxyFor=(address,l1)=>address===target?(l1?addr('55'):addr('66')):address===eoa?(l1?addr('aa'):addr('cc')):(l1?addr('bb'):addr('dd'));
async function fixture(browser,options={}){
 const context=await browser.newContext(), page=await context.newPage();
 const requests=[],errors=[],receipt={value:null},estimation={error:null,delay:false,pending:[]};
 const verification={codeError:options.codeError??false,missing:false,mismatch:false},deployed=new Set(),deploying=new Set();
 const proxyLookup={rollupId:null,malformed:false,delay:false,pending:[]};
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(({account,hash,forward,reverse,walletName,chain})=>{
  if(!localStorage.getItem('crossChainFixture')){
   localStorage.setItem('crossChainProxies',JSON.stringify(forward));localStorage.setItem('crossChainProxiesL2',JSON.stringify(reverse));
   const recent=Array.from({length:8},(_,i)=>'0x'+String(i+1).repeat(40));
   localStorage.setItem('recentL1Addresses',JSON.stringify(recent));localStorage.setItem('recentL2Addresses',JSON.stringify(recent));
   localStorage.setItem('crossChainFixture','seeded');
  }
  window.walletRequests=[];window.switches=[];window.currentChain=chain;window.rejectSwitch=false;window.holdSignature=false;
  window.ethereum={isRabby:walletName==='Rabby',isMetaMask:walletName==='MetaMask',on(){},removeListener(){},async request({method,params}){
   if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
   if(method==='eth_chainId')return window.currentChain;
   if(method==='eth_getTransactionCount')return '0x0';
   if(method==='wallet_addEthereumChain')return null;
   if(method==='wallet_switchEthereumChain'){if(window.rejectSwitch)throw new Error('User rejected switch');window.currentChain=params[0].chainId;window.switches.push(window.currentChain);return null;}
   if(method==='eth_sendTransaction'){window.walletRequests.push({...params[0],walletChain:window.currentChain});if(window.holdSignature)await new Promise(resolve=>window.releaseSignature=resolve);return hash;}
   throw new Error('Unexpected wallet method '+method);
  }};
 },{account,hash,forward,reverse,walletName:options.walletName||'Rabby',chain:options.chain||'0x27d8'});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(path.endsWith('/config.json'))return route.fulfill({json:{l1FeesEnabled:!!options.feesEnabled,l2FeesEnabled:!!options.feesEnabled,l1FeeMaxTotalWei:options.feeCeiling||'100000000000000000',l2FeeMaxTotalWei:options.feeCeiling||'100000000000000000',networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',l1FrontUrl:'/composer/l1',l2FrontUrl:'/composer/l2',l1ContractAddress:registry,l2ContractAddress:manager,rollupId:'1',l1ExplorerApiUrl:'/explorer/l1',l2ExplorerApiUrl:'/explorer/l2',l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
  if(path.startsWith('/explorer/')){
   requests.push({path,action:url.searchParams.get('action'),address:url.searchParams.get('address')});
   const contract=url.searchParams.get('address')===target, l1=path.startsWith('/explorer/l1');
   if(!contract)return route.fulfill({json:{status:'0',result:'Contract is not verified'}});
   if(url.searchParams.get('action')==='getsourcecode')return route.fulfill({json:{status:'1',result:[{ContractName:l1?'L1 Vault':'L2 Counter'}]}});
   return route.fulfill({json:{status:'1',result:JSON.stringify([{type:'function',name:l1?'setValue':'increment',inputs:l1?[{name:'value',type:'uint256'}]:[],outputs:[],stateMutability:'nonpayable'}])}});
  }
  if(req.method()!=='POST')return route.continue();
  const {method,params=[],id}=req.postDataJSON();assert(!/send|sign/i.test(method),'RPC broadcast forbidden');requests.push({path,method,params});
  const l1=path.endsWith('l1'), reply=result=>route.fulfill({json:{jsonrpc:'2.0',id,result}});let result=null;
  if(method==='eez_quoteFee'){
   assert(path.startsWith('/composer/'),'fee quotes must use the source Composer');
   const [request,selection]=params;
   assert.deepEqual(selection.transactionTypes,[request.type]);
   assert.equal(request.chainId,l1?(options.chain||'0x27d8'):(options.l2Chain||'0x1892'));
   const transaction={nonce:'0x0',gas:'0x671af',...request};
   const canonical=JSON.stringify(Object.fromEntries(Object.keys(transaction).sort().map(key=>[key,transaction[key]])));
   return reply({version:1,chainId:transaction.chainId,nonce:transaction.nonce,expiresAt:'0x'+(Math.floor(Date.now()/1000)+30).toString(16),
    options:[{type:transaction.type,gas:transaction.gas,requestHash:keccak256(toHex(canonical)),estimatedFee:'0x4ce78',
     ...(transaction.type==='0x0'?{gasPrice:'0xf'}:{maxPriorityFeePerGas:'0x5',maxFeePerGas:'0xf'})}]});
  }
  if(method==='eth_chainId')result=l1?(options.chain||'0x27d8'):(options.l2Chain||'0x1892');
  if(method==='eth_getBalance')result='0x3635c9adc5dea00000';
  if(method==='eth_getBlockByNumber')result={number:'0x10',timestamp:'0x65000000',gasUsed:'0x0',gasLimit:'0x1c9c380',baseFeePerGas:'0x7',transactions:[]};
  if(method==='eth_call'&&params[0].data.startsWith('0xeb20c0aa')){
   assert.equal(params[0].to,l1?registry:manager);assert.equal(BigInt('0x'+params[0].data.slice(-64)),l1?1n:0n);
   const destination='0x'+params[0].data.slice(34,74);result='0x'+(verification.mismatch?addr('ee'):proxyFor(destination,l1)).slice(2).padStart(64,'0');
  }
  if(method==='eth_call'&&params[0].data.startsWith('0x360d95b6')){
   assert.equal(params[0].to,l1?registry:manager,'proxy metadata must come from the source manager');
   const proxy='0x'+params[0].data.slice(-40);
   const destination=Object.entries(l1?forward:reverse).find(([,value])=>value.toLowerCase()===proxy.toLowerCase())?.[0];
   result=proxyLookup.malformed?'0x1234':'0x'+[destination?'1':'0',(destination||addr('00')).slice(2),(proxyLookup.rollupId??(l1?1n:0n)).toString(16)].map(value=>value.padStart(64,'0')).join('');
   if(proxyLookup.delay)await new Promise(resolve=>proxyLookup.pending.push(resolve));
  }
  if(method==='eth_getCode'){
   if(verification.codeError)return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32000,message:'Read RPC temporarily unavailable'}}});
   result=!verification.missing&&([...Object.values(forward),...Object.values(reverse)].includes(params[0])||deployed.has(params[0]))?'0x6000':'0x';
  }
  if(method==='eth_estimateGas'){
   if(path.startsWith('/rpc/')){
    assert.equal(params[0].to,l1?registry:manager,'proxy calls must estimate through Composer');
    if(params[0].data.startsWith('0xa7587c62'))deploying.add(proxyFor('0x'+params[0].data.slice(34,74),l1));
   }
   if(path.startsWith('/composer/')){
    if(estimation.delay)await new Promise(resolve=>estimation.pending.push(resolve));
    if(estimation.error)return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:3,message:estimation.error}}});
   }
   return reply('0x671af');
  }
  if(method==='eth_getTransactionReceipt'){
   result=receipt.value;
   if(result?.status==='0x1'){for(const proxy of deploying)deployed.add(proxy);deploying.clear();}
  }
  if(method==='eth_gasPrice'||method==='eth_maxPriorityFeePerGas')result='0x3b9aca00';
  if(method==='eth_getLogs'||method==='eez_getSettledL2RangesByL1Block')result=[];
  return reply(result);
 });
 await page.goto(origin+'/#/bridge');await page.getByRole('button',{name:'Connect Wallet',exact:true}).click();await page.getByRole('button',{name:options.walletName||'Rabby',exact:true}).click();
 const panel=page.getByRole('region',{name:'Cross-chain contracts'});
 await panel.getByText('L2 Counter',{exact:false}).first().waitFor();await panel.getByText('L1 Vault',{exact:false}).first().waitFor();
 const select=async(address,back)=>panel.getByRole('button',{name:`Select proxy for ${address} on ${back?'L2':'L1'}`,exact:true}).click();
 const send=panel.getByRole('button',{name:'Send Cross-Chain Transaction',exact:true});
 const dialog=page.getByRole('dialog');
 const waitPending=async(network,creation=false)=>{
  await dialog.getByRole('heading',{name:'Waiting for confirmation',exact:true}).waitFor();
  await dialog.getByRole('status').getByText(`Your ${creation?'proxy creation':'cross-chain call'} is pending on ${network}.`,{exact:true}).waitFor();
 };
 return {page,context,panel,select,send,requests,errors,receipt,estimation,verification,proxyLookup,dialog,waitPending};
}
async function until(condition, message) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error(message);
}
module.exports={fixture,until,target,eoa,fresh,forward,reverse};

if(require.main===module)(async()=>{
 const browser=await chromium.launch({headless:true,chromiumSandbox: true});let scenarios=0;
 try {
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(target,back);await f.send.waitFor({state:'visible'});await assert.doesNotReject(()=>f.send.click({trial:true}));
   const builder=f.panel.locator('[data-call-builder]');
   await builder.getByText(back?'L1 Vault':'L2 Counter',{exact:false}).first().waitFor();
   assert.equal(await f.panel.getByRole('columnheader',{name:'Status',exact:true}).count(),0);
   assert.equal(await f.page.evaluate(()=>window.currentChain),back?'0x1892':'0x27d8');
   const source=f.panel.getByRole('group',{name:'Source proxy',exact:true}),destination=f.panel.getByRole('group',{name:'Destination',exact:true});
   assert.equal(await source.getByText(back?'EEZ-X Devnet':'Chiado',{exact:true}).count(),1);
   assert.equal(await destination.getByText(back?'Chiado':'EEZ-X Devnet',{exact:true}).count(),1);
   assert.equal(await source.locator(`a[href="https://${back?'l2':'l1'}.invalid/address/${back?reverse[target]:forward[target]}"]`).count(),1);
   assert.equal(await destination.locator(`a[href="https://${back?'l1':'l2'}.invalid/address/${target}"]`).count(),1);
   assert(await builder.getByText('[ PREPARE CALL ]',{exact:true}).evaluate(e=>getComputedStyle(e).fontFamily.includes('Geist Mono')));
   assert(await source.getByText(back?'EEZ-X Devnet':'Chiado',{exact:true}).evaluate(e=>getComputedStyle(e).fontFamily.startsWith('Geist,')));
   assert.equal(await f.panel.getByRole('group',{name:'Call route',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','route surface stays neutral');
   assert.equal(await f.panel.getByLabel('Gas limit',{exact:true}).isVisible(),false);
   await builder.getByText('Gas settings',{exact:true}).click();
   const gas=f.panel.getByLabel('Gas limit',{exact:true});await gas.fill('500000');
   await builder.getByText('Gas settings',{exact:true}).click();
   await f.page.clock.install();await f.send.click();
   await f.waitPending(back?'EEZ-X Devnet':'Chiado');
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);
   assert.equal(tx.to,back?reverse[target]:forward[target]);assert.equal(tx.walletChain,back?'0x1892':'0x27d8');assert.equal(tx.gas,'0x7a120');assert.equal(tx.gasLimit,tx.gas);
   assert.ok(tx.data.startsWith(back?'0x55241077':'0xd09de08a'));assert.equal(tx.value,'0x0');
   const estimates=f.requests.filter(r=>r.method==='eth_estimateGas'&&r.path.startsWith('/composer/'));assert(estimates.length);assert(estimates.every(r=>r.path===(back?'/composer/l2':'/composer/l1')));
   assert(estimates.every(r=>Object.keys(r.params[0]).sort().join(',')==='data,from,to,value'));assert.equal(estimates.at(-1).params[0].from,account);
   f.receipt.value={status:'0x1',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
   await f.dialog.getByRole('heading',{name:'Cross-chain call confirmed',exact:true}).waitFor();
   await f.dialog.getByRole('status').getByText('Cross-chain call confirmed on '+(back?'EEZ-X Devnet':'Chiado')+'.',{exact:true}).waitFor();
   const history=await f.page.evaluate(()=>JSON.parse(localStorage.getItem('txHistory'))[0]);assert.equal(history.direction,back?'l2-to-l1':'l1-to-l2');assert.equal(history.status,'confirmed');
   assert(f.requests.some(r=>r.method==='eth_getTransactionReceipt'&&r.path===(back?'/rpc/l2':'/rpc/l1')));
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(eoa,back);await f.panel.getByLabel('Calldata',{exact:true}).waitFor();await f.panel.getByLabel('Value (xDAI)',{exact:true}).fill('0.01');
   await f.send.click({trial:true});await f.send.click();await f.waitPending(back?'EEZ-X Devnet':'Chiado');
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);assert.equal(tx.data,'0x');assert.equal(tx.value,'0x2386f26fc10000');assert.equal(tx.gas,'0x671af');assert.equal(tx.gasLimit,tx.gas);
   assert.equal(await f.panel.getByText('Enter calldata above to enable sending',{exact:true}).count(),0);
   assert.equal(await f.panel.getByLabel('ABI JSON',{exact:true}).evaluate(e=>getComputedStyle(e).resize),'none');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(target,false);await f.send.click({trial:true});await f.page.evaluate(()=>window.rejectSwitch=true);await f.select(target,true);
   await f.panel.getByRole('alert').getByText('Wallet network switch was cancelled.',{exact:false}).waitFor();
   assert.equal(await f.panel.getByRole('button',{name:`Selected proxy for ${target} on L1`,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   for(const back of [false,true]){
    if(back)await f.panel.getByRole('button',{name:'Call L2 to L1',exact:true}).click();
    await f.panel.getByLabel('Destination address',{exact:false}).fill(fresh);
    const create=f.panel.getByRole('button',{name:'Create proxy',exact:true});await create.waitFor();if(!back)await f.page.clock.install();f.receipt.value=null;await create.click();
    await f.waitPending(back?'EEZ-X Devnet':'Chiado',true);
    const tx=await f.page.evaluate(()=>window.walletRequests.at(-1));assert.equal(tx.to,back?manager:registry);assert.equal(tx.data.slice(0,10),'0xa7587c62');assert.equal(BigInt('0x'+tx.data.slice(-64)),back?0n:1n);
    f.receipt.value={status:'0x1',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
    await f.panel.getByRole('button',{name:`Selected proxy for ${fresh} on ${back?'L2':'L1'}`,exact:true}).waitFor();
    await f.dialog.getByRole('heading',{name:'Proxy created',exact:true}).waitFor();
    assert.equal(await f.page.evaluate(({key,fresh})=>JSON.parse(localStorage.getItem(key))[fresh],{key:back?'crossChainProxiesL2':'crossChainProxies',fresh}),proxyFor(fresh,!back));
    const row=f.page.getByRole('region',{name:'Transaction history'}).locator('li').first();
    assert.equal(await row.getByRole('group',{name:back?'L2':'L1',exact:true}).count(),1);
    if(!back)assert.equal(await row.getByText('L2 transaction not indexed yet',{exact:true}).count(),0);
    await f.dialog.getByRole('button',{name:'Done',exact:true}).click();
   }
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),2);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser,{codeError:true});
   assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('crossChainProxies'))),forward);
   assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('crossChainProxiesL2'))),reverse);
   assert(f.requests.some(r=>r.method==='eth_getCode'&&r.path==='/rpc/l1'));
   assert(f.requests.some(r=>r.method==='eth_getCode'&&r.path==='/rpc/l2'));
   await f.select(target,false);await f.panel.getByRole('alert').filter({hasText:'Cannot verify proxy'}).waitFor();
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);
   assert.equal(await f.page.evaluate(()=>window.switches.length),0);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const failure of ['missing','mismatch']){
   const f=await fixture(browser);await f.select(eoa,true);await f.send.click({trial:true});
   f.verification[failure]=true;await f.send.click();
   await f.dialog.getByRole('alert').filter({hasText:failure==='missing'?'Proxy is not deployed on L2':'Saved proxy does not match the registry address for this destination'}).waitFor();
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0,'invalid proxy must not reach the wallet');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,false);await f.panel.getByLabel('Value (xDAI)',{exact:true}).focus();
   assert.equal(await f.panel.getByLabel('Value (xDAI)',{exact:true}).evaluate(e=>getComputedStyle(e).outlineOffset),'-2px');
   const paint=await f.panel.evaluate(e=>{const s=getComputedStyle(e,'::before');return {top:s.top,left:s.left,right:s.right,radius:s.borderTopLeftRadius,overflow:getComputedStyle(e).overflow};});
   assert.deepEqual(paint,{top:'-1px',left:'-1px',right:'-1px',radius:'16px',overflow:'visible'});
   await f.panel.getByLabel('Value (xDAI)',{exact:true}).screenshot({path:'/tmp/eez-contained-focus-ring.png'});
   await f.panel.screenshot({path:'/tmp/eez-card-border-alignment.png'});
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,true);await f.send.click({trial:true});await f.page.clock.install();await f.send.click();
   await f.waitPending('EEZ-X Devnet');
   f.receipt.value={status:'0x0',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
   await f.dialog.getByRole('heading',{name:'Cross-chain call failed',exact:true}).waitFor();
   await f.dialog.getByRole('alert').filter({hasText:'Transaction reverted on L2'}).waitFor();
   assert.equal(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('txHistory'))[0].status),'failed');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);f.estimation.error='execution reverted: refused';await f.select(eoa,true);await f.panel.getByText('Transaction will revert:',{exact:false}).waitFor();
   assert.equal(await f.panel.getByRole('button',{name:'Transaction Will Revert',exact:true}).isDisabled(),true);
   await f.panel.getByText('Gas settings',{exact:true}).click();
   await f.panel.getByLabel('Gas limit',{exact:true}).fill('500000');assert.equal(await f.panel.getByRole('button',{name:'Transaction Will Revert',exact:true}).isDisabled(),true);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,false);await f.send.click({trial:true});
   f.estimation.delay=true;await f.panel.getByLabel('Calldata',{exact:true}).fill('0x1234');
   assert.equal(await f.send.isDisabled(),true,'changed calldata invalidates the previous estimate immediately');
   await until(()=>f.estimation.pending.length===1,'first delayed estimate missing');
   await f.panel.getByLabel('Calldata',{exact:true}).fill('0x5678');await until(()=>f.estimation.pending.length===2,'second delayed estimate missing');
   f.estimation.delay=false;for(const release of f.estimation.pending.splice(0).reverse())release();
   await f.send.click({trial:true});await f.send.click();await f.waitPending('Chiado');
   assert.equal(await f.page.evaluate(()=>window.walletRequests[0].data),'0x5678','old estimates must not restore stale calldata');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,false);await f.send.click({trial:true});
   await f.panel.getByText('Gas settings',{exact:true}).click();
   for(const width of [1920,1440,1280,1024,800,640,390,320]){
    await f.page.setViewportSize({width,height:1080});assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
    const tiny=await f.panel.evaluate(root=>[...root.querySelectorAll('*')].filter(el=>!el.children.length&&el.textContent.trim()&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
    assert.deepEqual(tiny,[], 'Cross-chain call data below 12px at '+width);
   }
   await f.page.setViewportSize({width:1440,height:1080});await f.panel.hover();await f.panel.screenshot({path:'/tmp/eez-bidirectional-calls.png'});
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(eoa,back);await f.send.click({trial:true});
   await f.page.clock.install();await f.page.evaluate(()=>window.holdSignature=true);await f.send.click();
   await f.dialog.getByRole('heading',{name:'Confirm in your wallet',exact:true}).waitFor();
   await f.page.waitForFunction(()=>typeof window.releaseSignature==='function');
   await f.page.evaluate(()=>window.releaseSignature());await f.waitPending(back?'EEZ-X Devnet':'Chiado');
   assert.equal(await f.panel.getByText('Waiting for confirmation on '+(back?'EEZ-X Devnet':'Chiado')+'…',{exact:true}).count(),0);
   const spinner=f.dialog.locator('span[aria-hidden="true"]');
   const before=await spinner.evaluate(e=>getComputedStyle(e).transform);await f.page.waitForTimeout(220);
   assert.notEqual(await spinner.evaluate(e=>getComputedStyle(e).transform),before,'proxy spinner rotates');
   await f.dialog.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await f.dialog.count(),0);
   assert.equal(await f.page.evaluate(()=>document.body.style.overflow),'');
   assert(await f.panel.getByRole('button',{name:/Sending/}).isDisabled());
   await f.panel.getByRole('button',{name:'View transaction',exact:true}).click();await f.waitPending(back?'EEZ-X Devnet':'Chiado');
   await f.page.keyboard.press('Escape');assert.equal(await f.dialog.count(),0);
   f.receipt.value={status:'0x1',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
   await f.dialog.getByRole('heading',{name:'Cross-chain call confirmed',exact:true}).waitFor();
   const chain=back?'l2':'l1';assert.equal(await f.dialog.locator(`a[href="https://${chain}.invalid/tx/${hash}"]`).count(),1);
   await f.page.clock.runFor(6000);await f.dialog.getByRole('heading',{name:'Cross-chain call confirmed',exact:true}).waitFor();
   await f.page.setViewportSize({width:320,height:844});assert(await f.dialog.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
   await f.dialog.screenshot({path:'/tmp/eez-proxy-confirmation-popup.png'});
   await f.dialog.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await f.dialog.count(),0);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const back of [false,true]){
   const f=await fixture(browser),key=back?'crossChainProxiesL2':'crossChainProxies',otherKey=back?'crossChainProxies':'crossChainProxiesL2';
   await f.select(target,back);await f.send.click({trial:true});
   await f.panel.getByRole('button',{name:`Remove saved proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).click();
   assert.equal(await f.panel.getByRole('button',{name:`Select proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).count(),0);
   assert.equal(await f.page.evaluate(({key,target})=>JSON.parse(localStorage.getItem(key))[target],{key,target}),undefined);
   assert.equal(await f.page.evaluate(({key,target})=>JSON.parse(localStorage.getItem(key))[target],{key:otherKey,target}),back?forward[target]:reverse[target]);
   assert.equal(await f.send.count(),0,'removing the selected proxy clears the call form');
   await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   const input=f.panel.getByLabel('Destination address',{exact:false});await input.fill(target);
   const save=f.panel.getByRole('button',{name:'Save proxy',exact:true});await save.waitFor();await save.click();
   await f.panel.getByRole('button',{name:`Selected proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).waitFor();
   assert.equal(await f.page.evaluate(({key,target})=>JSON.parse(localStorage.getItem(key))[target],{key,target}),back?reverse[target]:forward[target]);
   await f.panel.getByText('Use an existing proxy address',{exact:true}).click();
   const importInput=f.panel.getByLabel('Proxy address',{exact:false});await importInput.fill(addr('ee'));
   await f.panel.getByRole('alert').filter({hasText:'not a registered cross-chain proxy'}).waitFor();assert(await save.isDisabled());
   assert.equal(await f.page.evaluate(({key,target})=>JSON.parse(localStorage.getItem(key))[target],{key,target}),back?reverse[target]:forward[target]);
   f.verification.missing=true;await importInput.fill(back?reverse[target]:forward[target]);
   await f.panel.getByRole('alert').filter({hasText:`Proxy is not deployed on ${back?'L2':'L1'}`}).waitFor();f.verification.missing=false;
   f.verification.codeError=true;await f.panel.getByRole('button',{name:'Retry lookup',exact:true}).click();
   await f.panel.getByRole('alert').filter({hasText:'Read RPC temporarily unavailable'}).waitFor();
   assert.equal(await f.page.evaluate(({key,target})=>JSON.parse(localStorage.getItem(key))[target],{key,target}),back?reverse[target]:forward[target]);
   f.verification.codeError=false;
   await f.panel.getByRole('button',{name:'Retry lookup',exact:true}).click();await f.panel.getByText('Saved',{exact:true}).waitFor();
   await f.panel.getByRole('button',{name:`Remove saved proxy for ${eoa} on ${back?'L2':'L1'}`,exact:true}).click();
   assert.equal(await f.panel.getByRole('button',{name:`Selected proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).getAttribute('aria-pressed'),'true','removing another row preserves selection');
   assert.equal(await f.send.count(),1);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0,'saving and removing proxies are browser-only actions');
   await f.page.reload();await f.panel.getByRole('button',{name:`Select proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).waitFor();
   await f.panel.getByRole('button',{name:`Remove saved proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).click();
   await f.page.reload();await f.panel.getByRole('button',{name:`Select proxy for ${eoa} on ${back?'L1':'L2'}`,exact:true}).waitFor();
   assert.equal(await f.panel.getByRole('button',{name:`Select proxy for ${target} on ${back?'L2':'L1'}`,exact:true}).count(),0,'removed proxy stays removed after reload');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   const input=f.panel.getByLabel('Destination address',{exact:false});await input.focus();
   const recent=f.panel.getByText('Recent addresses',{exact:true}).locator('..');await recent.waitFor();
   assert.equal(await recent.getByRole('button').count(),8);
   await recent.getByRole('button').last().click();assert.equal(await input.inputValue(),'0x'+'8'.repeat(40));
   for(const width of [1440,1024,640,390,320]){
    await f.page.setViewportSize({width,height:1080});await input.click();await recent.waitFor();
    assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'proxy form overflow at '+width);
    assert(await recent.evaluate(e=>{const p=e.closest('[hidden]');return !p&&e.getBoundingClientRect().height>=150;}),'recent list clipped at '+width);
    await f.panel.getByText('[ PREPARE CALL ]',{exact:true}).waitFor();
    const listBox=await recent.boundingBox(),builderBox=await f.panel.locator('[data-call-builder]').boundingBox();
    assert(listBox.y+listBox.height<builderBox.y,'recent list overlaps prepare call at '+width);
    await f.page.keyboard.press('Escape');assert.equal(await recent.isVisible(),false);
   }
   await f.page.setViewportSize({width:1440,height:1080});await input.click();await f.panel.screenshot({path:'/tmp/eez-proxy-manager-updated.png'});
   await f.panel.getByRole('button',{name:'Hide address',exact:true}).click();assert.equal(await input.isVisible(),false);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(eoa,back);await f.send.click({trial:true});
   await f.panel.getByRole('button',{name:`Remove saved proxy for ${eoa} on ${back?'L2':'L1'}`,exact:true}).click();
   await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   assert.equal(await f.panel.getByLabel('Destination address',{exact:false}).inputValue(),'');
   await f.panel.getByRole('button',{name:'Use an existing proxy address',exact:true}).click();
   assert.equal(await f.panel.getByLabel('Destination address',{exact:false}).count(),0,'proxy-only import does not require a destination field');
   const proxy=back?reverse[eoa]:forward[eoa],input=f.panel.getByLabel(`Proxy address on ${back?'EEZ-X Devnet':'Chiado'}`,{exact:true});
   await input.fill(proxy);
   await f.panel.getByRole('group',{name:'Detected destination',exact:true}).locator(`a[href="https://${back?'l1':'l2'}.invalid/address/${eoa}"]`).waitFor();
   await f.send.click({trial:true});
   assert((await f.panel.getByRole('group',{name:'Source proxy',exact:true}).getByRole('link').getAttribute('href')).endsWith('/address/'+proxy));
   const calls=f.requests.filter(r=>r.method==='eth_call'&&r.params[0].data.startsWith('0x360d95b6'));
   assert(calls.length);assert(calls.every(r=>r.path===(back?'/rpc/l2':'/rpc/l1')&&r.params[0].to===(back?manager:registry)));
   await f.panel.getByRole('button',{name:'Save proxy',exact:true}).click();await f.panel.getByText('Saved',{exact:true}).waitFor();
   assert.equal(await f.page.evaluate(({key,eoa})=>JSON.parse(localStorage.getItem(key))[eoa],{key:back?'crossChainProxiesL2':'crossChainProxies',eoa}),proxy);
   await f.page.setViewportSize({width:320,height:1080});assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await f.panel.locator('[class*="deployInner"]').screenshot({path:'/tmp/eez-proxy-only-import.png'});
   await f.panel.getByRole('button',{name:`Remove saved proxy for ${eoa} on ${back?'L2':'L1'}`,exact:true}).click();
   assert.equal(await input.inputValue(),'');assert.equal(await f.send.count(),0);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const issue of ['wrong-network','malformed','registry-mismatch']){
   const f=await fixture(browser);await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   await f.panel.getByRole('button',{name:'Use an existing proxy address',exact:true}).click();
   if(issue==='wrong-network')f.proxyLookup.rollupId=2n;if(issue==='malformed')f.proxyLookup.malformed=true;if(issue==='registry-mismatch')f.verification.mismatch=true;
   await f.panel.getByLabel('Proxy address on Chiado',{exact:true}).fill(forward[eoa]);
   await f.panel.getByRole('alert').filter({hasText:issue==='wrong-network'?'different network':issue==='malformed'?'invalid response':'does not match the registry'}).waitFor();
   assert(await f.panel.getByRole('button',{name:'Save proxy',exact:true}).isDisabled());assert.equal(await f.send.count(),0);
   assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('crossChainProxies'))),forward);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   await f.panel.getByRole('button',{name:'Use an existing proxy address',exact:true}).click();f.proxyLookup.delay=true;
   const input=f.panel.getByLabel('Proxy address on Chiado',{exact:true});await input.fill(forward[target]);
   await until(()=>f.proxyLookup.pending.length===1,'first proxy lookup missing');await input.fill(forward[eoa]);
   await until(()=>f.proxyLookup.pending.length===2,'second proxy lookup missing');f.proxyLookup.delay=false;
   f.proxyLookup.pending[1]();await f.panel.getByRole('group',{name:'Detected destination',exact:true}).getByRole('link').waitFor();f.proxyLookup.pending[0]();
   await f.page.waitForTimeout(100);
   assert((await f.panel.getByRole('group',{name:'Detected destination',exact:true}).getByRole('link').getAttribute('href')).endsWith('/address/'+eoa),'old lookup cannot overwrite the new destination');
   assert.equal(await input.inputValue(),forward[eoa]);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  console.log(JSON.stringify({passed:true,scenarios,bothDirections:true,sourceComposerEstimates:true,manualGas:true,eoasAndEmptyCalldata:true,proxyCreationBothChains:true,separateCaches:true,registryAndCodeVerified:true,invalidProxiesBlockSubmission:true,focusRingContained:true,accentMatchesBorder:true,chainScopedNamesAndAbi:true,rejectedSwitchPreservesSelection:true,sourceReceiptPolling:true,historyDirections:true,transactionPopups:true,pendingDismissKeepsPolling:true,resultReopens:true,spinnerAnimates:true,proxySaveAndRemove:true,invalidImportsRejected:true,proxyOnlyImport:true,sourceRegistryMetadata:true,wrongNetworkImportsRejected:true,staleLookupsIgnored:true,sourceAndDestinationAddresses:true,gasCollapsedByDefault:true,recentAddressesNotClipped:true,responsiveWidths:8,transactionsBroadcast:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
