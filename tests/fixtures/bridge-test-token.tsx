import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BridgeTestToken} from '../../src/components/BridgeTestToken';
import {L1_CHAIN,L2_CHAIN,setConfig} from '../../src/config';
import '../../src/styles/global.css';

export function mount() {
  const w=window as any;
  L1_CHAIN.chainId='0x27d8';L2_CHAIN.chainId='0xaab21';
  setConfig({l1Rpc:location.origin+'/l1',l2Rpc:location.origin+'/l2',l1Bridge:'0x'+'11'.repeat(20),l2Bridge:'0x'+'22'.repeat(20),l1NetworkName:'Chiado',rollupName:'EEZ-X Testnet'});
  const listeners=new Map<string,Set<Function>>();
  const control=w.tokenFixture={account:'0x'+'12'.repeat(20),chain:'0x27d8',nonce:'0x0',calls:[],selection:null,mode:'success',changeAccount:(_:string)=>{},reverse:()=>{}};
  const provider={on:(event:string,fn:Function)=>{const set=listeners.get(event)??new Set();set.add(fn);listeners.set(event,set);},removeListener:(event:string,fn:Function)=>listeners.get(event)?.delete(fn),
    request:async({method,params}:any)=>{
      control.calls.push({method,params});
      if(method==='eth_accounts')return [control.account];
      if(method==='eth_chainId')return control.chain;
      if(method==='eth_getTransactionCount')return control.nonce;
      if(method==='eth_sendTransaction'){
        if(control.mode==='reject')throw Object.assign(new Error('Rejected'),{code:4001});
        if(control.mode==='rpc-error')throw {code:-32602,message:'Provider rejected deployment parameters'};
        const hash=await w.sendTestToken(params[0]);
        return control.mode==='unknown'?null:hash;
      }
      throw new Error('Unexpected wallet operation: '+method);
    }};
  function App(){
    const [account,setAccount]=useState(control.account),[reverse,setReverse]=useState(false);
    control.changeAccount=(next:string)=>{control.account=next;listeners.get('accountsChanged')?.forEach(fn=>fn([next]));setAccount(next);};
    control.reverse=()=>setReverse((value:boolean)=>!value);
    const wallet={address:account,provider,switchToL1:async()=>{control.chain='0x27d8';return true;},switchToL2:async()=>{control.chain='0xaab21';return true;}};
    return <main style={{maxWidth:430,margin:'20px auto',padding:16}}><BridgeTestToken wallet={wallet as any} direction={reverse?'l2-to-l1':'l1-to-l2'} disabled={false} /></main>;
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
