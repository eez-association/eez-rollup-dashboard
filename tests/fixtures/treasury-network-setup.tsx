import React from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryNetworkSetup } from '../../src/components/TreasuryNetworkSetup';
import { toHex } from 'viem';
import '../../src/styles/global.css';
export function mount(dashboard: any, owner: string, token = "") {
  const w = window as any;
  const target = { l1: { rpc: `${location.origin}/l1`, front: `${location.origin}/l1`, explorer: 'https://example.com' }, l2: { rpc: `${location.origin}/l2`, front: `${location.origin}/l2`, explorer: 'https://example.com' }, fees: { l1: '100000000000000000', l2: '100000000000000000' } };
  const provider = { request: async ({method,params}: any) => {
    if(method === 'eth_accounts')return [owner];
    if(method === 'eth_chainId')return toHex(BigInt(dashboard.l1ChainId));
    if(method === 'eth_sendTransaction') return w.walletSend(params[0]);
    return (await (await fetch(target.l1.rpc, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()).result;
  }};
  const wallet = { address: owner, chainId: toHex(BigInt(dashboard.l1ChainId)), provider, walletOptions: [], connect:async()=>{}, switchToL1:async()=>true,switchToL2:async()=>true };
  createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1100,margin:'32px auto',padding:20}}><TreasuryNetworkSetup dashboard={dashboard} target={target} wallet={wallet as any} token={token} feesEnabled /></main>);
}
