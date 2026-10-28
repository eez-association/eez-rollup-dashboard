// Production-bundle UX checks. RPC and Monitor data are mocked; signing is forbidden.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeAbiParameters, keccak256, stringToHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const hash = byte => '0x' + byte.repeat(32), address = byte => '0x' + byte.repeat(20);
const registry = address('11'), manager = address('22'), caller = address('33');
const l1Hash = hash('a1'), l2Hash = hash('a2'), postHash = hash('b1'), callHash = hash('b2');
const record = { l1BlockNumber:'0x64', l1BlockHash:l1Hash, l1TransactionHash:postHash,
  l2Blocks:[{number:'0x7',hash:l2Hash}], canonicalL2:true, l2Finalized:false };
const postLog = {address:registry, topics:[keccak256(stringToHex('BatchPosted(bytes32,uint64[])'))],
  data:encodeAbiParameters([{type:'bytes32'},{type:'uint64[]'}],[hash('cc'),[1n]]),
  blockNumber:'0x64',blockHash:l1Hash,transactionHash:postHash,logIndex:'0x0'};
const transaction = l1 => ({hash:l1?postHash:callHash,from:caller,to:l1?registry:manager,input:'0x',value:'0x0',
  blockNumber:l1?'0x64':'0x7',blockHash:l1?l1Hash:l2Hash,transactionIndex:'0x0'});
const settlements = Array.from({length:8},(_,i)=>({transactionHash:i===0?postHash:hash((i+16).toString(16)),
  l1BlockNumber:100+i,l1BlockHash:l1Hash,timestamp:1750000000,blobCount:1,blobVersionedHashes:[hash('dd')],
  isProtocolSettlement:true,status:'confirmed',receiptStatus:1,beacon:{configured:false},
  l2Ranges:[{l2Range:{firstBlockNumber:'0x7',lastBlockNumber:'0x7',blockCount:'0x1'},canonicalL2:true,l2Finalized:false}],
  executionCostWei:'100',blobCostWei:'100',totalCostWei:'200'}));
const snapshot = {generatedAt:new Date().toISOString(),healthy:true,stale:false,errors:[],
  configuration:{refreshSeconds:4,explorers:{l1:'https://l1.invalid',l2:'https://l2.invalid'},nativeCurrency:'xDAI'},
  chains:{l1:{healthy:true,chainId:10200,latest:{number:100,hash:l1Hash,timestamp:1750000000},blocks:[]},
    l2:{healthy:true,chainId:1337,latest:{number:7,hash:l2Hash,timestamp:1750000000},blocks:[]}},
  rollup:{status:'unavailable'},metrics:{},settlementHistory:{available:true},blobSettlements:settlements};
