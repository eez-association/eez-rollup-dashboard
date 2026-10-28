// Paired policies and normal bridges in fresh local state. Public fixture keys only.
// Optional saved USDC runtime bytes enable the blacklist/browser rehearsal.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { keccak256, toHex, padHex, parseAbi, encodeFunctionData, zeroAddress } from 'viem';
import { runFixture } from './treasury-owners.mjs';
import { TreasuryClient, parseTreasuryConfig, readIntent } from '../../src/lib/treasury/client.ts';
import { buildSafeTransaction, packOwnerApprovals, packEOAApprovals, encodeSafeExecution } from '../../src/lib/treasury/safeTransactions.ts';
import { paymentState, paymentTransaction, tokenAbi, paymentAbi } from '../../src/lib/treasury/payments.ts';
import { USDC_IMPLEMENTATION_SLOT } from '../../src/lib/treasury/mainnet.ts';
import { packSafeCalls } from '../../src/lib/treasury/safeSetup.ts';
import { startComposerAdapter } from '../../scripts/treasury-composer.mjs';

export async function runStandardBridge(networkFile, evidenceFile) {
  const f = await runFixture(networkFile, evidenceFile, { setupOnly:true });
  return runPairedPayments(f, evidenceFile);
}

export async function runPairedPayments(f, evidenceFile) {
  const n=f.network, captured=process.env.TREASURY_STANDARD_BRIDGE_SNAPSHOT
    ? JSON.parse(readFileSync(process.env.TREASURY_STANDARD_BRIDGE_SNAPSHOT)) : null;
  if(captured) {
    assert.equal(captured.chains.l1.chainId,1);
    assert.equal(captured.protocolCommit,'855fe0602484750861b4c31502a1a91355d33ed6');
  }
  const adapters=[];
  const call=(chain,to,abi,functionName,args=[])=>f.send(chain,to,encodeFunctionData({abi,functionName,args}));
  const fixture=f.artifact('out','RuntimeSnapshot');
  async function clone(name,chain,slots=[],values=[]) {
    const record=captured.contracts[name]; assert.equal(keccak256(record.code),record.hash);
    const address=await f.deploy(chain,fixture,[record.code,slots,values]);
    assert.equal(keccak256(await f.rpc(chain.rpc,'eth_getCode',[address,'latest'])),record.hash);
    (f.evidence.runtimeClones??=[]).push({name,address,source:record.address,hash:record.hash});f.checkpoint();
    return address;
  }
  try {
    const bridgeArtifact=f.artifact('out','Bridge'),bridgeABI=bridgeArtifact.abi;
    const bridgeL1=captured?await clone('bridgeL1',n.l1):await f.deploy(n.l1,bridgeArtifact);
    const bridgeL2=captured?await clone('bridgeL2',n.l2):await f.deploy(n.l2,bridgeArtifact);
    await call(n.l1,bridgeL1,bridgeABI,'initialize',[n.registry,0n,f.submitter.address]);
    await call(n.l2,bridgeL2,bridgeABI,'initialize',[f.manager,BigInt(n.rollupId),f.submitter.address]);
    await call(n.l1,bridgeL1,bridgeABI,'setCanonicalBridgeAddress',[bridgeL2]);
    await call(n.l2,bridgeL2,bridgeABI,'setCanonicalBridgeAddress',[bridgeL1]);
    let tokenL1;
    const token=parseAbi(['function initialize(string,string,string,uint8,address,address,address,address)',
      'function initializeV2(string)','function initializeV2_1(address)','function initializeV2_2(address[],string)',
      'function configureMinter(address,uint256) returns(bool)','function mint(address,uint256) returns(bool)',
      'function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)',
      'function blacklist(address)','function unBlacklist(address)','function paused() view returns(bool)','function pause()','function unpause()',
      'function symbol() view returns(string)','function name() view returns(string)','function decimals() view returns(uint8)',
      'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function totalSupply() view returns(uint256)']);
    if(captured) {
      const implementation=await clone('usdcImplementation',n.l1);
      tokenL1=await clone('usdcProxy',n.l1,[USDC_IMPLEMENTATION_SLOT,keccak256(toHex('org.zeppelinos.proxy.admin'))],[padHex(implementation,{size:32}),padHex("0x000000000000000000000000000000000000dEaD",{size:32})]);
      await call(n.l1,tokenL1,token,'initialize',['USD Coin','USDC','USD',6,f.submitter.address,f.submitter.address,f.C.address,f.submitter.address]);
      await call(n.l1,tokenL1,token,'initializeV2',['USD Coin']);
      await call(n.l1,tokenL1,token,'initializeV2_1',[f.submitter.address]);
      await call(n.l1,tokenL1,token,'initializeV2_2',[[],'USDC']);
      await call(n.l1,tokenL1,token,'configureMinter',[f.submitter.address,450_000_000n]);
      await call(n.l1,tokenL1,token,'mint',[f.submitter.address,450_000_000n]);
      assert.equal(await f.read(n.l1.rpc,tokenL1,token,'name'),'USD Coin');
    } else {
      const faucet=f.artifact('out','TestUSDC');
      tokenL1=await f.deploy(n.l1,faucet,[bridgeL1,BigInt(n.rollupId)]);
      await call(n.l1,tokenL1,faucet.abi,'claim',[f.submitter.address]);
    }
    assert.equal(await f.read(n.l1.rpc,tokenL1,token,'decimals'),6);
    await call(n.l1,tokenL1,token,'transfer',[f.safeL1,300_000_000n]);
    await call(n.l1,tokenL1,token,'approve',[bridgeL1,150_000_000n]);
    await call(n.l1,bridgeL1,bridgeABI,'bridgeTokens',[tokenL1,150_000_000n,BigInt(n.rollupId),f.safeL2]);
    const tokenL2=await f.until('standard bridge wrapped USDC',async()=>{
      const a=await f.read(n.l2.rpc,bridgeL2,bridgeABI,'getWrappedToken',[tokenL1,0n]);return a!==zeroAddress?a:false;
    });
    assert.equal(await f.read(n.l2.rpc,tokenL2,token,'balanceOf',[f.safeL2]),150_000_000n);
    const moduleArtifact=f.artifact('legacy/out','AllowanceModule');
    const moduleL1=await f.deploy(n.l1,moduleArtifact),moduleL2=await f.deploy(n.l2,moduleArtifact);
    const helper=f.artifact('legacy/out','MultiSendCallOnly');
    const helperL1=await f.deploy(n.l1,helper),helperL2=await f.deploy(n.l2,helper);
    await call(n.l1,n.registry,f.eeZAbi,'getOrCreateCrossChainProxy',[f.safeL2,BigInt(n.rollupId)]);
    const safeL2Alias=await f.read(n.l1.rpc,n.registry,f.eeZAbi,'computeCrossChainProxyAddress',[f.safeL2,BigInt(n.rollupId)]);
    const policyArtifact=f.artifact('out','PairedTreasuryPolicy');
    const base={ version:1, environment:'isolated-devnet', instance:keccak256(toHex(f.safeL2)),
      registry:n.registry,manager:f.manager,safeL1:f.safeL1,safeL2:f.safeL2,adapter:f.adapter,ownerLabels:{},code:[] };
    for(const chain of ['l1','l2']) {
      base[chain]={...n[chain],genesis:(await f.rpc(n[chain].rpc,'eth_getBlockByNumber',['0x0',false])).hash};
      const adapter=await startComposerAdapter(n[chain].front,{chainId:n[chain].chainId,genesis:base[chain].genesis,l1ChainId:n.l1.chainId,l2ChainId:n.l2.chainId,registry:n.registry,manager:f.manager,statusRpc:n.l2.rpc});
      adapters.push(adapter);base[chain].front=adapter.url;
    }
    let c,client,enabled=false;
    async function admin(onL1,calls) {
      const chain=onL1?n.l1:n.l2,safe=onL1?f.safeL1:f.safeL2;
      const tx=buildSafeTransaction({chainId:BigInt(chain.chainId),safe,to:onL1?helperL1:helperL2,operation:1,nonce:await f.read(chain.rpc,safe,f.safeArtifact.abi,'nonce'),data:encodeFunctionData({abi:helper.abi,functionName:'multiSend',args:[packSafeCalls(calls)]})});
      const owners=await f.read(n.l1.rpc,f.safeL1,f.safeArtifact.abi,'getOwners');
      const approvals=await Promise.all([f.A,f.B].map(async o=>({owner:o.address,signature:await o.signTypedData(tx)})));
      const sig=onL1?await packEOAApprovals(tx,owners,2,approvals):await packOwnerApprovals(tx,f.adapter,owners,2,approvals);
      return f.send(n.l1,onL1?safe:safeL2Alias,encodeSafeExecution(tx,sig));
    }
    async function newPolicy(label) {
      const policyL1=await f.deploy(n.l1,policyArtifact,[f.safeL1,moduleL1,tokenL1,bridgeL1,BigInt(n.rollupId)]);
      const policy=await f.deploy(n.l2,policyArtifact,[f.safeL2,moduleL2,tokenL2,bridgeL2,BigInt(n.rollupId)]);
      for(const onL1 of [true,false]) {
        const safe=onL1?f.safeL1:f.safeL2,module=onL1?moduleL1:moduleL2,delegate=onL1?policyL1:policy;
        const calls=[{to:delegate,data:encodeFunctionData({abi:policyArtifact.abi,functionName:'connectPeer',args:[onL1?policy:policyL1]})}];
        if(!enabled) calls.push({to:safe,data:encodeFunctionData({abi:f.safeArtifact.abi,functionName:'enableModule',args:[module]})});
        calls.push({to:module,data:encodeFunctionData({abi:moduleArtifact.abi,functionName:'addDelegate',args:[delegate]})},
          {to:module,data:encodeFunctionData({abi:moduleArtifact.abi,functionName:'setAllowance',args:[delegate,onL1?tokenL1:tokenL2,100_000_000n,10,10]})});
        if(!onL1) calls.push({to:policy,data:encodeFunctionData({abi:policyArtifact.abi,functionName:'activate'})});
        await admin(onL1,calls);
      }
      enabled=true;
      const alias=await f.read(n.l1.rpc,n.registry,f.eeZAbi,'computeCrossChainProxyAddress',[policy,BigInt(n.rollupId)]);
      const peerProxyL2=await f.read(n.l2.rpc,f.manager,f.eeZAbi,'computeCrossChainProxyAddress',[policyL1,0n]);
      const payments={bridgeKind:'standard',pair:{version:1,policyL1,peerProxyL2},safeL2Alias,policy,alias,tokenL1,tokenL2,moduleL1,moduleL2,bridgeL1,bridgeL2,
        version: 2,recipient:'0x0000000000000000000000000000000000001234',decimals:6,period:600,globalLimit:'150000000',assetLabel:'Devnet USDC'};
      const bindings=[['l1',policyL1],['l2',peerProxyL2],['l1',f.safeL1],['l2',f.safeL2],['l2',f.adapter],['l1',safeL2Alias],['l1',alias],['l1',tokenL1],['l2',tokenL2],['l1',moduleL1],['l2',moduleL2],['l1',bridgeL1],['l2',bridgeL2],['l2',policy]];
      const code=await Promise.all(bindings.map(async([chain,address])=>({chain,address,hash:keccak256(await f.rpc(n[chain].rpc,'eth_getCode',[address,'latest']))})));
      c=parseTreasuryConfig({...base,instance:keccak256(toHex(policy)),payments,code});client=new TreasuryClient(c);await client.validate();
      (f.evidence.standardPolicies??=[]).push({label,policyL1,policy,alias,peerProxyL2});f.checkpoint();
    }
    // Exercise the public client used by the UI, with genuine EIP-712 approvals.
    async function build(payment,signers=[f.A,f.B]) {
      const source=payment.source??'l2',snapshot=await client.snapshot(source);
      const tx=paymentTransaction(c,payment,snapshot.nonce),approvals=[];
      for(const owner of signers) approvals.push(await client.approve({request:async({method,params})=>{
        if(method==='eth_chainId') return toHex(n[source].chainId);
        if(method==='eth_accounts') return [owner.address];
        if(method==='eth_signTypedData_v4') return owner.signTypedData(JSON.parse(params[1]));
        return f.rpc(c[source].front,method,params??[]);
      }},tx,snapshot,owner.address));
      const wallet={request:async({method,params})=>method==='eth_chainId'?toHex(n.l1.chainId):method==='eth_accounts'?[f.submitter.address]:f.rpc(c.l1.front,method,params??[])};
      const prepared=await client.prepare(wallet,tx,snapshot,approvals,payment);
      assert.equal(BigInt(prepared.request.chainId),BigInt(n.l1.chainId));
      assert.equal(prepared.request.to.toLowerCase(),(source==='l1'?f.safeL1:safeL2Alias).toLowerCase());
      return prepared;
    }
    async function payment(source,destination,amount,fromL1,extra={}) {
      return {source,destination,recipient:c.payments.recipient,epoch:String((await paymentState(client)).epoch),amount:String(amount),fromL1:String(fromL1),...extra};
    }
    async function pay(input,signers) {
      const before=await paymentState(client),asset=input.destination==='l1'?tokenL1:tokenL2;
      const beforeRecipient=await f.read(n[input.destination].rpc,asset,tokenAbi,'balanceOf',[input.recipient]);
      const {intent,request}=await build(input,signers);
      intent.hash=await f.submit(n.l1,request.to,request.data);
      const outcome=await f.until('standard bridge payment settlement',async()=>{
        const o=await client.outcome(readIntent(c,JSON.stringify(intent)));
        assert.notEqual(o.kind,'rejected',JSON.stringify(o));
        return o.kind==='settled'?o:false;
      },180);
      const after=await paymentState(client),contribution=outcome.contributions;
      const amount=BigInt(contribution.fromL1)+BigInt(contribution.fromL2);
      assert.equal(after.balanceL1,before.balanceL1-BigInt(contribution.fromL1));assert.equal(after.balanceL2,before.balanceL2-BigInt(contribution.fromL2));
      assert.equal(after.spent,before.spent+amount);
      assert.equal(await f.read(n[input.destination].rpc,asset,tokenAbi,'balanceOf',[input.recipient]),beforeRecipient+amount);
      const block=await f.rpc(n.l2.rpc,'eth_getBlockByNumber',[toHex(BigInt(outcome.block)),false]);
      await f.until('independent standard bridge replay',async()=>{
        const b=await f.rpc(n.follower,'eth_getBlockByNumber',[block.number,false]);return b?.hash===block.hash;
      });
      assert.equal(await f.read(n.follower,c.payments.policy,paymentAbi,'spent',[BigInt(input.epoch)],block.number),after.spent);
      const recovered=await client.outcome({...intent,hash:undefined});assert.equal(recovered.kind,'settled');assert.equal(recovered.hash,intent.hash);
      f.evidence.lastSuccessfulL2Block=Number(outcome.block);
      f.evidence.cases.push({source:input.source,destination:input.destination,kind:input.kind??'fixed',amount:String(amount),contributions:contribution,hash:intent.hash,safeHash:intent.safeHash,block:outcome.block,sourceBlock:outcome.sourceBlock,independentReplay:true,reloadAndLostHashRecovery:true});f.checkpoint();
      console.log(`Standard bridge ${input.source} → ${input.destination}: ${amount}, verified`);
      return {intent,outcome};
    }
    await newPolicy('independent shared budget');
    await f.until('time for the three-step budget demo',async()=>BigInt((await f.rpc(n.l1.rpc,'eth_getBlockByNumber',['latest',false])).timestamp)%600n<420n,210);
    await f.safeAdmin(f.safeL1,'addOwnerWithThreshold',[f.C.address,2n]);
    assert.equal((await client.snapshot()).owners.length,3);
    await pay(await payment('l2','l2',40_000_000n,0n),[f.B,f.C]);
    await f.safeAdmin(f.safeL1,'removeOwner',['0x0000000000000000000000000000000000000001',f.C.address,2n]);
    assert.equal((await client.snapshot()).owners.length,2);
    const split=await pay(await payment('l2','l1',110_000_000n,100_000_000n));
    assert.deepEqual(split.outcome.contributions,{fromL1:'100000000',fromL2:'10000000'});
    const before=await paymentState(client);
    assert.equal(before.allowanceL2[0]-before.allowanceL2[1],50_000_000n);
    const rejected=await build(await payment('l2','l2',1_000_000n,0n));
    const hash=await f.submit(n.l1,rejected.request.to,rejected.request.data);
    const status=await f.until('global budget rejection',async()=>{const s=await f.rpc(n.l2.rpc,'eez_getCrossChainTransaction',[hash]);return s?.lifecycle==='terminal'?s:false;});
    assert.equal(status.ownership.reason,'PoolDiscarded');assert.equal((await paymentState(client)).spent,150_000_000n);
    f.evidence.cases.push({label:'shared 150 limit rejects with 50 remaining on EEZ-X',hash,stage:'preparation',unchanged:true});f.checkpoint();
    await newPolicy('all routes and fixed payments');
    for(const source of ['l1','l2'])for(const destination of ['l1','l2'])await pay(await payment(source,destination,10_000_000n,5_000_000n));
    await pay(await payment('l2','l2',26_000_000n,0n));
    if(captured) {
      const { standardBrowser } = await import('./treasury-standard-browser.mjs');
      await standardBrowser(f,c,dirname(evidenceFile));
      const { standardRollback } = await import('./treasury-standard-rollback.mjs');
      await standardRollback(f,c,client,build,await payment('l2','l1',20_000_000n,10_000_000n),token,dirname(evidenceFile));
    }
    f.evidence.standardBridge={snapshotBlocks:captured?.chains??null,realRuntime:!!captured,policy:'paired',freshFixtureState:true,ownerAddRemove:true,liveBroadcasts:false,
      browserAndBlacklistRollback:captured?'checked':'not run: requires the explicit USDC runtime snapshot'};
    f.evidence.scenarioComplete=true;f.checkpoint();
    writeFileSync(resolve(dirname(evidenceFile),'standard-manifest.json'),JSON.stringify(c,null,2)+'\n');
  } catch(error) {f.evidence.failure=String(error.stack??error);f.checkpoint();throw error;}
  finally {await Promise.all(adapters.map(a=>a.close()));}
}
