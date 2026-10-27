import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryPaymentHistory } from '../../src/components/TreasuryPaymentHistory';
import '../../src/styles/global.css';

export function mount(initial: any[]) {
  function Harness() {
    const [entries, setEntries] = useState(initial);
    (window as any).setHistoryEntries = setEntries;
    const history = { entries, observations: {}, checking: false, error: '', refresh: async () => {}, settlementFor: () => undefined };
    return <main style={{ maxWidth: 1100, margin: '24px auto', padding: 18 }}>
      <TreasuryPaymentHistory history={history as any} deployment={{ l1: { chainId: 10200, explorer: 'https://l1.example' }, l2: { chainId: 699069, explorer: 'https://l2.example' } } as any} />
    </main>;
  }
  createRoot(document.getElementById('root')!).render(<Harness />);
}

export async function mountLoading(fixture: any) {
  const { useTreasuryHistory } = await import('../../src/hooks/useTreasuryHistory');
  const { PaymentHistoryStore } = await import('../../src/lib/treasury/history');
  const { toHex } = await import('viem');
  const { setConfig } = await import('../../src/config');
  setConfig({ l1Explorer: 'https://l1.example', l2Explorer: 'https://l2.example' });
  const w = window as any, h = (n: number) => toHex(n, { size: 32 });
  localStorage.clear();
  const store = new PaymentHistoryStore(fixture.config, localStorage);
  for (const intent of fixture.intents) store.remember(intent);
  const control = w.loadingHistory = { reads: [] as number[], waiting: {} as any, history: null as any, failValidation: false,
    holdEvidence: 0, releaseEvidence: null as any };
  const outcome = (n: number) => ({ kind: 'settled', hash: h(n), block: String(n), detail: 'Verified payment',
    execution: { l2: h(n) }, contributions: { fromL1: '0', fromL2: String(n * 1000000) } });
  w.historyOutcome = outcome;
  const client = { config: fixture.config,
    validate: async () => { if (control.failValidation) throw Error('Network verification unavailable'); },
    outcome: async (intent: any) => {
      const n = Number(intent.nonce); control.reads.push(n);
      return new Promise((resolve, reject) => { control.waiting[n] = { resolve: () => { delete control.waiting[n]; resolve(outcome(n)); }, reject: () => { delete control.waiting[n]; reject(Error('Receipt RPC unavailable')); } }; });
    },
    rpc: async (url: string, method: string, params: string[]) => {
      if (method === 'eth_getTransactionReceipt') {
        const n = Number(BigInt(params[0]!));
        return url === fixture.config.l1.rpc
          ? { status: '0x1', transactionHash: h(n), blockNumber: toHex(n + 200), blockHash: h(n + 100) }
          : { status: '0x1', blockNumber: toHex(n), blockHash: h(n + 400) };
      }
      if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0]!));
        return { number: toHex(n), hash: h(url === fixture.config.l1.rpc ? n - 100 : n + 400) };
      }
      if (method === 'eez_getSettlementByL2Block') {
        const n = Number(BigInt(params[0]!)) - 400;
        if (control.holdEvidence === n) await new Promise(resolve => { control.releaseEvidence = resolve; });
        return { canonicalL2: true, l1TransactionHash: h(n + 100), l1BlockHash: h(n + 200), l1BlockNumber: toHex(n + 300), l2Blocks: [{ number: toHex(n), hash: h(n + 400) }] };
      }
      throw Error('Unexpected history RPC ' + method);
    },
  };
  function Harness() {
    const history = useTreasuryHistory(client as any, null, true); control.history = history;
    return <main style={{ maxWidth: 1100, margin: '24px auto', padding: 18 }}><TreasuryPaymentHistory history={history} deployment={fixture.config} /></main>;
  }
  createRoot(document.getElementById('root')!).render(<Harness />);
}
