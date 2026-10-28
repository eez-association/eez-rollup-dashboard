import { createRoot } from 'react-dom/client';
import { TreasurySourceVerification } from '../../src/components/TreasurySourceVerification';
import { L1_CHAIN, L2_CHAIN, setConfig } from '../../src/config';

export function mount(treasury: unknown = null) {
  L1_CHAIN.chainId = '0x27d8';
  L2_CHAIN.chainId = '0xdd6d9';
  setConfig({ l1Explorer: 'https://chiado.invalid', l2Explorer: 'https://eez.invalid', treasury });
  const root = createRoot(document.getElementById('root')!);
  root.render(<TreasurySourceVerification />);
  return () => root.unmount();
}
