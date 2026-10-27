import React from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryDemo } from '../../src/components/TreasuryDemo';
import { setConfig, L1_CHAIN, L2_CHAIN } from '../../src/config';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO';
import { MainnetSetup } from '../../src/lib/treasury/mainnetSetup';
import network from '../../src/lib/treasury/mainnet-network.json';
import '../../src/styles/global.css';

export function mount() {
  const w = window as any;
  DeploymentIO.prototype.rpc = async () => '0xde0b6b3a7640000' as any;
  L1_CHAIN.chainId='0x1'; L2_CHAIN.chainId='0xaa29e';
  setConfig({rollupsAddress:network.registry,ccmL2Address:network.manager,l1Bridge:network.contracts.bridgeL1.address,l2Bridge:network.contracts.bridgeL2.address,
    l1Rpc:'https://mainnet.example/rpc/l1',l2Rpc:'https://mainnet.example/rpc/l2',l1ProxyRpc:'https://mainnet.example/composer/l1',l2ProxyRpc:'https://mainnet.example/composer/l2',
    l1Explorer:'https://etherscan.io',l2Explorer:'https://explorer.example',l1FeesEnabled:true,l2FeesEnabled:true,treasury:null});
  // Form-only fixture: selection is recorded before the real planner would make
  // its on-chain checks. It does not manufacture a deployment or open a wallet.
  MainnetSetup.prototype.configure=async function(deployer,safeL1,safeL2){w.selection={deployer,safeL1,safeL2};throw Error('Fixture stopped before network validation');};
  const wallet={address:'0x00000000000000000000000000000000000000C8',chainId:'0x1',provider:{request:async()=>{throw Error('Unexpected wallet prompt');}},walletOptions:[],connect:async()=>{},switchToL1:async()=>true,switchToL2:async()=>true};
  createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1200,margin:'32px auto',padding:20}}><TreasuryDemo ready wallet={wallet as any}/></main>);
}

export async function mountUX(fixture: any) {
  const { useState } = await import('react');
  const { TreasuryMainnetSetup } = await import('../../src/components/TreasuryMainnetSetup');
  const { mainnetSetupKey } = await import('../../src/lib/treasury/mainnetSetup');
  const w = window as any, control = w.setupUX = { walletCalls: 0, select: (_: string) => {}, zeroGas: false, reject: true, release: null as any };
  DeploymentIO.prototype.rpc = async (_chain, method, params = []) => {
    if (method === 'eth_getBalance') return control.zeroGas ? '0x0' : '0xde0b6b3a7640000';
    if (method === 'eth_getTransactionReceipt') { const tx = fixture.state.completed.find((x: any) => x.hash === params[0]); return tx ? { status:'0x1',blockNumber:tx.number,blockHash:tx.blockHash } : null; }
    const tx = fixture.state.completed.find((x: any) => x.number === params[0]);
    return tx ? { number:tx.number,hash:tx.blockHash,timestamp:'0x65000000' } : {number:'0x0',hash:fixture.state.salt,timestamp:'0x65000000'};
  };
  MainnetSetup.prototype.configure = async (_deployer, safeL1, _safeL2, progress) => {
    progress?.('Checking network bindings and Safe ownership…');
    if (fixture.holdConfigure) await new Promise(resolve => { (control as any).releaseConfigure = resolve; });
    return {...fixture.state,completed:[],addresses:{...fixture.state.addresses,safeL1}};
  };
  MainnetSetup.prototype.review = async state => ({step:state.completed.length,chain:state.completed.length===5?'l2':'l1',nonce:'7',owners:fixture.owners,threshold:2,fingerprint:'fixture',hash:fixture.state.salt,approvals:[]});
  MainnetSetup.prototype.approve = async (_state, provider) => ({owner:(await provider.request({method:'eth_accounts'}))[0],signature:'0x1234'});
  MainnetSetup.prototype.prepare = async (state, _provider, progress) => {
    progress?.('Quoting cross-chain execution fees with Composer…');
    await new Promise(resolve => { control.release = resolve; });
    return {pending:{id:String(state.completed.length),chain:'l1',sender:fixture.owners[0],nonce:'0x0',data:'0x1234',outputs:[]},request:{from:fixture.owners[0],data:'0x1234'}};
  };
  MainnetSetup.prototype.reconcile = async state => state;
  let current = fixture.disconnected ? undefined : fixture.owners[0];
  const provider = {request:async({method}:any)=>{
    if(method==='eth_accounts')return[current];
    control.walletCalls++;
    if(control.reject)throw Object.assign(Error('User rejected transaction'),{code:4001});
    return undefined;
  }};
  if (fixture.saved) localStorage.setItem(mainnetSetupKey,JSON.stringify(fixture.state));
  function Harness(){
    const [address,setAddress]=useState(current);control.select=(next:string)=>{current=next;setAddress(next);};
    return <main style={{maxWidth:1100,margin:'24px auto',padding:20}}><TreasuryMainnetSetup target={fixture.target} wallet={{address,chainId:'0x1',provider:address?provider:null,
      walletOptions:[{id:'fixture',name:'MetaMask'}],connect:async()=>control.select(fixture.owners[0]),switchToL1:async()=>true,switchToL2:async()=>true} as any} onComplete={()=>{}} /></main>;
  }
  const root = createRoot(document.getElementById('root')!);
  (control as any).unmount = () => root.unmount();
  root.render(<Harness/>);
}
