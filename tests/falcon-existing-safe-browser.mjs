import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, pad, toHex, zeroAddress, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { crossChainDeployment as d } from '../src/lib/falcon/crossChainDeployment.ts';
import { l1ControllerAbi, l1ControllerFactoryAbi } from '../src/lib/falcon/l1Action.ts';
import { managerAbi } from '../src/lib/falcon/l1Controller.ts';
import { safeAbi, safeFactoryAbi } from '../src/lib/falcon/safe.ts';
import { ownerTransaction, attachmentKey } from '../src/lib/falcon/existingSafe.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { loadTreasuryArtifacts } from '../src/lib/treasury/release.ts';
import { recoveryKey, scopedRecoveryKey } from '../src/lib/falcon/recoveryJournal.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { fixture, origin } from './falcon/fixture.mjs';
import { treasuryFixture } from './falcon/treasuryFixture.mjs';

const a=n=>toHex(n,{size:20}), eq=(a,b)=>a.toLowerCase()===b.toLowerCase();
const wallet=privateKeyToAccount(toHex(12345,{size:32})),account=wallet.address,controller=a(300),owner=a(301),singleton=a(302),module=a(303);
const treasury=treasuryFixture(d,origin),safe=treasury.config.safeL1,l2Safe=treasury.config.safeL2;
const code=JSON.parse(readFileSync(new URL('./falcon/fixtures/deployed-code.json',import.meta.url),'utf8'));
const artifacts=await loadTreasuryArtifacts();
const blockNumber=d.l1.anchor.blockNumber+100n,blockHash=keccak256(toHex('owner-block')),txHash=keccak256(toHex('owner-transaction'));
const signed=[],sends=[],reads=[];
let keyHash,publicKey,owners=[account],threshold=1n,nonce=7n,confirmed=false,changeNonce=false;
const ownerTx=()=>ownerTransaction(d,safe,owner,7n);
async function rpc({method,params=[],chain}) {
 if(!method)return null;
 reads.push({method,params,chain});
 if(method==='eth_chainId')return chain;
 if(method==='eth_blockNumber')return toHex(blockNumber);
 if(method==='eth_getBalance')return toHex(10n**18n);
 if(method==='eth_gasPrice')return '0x1';
 if(method==='eth_estimateGas')return '0x493e0';
 if(method==='eth_getLogs')return [];
 if(method==='eth_getTransactionBySenderAndNonce')return null;
 if(method==='eth_getTransactionCount')return '0x2';
 if(method==='eth_getCode')return eq(params[0],safe)?artifacts.contracts.SafeProxy.runtime:eq(params[0],singleton)?artifacts.contracts.Safe.runtime:Object.values(code).find(c=>eq(c.address,params[0]))?.code??'0x';
 if(method==='eth_getStorageAt')return params[1]==='0x0'?pad(singleton):zeroHash;
 if(method==='eth_getBlockByNumber'){
  const side=BigInt(chain)===BigInt(d.l1.chainId)?d.l1:d.l2;
  const number=['latest','pending'].includes(params[0])?blockNumber:BigInt(params[0]);
  return {number:toHex(number),hash:number===side.anchor.blockNumber?side.anchor.blockHash:blockHash,timestamp:'0x65000000',gasLimit:'0x1000000',gasUsed:'0x0',transactions:[]};
 }
 if(method==='eth_getTransactionReceipt')return confirmed?{transactionHash:txHash,from:account,to:safe,status:'0x1',blockHash,blockNumber:toHex(blockNumber),transactionIndex:'0x0',type:'0x0',gasUsed:'0x493e0',effectiveGasPrice:'0x1',cumulativeGasUsed:'0x493e0',logs:[{
  address:safe,topics:encodeEventTopics({abi:safeAbi,eventName:'ExecutionSuccess',args:{txHash:safeTransactionHash(ownerTx())}}),data:encodeAbiParameters([{type:'uint256'}],[0n]),blockHash,blockNumber:toHex(blockNumber),transactionHash:txHash,transactionIndex:'0x0',logIndex:'0x0',removed:false,
 }]}:null;
 if(method==='eth_getTransactionByHash')return {hash:txHash,from:account,to:safe,nonce:'0x2',value:'0x0',input:sends.at(-1).data,chainId:toHex(d.l1.chainId),blockHash:confirmed?blockHash:null,blockNumber:confirmed?toHex(blockNumber):null,transactionIndex:confirmed?'0x0':null,type:'0x0',gas:'0x493e0',gasPrice:'0x1',v:'0x1b',r:toHex(1n,{size:32}),s:toHex(1n,{size:32})};
 if(method==='eth_call'){
  const {to,data}=params[0];
  if(eq(to,COMPOSER_DISCOVERY_ADDRESS)){
   const {args}=decodeFunctionData({abi:COMPOSER_DISCOVERY_ABI,data});
   return encodeFunctionResult({abi:COMPOSER_DISCOVERY_ABI,functionName:'composerInfo',result:[COMPOSER_DISCOVERY_MARKER,1n,args[0],BigInt(chain),toHex(JSON.stringify({version:'fixture',supportedNetworks:{eezL1:d.l1.chainId,eezL2:d.l2.chainId},eezContracts:{eezRegistryAddress:d.l1.registry,eezL2Address:d.l2.manager}}))]});
  }
  const abi=eq(to,controller)?l1ControllerAbi:eq(to,d.l2.factory.address)?l1ControllerFactoryAbi:eq(to,d.l1.safe.factory.address)?safeFactoryAbi:eq(to,safe)?safeAbi:managerAbi;
  const {functionName,args}=decodeFunctionData({abi,data});
  if(functionName==='controllers')keyHash=args[0];
  const values={verifier:d.l2.verifier.address,eezL2:d.l2.manager,l1ChainId:BigInt(d.l1.chainId),ROLLUP_ID:d.l2.rollupId,USE_GAS_LEFT:false,controllers:controller,publicKeyHash:keyHash,nonce:eq(to,safe)?nonce:0n,
   singleton:d.l1.safe.singleton.address,fallbackHandler:d.l1.safe.fallbackHandler.address,computeCrossChainProxyAddress:owner,safes:zeroAddress,VERSION:'1.4.1',getOwners:owners,getThreshold:threshold,getModulesPaginated:[[module],a(1)],authorizedProxies:[false,zeroAddress,0n]};
  const result=functionName==='getTransactionHash'?safeTransactionHash(ownerTransaction(d,safe,owner,args[9])):values[functionName];
  assert.notEqual(result,undefined,functionName);return encodeFunctionResult({abi,functionName,result});
 }
 throw Error('Unexpected RPC '+method);
}
const browser=await chromium.launch({headless:true,chromiumSandbox:process.env.TREASURY_BROWSER_SANDBOX!=='0'});
try {
 const f=await fixture(browser,{rpc:async request=>{try{return await rpc(request);}catch(error){console.error(request.method,error.message);throw error;}}}),{page}=f;
 await page.exposeFunction('existingSafeWalletRpc',async request=>{
  if(request.method==='eth_signTypedData_v4'){
   assert.equal(request.chain,toHex(d.l1.chainId));assert(eq(request.params[0],account));
   const typed=JSON.parse(request.params[1]);signed.push(typed);
   assert.equal(typed.domain.verifyingContract.toLowerCase(),safe.toLowerCase());
   assert.equal(typed.message.to.toLowerCase(),safe.toLowerCase());assert.equal(typed.message.data,ownerTx().message.data);
   if(changeNonce){nonce++;changeNonce=false;}
   return wallet.signTypedData(typed);
  }
  if(request.method==='eth_sendTransaction'){
   const tx=request.params[0];assert.equal(tx.chainId,toHex(d.l1.chainId));assert(eq(tx.to,safe));assert(!eq(tx.to,l2Safe));
   const {functionName,args}=decodeFunctionData({abi:safeAbi,data:tx.data});assert.equal(functionName,'execTransaction');assert(eq(args[0],safe));assert.equal(args[2],ownerTx().message.data);
   sends.push(tx);return txHash;
  }
  return rpc(request);
 });
 await page.addInitScript(({account,chain,entries})=>{
  const listeners=new Map();const state=window.existingSafeWallet={chain,loseReply:true};
  const provider={isMetaMask:true,on:(event,fn)=>listeners.set(event,[...(listeners.get(event)??[]),fn]),removeListener:(event,fn)=>listeners.set(event,(listeners.get(event)??[]).filter(f=>f!==fn)),request:async({method,params})=>{
   if(method==='eth_chainId')return state.chain;
   if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
   if(method==='wallet_switchEthereumChain'){state.chain=params[0].chainId;for(const fn of listeners.get('chainChanged')??[])fn(state.chain);return null;}
   if(method==='wallet_addEthereumChain')return null;
   const result=await window.existingSafeWalletRpc({method,params,chain:state.chain});
   if(method==='eth_sendTransaction'&&state.loseReply){state.loseReply=false;throw Error('Lost wallet response');}
   return result;
  }};
  window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'existing-safe-wallet',name:'MetaMask',rdns:'io.metamask'},provider}})));
  for(const [key,value]of entries)localStorage.setItem(key,value);
 },{account,chain:toHex(d.l2.chainId),entries:treasury.entries});
 await f.open();await page.getByRole('button',{name:'Connect Wallet',exact:true}).click();await page.getByRole('button',{name:'MetaMask',exact:true}).click();
 await page.locator('#generate').click();await page.waitForFunction(()=>document.querySelector('#key-status')?.textContent.includes('Key generated'));
 publicKey='0x'+await page.getByTestId('public-key').inputValue();
 try { await page.getByRole('button',{name:'Add to existing Safe',exact:true}).click(); } catch(error) { console.error(await page.locator('body').innerText()); throw error; }
 const input=page.getByLabel('L1 Safe address',{exact:true}),add=page.getByRole('button',{name:'Add owner',exact:true});
 assert.equal((await input.inputValue()).toLowerCase(),safe.toLowerCase(),'Treasury L1 address is prefilled, not its mirror');
 assert.equal(await page.getByText(/Gas wallet ·/).count(),0);
 const status=text=>page.getByRole('status').filter({hasText:text}).waitFor();
 owners=[a(999)];await add.click();await status('Only a 1-of-1 Safe');assert.equal(signed.length,0);
 owners=[account,a(999)];await add.click();await status('Only a 1-of-1 Safe');assert.equal(signed.length,0);
 owners=[account];threshold=2n;await add.click();await status('Unsupported Safe owners');assert.equal(signed.length,0);
 threshold=1n;changeNonce=true;await add.click();await status('Safe owners or nonce changed');assert.equal(sends.length,0);nonce=7n;
 await page.locator('#backup-options input[name="password"]').fill('existing-safe-test-password');
 await page.locator('#backup-options input[name="confirmation"]').fill('existing-safe-test-password');await page.locator('#remember').click();
 await page.waitForFunction(()=>document.querySelector('#key-status')?.textContent.includes('saved'));
 await add.click();await status('wallet');
 const journalKey=scopedRecoveryKey(recoveryKey(d,'owner'),{account,publicKey});
 await page.waitForFunction(key=>!!localStorage.getItem(key),journalKey);
 assert.equal(sends.length,1);await page.waitForFunction(()=>document.querySelector('#falcon-existing-safe')?.disabled);
 await page.reload();await page.locator('#unlock-saved').waitFor();
 await page.getByLabel('Saved key password',{exact:true}).fill('existing-safe-test-password');await page.locator('#unlock-saved').click();
 await page.getByText('Owner transaction recovery',{exact:true}).waitFor();assert.equal(sends.length,1,'reload never resubmits');
 owners=[owner,account];nonce=8n;confirmed=true;
 await page.getByLabel('Owner transaction hash',{exact:true}).fill(txHash);
 await page.getByRole('button',{name:'Recover owner transaction',exact:true}).click();
 await page.getByRole('heading',{name:'Your Safe account',exact:true}).waitFor();
 assert.equal(await page.locator('#safe-address').getAttribute('title'),safe);
 await page.locator('#safe-sign').waitFor();await page.locator('#safe-send').waitFor();await page.locator('#safe-fund').waitFor();
 assert.equal(sends.length,1);assert.equal(await page.evaluate(key=>localStorage.getItem(key),journalKey),null);
 assert((await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),attachmentKey(d,publicKey))).target.toLowerCase()===safe.toLowerCase());
 await page.setViewportSize({width:390,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'/tmp/falcon-existing-safe.png',fullPage:true});
 await page.reload();await page.locator('#unlock-saved').waitFor();await page.getByLabel('Saved key password',{exact:true}).fill('existing-safe-test-password');await page.locator('#unlock-saved').click();
 await page.getByRole('heading',{name:'Your Safe account',exact:true}).waitFor();assert.equal(sends.length,1);
 assert(!reads.some(r=>r.method==='eth_call'&&eq(r.params[0].to,l2Safe)),'attachment never reads or changes the L2 mirror');
 await f.close();console.log('PASS: Treasury prefill, 1/1 wallet checks, typed Safe signature, stale nonce rejection, L1-only owner addition, lost-reply recovery, reload and retained Safe menu');
}finally{await browser.close();}
