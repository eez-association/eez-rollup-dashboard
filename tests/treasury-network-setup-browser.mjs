import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { decodeAbiParameters, toHex } from 'viem';
import { fixture, dashboard, owner, token, release } from './fixtures/treasury-discovery.mjs';
import { ETHEREUM_USDC } from '../src/lib/treasury/mainnet.ts';
const server = await createServer({ configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0,watch:null},base:'/' });
await server.listen();let browser;
try {
  browser=await chromium.launch({headless:true,chromiumSandbox:process.env.TREASURY_BROWSER_SANDBOX !== '0'});
  const page=await browser.newPage(),origin=`http://127.0.0.1:${server.httpServer.address().port}`,errors=[],sends=[];
  let {io,state}=fixture();let selectedDashboard=dashboard, selectedToken=token;
  let reject=true, failTokenOnce=false, failNext=false, failedRequest=null, failedHash=null, failureCanonical=true, returnHashes=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('walletSend',request=>{sends.push(request);if(reject){const e=new Error('User rejected transaction');e.code=4001;throw e;}if(failNext){failNext=false;failedRequest=request;failedHash=toHex(sends.length,{size:32});returnHashes=true;}return returnHashes?toHex(sends.length,{size:32}):null;});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,origin);
    if(url.pathname==='/demo')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
    if(['/l1','/l2'].includes(url.pathname)){
      const payload=route.request().postDataJSON();
      const respond=async request=>{ try {
        if(failTokenOnce && request.method==='eth_call' && request.params[0].to.toLowerCase()===selectedToken.toLowerCase()){failTokenOnce=false;throw new Error('Temporary token RPC failure');}
        let result;
        if(failedRequest && request.method==='eth_getTransactionReceipt' && request.params[0]===failedHash)
          result={status:'0x0',blockNumber:'0xa',blockHash:toHex(failureCanonical?1:99,{size:32}),logs:[]};
        else if(failedRequest && request.method==='eth_getTransactionByHash' && request.params[0]===failedHash)
          result={...failedRequest,to:null,input:failedRequest.data};
        else if(failedRequest && request.method==='eth_getTransactionCount')result='0x1';
        else result=await io.rpc(url.pathname.slice(1),request.method,request.params);
        return {jsonrpc:'2.0',id:request.id,result};
      }
      catch(e){return {jsonrpc:'2.0',id:request.id,error:{code:-32000,message:e.message}};} };
      return route.fulfill({json:Array.isArray(payload)?await Promise.all(payload.map(respond)):await respond(payload)});
    }
    return route.continue();
  });
  const mount=async(configuredToken='')=>{await page.goto(`${origin}/demo`);await page.evaluate(async({dashboard,owner,configuredToken})=>(await import('/tests/fixtures/treasury-network-setup.tsx')).mount(dashboard,owner,configuredToken),{dashboard:selectedDashboard,owner,configuredToken});};
  await mount();await page.getByLabel('L1 token address',{exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Treasury network readiness',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).count(),0);
  assert.equal(sends.length,0);
  // Repair the old tip-anchored discovery format only while no transaction exists.
  await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':base'));const n=JSON.parse(localStorage.getItem(key));n.chains.l1.number=n.chains.l2.number='0xa';localStorage.setItem(key,JSON.stringify(n));});
  state.tipReorg=true;await mount();await page.getByText(/L1 protocol, bridge and Composer: Saved network reference changed/).waitFor();
  await page.getByRole('button',{name:'Refresh unused network setup',exact:true}).click();
  await page.getByLabel('L1 token address',{exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Treasury network readiness',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':base')))).chains.l1.number),'0x0');
  state.tipReorg=false;assert.equal(sends.length,0);
  failTokenOnce=true;await page.getByLabel('L1 token address',{exact:true}).fill(token);
  await page.getByRole('alert').filter({hasText:'Temporary token RPC failure'}).waitFor();
  assert(await page.getByRole('button',{name:'Use this token',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Retry token check',exact:true}).click();
  await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Use this token');return b&&!b.disabled;});
  assert.equal((await page.getByLabel('L1 token address',{exact:true}).inputValue()).toLowerCase(),token.toLowerCase());
  assert.equal(await page.getByRole('button',{name:'Retry token check',exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Treasury network readiness',exact:true}).count(),0);
  assert.equal(sends.length,0,'Retrying token reads never opens a wallet transaction');
  await page.getByLabel('L1 token address',{exact:true}).fill('');state.decimals=18;
  await page.getByLabel('L1 token address',{exact:true}).fill(token);
  await page.getByRole('alert').filter({hasText:'6 decimal places'}).waitFor();
  assert(await page.getByRole('button',{name:'Use this token',exact:true}).isDisabled());
  state.decimals=6;state.wrapped=false;
  await page.getByLabel('L1 token address',{exact:true}).fill('');await page.getByLabel('L1 token address',{exact:true}).fill(token);
  await page.getByText(/EXAMPLE is not available on L2 yet/).waitFor();
  assert(await page.getByRole('button',{name:'Use this token',exact:true}).isDisabled());
  state.wrapped=true;await page.getByRole('button',{name:'Use this token',exact:true}).click();
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  assert.equal(sends.length,0);await mount();await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  await page.getByRole('button',{name:'Choose another token',exact:true}).click();
  assert.equal((await page.getByLabel('L1 token address',{exact:true}).inputValue()).toLowerCase(),token.toLowerCase());
  // Deployment requires a wallet prompt and retains the request if its response is lost.
  reject=false;await page.getByRole('button',{name:'Deploy a new demo token',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Wallet response missing'}).waitFor();assert.equal(sends.length,1);
  const a=release.contracts.TestUSDC,args=decodeAbiParameters(a.abi.find(x=>x.type==='constructor').inputs,`0x${sends[0].data.slice(a.bytecode.length)}`);
  assert.equal(args[0].toLowerCase(),dashboard.bridgeL1.toLowerCase());assert.equal(args[1],77n);
  await mount();await page.getByText(/Demo token deployment pending/).waitFor();assert.equal(sends.length,1);
  assert.equal(await page.getByRole('button',{name:'Deploy demo token',exact:true}).count(),0);
  // Preserve the pending record across a failed network check; do not resend it.
  state.missing.add(dashboard.bridgeL1.toLowerCase());await mount();await page.getByText(/Normal bridge: no contract is deployed/).waitFor();assert.equal(sends.length,1);
  assert.equal(await page.getByRole('button',{name:'Refresh unused network setup',exact:true}).count(),0);
  state.missing.clear();state.deployer=false;
  await page.evaluate(()=>localStorage.clear());await mount(token);
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Deploy demo token',exact:true}).count(),0);
  await page.getByText(/L1 Arachnid deployer: Missing/).waitFor();
  await page.getByText(/L2 Arachnid deployer: Missing/).waitFor();
  assert.equal(await page.getByText(/protocol, bridge and Composer: Ready/).count(),0);
  assert.equal(await page.getByText(/New Safes use Arachnid to keep/).count(),0);
  assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).count(),1);
  assert.equal(sends.length,1);
  // A canonical revert becomes a failed record, never an automatic resend.
  state.deployer=true;await page.evaluate(()=>localStorage.clear());await mount();
  failNext=true;await page.getByRole('button',{name:'Deploy demo token',exact:true}).click();
  await page.getByRole('button',{name:'Retry demo token deployment',exact:true}).waitFor();
  assert.equal(sends.length,2);assert.equal(await page.getByLabel('L1 token address',{exact:true}).isDisabled(),false);
  const savedFailure=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':asset')))));
  assert(!savedFailure.pending);assert.equal(savedFailure.failed.request.hash,failedHash);
  await mount();await page.getByRole('button',{name:'Retry demo token deployment',exact:true}).waitFor();assert.equal(sends.length,2);
  failureCanonical=false;await page.getByRole('button',{name:'Retry demo token deployment',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'no longer confirmed as failed'}).waitFor();assert.equal(sends.length,2);
  failureCanonical=true;await page.getByRole('button',{name:'Retry demo token deployment',exact:true}).click();
  await page.getByText(/Demo token deployment pending/).waitFor();assert.equal(sends.length,3);assert.equal(sends[2].nonce,'0x1');
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(':asset:failed:')).length),1);
  // Demo tokens expose one active next step; the existing token is never redeployed.
  failedRequest=null;returnHashes=false;state.demo=true;state.wrapped=false;
  await page.evaluate(()=>localStorage.clear());await mount(token);
  const useToken=page.getByRole('button',{name:'Use this token',exact:true});
  await page.getByRole('button',{name:'Initialize on L2',exact:true}).waitFor();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Initialize on L2')?.disabled);
  assert(await useToken.isDisabled());
  assert.equal(await useToken.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(80, 80, 80)');
  assert.equal((await page.getByLabel('L1 token address',{exact:true}).inputValue()).toLowerCase(),token.toLowerCase());
  assert.equal(await page.getByRole('button',{name:'Deploy a new demo token',exact:true}).isDisabled(),false);
  assert.equal(await page.getByRole('button',{name:'Deploy demo token',exact:true}).count(),0);
  state.wrapped=true;
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Use this token')?.disabled);
  assert.equal(await page.getByRole('button',{name:'Initialize on L2',exact:true}).count(),0);
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Use this token');return button && getComputedStyle(button).backgroundColor==='rgb(255, 255, 255)';});
  await useToken.click();await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  // The same primary button stays centered for both Safe choices.
  const start=page.getByRole('button',{name:'Start setup',exact:true});
  const checkStart=async()=>{const layout=await start.evaluate(el=>{const b=el.getBoundingClientRect(),p=el.closest('section').getBoundingClientRect();return {offset:Math.abs(b.x+b.width/2-p.x-p.width/2),height:b.height,width:b.width};});assert(layout.offset<2);assert(layout.height>=48);assert(layout.width>=220);};
  await checkStart();await page.getByRole('button',{name:'Use an existing Safe',exact:true}).click();await checkStart();
  assert.equal(sends.length,3);
  // Returning to token selection also allows replacement of a previously deployed token.
  await page.evaluate(token=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':base')).replace(/:base$/,':asset');localStorage.setItem(key,JSON.stringify({token}));},token);
  await page.getByRole('button',{name:'Choose another token',exact:true}).click();
  assert.equal((await page.getByLabel('L1 token address',{exact:true}).inputValue()).toLowerCase(),token.toLowerCase());
  await page.getByRole('button',{name:'Deploy a new demo token',exact:true}).waitFor();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Deploy a new demo token')?.disabled);
  assert.equal(sends.length,3,'Returning to the menu never deploys automatically');
  // A saved/configured token must not hide deployment when its field is cleared.
  await mount(token);await page.getByLabel('L1 token address',{exact:true}).waitFor();
  assert.equal((await page.getByLabel('L1 token address',{exact:true}).inputValue()).toLowerCase(),token.toLowerCase());
  assert.equal(await page.getByRole('button',{name:'Deploy a new demo token',exact:true}).isDisabled(),false);
  await page.getByLabel('L1 token address',{exact:true}).fill('');
  await page.getByRole('button',{name:'Deploy a new demo token',exact:true}).waitFor();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Deploy a new demo token')?.disabled);
  assert.equal(sends.length,3);
  // Mainnet bypasses configured token selection, including empty or invalid overrides.
  selectedDashboard={...dashboard,l1ChainId:'0x1'};selectedToken=ETHEREUM_USDC;
  ({io,state}=fixture({dashboard:selectedDashboard,token:selectedToken,symbol:'USDC'}));
  const noTokenControls=async()=>{
    assert.equal(await page.getByRole('region',{name:'Treasury token',exact:true}).count(),0);
    assert.equal(await page.getByLabel('L1 token address',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/Use this token|Choose another token|Deploy.*demo token|Initialize on L2/}).count(),0);
  };
  for(const configured of ['',token,'invalid-token']){
    await page.evaluate(()=>localStorage.clear());await mount(configured);
    await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();await noTokenControls();
    const saved=await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':network'))));
    assert.equal(JSON.parse(saved).contracts.usdcProxy.address,ETHEREUM_USDC);
    await mount(configured);await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();await noTokenControls();
    assert.equal(await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':network')))),saved,'USDC selection keeps its saved identity');
  }
  await page.evaluate(token=>{
    const key=Object.keys(localStorage).find(k=>k.endsWith(':network'));
    localStorage.removeItem(key);localStorage.setItem(key.replace(/:network$/,':asset'),JSON.stringify({token}));
  },ETHEREUM_USDC);
  await mount();await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();await noTokenControls();
  // Token failures stay visible even though mainnet has no token card.
  await page.evaluate(()=>localStorage.clear());state.wrapped=false;await mount();
  await page.getByRole('alert').filter({hasText:'USDC has not been bridged'}).waitFor();await noTokenControls();
  assert.equal(await page.getByRole('heading',{name:'Choose your Safes',exact:true}).count(),0);
  state.wrapped=true;await page.getByRole('button',{name:'Check again',exact:true}).click();
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  await page.evaluate(()=>localStorage.clear());failTokenOnce=true;await mount();
  await page.getByRole('alert').filter({hasText:'Temporary token RPC failure'}).waitFor();await noTokenControls();
  await page.getByRole('button',{name:'Check again',exact:true}).click();
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  // Older selections cannot replace USDC or silently change an existing setup.
  const previousSelection=await page.evaluate(token=>{
    const key=Object.keys(localStorage).find(k=>k.endsWith(':network')),network=JSON.parse(localStorage.getItem(key));
    network.contracts.usdcProxy.address=token;const value=JSON.stringify(network);localStorage.setItem(key,value);return {key,value};
  },token);
  await mount();await page.getByRole('alert').filter({hasText:/Mainnet treasury requires.*USDC/}).waitFor();await noTokenControls();
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),previousSelection.key),previousSelection.value);
  assert.equal(await page.getByRole('heading',{name:'Choose your Safes',exact:true}).count(),0);
  await page.getByRole('button',{name:'Refresh unused network setup',exact:true}).click();
  await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
  const journalKey=previousSelection.key.replace(/:network$/,':asset');
  for(const journal of [{token},{pending:savedFailure.failed.request},{failed:savedFailure.failed}]){
    const value=JSON.stringify(journal);await page.evaluate(({key,value})=>localStorage.setItem(key,value),{key:journalKey,value});
    await mount();await page.getByRole('alert').filter({hasText:'A previous demo-token setup is saved'}).waitFor();await noTokenControls();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),journalKey),value);
    assert.equal(await page.getByRole('button',{name:/Refresh unused network setup|Retry demo token/}).count(),0);
    assert.equal(await page.getByRole('heading',{name:'Choose your Safes',exact:true}).count(),0);
  }
  assert.equal(sends.length,3,'Mainnet selection, reload and recovery never send token transactions');
  assert.deepEqual(errors,[]);
  console.log('PASS: mainnet USDC-only setup, hidden token controls, preserved journals, testnet token selection/deployment, network readiness and no automatic resend');
}finally{await browser?.close();await server.close();}
