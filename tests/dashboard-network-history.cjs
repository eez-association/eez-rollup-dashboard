// Run against a local production preview. All RPC responses are mocked; no wallet is injected.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeAbiParameters, keccak256, stringToHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const hash = b => '0x' + b.repeat(32), address = b => '0x' + b.repeat(20);
const registry = address('11'), manager = address('22'), caller = address('33');
const l1Block = hash('a1'), l2Block = hash('a2'), l1Tx = hash('b1'), l2Tx = hash('b2'), callHash = hash('cc');
const data = (types, values) => encodeAbiParameters(types.map(type => ({ type })), values);
const outgoing = { address: registry, topics: [keccak256(stringToHex('CrossChainCallExecuted(bytes32,address,address,bytes,uint256)')), callHash, '0x'+manager.slice(2).padStart(64,'0')],
  data: data(['address','bytes','uint256'],[caller,'0x1234',1n]), blockHash: l1Block, blockNumber: '0x64', transactionHash: l1Tx };
const incoming = { address: manager, topics: [keccak256(stringToHex('IncomingCrossChainCallExecuted(bytes32,bool,address,uint64,address,uint256,uint64,bytes)')),callHash],
  data: data(['bool','address','uint64','address','uint256','uint64','bytes'],[false,caller,0n,manager,1n,90000n,'0x1234']), blockHash: l2Block, blockNumber: '0x7', transactionHash: l2Tx };
