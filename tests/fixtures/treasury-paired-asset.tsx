import React from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryConnected } from '../../src/components/TreasuryConnected';
import { PairedTestnetAsset } from '../../src/components/TreasuryTestnet';
import { TestnetAsset } from '../../src/lib/treasury/testnetAsset';
import { loadTreasuryArtifacts } from '../../src/lib/treasury/release';
import '../../src/styles/global.css';

export async function mount() {
  const w = window as any, sender = '0x0000000000000000000000000000000000000003';
  const release = await loadTreasuryArtifacts();
  // UI-only fixture: actual packaged calldata; network confirmation is controlled.
  TestnetAsset.prototype.validate = async () => {};
  TestnetAsset.prototype.validateToken = async () => {};
  TestnetAsset.prototype.wallet = async () => sender;
  TestnetAsset.prototype.prepare = async function(kind, token, recipient) {
    const data = this.data(kind, recipient);
    return { pending: { id: kind, kind, chain: 'l1', sender, nonce: '0x0', data, recipient, build: release.build!, l2StartBlock: '0x1',
      ...(kind === 'deploy' ? {} : { token, to: token }) }, request: { from: sender, data, value: '0x0', chainId: '0x27d8', ...(token ? { to: token } : {}) } };
  };
  TestnetAsset.prototype.reconcile = async state => {
    if (!state.pending || !w.confirmFixture) return state;
    return { ...state, token: '0x0000000000000000000000000000000000000030', pending: undefined,
      ...(state.pending.kind === 'deploy' ? {} : { last: { hash: state.pending.hash!, destination: state.pending.kind } }) };
  };
  const wallet = { address: sender, chainId: '0x27d8', provider: { request: ({ method, params }: any) => {
    if (method === 'eth_sendTransaction') return w.recordWalletSend(params[0]);
    throw new Error(`Unexpected wallet method ${method}`);
  } }, switchToL1: async () => true, switchToL2: async () => true, connect: async () => {}, walletOptions: [] };
  const endpoint = location.origin;
  createRoot(document.getElementById('root')!).render(<PairedTestnetAsset wallet={wallet as any}
    target={{ l1: { rpc: endpoint, front: endpoint, explorer: endpoint }, l2: { rpc: endpoint, front: endpoint, explorer: endpoint }, fees: { l1: '100', l2: '100' } }}
    bridgeL1="0x0000000000000000000000000000000000000001" bridgeL2="0x0000000000000000000000000000000000000002" onReady={() => {}} />);
}

export function mountLegacy() {
  const container = document.createElement('div'); document.body.append(container);
  createRoot(container).render(<TreasuryConnected deployment={{ payments: { policy: '0x0000000000000000000000000000000000000009' } } as any} wallet={{} as any} payments />);
}
