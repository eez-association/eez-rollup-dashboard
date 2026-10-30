import { createRoot } from 'react-dom/client';
import { TreasuryMainnetNetwork } from '../../src/components/TreasuryMainnetNetwork';
import { config, setConfig, L1_CHAIN, L2_CHAIN } from '../../src/config';
import { MainnetSetup, selectMainnetSetupNetwork } from '../../src/lib/treasury/mainnetSetup';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO';
import network from '../../src/lib/treasury/rollupx-mainnet-network.json';
import '../../src/styles/global.css';

export function mount() {
  const control = (window as any).rollupxTest = { error: 'USDC has not been provisioned on RollupX.', checks: 0, walletCalls: 0, selected: 0 };
  L1_CHAIN.chainId = '0x1'; L2_CHAIN.chainId = '0xaa29f';
  setConfig({ treasury: null, rollupsAddress: network.registry, ccmL2Address: network.manager,
    l1Bridge: network.contracts.bridgeL1.address, l2Bridge: network.contracts.bridgeL2.address,
    l1FeesEnabled: true, l2FeesEnabled: true, l1Rpc: '/rpc/l1', l2Rpc: '/rpc/l2', l1ProxyRpc: '/composer/l1', l2ProxyRpc: '/composer/l2' });
  config.rollupId = '2';
  MainnetSetup.prototype.validate = async function () {
    control.checks++; control.selected = this.network.chains.l2.chainId;
    if (control.error) throw new Error(control.error);
  };
  MainnetSetup.prototype.configure = async function () { throw new Error('Fixture stopped before any deployment'); };
  DeploymentIO.prototype.rpc = async (_chain, method) => {
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000' as any;
    throw new Error('Unexpected fixture RPC: ' + method);
  };
  const wallet: any = { address: '0x0000000000000000000000000000000000000044', chainId: '0x1', walletOptions: [],
    provider: { request() { control.walletCalls++; throw new Error('No wallet requests expected'); } } };
  // Retained RollupX setups use this pinned provisioning gate. Fresh dashboard
  // discovery is exercised separately by treasury-network-setup-browser.mjs.
  const selected = selectMainnetSetupNetwork(L1_CHAIN.chainId, L2_CHAIN.chainId, config.rollupsAddress,
    config.ccmL2Address, config.l1Bridge, config.l2Bridge);
  if (!selected) throw new Error('RollupX fixture did not select its pinned setup network');
  const target = { l1: { rpc: config.l1Rpc, front: config.l1ProxyRpc, explorer: config.l1Explorer },
    l2: { rpc: config.l2Rpc, front: config.l2ProxyRpc, explorer: config.l2Explorer },
    fees: { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei } };
  createRoot(document.getElementById('root')!).render(<TreasuryMainnetNetwork network={selected} target={target} wallet={wallet} onComplete={()=>{}} />);
}