const settlement = { l1BlockNumber:'0x64',l1BlockHash:l1Block,l1TransactionHash:l1Tx,l2Blocks:[{number:'0x7',hash:l2Block}],canonicalL2:true };
(async()=>{
  const browser = await chromium.launch({headless:true,chromiumSandbox: true});
  try {
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    const errors=[],requests=[];let indexed=false,indexError=true,receiptError=true,receiptMissing=false;
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.clock.install();
    await page.addInitScript(({l1Tx,l2Tx})=>localStorage.setItem('txHistory',JSON.stringify([
      {id:'out',type:'bridge',direction:'l1-to-l2',hash:l1Tx,status:'confirmed',label:'Bridge 1 xDAI L1→L2',timestamp:Date.now()},
      {id:'back',type:'bridge',direction:'l2-to-l1',hash:l2Tx,status:'confirmed',label:'Bridge 2 xDAI L2→L1',timestamp:Date.now()},
    ])),{l1Tx,l2Tx});
    await page.route('**/*',route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path.endsWith('/config.json'))return route.fulfill({json:{networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',l1ContractAddress:registry,l2ContractAddress:manager,
        l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
      if(req.method()!=='POST')return route.continue();
      const {method,params=[],id}=req.postDataJSON();assert.ok(!/send|sign/i.test(method));const l1=path.endsWith('l1');let result=null;
      requests.push({path,method});
      if(method==='eth_getTransactionReceipt'&&receiptError)return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32000,message:'Receipt RPC offline'}}});
      if(method.startsWith('eez_')&&(path!=='/composer/l2'||indexError))return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}}});
      if(method==='eth_chainId')result=l1?'0x27d8':'0x1892';
      if(method==='eth_getBlockByNumber')result={number:l1?'0x64':'0x7',timestamp:'0x65000000',gasUsed:'0x0',gasLimit:'0x1c9c380',transactions:[]};
      if(method==='eth_getBalance')result='0x0';
      if(method==='eth_getTransactionReceipt')result=!receiptMissing&&params[0]===(l1?l1Tx:l2Tx)?{blockNumber:l1?'0x64':'0x7',blockHash:l1?l1Block:l2Block,logs:l1?[outgoing]:[incoming]}:null;
      if(method==='eez_getSettlementByL2Block')result=indexed?settlement:null;
      if(method==='eez_getSettledL2RangesByL1Block')result=indexed?[settlement]:[];
      if(method==='eth_getLogs')result=params[0]?.topics ? l1?[outgoing]:[incoming]:[];
      return route.fulfill({json:{jsonrpc:'2.0',id,result}});
    });
    await page.goto(origin+'/#/bridge');
    const header=page.getByRole('banner'),history=page.getByRole('region',{name:'Transaction history'});
    const forward=history.locator('li').filter({hasText:'1 xDAI'}),reverse=history.locator('li').filter({hasText:'2 xDAI'});
    await forward.getByText(/Transaction lookup unavailable: L1 receipt: Receipt RPC offline/).waitFor();
    await reverse.getByText(/Transaction lookup unavailable: L2 receipt: Receipt RPC offline/).waitFor();
    assert.equal(await history.getByText(/Looking up counterpart|not indexed yet/).count(),0,'receipt failures must not look like indexing delays');
    assert.equal(await forward.locator(`a[href="https://l1.invalid/tx/${l1Tx}"]`).count(),1);
    assert.equal(await reverse.locator(`a[href="https://l2.invalid/tx/${l2Tx}"]`).count(),1);
    assert.equal(await history.locator('a[href*="/block/"]').count(),0,'failed receipt reads cannot invent blocks');
    receiptError=false;receiptMissing=true;await page.clock.fastForward(16000);
    await forward.getByText('Looking up counterpart…').waitFor();
    await reverse.getByText('Looking up counterpart…').waitFor();
    assert.equal(await history.getByText(/lookup unavailable/).count(),0,'valid null receipts clear stale errors');
    receiptMissing=false;await page.clock.fastForward(16000);
    await forward.getByText('Counterpart lookup unavailable: Method not found').waitFor();
    await reverse.getByText('Counterpart lookup unavailable: Method not found').waitFor();
    assert.equal(await history.getByText(/not indexed yet/).count(),0,'RPC failures must not look like indexing delays');
    assert.equal(await forward.locator(`a[href="https://l1.invalid/tx/${l1Tx}"]`).count(),1);
    assert.equal(await reverse.locator(`a[href="https://l2.invalid/tx/${l2Tx}"]`).count(),1);
    await forward.locator('a[href="https://l1.invalid/block/100"]').waitFor();
    await reverse.locator('a[href="https://l2.invalid/block/7"]').waitFor();
    indexError=false;await page.clock.fastForward(16000);
    await forward.getByText('L2 transaction not indexed yet').waitFor();
    await reverse.getByText('L1 settlement not indexed yet').waitFor();
    assert.equal(await history.getByText(/Counterpart lookup unavailable/).count(),0,'retries clear the lookup error');
    indexed=true;await page.clock.fastForward(16000);
    await forward.locator(`a[href="https://l2.invalid/tx/${l2Tx}"]`).waitFor();
    await reverse.locator(`a[href="https://l1.invalid/tx/${l1Tx}"]`).waitFor();
    assert.equal(await reverse.getByText('Settlement',{exact:true}).count(),1);
    assert.equal(await forward.getByRole('group',{name:'L1 → L2',exact:true}).locator('img').count(),2);
    assert.equal(await reverse.getByRole('group',{name:'L2 → L1',exact:true}).locator('img').count(),2);
    assert.equal(await forward.locator('a[href="https://l1.invalid/block/100"]').count(),1);
    assert.equal(await forward.locator('a[href="https://l2.invalid/block/7"]').count(),1);
    for (const row of [forward, reverse]) {
      const transactions = row.getByRole('group',{name:'Transaction links',exact:true});
      const blocks = row.getByRole('group',{name:'Blocks',exact:true});
      assert.equal(await transactions.getByText('L1 tx:',{exact:true}).count(),1);
      assert.equal(await transactions.getByText('L2 tx:',{exact:true}).count(),1);
      assert.equal(await transactions.locator('img').count(),0,'transaction links use chain labels');
      assert.equal(await transactions.locator('a[href*="/block/"]').count(),0,'blocks have their own column');
      assert.equal(await blocks.locator('a[href*="/block/"]').count(),2);
      const txBox=await transactions.boundingBox(), blockBox=await blocks.boundingBox();
      assert.ok(blockBox.x >= txBox.x+txBox.width,'block column is separate from transactions');
    }
    for(const width of [1920,1440,1280,1201,1200,1024,800,640,390,320]) {
      await page.setViewportSize({width,height:1080});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
      assert.equal(await header.locator('[data-chain]').count(),0);
      assert.equal(await header.getByLabel('Latest network blocks').count(),0);
      // Disconnected wallets intentionally hide balances rather than displaying unavailable values.
      assert.equal(await header.getByRole('group',{name:'Network balances'}).count(),0);
      assert.ok(await header.getByRole('button',{name:'Connect Wallet',exact:true}).isVisible());
    }
    assert.deepEqual(errors,[]);
    assert.ok(requests.filter(r=>r.method.startsWith('eez_')).every(r=>r.path==='/composer/l2'),'settlement queries never use read RPCs');
    assert.ok(requests.filter(r=>['eth_getTransactionReceipt','eth_getLogs'].includes(r.method)).every(r=>r.path.startsWith('/rpc/')),'receipt and event reads stay on read RPCs');
    console.log(JSON.stringify({passed:true,canonicalTransactionLinks:true,settlementLabel:true,indexRetry:true,lookupErrorsShown:true,composerIndexRouting:true,historyNetworkLogos:true,labeledTransactionLinks:true,separateBlockColumn:true,blockLinks:true,responsiveWidths:10,walletEmptyState:true,consoleErrors:0,transactionsSent:0}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
