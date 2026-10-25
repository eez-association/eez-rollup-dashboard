// Isolated EVM + real compiler verification. Explorer transport is controlled;
// this does not claim public explorer availability or EEZ settlement coverage.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { encodeDeployData, encodeFunctionData, getContractAddress, toHex, zeroAddress } from 'viem';
import { VerificationWorker, loadBuilds } from '../../scripts/verification/worker.mjs';
import { matchesRuntime } from '../../src/lib/treasury/runtimeCode.ts';
const current=JSON.parse(readFileSync('src/lib/treasury/current-build.json')).build;
const bundle=JSON.parse(readFileSync(`src/lib/treasury/builds/${current}.json`));
const artifacts=bundle.contracts;
mkdirSync('.runtime/treasury-auto-verification-20261022',{recursive:true});
const directory=mkdtempSync('.runtime/treasury-auto-verification-20261022/anvil-');
const server=createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
const log=openSync(`${directory}/anvil.log`,'w');
const node=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','906969','--silent'],{stdio:['ignore',log,log]});
const rpcUrl=`http://127.0.0.1:${port}`;
const rpc=async(method,params=[])=>{const r=await(await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(r.error)throw Error(r.error.message);return r.result;};
const evidence={build:current,scope:'isolated Anvil, real solc standard JSON recompilation, controlled explorer transport',transactions:[],verified:[]};
try {
  for(let i=0;i<100;i++){try{await rpc('eth_chainId');break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const [owner]=await rpc('eth_accounts');
  async function send(data,to,record=true){const tx=await rpc('eth_sendTransaction',[{from:owner,to,data,gas:'0x1c9c380'}]);let receipt;for(let i=0;i<100&&!receipt;i++){receipt=await rpc('eth_getTransactionReceipt',[tx]);if(!receipt)await new Promise(r=>setTimeout(r,20));}assert(receipt,'deployment receipt timeout');assert.equal(receipt.status,'0x1');if(record)evidence.transactions.push(tx);return receipt;}
  async function deploy(name,args=[]){const a=artifacts[name];return (await send(encodeDeployData({abi:a.abi,bytecode:a.bytecode,args}))).contractAddress;}
  const safe=await deploy('Safe'),factory=await deploy('SafeProxyFactory'),module=await deploy('AllowanceModule');
  const initializer=encodeFunctionData({abi:artifacts.Safe.abi,functionName:'setup',args:[[owner],1n,zeroAddress,'0x',zeroAddress,zeroAddress,0n,zeroAddress]});
  await send(encodeFunctionData({abi:artifacts.SafeProxyFactory.abi,functionName:'createProxyWithNonce',args:[safe,initializer,77n]}),factory);
  // Real compiled fixture bindings let the packaged policy constructor execute.
  // Only released contracts enter the verification queue; this is no EEZ proof.
  async function fixture(source,name,args=[]) {
    const a=JSON.parse(readFileSync(`contracts/out/${source}.sol/${name}.json`));
    const address=(await send(encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args}),undefined,false)).contractAddress;
    return {address,abi:a.abi};
  }
  const manager=await fixture('OwnerFixture','ReadThroughManager',[0n]),bridge=await fixture('Bridge','Bridge');
  await send(encodeFunctionData({abi:bridge.abi,functionName:'initialize',args:[manager.address,0n,owner]}),bridge.address,false);
  await send(encodeFunctionData({abi:bridge.abi,functionName:'setCanonicalBridgeAddress',args:[safe]}),bridge.address,false);
  const token=await deploy('TestUSDC',[bridge.address,1n]);
  const nonce=BigInt(await rpc('eth_getTransactionCount',[owner,'latest'])),executor=getContractAddress({from:owner,nonce});
  const target=getContractAddress({from:executor,nonce:1n});
  await deploy('TreasuryBootstrap',[[{create:true,target,data:encodeDeployData({abi:artifacts.PairedTreasuryPolicy.abi,bytecode:artifacts.PairedTreasuryPolicy.bytecode,args:[safe,module,token,bridge.address,1n]}),returnHash:toHex(0n,{size:32})}]]);
  const verified=new Map(),compiled=new Map();
  const fetcher=async(url,options)=>{
    if(url===rpcUrl)return fetch(url,options);
    const address=/smart-contracts\/(0x[\da-f]+)/i.exec(url)?.[1];assert(address);
    if(options?.method==='POST'){
      const form=options.body;const input=await form.get('files[0]').text(),version=form.get('compiler_version').slice(1).split('+')[0],key=version+input;
      if(!compiled.has(key)){
        const solc=['.local/share/svm','.svm'].map(p=>resolve(homedir(),p,version,`solc-${version}`)).find(existsSync);
        assert(solc,`Install solc ${version} before running verification integration`);
        const output=JSON.parse(execFileSync(solc,['--standard-json'],{input,encoding:'utf8',maxBuffer:64*1024*1024}));
        assert(!(output.errors??[]).some(e=>e.severity==='error'));compiled.set(key,output);
      }
      const [source,name]=form.get('contract_name').split(':'),a=compiled.get(key).contracts[source][name];
      const refs=Object.values(a.evm.deployedBytecode.immutableReferences??{});
      const code=await rpc('eth_getCode',[address,'latest']);assert(matchesRuntime(code,{runtime:'0x'+a.evm.deployedBytecode.object,immutables:refs.flat(),immutableGroups:refs}),'submitted input must reproduce deployed metadata and executable');
      verified.set(address,{is_verified:true,is_partially_verified:false,deployed_bytecode:code});
      return Response.json({message:'Smart-contract verification started'});
    }
    return Response.json(verified.get(address)??{is_verified:false});
  };
  let now=Date.now();
  const options={directory:`${directory}/queue`,builds:loadBuilds('verification/builds'),networks:{906969:{rpc:rpcUrl,explorerApi:'https://fixture.invalid/api'}},fetcher,now:()=>now};
  let worker=new VerificationWorker(options);
  for(const transactionHash of evidence.transactions)await worker.admit({build:current,chainId:906969,transactionHash});
  for(let i=0;i<evidence.transactions.length;i++)await worker.tick();
  assert([...worker.jobs.values()].every(j=>j.status==='pending'));
  worker=new VerificationWorker(options);now+=60000;
  for(let i=0;i<evidence.transactions.length;i++)await worker.tick();
  assert([...worker.jobs.values()].every(j=>j.status==='verified'));
  evidence.verified=[...worker.jobs.values()].flatMap(j=>j.contracts.map(c=>({address:c.address,name:c.name,status:c.status})));
  assert.equal(evidence.verified.length,7);assert(evidence.verified.some(c=>c.name==='SafeProxy'));assert(evidence.verified.some(c=>c.name==='PairedTreasuryPolicy'));assert(evidence.verified.some(c=>c.name==='TestUSDC'));
  evidence.passed=true;console.log(`PASS: ${evidence.verified.length} real deployments, exact recompilation, nested discovery and restart recovery`);
} finally {writeFileSync(`${directory}/summary.json`,JSON.stringify(evidence,null,2));node.kill('SIGTERM');await once(node,'exit');console.log(`Evidence: ${directory}`);}
