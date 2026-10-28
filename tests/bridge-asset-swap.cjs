// Real browser, mocked wallets/RPCs. No network transaction is broadcast.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixture,until,RAW_GAS}=require('./bridge-gas-fees.cjs');
const units=value=>{const whole=value/10n**18n;const frac=(value%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return whole+(frac?'.'+frac:'');};
const feeCap=1000000014n;
(async()=>{
 const browser=await chromium.launch({ headless: true, chromiumSandbox: true });let scenarios=0;
 const close=async f=>{assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;};
 try{
  const empty=await fixture(browser,{disconnected:true,multipleWallets:true});
  const panel=empty.page.getByRole('region',{name:'Bridge transfers',exact:true});
  const connect=panel.getByRole('button',{name:'Connect wallet',exact:true});
  assert.equal(await connect.isDisabled(),false);
  assert.equal(await panel.getByLabel('Bridge amount',{exact:true}).inputValue(),'');
  assert.equal(await panel.getByText('Connect your wallet to bridge.',{exact:true}).count(),0);
  assert.equal(await panel.getByRole('alert').count(),0);
  await connect.click();
  const wallets=panel.getByRole('group',{name:'Choose a wallet',exact:true});
  assert(await wallets.getByRole('button',{name:'Rabby',exact:true}).evaluate(el=>el===document.activeElement));
  await empty.page.keyboard.press('Escape');assert(await connect.evaluate(el=>el===document.activeElement));
  await connect.click();await wallets.getByRole('button',{name:'MetaMask',exact:true}).click();
  await empty.page.getByRole('button',{name:/MetaMask ·/}).waitFor();
  assert.equal(await empty.page.evaluate(()=>window.walletRequests.length),0);
  await close(empty);

  const layout=await fixture(browser,{expandGas:false});
  const control=layout.page.getByRole('region',{name:'Bridge transfer',exact:true});
  for(const width of [1440,1024,560,390,320]){
   await layout.page.setViewportSize({width,height:900});
   for(const reverse of [false,true]){
    if(reverse)await layout.page.getByTitle('Swap direction').click();
    const panels=control.locator('[data-chain]');assert.equal(await panels.count(),2);
    assert.equal(await panels.first().getAttribute('data-chain'),'l1');assert.equal(await panels.last().getAttribute('data-chain'),'l2');
    const source=control.getByRole('group',{name:'Source network',exact:true});
    assert.equal(await source.getAttribute('data-chain'),reverse?'l2':'l1');
    assert.equal(await source.getByLabel('Bridge amount',{exact:true}).count(),1);
    assert.equal(await source.getByRole('button',{name:'MAX',exact:true}).count(),1);
    assert.equal(await control.getByRole('group',{name:'Destination network',exact:true}).getByLabel('Destination amount',{exact:true}).textContent(),'0.001');
    assert(await layout.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow at '+width);
    const tiny=await control.evaluate(root=>[...root.querySelectorAll('*')].filter(el=>!el.children.length&&el.textContent.trim()&&el.getClientRects().length&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
    assert.deepEqual(tiny,[]);
    const sourcePill=source.getByRole('button',{name:/^Choose bridge asset on/});await sourcePill.click();
    const choices=source.getByRole('group',{name:'Bridge asset choices',exact:true});
    assert(await choices.getByRole('button',{name:'xDAI',exact:true}).evaluate(el=>el===document.activeElement));
    await layout.page.screenshot({path:`/tmp/eez-asset-swap-picker-${width}-${reverse?'reverse':'forward'}.png`,fullPage:true});
    await layout.page.keyboard.press('Escape');assert(await sourcePill.evaluate(el=>el===document.activeElement));
    await layout.page.screenshot({path:`/tmp/eez-asset-swap-${width}-${reverse?'reverse':'forward'}.png`,fullPage:true});
    if(reverse)await layout.page.getByTitle('Swap direction').click();
   }
  }
  for(const width of [1440,390,320]){
   await layout.page.setViewportSize({width,height:900});
   await layout.page.getByLabel('Bridge amount',{exact:true}).fill('800.123456789012345678');
   const output=layout.page.getByLabel('Destination amount',{exact:true});
   assert.equal(await output.textContent(),'800.123456789012345678');
   assert(await output.evaluate(el=>el.getBoundingClientRect().height<2*parseFloat(getComputedStyle(el).lineHeight)),'Full-precision amount should fit on one line at '+width);
   await layout.page.getByText('Gas settings',{exact:true}).click();
   const small=await layout.page.getByRole('region',{name:'Bridge transfers',exact:true}).evaluate(root=>[...root.querySelectorAll('*')].filter(el=>!el.children.length&&el.textContent.trim()&&el.getClientRects().length&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));assert.deepEqual(small,[]);
   await layout.page.getByText('Gas settings',{exact:true}).click();
  }
  await layout.page.getByLabel('Bridge amount',{exact:true}).fill('0.001');
  await layout.page.emulateMedia({reducedMotion:'reduce'});
  await control.getByRole('button',{name:/^Choose bridge asset on/}).first().click();
  assert.equal(await control.getByRole('group',{name:'Bridge asset choices',exact:true}).evaluate(el=>el.getAnimations().length),0);
  await layout.page.keyboard.press('Escape');
  await layout.page.getByLabel('Bridge amount',{exact:true}).fill('1001');
  const warning=layout.page.getByText('Insufficient xDAI balance on L1.',{exact:true});await warning.waitFor();
  assert.equal(await warning.evaluate(el=>getComputedStyle(el).color),'rgb(251, 191, 36)');
  assert(await layout.button.isDisabled());await close(layout);

  for(const reverse of [false,true])for(const manual of [false,true]){
   const f=await fixture(browser,{reverse,nativeBalance:1000000000000000001n});
   if(manual)await f.page.getByLabel('Gas limit',{exact:true}).fill('500000');
   await f.page.getByRole('button',{name:'MAX',exact:true}).click();
   const chosen=manual?500000n:RAW_GAS;
   const expected=units(1000000000000000001n-chosen*feeCap);
   await until(async()=>await f.page.getByLabel('Bridge amount',{exact:true}).inputValue()===expected,'MAX must reserve quoted fees');
   await until(async()=>!await f.button.isDisabled(),'Final MAX amount must be re-estimated');
   assert.equal(await f.page.getByLabel('Destination amount',{exact:true}).textContent(),expected);
   const estimates=f.rpcRequests.filter(r=>r.method==='eth_estimateGas');
   assert(estimates.every(r=>r.path==='/composer/'+(reverse?'l2':'l1')));
   assert(estimates.every(r=>r.params[0].gas===undefined&&r.params[0].gasLimit===undefined));
   assert.equal(BigInt(estimates.at(-1).params[0].value),1000000000000000001n-chosen*feeCap);
   await f.button.click();await until(async()=>await f.page.evaluate(()=>window.walletRequests.length)===1,'Mock wallet must receive MAX');
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);assert.equal(BigInt(tx.gas),chosen);assert.equal(tx.gas,tx.gasLimit);
   assert.equal(BigInt(tx.value)+BigInt(tx.gas)*BigInt(tx.maxFeePerGas),1000000000000000001n);
   await close(f);
  }
  const manualUnsupported=await fixture(browser,{unsupported:true,nativeBalance:1000000000000000001n});
  await manualUnsupported.page.getByLabel('Gas limit',{exact:true}).fill('500000');
  await manualUnsupported.page.getByRole('button',{name:'MAX',exact:true}).click();
  await until(async()=>await manualUnsupported.page.getByLabel('Bridge amount',{exact:true}).inputValue()===units(1000000000000000001n-500000n*feeCap),'Manual MAX should work on known unsupported Composer');
  await until(async()=>!await manualUnsupported.button.isDisabled(),'Manual override must still unblock known missing estimator support');
  await close(manualUnsupported);

  const keyboard=await fixture(browser);
  const assetPill=keyboard.page.getByRole('group',{name:'Source network',exact:true}).getByRole('button',{name:/^Choose bridge asset on/});
  await assetPill.focus();await keyboard.page.keyboard.press('Enter');await keyboard.page.keyboard.press('Tab');await keyboard.page.keyboard.press('Enter');
  await keyboard.page.getByLabel('Token address',{exact:true}).waitFor();
  assert(await assetPill.evaluate(el=>el===document.activeElement),'Selecting an asset should return focus');
  await close(keyboard);

  const invalid=await fixture(browser);
  await invalid.page.getByRole('button',{name:'Change recipient',exact:true}).click();
  await invalid.page.getByLabel('Recipient address',{exact:true}).fill('0x1234');
  await invalid.page.getByText('Enter a valid recipient address.',{exact:true}).waitFor();
  assert(await invalid.button.isDisabled());
  await invalid.page.getByRole('button',{name:'MAX',exact:true}).click();
  await invalid.page.getByText('Enter a valid recipient address before using MAX.',{exact:false}).waitFor();
  assert.equal(await invalid.page.evaluate(()=>window.walletRequests.length),0);
  await invalid.page.getByLabel('Recipient address',{exact:true}).fill('0x'+'88'.repeat(20));
  await until(async()=>!await invalid.button.isDisabled(),'Valid recipient must receive a fresh estimate');
  assert.equal(invalid.rpcRequests.filter(r=>r.method==='eth_estimateGas').at(-1).params[0].data.slice(-64),'88'.repeat(20).padStart(64,'0'));
  await close(invalid);

  const tokenBalance=1000000000000000001n;
  const erc=await fixture(browser,{erc20:true,symbol:'DAI',balance:tokenBalance});
  await erc.page.getByRole('button',{name:'MAX',exact:true}).click();
  assert.equal(await erc.page.getByLabel('Bridge amount',{exact:true}).inputValue(),'1.000000000000000001');
  assert.equal(await erc.page.getByLabel('Destination amount',{exact:true}).textContent(),'1.000000000000000001');
  await close(erc);

  for(const opts of [{nativeBalance:1000n,amount:'0.000000000000000001'},{noBaseFee:true},{}]){
   const f=await fixture(browser,opts);const before=await f.page.getByLabel('Bridge amount',{exact:true}).inputValue();
   if(!opts.nativeBalance&&!opts.noBaseFee)f.estimation.error='Composer unavailable';
   await f.page.getByRole('button',{name:'MAX',exact:true}).click();
   await f.page.getByText('Unable to set MAX:',{exact:false}).waitFor();
   assert.equal(await f.page.getByLabel('Bridge amount',{exact:true}).inputValue(),before);assert(await f.button.isDisabled());
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);await close(f);
  }
  const stale=await fixture(browser);stale.estimation.delay=300;
  await stale.page.getByRole('button',{name:'MAX',exact:true}).click();
  await stale.page.getByRole('button',{name:'Calculating…',exact:true}).waitFor();
  await stale.page.getByLabel('Bridge amount',{exact:true}).fill('0.2');
  await until(async()=>!await stale.button.isDisabled(),'Manual amount must receive its own estimate');
  assert.equal(await stale.page.getByLabel('Bridge amount',{exact:true}).inputValue(),'0.2');
  assert.equal(await stale.page.evaluate(()=>window.walletRequests.length),0);await close(stale);
  console.log(JSON.stringify({passed:true,scenarios,fixedNetworkPositions:true,exactAmounts:true,bridgeWalletPicker:true,keyboard:true,reducedMotion:true,widths:[1440,1024,560,390,320],nativeMaxReservesQuotedGas:true,erc20MaxFullPrecision:true,maxFailuresBlockSubmission:true,staleMaxCancelled:true,realTransactionsBroadcast:0}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
