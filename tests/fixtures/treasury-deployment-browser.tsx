import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toHex } from 'viem';
import { TreasuryMainnetSetup } from '../../src/components/TreasuryMainnetSetup';
import { MainnetSetup, setupIdentity } from '../../src/lib/treasury/mainnetSetup';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO';
import { TreasuryClient } from '../../src/lib/treasury/client';
import '../../src/styles/global.css';

// Only network discovery, price quoting and the final cross-chain transport are
// fixture-controlled. Planner calldata, Safe approvals and contracts are real.
export function mount(fixture: any) {
  const w = window as any;
  MainnetSetup.prototype.validate = async () => {};
  DeploymentIO.prototype.rpc = function(chain, method, params = [], front = false) { return w.setupRpc({ chain, method, params, front }); };
  const reconcile = MainnetSetup.prototype.reconcile;
  MainnetSetup.prototype.reconcile = function(state) { return state.pending?.id === '5' ? w.reconcileMirror(state) : reconcile.call(this, state); };
  TreasuryClient.prototype.validate = function() { return w.verifyPair(this.config); };
  const control = { owner: 'A', chain: toHex(fixture.network.chains.l1.chainId), rejectNext: false, select: (_:string) => {} };
  const provider = { request: async ({ method, params }: any) => {
    if (method === 'eth_chainId') return control.chain;
    if (method === 'eth_accounts') return [fixture.owners[control.owner]];
    if (method === 'eth_sendTransaction' && control.rejectNext) {
      control.rejectNext = false; throw Object.assign(new Error('User rejected transaction'), { code: 4001 });
    }
    return w.setupWalletRequest({ owner: control.owner, chainId: control.chain, method, params });
  } };
  const key = `eez:treasury:paired-setup:${setupIdentity(fixture.network)}`;
  function Harness() {
    const [owner, selectOwner] = useState('A'), [chain, selectChain] = useState(control.chain), [complete, setComplete] = useState(false);
    control.select = next => { control.owner = next; selectOwner(next); };
    const switchTo = async (side:'l1'|'l2') => { control.chain = toHex(fixture.network.chains[side].chainId); selectChain(control.chain); return true; };
    return <main style={{ maxWidth: 1100, margin:'24px auto', padding:20 }}>{complete ? <h2>Shared treasury ready</h2> : <TreasuryMainnetSetup
      target={fixture.target} network={fixture.network} wallet={{ address:fixture.owners[owner],chainId:chain,provider,connect:async()=>{},walletOptions:[],switchToL1:()=>switchTo('l1'),switchToL2:()=>switchTo('l2') } as any}
      onComplete={manifest => { w.completedManifest = manifest; w.completedState = JSON.parse(localStorage.getItem(key)!); setComplete(true); }} />}</main>;
  }
  w.setupControls = control;
  createRoot(document.getElementById('root')!).render(<Harness />);
}
