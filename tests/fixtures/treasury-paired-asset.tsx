import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryConnected } from '../../src/components/TreasuryConnected';
import { TreasuryTestnet } from '../../src/components/TreasuryTestnet';
import { TreasurySafeFaucet } from '../../src/components/TreasurySafeFaucet';
import { TreasuryFundingSplit } from '../../src/components/TreasuryFundingSplit';
import { useTreasuryFaucet } from '../../src/hooks/useTreasuryFaucet';
import { TestnetAsset } from '../../src/lib/treasury/testnetAsset';
import { loadTreasuryArtifacts } from '../../src/lib/treasury/release';
import { MainnetSetup } from '../../src/lib/treasury/mainnetSetup';
import networkDefault from '../../src/lib/treasury/mainnet-network.json';
import '../../src/styles/global.css';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
export async function mount(mode = 'test') {
  const w = window as any, sender = a(3), release = await loadTreasuryArtifacts();
  w.confirmFixture = false; w.rejectNext = false; w.uncertainNext = false; w.refreshes = 0;
  // UI-only fixture: genuine packaged claim calldata, controlled wallet and receipts.
  TestnetAsset.prototype.validate = async () => {};
  TestnetAsset.prototype.validateToken = async () => {};
  TestnetAsset.prototype.rpc = async (_chain, method) => method === 'eth_getTransactionCount' ? w.readWalletNonce() : (mode === 'ordinary-token' ? '0x6000' : release.contracts.TestUSDC.runtime) as any;
  TestnetAsset.prototype.read = async () => a(31) as any;
  TestnetAsset.prototype.wallet = async () => sender as any;
  TestnetAsset.prototype.prepare = async function(kind, token, recipient) {
    if (kind === 'deploy') throw new Error('Token deployment is not part of Safe setup');
    const data = this.data(kind, recipient), nonce = await this.rpc('l1', 'eth_getTransactionCount', [sender, 'pending']);
    return { pending: { id: kind, kind, chain: 'l1', sender, nonce, data, recipient, build: release.build!, l2StartBlock: '0x1', token, to: token },
      request: { from: sender, to: token!, nonce, data, value: '0x0', chainId: '0x27d8' } } as any;
  };
  TestnetAsset.prototype.reconcile = async state => !state.pending || !w.confirmFixture ? state : {
    ...state, pending: undefined, last: { hash: state.pending.hash!, destination: state.pending.kind as 'l1' | 'l2' },
  };
  const wallet = { address: sender, chainId: '0x27d8', provider: { request: async ({ method, params }: any) => {
    if (method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${method}`);
    if (w.rejectNext) { w.rejectNext = false; throw Object.assign(new Error('User rejected transaction'), { code: 4001 }); }
    if (w.uncertainNext) { w.uncertainNext = false; throw new Error('Wallet response lost'); }
    return w.recordWalletSend(params[0]);
  } }, switchToL1: async () => { w.switched = 'l1'; return true; }, switchToL2: async () => true, connect: async () => {}, walletOptions: [] };
  const target = { l1: { rpc: location.origin, front: location.origin, explorer: location.origin },
    l2: { rpc: location.origin, front: location.origin, explorer: location.origin }, fees: { l1: '100', l2: '100' } };
  const deployment = { version: 1, instance: a(99), environment: mode === 'real' ? 'ethereum-mainnet' : 'dashboard-testnet',
    safeL1: a(10), safeL2: a(11), l1: target.l1, l2: target.l2, fees: { maxTotalWei: '100', l1MaxTotalWei: '100' },
    payments: { pair: { version: 1 }, bridgeKind: 'standard', tokenL1: a(30), tokenL2: a(31), bridgeL1: a(1), bridgeL2: a(2) } } as any;
  function Harness() {
    const faucet = useTreasuryFaucet(deployment, wallet as any, async () => { w.refreshes++; });
    const [fromL1, setFromL1] = useState(20_000_000n), [review, setReview] = useState(false);
    return <main style={{ maxWidth: 900, margin: '30px auto', padding: 20 }}>
      {(['l1', 'l2'] as const).map(chain => <section key={chain} aria-label={`${chain} Safe`}><h2>{chain} Safe</h2><code>{deployment[chain === 'l1' ? 'safeL1' : 'safeL2']}</code>
        <TreasurySafeFaucet faucet={faucet} chain={chain} l1Name="Chiado" disabled={review} /></section>)}
      {faucet.error && <p role="alert">{faucet.error}</p>}
      <fieldset disabled={review}><TreasuryFundingSplit l1Name="Chiado" split={{ amount: 40_000_000n, fromL1, fromL2: 40_000_000n - fromL1, error: '' }} onChange={setFromL1} onReset={() => setFromL1(20_000_000n)} /></fieldset>
      <output data-testid="l1-contribution">{String(fromL1)}</output><button onClick={() => setReview(!review)}>{review ? 'Edit split' : 'Review split'}</button>
    </main>;
  }
  if (mode === 'setup' || mode === 'unconfigured') {
    const network = { ...networkDefault, testnet: true, chains: { ...networkDefault.chains, l1: { ...networkDefault.chains.l1, chainId: 10200 } } };
    TestnetAsset.prototype.network = async () => network;
    MainnetSetup.prototype.configure = async () => { throw new Error('Fixture stopped before deployment'); };
    createRoot(document.getElementById('root')!).render(<TreasuryTestnet wallet={wallet as any} target={target} bridgeL1={a(1)} bridgeL2={a(2)} token={mode === 'setup' ? a(30) : ''} />);
  } else createRoot(document.getElementById('root')!).render(<Harness />);
}
export function mountLegacy() {
  const container = document.createElement('div'); document.body.append(container);
  createRoot(container).render(<TreasuryConnected deployment={{ payments: { policy: a(9) } } as any} wallet={{} as any} payments />);
}
