// Wallets and RPCs are mocked. Contract mint behavior is exercised separately by Foundry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {decodeAbiParameters,encodeAbiParameters,encodeEventTopics,getContractAddress,parseAbi,toFunctionSelector,toHex,zeroAddress} from 'viem';
const artifact=JSON.parse(fs.readFileSync('src/lib/bridge-test-token-artifact.json'));
const bridgeCode=JSON.parse(fs.readFileSync('tests/fixtures/bridge-token-factories.json'));
const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0,watch:null},base:'/'});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,chromiumSandbox:true});
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[],sends=[];
  page.on('pageerror',e=>errors.push(e.message));
  const transactions=new Map();let confirmed=true,hold=null,pendingNonce='0x0';
  await page.exposeFunction('sendTestToken',async request=>{
    sends.push(request);
    const hash=toHex(sends.length,{size:32});transactions.set(hash,request);
    if(hold)await hold;
    return hash;
  });
  const word=n=>encodeAbiParameters([{type:'uint256'}],[BigInt(n)]),addr=a=>encodeAbiParameters([{type:'address'}],[a]),text=s=>encodeAbiParameters([{type:'string'}],[s]);
  const blockHash=toHex(99,{size:32}),mintAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin);
    if(url.pathname==='/demo')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});
    if(!['/l1','/l2'].includes(url.pathname))return route.continue();
    const {id,method,params=[]}=request.postDataJSON();
    const reply=result=>route.fulfill({json:{jsonrpc:'2.0',id,result}});
    if(method==='eth_chainId')return reply(url.pathname==='/l1'?'0x27d8':'0xaab21');
    if(method==='eth_estimateGas')return reply('0x80000');
    if(method==='eth_getTransactionCount')return reply(pendingNonce);
    if(method==='eth_getBlockByNumber')return reply({hash:blockHash,number:'0x10'});
    if(method==='eth_getTransactionByHash'){
      const tx=transactions.get(params[0]);return reply(tx?{...tx,hash:params[0],to:null,input:tx.data,blockNumber:'0x10',blockHash}:null);
    }
    if(method==='eth_getTransactionReceipt'){
      const tx=transactions.get(params[0]);if(!tx||!confirmed)return reply(null);
      const address=getContractAddress({from:tx.from,nonce:BigInt(tx.nonce)});
      const args=decodeAbiParameters([{type:'string'},{type:'string'},{type:'uint256'}],'0x'+tx.data.slice(artifact.bytecode.length));
      return reply({transactionHash:params[0],from:tx.from,to:null,status:'0x1',blockHash,blockNumber:'0x10',contractAddress:address,
        logs:[{address,topics:encodeEventTopics({abi:mintAbi,eventName:'Transfer',args:{from:zeroAddress,to:tx.from}}),data:word(args[2])}]});
    }
    if(method==='eth_getCode')return reply(['0x'+'11'.repeat(20),'0x'+'22'.repeat(20)].includes(params[0])?bridgeCode.proxy:params[0]==='0x'+'33'.repeat(20)?bridgeCode.implementation:artifact.runtime);
    if(method==='eth_getStorageAt')return reply(addr('0x'+'33'.repeat(20)));
    if(method==='eth_call'){
      const selector=params[0].data.slice(0,10);
      if(selector===toFunctionSelector('name()'))return reply(text('Bridge Test Token'));
      if(selector===toFunctionSelector('symbol()'))return reply(text('TEST'));
      if(selector===toFunctionSelector('decimals()'))return reply(word(18));
      if(selector===toFunctionSelector('wrappedTokenInfo(address)'))return reply(encodeAbiParameters([{type:'address'},{type:'uint64'}],[zeroAddress,0n]));
      if(selector===toFunctionSelector('rollupId()'))return reply(word(url.pathname==='/l1'?0:2));
      if(selector===toFunctionSelector('getWrappedToken(address,uint64)'))return reply(addr(zeroAddress));
      if(selector===toFunctionSelector('EEZContract()'))return reply(addr('0x'+'44'.repeat(20)));
    }
    throw new Error('Unexpected RPC '+method);
  });
  const open=()=>page.locator('summary').filter({hasText:'Create test token'}).click();
  const mount=async()=>{await page.goto(origin+'/demo');await page.evaluate(async()=>(await import('/tests/fixtures/bridge-test-token.tsx')).mount());};
  const deploy=()=>page.getByRole('button',{name:'Deploy test token',exact:true}).click();
  await mount();
  assert.equal(await page.getByLabel('Token name',{exact:true}).count(),0);assert.equal(sends.length,0);
  await open();
  assert.match(await page.getByRole('button',{name:'Deploy test token',exact:true}).getAttribute('class'),/\bbtn-solid\b/);
  await page.getByLabel('Initial supply',{exact:true}).fill('0');await deploy();
  await page.getByRole('alert').filter({hasText:'Initial supply must be positive'}).waitFor();assert.equal(sends.length,0);
  await page.getByLabel('Initial supply',{exact:true}).fill('10000');
  await page.evaluate(()=>window.tokenFixture.mode='reject');await deploy();
  await page.getByRole('alert').filter({hasText:'Deployment cancelled'}).waitFor();
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('eez:bridge:test-token:')).length),0);
  await page.evaluate(()=>window.tokenFixture.mode='rpc-error');await deploy();
  await page.getByRole('alert').filter({hasText:'Provider rejected deployment parameters'}).waitFor();
  assert.equal(sends.length,0);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('eez:bridge:test-token:')).length),0);
  await page.evaluate(()=>window.tokenFixture.mode='success');await deploy();
  await page.getByText('Token deployed',{exact:true}).waitFor();
  assert.equal(sends.length,1);assert.equal(sends[0].to,undefined);assert.equal(sends[0].chainId,'0x27d8');assert.equal(sends[0].value,'0x0');
  assert.equal(await page.evaluate(()=>window.tokenFixture.selection),null,'Deployment must not change the bridge selection');
  const deployedAddress=getContractAddress({from:sends[0].from,nonce:BigInt(sends[0].nonce)});
  await page.getByRole('button',{name:'Copy address',exact:true}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),deployedAddress);
  assert.equal(sends.length,1,'Copying the address must not approve or bridge it');
  assert.equal(await page.locator('summary').filter({hasText:'Recover deployment'}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Use in bridge',exact:true}).count(),0);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await mount();await open();await page.getByRole('button',{name:'Copy address',exact:true}).waitFor();assert.equal(sends.length,1);
  await page.evaluate(()=>window.tokenFixture.reverse());
  await page.getByRole('button',{name:'Deploy test token',exact:true}).waitFor();
  await deploy();await page.getByRole('button',{name:'Copy address',exact:true}).waitFor();assert.equal(sends[1].chainId,'0xaab21');
  assert.equal(await page.evaluate(()=>window.tokenFixture.selection),null);

  // A wallet reply arriving after closing the panel is retained and observed on reopening.
  await page.getByRole('button',{name:'Deploy another token',exact:true}).click();
  confirmed=false;let release;hold=new Promise(resolve=>{release=resolve;});
  await deploy();await page.waitForFunction(()=>window.tokenFixture.calls.some(c=>c.method==='eth_sendTransaction'));
  // Wait for this specific submission to reach the host before closing.
  for(let i=0;sends.length<3&&i<100;i++)await page.waitForTimeout(20);
  assert.equal(sends.length,3);await open();release();hold=null;await open();
  await page.getByText('Deploying…',{exact:true}).waitFor();
  await mount();await open(); // L1's completed record remains independent of L2.
  await page.evaluate(()=>window.tokenFixture.reverse());await page.getByText('Deploying…',{exact:true}).waitFor();
  assert.equal(sends.length,3);
  confirmed=true;await page.getByRole('button',{name:'Copy address',exact:true}).waitFor();

  // Unknown provider failures stay explicit; starting another token is a new user action.
  await page.getByRole('button',{name:'Deploy another token',exact:true}).click();
  await page.evaluate(()=>window.tokenFixture.mode='unknown');await deploy();
  await page.getByRole('alert').filter({hasText:'No transaction hash returned'}).waitFor();
  assert.equal(sends.length,4);
  await page.getByRole('button',{name:'Deploy another token',exact:true}).click();
  await page.getByRole('button',{name:'Deploy test token',exact:true}).waitFor();
  assert.equal(sends.length,4,'Opening the form must never deploy automatically');
  assert.deepEqual(errors,[]);
  console.log('PASS: collapsed panel, validation, rejection, mint confirmation, copy address, L1/L2, reload, late replies, explicit new deployment and mobile widths; no live transactions');
} finally {await browser?.close();await server.close();}
