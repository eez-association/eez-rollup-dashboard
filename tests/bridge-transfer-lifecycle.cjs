// Mock RPCs and wallets only. Count requests through approval and confirmation.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until } = require('./bridge-gas-fees.cjs');
const success = {status:'0x1',blockNumber:'0x10',blockHash:'0x'+'55'.repeat(32),logs:[]};
const quotes = f => f.rpcRequests.filter(r => r.transaction).length;
const estimates = f => f.rpcRequests.filter(r => r.method === 'eth_estimateGas' && r.path.startsWith('/composer/')).length;
const fees = f => f.page.getByRole('region',{name:'Quoted bridge fees'});
(async()=>{
  const browser=await chromium.launch({headless:true,chromiumSandbox:true});
  let scenarios=0;
  try {
    for(const reverse of [false,true]) for(const erc20 of [false,true]) {
      const f=await fixture(browser,{reverse,erc20,feesEnabled:true,expandGas:false});
      await until(()=>quotes(f)>0,'Initial preview must be quoted');
      await f.page.clock.install();
      await f.button.click();
      await f.page.getByRole('heading',{name:'Waiting for confirmation',exact:true}).waitFor();
      f.feeQuote.failure=true;
      const beforeQuotes=quotes(f), beforeEstimates=estimates(f);
      f.receipt.result=success;
      await f.page.clock.runFor(1200);
      await f.page.getByRole('heading',{name:'Bridge transaction confirmed',exact:true}).waitFor();
      await f.page.clock.runFor(65000);
      assert.equal(quotes(f),beforeQuotes,'No new quote after confirmation, including the old 5s reset and expiry');
      assert.equal(estimates(f),beforeEstimates,'No new transfer estimate after confirmation');
      assert.equal(await fees(f).count(),0);
      assert.equal(await f.page.getByText('Fee quote unavailable:',{exact:false}).count(),0);
      await f.page.getByRole('button',{name:'Done',exact:true}).click();
      assert.equal(await f.page.getByLabel('Bridge amount',{exact:true}).inputValue(),'');
      await f.page.clock.runFor(35000);
      assert.equal(quotes(f),beforeQuotes,'Dismissing success must not requote the completed transfer');
      f.feeQuote.failure=false;
      await f.page.getByLabel('Bridge amount',{exact:true}).fill('0.002');
      await f.page.clock.runFor(1500);
      await until(()=>quotes(f)>beforeQuotes,'New amount must resume fee quoting');
      assert.equal(await fees(f).count(),1);
      assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
    }
    for(const reverse of [false,true]) {
      const f=await fixture(browser,{reverse,erc20:true,symbol:'TEST',allowance:0n,approvalRequired:true,feesEnabled:true,expandGas:false});
      await f.page.clock.install();
      await f.page.clock.runFor(12000);
      assert.equal(estimates(f),0,'Do not estimate a transfer before approval');
      assert.equal(quotes(f),0,'Do not quote a transfer before approval');
      assert.equal(await f.page.getByRole('alert').filter({hasText:'Gas estimation failed:'}).count(),0);
      assert.equal(await fees(f).count(),0);
      await f.page.getByRole('button',{name:'Approve TEST',exact:true}).click();
      await f.page.getByRole('heading',{name:'Waiting for confirmation',exact:true}).waitFor();
      assert.equal(estimates(f),0,'Approval is an ordinary source transaction');
      f.receipt.result=success;
      await f.page.clock.runFor(1200);
      await f.page.getByRole('heading',{name:'Approval confirmed',exact:true}).waitFor();
      await f.page.getByRole('button',{name:'Done',exact:true}).click();
      assert.equal(await f.page.getByLabel('Bridge amount',{exact:true}).inputValue(),'0.001','Approval confirmation preserves the transfer amount');
      await f.page.clock.runFor(900);
      await until(()=>estimates(f)>0 && quotes(f)>0,'Confirmed approval must start the transfer estimate and quote');
      assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
    }
    console.log(JSON.stringify({passed:true,scenarios,noQuotesAfterBridgeSuccess:true,noEstimatesBeforeApproval:true,newTransferResumesQuoting:true,realTransactionsBroadcast:0}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
