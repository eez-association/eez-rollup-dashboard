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
