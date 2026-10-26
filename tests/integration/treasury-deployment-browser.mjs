import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../../src/lib/composerDiscovery.ts';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { validatePairedPayments } from '../../src/lib/treasury/pairedPolicy.ts';
import { decodeSafeExecution } from '../../src/lib/treasury/safeEvents.ts';
import { setupIdentity } from '../../src/lib/treasury/mainnetSetup.ts';

export async function deploymentBrowser(f) {
  const { network,target,engine,A,B,safeL1,rpc,send,evidence,directory,ids } = f;
  const server = await createServer({ configFile:false, envFile:false, plugins:[react()], server:{host:'127.0.0.1',port:0}, base:'/' }); await server.listen();
  let browser, page, held = true;
  const hashes = new Set(), submissions = [], signatures = [], errors = [];
  const key = `eez:treasury:paired-setup:${setupIdentity(network)}`;
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  try {
    browser = await chromium.launch({headless:true,chromiumSandbox:true});
    page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(25000);
    page.on('pageerror',e=>errors.push(e.message));
    const state = () => page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
    await page.exposeFunction('setupRpc',async({chain,method,params,front})=>{
      if(method==='eth_getTransactionReceipt' && held && hashes.has(params[0])) return null;
      if(method==='eez_quoteFee') {
        assert(front); const [request,options]=params,s=await state();
        assert.equal(request.to.toLowerCase(),s.addresses.safeL2Alias.toLowerCase());
        await rpc('anvil_setChainId',[ids.l2]);
        // A single EVM cannot execute the outer L1 request with the inner L2
        // signing domain. Estimate the genuine inner Safe call on logical L2.
        const {chainId:_,...local}=request;
        const estimated=BigInt(await rpc('eth_estimateGas',[{...local,to:s.addresses.safeL2}]));
        return {version:1,chainId:request.chainId,nonce:request.nonce,expiresAt:toHex(Math.floor(Date.now()/1000)+30),options:options.transactionTypes.map(type=>{
          const gas=request.gas??toHex(estimated*120n/100n);
          const tx={type,chainId:request.chainId,from:request.from.toLowerCase(),to:request.to.toLowerCase(),nonce:request.nonce,gas,value:request.value??'0x0',data:request.data.toLowerCase()};
          return {type,gas,requestHash:keccak256(toHex(JSON.stringify(Object.fromEntries(Object.keys(tx).sort().map(k=>[k,tx[k]]))))),estimatedFee:toHex(estimated*2_000_000_000n),maxFeePerGas:toHex(2_000_000_000n),maxPriorityFeePerGas:toHex(1_000_000_000n)};
        })};
      }
      if(method==='eth_estimateGas') await rpc('anvil_setChainId',[ids[chain]]);
      return engine.io.rpc(chain,method,params,front);
    });
    await page.exposeFunction('setupWalletRequest',async({owner,chainId,method,params})=>{
      const account=owner==='A'?A:B;
      if(method==='eth_call') {
        const {functionName,args:[nonce]}=decodeFunctionData({abi:COMPOSER_DISCOVERY_ABI,data:params[0].data}); assert.equal(functionName,'composerInfo');
        return encodeFunctionResult({abi:COMPOSER_DISCOVERY_ABI,functionName,result:[COMPOSER_DISCOVERY_MARKER,1n,nonce,BigInt(chainId),toHex(JSON.stringify({version:'single-EVM-fixture',supportedNetworks:{eezL1:ids.l1,eezL2:ids.l2},eezContracts:{eezRegistryAddress:network.registry,eezL2Address:network.manager}}))]});
      }
      if(method==='eth_signTypedData_v4') {
        const tx=JSON.parse(params[1]); assert.equal(BigInt(tx.domain.chainId),BigInt(chainId));
        signatures.push({owner,chainId,safe:tx.domain.verifyingContract,to:tx.message.to});
        return account.signTypedData(tx);
      }
      assert.equal(method,'eth_sendTransaction'); assert.equal(owner,'A');
      const [request]=params,s=await state(),step=s.completed.length;
      const source=step===1||step===2?'l2':'l1';
      assert.equal(BigInt(request.chainId),BigInt(ids[source])); assert.equal(BigInt(request.nonce),BigInt(await rpc('eth_getTransactionCount',[A.address,'pending'])));
      assert.equal(request.data.toLowerCase(),s.pending.data.toLowerCase()); assert.equal(request.from.toLowerCase(),A.address.toLowerCase());
      if(step===5) assert.equal(request.to.toLowerCase(),s.addresses.safeL2Alias.toLowerCase());
      const receipt=await send(step===5?'l2':source,step===5?s.addresses.safeL2:request.to,request.data);
      hashes.add(receipt.transactionHash); submissions.push({step,source,hash:receipt.transactionHash,requestedTo:request.to,executedTo:step===5?s.addresses.safeL2:request.to});
      return receipt.transactionHash;
    });
    await page.exposeFunction('reconcileMirror',async s=>{
      const p=s.pending; if(held || !p?.hash) return s;
      const receipt=await rpc('eth_getTransactionReceipt',[p.hash]); if(!receipt) return s;
      const tx=await rpc('eth_getTransactionByHash',[p.hash]);
      assert.equal(receipt.status,'0x1'); assert.equal(tx.input.toLowerCase(),p.data.toLowerCase()); assert.equal(tx.to.toLowerCase(),s.addresses.safeL2.toLowerCase());
      assert.equal(BigInt(tx.nonce),BigInt(p.nonce));
      assert(receipt.logs.some(log=>log.address.toLowerCase()===s.addresses.safeL2.toLowerCase() && decodeSafeExecution(log)?.eventName==='ExecutionSuccess' && decodeSafeExecution(log)?.args.txHash===p.safeHash));
      assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash);
      return {...s,pending:undefined,review:undefined,completed:[...s.completed,{chain:'l2',hash:p.hash,number:receipt.blockNumber,blockHash:receipt.blockHash}]};
    });
    await page.exposeFunction('verifyPair',config=>validatePairedPayments(new TreasuryClient(config)));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()); assert.equal(url.origin,origin,'browser stays on its owned server');
      if(url.pathname==='/deployment')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
      return route.continue();
    });
    const mount=async()=>{await page.goto(`${origin}/deployment`);await page.evaluate(async fixture=>(await import('/tests/fixtures/treasury-deployment-browser.tsx')).mount(fixture),{network,target,owners:{A:A.address,B:B.address}});};
    await mount(); await page.getByLabel('Chiado Safe address',{exact:true}).fill(safeL1); await page.getByRole('button',{name:'Start setup',exact:true}).click();
    for(let step=0;step<6;step++) {
      held=true;
      await page.waitForFunction(({key,step})=>JSON.parse(localStorage.getItem(key)??'null')?.completed.length===step,{key,step});
      assert.equal(await page.getByRole('progressbar',{name:'Setup progress'}).getAttribute('value'),String(step));
      await page.getByRole('region',{name:'About this step'}).waitFor();
      if(step>=4) {
        await page.getByRole('button',{name:'Review Safe step',exact:true}).click();
        await page.getByText('Current owners',{exact:true}).click();
        assert(await page.getByRole('button',{name:'Approve Safe step',exact:true}).evaluate(e=>e.classList.contains('btn-solid')));
        assert(await page.getByRole('button',{name:'Submit approved Safe step',exact:true}).isDisabled());
        if(step===5)await page.getByText('Sign for your',{exact:false}).waitFor();
        await page.screenshot({path:`${directory}/setup-approval-${step}.png`,fullPage:true});
        await page.getByRole('button',{name:'Approve Safe step',exact:true}).click();
        await page.getByText('1 of 2 owner approvals',{exact:true}).waitFor();
        await page.evaluate(()=>window.setupControls.select('B'));
        await page.getByRole('button',{name:'Approve Safe step',exact:true}).click();
        await page.getByText('2 of 2 owner approvals',{exact:true}).waitFor();
        await page.evaluate(()=>window.setupControls.select('A'));
      }
      if(step===0) {
        await page.evaluate(()=>{window.setupControls.rejectNext=true;});
        await page.getByRole('button',{name:step>=4?'Submit approved Safe step':'Approve next deployment step',exact:true}).click();
        await page.getByRole('status').getByText('Wallet cancelled. No transaction was authorized.',{exact:true}).waitFor();
        assert.equal((await state()).pending,undefined); assert.equal(submissions.length,0);
      }
      await page.getByRole('button',{name:step>=4?'Submit approved Safe step':'Approve next deployment step',exact:true}).click();
      await page.waitForFunction(key=>!!JSON.parse(localStorage.getItem(key)??'null')?.pending?.hash,key);
      assert.equal(submissions.length,step+1);
      const before=await state(); await mount();
      await page.getByRole('status').filter({hasText:'Waiting for confirmation'}).waitFor();
      assert.deepEqual(await state(),before); assert.equal(submissions.length,step+1,'reload must not resend');
      held=false;
      if(step<5) await page.waitForFunction(({key,step})=>JSON.parse(localStorage.getItem(key)??'null')?.completed.length===step+1,{key,step});
    }
    await page.getByRole('heading',{name:'Shared treasury ready',exact:true}).waitFor();
    const completed=await page.evaluate(()=>window.completedState);
    assert.equal(completed.completed.length,6); assert.equal(signatures.length,4); assert.deepEqual(signatures.map(s=>Number(BigInt(s.chainId))),[ids.l1,ids.l1,ids.l2,ids.l2]);
    assert.deepEqual(errors,[]); await page.screenshot({path:`${directory}/deployment-browser.png`,fullPage:true});
    evidence.browser={passed:true,sandbox:true,steps:6,walletCancellation:true,reloadEveryStep:true,singleSubmissionPerStep:true,submissions,signatures,
      limitation:'Final L1 alias request is checked but executed directly on logical L2 in the single-EVM fixture; native relay/settlement is not proven.'};
    console.log('PASS all six setup steps through browser: real deployment/approvals, cancellation, six pending reloads, activation and manifest validation');
    return completed;
  } catch(error) {
    const body=await page?.locator('body').innerText().catch(()=>'<browser unavailable>');
    await writeFile(`${directory}/browser-failure.json`,JSON.stringify({error:String(error),body,errors,submissions,signatures},null,2));
    console.error('Browser setup failure:',body);
    throw error;
  } finally { await browser?.close(); await server.close(); }
}
