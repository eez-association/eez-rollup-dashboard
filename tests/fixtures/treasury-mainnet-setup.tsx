import React, { useState } from 'react';
import { getAddress, keccak256, toHex } from 'viem';
import { createRoot } from 'react-dom/client';
import { TreasuryMainnetSetup } from '../../src/components/TreasuryMainnetSetup';
import { config, setConfig, L1_CHAIN, L2_CHAIN } from '../../src/config';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO';
import { MainnetSetup, loadMainnetManifest, setupIdentity } from '../../src/lib/treasury/mainnetSetup';
import { TreasurySetupRequired } from '../../src/lib/treasury/existingTreasury';
import network from '../../src/lib/treasury/mainnet-network.json';
import currentBuild from '../../src/lib/treasury/current-build.json';
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
  MainnetSetup.prototype.configure=async function(deployer,safeL1,safeL2,_progress,options){w.selection={deployer,safeL1,safeL2,options};throw Error('Fixture stopped before network validation');};
  const control=w.connection={mode:'selection',walletCalls:0,connects:0,checks:0,address:'',select:(_:string)=>{},release:null as any,unmount:()=>{}};
  const a=(n:number)=>getAddress(toHex(n,{size:20}));
  MainnetSetup.prototype.connect=async function(deployer,safeL1,safeL2){
    control.connects++;w.selection={deployer,safeL1,safeL2,connect:true};
    if(control.mode==='selection')throw Error('Fixture stopped before network validation');
    if(control.mode==='missing')throw new TreasurySetupRequired('Treasury setup is still required.');
    if(control.mode==='error')throw Error('RPC unavailable');
    if(control.mode==='deferred')await new Promise(resolve=>{control.release=resolve;});
    return {version:4,build:currentBuild.build,identity:setupIdentity(network),salt:toHex(1n,{size:32}),deployer,code:[],completed:[],
      addresses:{safeL1,safeL2,singletonL1:a(102),singletonL2:a(103),adapter:a(104),policyL1:a(105),policy:a(106),moduleL1:a(107),moduleL2:a(108),alias:a(109),safeL2Alias:a(110)}};
  };
  MainnetSetup.prototype.manifest=async function(state){
    control.checks++; if(control.mode==='invalid')throw Error('Paired Safe allowance configuration changed');
    const {safeL1,safeL2}=state.addresses;
    return {version:1,environment:'isolated-devnet',instance:keccak256(toHex(`${state.salt}:${safeL1}:${safeL2}`)),
      l1:{chainId:1337,rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1',genesis:state.salt},l2:{chainId:1338,rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2',genesis:state.salt},
      safeL1,safeL2,adapter:a(104),registry:a(120),manager:a(121),ownerLabels:{},
      code:['l1','l2'].flatMap(chain=>Array.from({length:40},(_,i)=>({chain,address:a(i+100),hash:state.salt}))),
      payments:{version:2,bridgeKind:'standard',policy:a(106),alias:a(109),tokenL1:a(112),tokenL2:a(113),pair:{version:2,policyL1:a(105),peerProxyL2:a(114)},safeL2Alias:a(110),moduleL1:a(107),moduleL2:a(108),bridgeL1:a(115),bridgeL2:a(116),recipient:state.deployer,decimals:6,period:600,globalLimit:'150000000',assetLabel:'Devnet USDC'}};
  };
  const wallet={address:a(200),chainId:'0x1',provider:{request:async()=>{control.walletCalls++;throw Error('Unexpected wallet prompt');}},walletOptions:[],connect:async()=>{},switchToL1:async()=>true,switchToL2:async()=>true};
  // Test the Safe chooser independently of the dashboard's infrastructure/token
  // discovery, which has its own network-setup browser regression.
  const target = { l1: { rpc: config.l1Rpc, front: config.l1ProxyRpc, explorer: config.l1Explorer },
    l2: { rpc: config.l2Rpc, front: config.l2ProxyRpc, explorer: config.l2Explorer },
    fees: { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei } };
  function Harness(){
    const [,refresh]=useState(0),[address,select]=useState(wallet.address);control.select=select;control.address=address;
    return <main style={{maxWidth:1200,margin:'32px auto',padding:20}}>{loadMainnetManifest(localStorage,network)
      ? <h2>Treasury controls</h2>
      : <TreasuryMainnetSetup network={network} target={target} wallet={{...wallet,address} as any} onComplete={()=>refresh(x=>x+1)}/>}</main>;
  }
  const root=createRoot(document.getElementById('root')!);control.unmount=()=>root.unmount();root.render(<Harness/>);
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