(async()=>{
  const browser=await chromium.launch({ headless: true, chromiumSandbox: true });
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[],requests=[];
  let state='awaiting';
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.WebSocket=undefined;});
  await page.clock.install();
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(path==='/monitor/') return route.fulfill({response:await route.fetch({url:origin+'/'} )});
    if(path.endsWith('/config.json')) return route.fulfill({json:{networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',
      l1ContractAddress:registry,l2ContractAddress:manager,l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
    if(path==='/monitor/api/snapshot') return route.fulfill({json:snapshot});
    if(path==='/monitor/api/settlement-search') {
      requests.push({method:'settlement-search',query:url.searchParams.get('q')});
      return route.fulfill({json:{matches:settlements.filter(item=>item.transactionHash===url.searchParams.get('q')),lookupErrors:[]}});
    }
    if(req.method()!=='POST') return route.continue();
    const {method,params=[],id}=req.postDataJSON();
    assert(!/send|sign/i.test(method),'No transaction submission is allowed');
    const l1=path.endsWith('/l1'); requests.push({method,params,l1,path});
    if(method.startsWith('eez_')&&path!=='/composer/l2')return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}}});
    let result=null,error;
    if(method==='eth_chainId') result=l1?'0x27d8':'0x539';
    if(method==='eth_blockNumber') result=l1?'0x64':'0x7';
    if(method==='eth_getTransactionByHash') result=params[0]===(l1?postHash:callHash)?transaction(l1):null;
    if(method==='eth_getTransactionReceipt') result=params[0]===(l1?postHash:callHash)?{status:'0x1',gasUsed:'0x5208',blockNumber:l1?'0x64':'0x7',blockHash:l1?l1Hash:l2Hash,logs:l1?[postLog]:[]}:null;
    if(method==='eth_getBlockByNumber'||method==='eth_getBlockByHash') {
      const tag=params[0],isTag=tag==='safe'||tag==='finalized';
      let number=l1?'0x64':'0x7';
      if(isTag&&!(tag==='safe'&&['safe','finalized'].includes(state)||tag==='finalized'&&state==='finalized')) number='0x0';
      result={number,hash:l1&&state==='reorg'&&!isTag&&method==='eth_getBlockByNumber'?hash('ff'):l1?l1Hash:l2Hash,
        parentHash:hash('dd'),timestamp:'0x65000000',gasUsed:'0x5208',gasLimit:'0xffffff',transactions:params[1]?[transaction(l1)]:[l1?postHash:callHash]};
    }
    if(method==='eth_getLogs') result=l1?[postLog]:[];
    if(method==='eez_getSettlementByL2Block') {
      result=state==='awaiting'?null:record;
      if(state==='unavailable') error={code:-32000,message:'Settlement index unavailable'};
    }
    if(method==='eez_getSettledL2RangesByL1Block') result=state==='awaiting'?[]:[record];
    if(method==='debug_traceTransaction') result={type:'CALL',from:caller,to:l1?registry:manager,input:'0x',output:'0x',gas:'0x5208',gasUsed:'0x5208'};
    return route.fulfill({json:error?{jsonrpc:'2.0',id,error}:{jsonrpc:'2.0',id,result}});
  });
  try {
    await page.goto(origin+'/');
    await page.getByRole('button',{name:'Bridge & Calls',exact:true}).waitFor();
    assert.equal(await page.getByRole('group',{name:'Network balances',exact:true}).count(),0);
    assert.equal(await page.getByText('Balance unavailable',{exact:true}).count(),0);
    assert.equal(await page.getByText('Connect your wallet to bridge.',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).isDisabled(),false);
    assert.match(await page.getByTitle('Swap direction',{exact:true}).getAttribute('aria-label'),/Swap source and destination/);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      const tiny=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>!el.children.length&&el.textContent.trim()&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
      assert.deepEqual(tiny,[],'Dashboard text below 12px at '+width);
    }
    await page.setViewportSize({width:1440,height:900});
    await page.goto(origin+`/#/visualizer?mode=inspect&chain=l2&tx=${callHash}`);
    const progress=page.getByRole('region',{name:'Call settlement progress'});
    await progress.getByText(/No indexed L1 settlement/).waitFor();
    for(const [next,text] of [['posted',/Posted in a canonical L1/],['safe',/range are safe/],['finalized',/range are finalized/],['reorg',/posting block changed/],['unavailable',/Settlement evidence unavailable/]]) {
      state=next; await page.clock.fastForward(11000); await progress.getByText(text).waitFor();
      if(next==='reorg'||next==='unavailable') assert.equal(await progress.locator('[data-reached="true"]').count(),0);
    }
    state='posted';await page.clock.fastForward(11000);
    const monitorLink=progress.getByRole('link',{name:'View settlement in Monitor →'});
    await monitorLink.waitFor();assert.match(await monitorLink.getAttribute('href'),new RegExp(postHash));
    await monitorLink.click();
    await page.locator('#blob-rows tr').waitFor();
    assert.equal(await page.locator('#blob-search').inputValue(),postHash);
    assert(requests.some(request=>request.method==='settlement-search'&&request.query===postHash));
    assert.equal(await page.locator('#blob-rows tr').count(),1);
    assert.match(await page.locator('#blob-rows tr').first().locator('[data-label="L2 range"]').innerText(),/1 block\b/);
    assert.doesNotMatch(await page.locator('#blob-rows tr').first().innerText(),/1 blocks\b/);
    await page.locator('#blob-search-clear').click();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflows at '+width);
      const tiny=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.children.length===0&&el.textContent.trim()&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.textContent));
      assert.deepEqual(tiny,[],'Text below 12px at '+width);
      assert.equal(await page.locator('.operator-settings').getAttribute('open'),null);
      if(width===390) {
        assert.equal(await page.locator('#blob-rows tr:visible').count(),5);
        assert(await page.locator('#blob-rows tr').first().locator('[data-label="Result"]').isVisible());
        assert(await page.locator('#blob-rows tr').first().getByRole('button',{name:'Decode',exact:true}).isVisible());
        await page.getByRole('button',{name:'Show all 8 settlements',exact:true}).click();
        assert.equal(await page.locator('#blob-rows tr:visible').count(),8);
        const first=page.locator('#blob-rows tr').first();
        await first.getByRole('button',{name:'Details',exact:true}).click();
        assert(await first.locator('[data-label="Beacon"]').isVisible());
        await page.clock.fastForward(5000);
        assert(await first.locator('[data-label="Beacon"]').isVisible(),'Expanded details must survive refresh');
      }
    }
    await page.goto(origin+'/#/visualizer');
    await page.getByLabel('Search batches',{exact:true}).fill('latest');
    const inspectLatest=page.getByRole('button',{name:'Inspect ‘latest’ →',exact:true});
    await inspectLatest.waitFor();await inspectLatest.click();
    await page.getByRole('region',{name:'Call settlement progress'}).waitFor();
    assert(await page.getByRole('button',{name:'Flow',exact:true}).isVisible(),'Latest EEZ batch should select an inspectable transaction');
    await page.clock.resume();
    const inspectForm=page.getByRole('form',{name:'Inspect execution',exact:true});
    await inspectForm.getByRole('button',{name:'Inspect',exact:true}).waitFor();
    await page.getByLabel('Transaction hash or block',{exact:true}).fill('latest');
    await inspectForm.getByRole('button',{name:'Inspect',exact:true}).click();
    await page.waitForFunction(expected => location.hash.includes('tx='+expected), postHash);
    await inspectForm.getByRole('button',{name:'Inspect',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Transaction hash or block',{exact:true}).inputValue(),postHash,'Typing latest must resolve to an EEZ batch transaction');
    assert.equal(await page.getByRole('button',{name:'Flow',exact:true}).count(),1);
    assert.match(await page.title(),/Execution Visualizer/);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,settlementStages:6,sourceExecutionDistinct:true,reorgClearsSuccess:true,monitorDeepLink:true,mobileSummaryLimit:5,expandedRowsSurviveRefresh:true,textFloor:12,latestBatchShortcut:true,typedLatestBatch:true,walletEmptyState:true,consoleErrors:0,transactionsBroadcast:0}));
  } finally {await browser.close();}
})();
