// Two independent EVMs: identical Safe addresses, distinct state/signing domains.
// Does not emulate the native EEZ relay or cross-chain policy execution.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import{once}from'node:events';import{createServer}from'node:net';
import{readFileSync,mkdirSync,mkdtempSync,writeFileSync}from'node:fs';
import{encodeDeployData,encodeFunctionData,toHex,zeroHash}from'viem';import{privateKeyToAccount}from'viem/accounts';
import{MainnetSetup,setupIdentity,readMainnetSetup}from'../../src/lib/treasury/mainnetSetup.ts';
import{matchingSafePlan,matchingDeployer,matchingDeployerRuntime,matchingDeployerHash}from'../../src/lib/treasury/matchingSafes.ts';
import{buildSafeTransaction,encodeSafeExecution,packEOAApprovals}from'../../src/lib/treasury/safeTransactions.ts';
const read=p=>JSON.parse(readFileSync(p)),release=read('src/lib/treasury/builds/'+read('src/lib/treasury/current-build.json').build+'.json');
const A=privateKeyToAccount(toHex(0xa11cen,{size:32})),ids={l1:10200,l2:699069},nodes={},wait=ms=>new Promise(r=>setTimeout(r,ms));
mkdirSync('.runtime/matching-safes',{recursive:true});const directory=mkdtempSync('.runtime/matching-safes/test-');
const evidence={passed:false,scope:'Two isolated EVMs; Safe deployment and wallet-to-adapter handover, not native EEZ relay',addresses:{}};
async function rpc(chain,method,params=[]){const r=await(await fetch(nodes[chain].url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(r.error)throw Error(r.error.message);return r.result;}
async function send(chain,to,data){const hash=await rpc(chain,'eth_sendTransaction',[{from:A.address,to,data,gas:'0x1c9c380'}]);let receipt;for(let i=0;i<100&&!receipt;i++){receipt=await rpc(chain,'eth_getTransactionReceipt',[hash]);if(!receipt)await wait(20);}assert.equal(receipt?.status,'0x1');return receipt;}
try{
 for(const chain of ['l1','l2']){
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const process=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id',String(ids[chain]),'--silent'],{stdio:'ignore'});
  nodes[chain]={process,url:`http://127.0.0.1:${port}`};
  for(let i=0;i<100;i++){try{await rpc(chain,'eth_chainId');break;}catch{await wait(40);}}
  await rpc(chain,'anvil_setBalance',[A.address,toHex(100n*10n**18n)]);await rpc(chain,'anvil_impersonateAccount',[A.address]);
  await rpc(chain,'anvil_setCode',[matchingDeployer,matchingDeployerRuntime]);
 }
 assert.equal(matchingDeployerHash,'0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989');
 const fixture=read('contracts/out/OwnerFixture.sol/ReadThroughManager.json');
 const manager=(await send('l2',undefined,encodeDeployData({abi:fixture.abi,bytecode:fixture.bytecode.object,args:[1n]}))).contractAddress;
 const network=read('src/lib/treasury/mainnet-network.json');network.chains.l1.chainId=ids.l1;network.chains.l2.chainId=ids.l2;network.manager=manager;
 const target={l1:{rpc:nodes.l1.url,front:nodes.l1.url,explorer:''},l2:{rpc:nodes.l2.url,front:nodes.l2.url,explorer:''},fees:{l1:'0',l2:'0'}};
 const engine=new MainnetSetup(target,release,network),salt=toHex(42n,{size:32}),matching=matchingSafePlan(A.address,salt,release);
 let state={version:3,creation:'create-both',matching,build:release.build,identity:setupIdentity(network),salt,deployer:A.address,addresses:{},code:[],completed:[]};
 for(const [index,chain]of ['l1','l2'].entries()){
  const nonce=await rpc(chain,'eth_getTransactionCount',[A.address,'pending']);
  const batch=await engine.batch(state,nonce);assert((batch.data.length-2)/2<49152);
  const receipt=await send(chain,batch.to,batch.data);
  state=await engine.reconcile({...state,pending:{...batch,id:String(index),chain,sender:A.address,nonce,hash:receipt.transactionHash}});
  state=readMainnetSetup(JSON.stringify(state),network);
  evidence.addresses[chain]=state.addresses[chain==='l1'?'safeL1':'safeL2'];
  assert.equal(evidence.addresses[chain],matching.safe);
  assert.deepEqual(await engine.io.read(chain,matching.safe,'Safe','getOwners'),[A.address]);
  assert.equal(await engine.io.read(chain,matching.safe,'Safe','getThreshold'),1n);
  assert.equal(await engine.io.read(chain,matching.safe,'Safe','nonce'),0n);
 }
 assert.notEqual(state.addresses.bootstrapL1,state.addresses.bootstrapL2,'wallet nonces differ but Safe addresses match');
 const abi=release.contracts.Safe.abi;
 const tx=buildSafeTransaction({chainId:BigInt(ids.l2),safe:matching.safe,to:matching.safe,nonce:0n,data:encodeFunctionData({abi,functionName:'swapOwner',args:['0x0000000000000000000000000000000000000001',A.address,state.addresses.adapter]})});
 const signature=await packEOAApprovals(tx,[A.address],1,[{owner:A.address,signature:await A.signTypedData(tx)}]);
 await send('l2',matching.safe,encodeSafeExecution(tx,signature));
 assert.deepEqual(await engine.io.read('l2',matching.safe,'Safe','getOwners'),[state.addresses.adapter]);
 assert.deepEqual(await engine.io.read('l1',matching.safe,'Safe','getOwners'),[A.address]);
 assert.equal(await engine.io.read('l1',matching.safe,'Safe','nonce'),0n);assert.equal(await engine.io.read('l2',matching.safe,'Safe','nonce'),1n);
 assert.equal(await rpc('l1','eth_getCode',[matching.singleton,'latest']),await rpc('l2','eth_getCode',[matching.singleton,'latest']));
 await assert.rejects(engine.batch({...state,completed:[],addresses:{},matching:{...matching,safe:A.address}},'0x50'),/plan changed/);
 await assert.rejects(engine.batch({...state,completed:[],addresses:{}},'0x50'),/already occupied/);
 await rpc('l1','anvil_setCode',[matchingDeployer,'0x6000']);
 await assert.rejects(engine.batch({...state,completed:[],addresses:{}},'0x50'),/deployer changed/);
 evidence.passed=true;console.log('PASS identical Safe addresses on two independent EVMs, explicit owners, nonce independence, L2 handover, collisions and deployer checks');
}finally{
 writeFileSync(directory+'/summary.json',JSON.stringify(evidence,null,2));
 await Promise.all(Object.values(nodes).map(async({process})=>{if(process.exitCode===null){process.kill('SIGTERM');await once(process,'exit');}}));
 console.log('Evidence: '+directory);
}
