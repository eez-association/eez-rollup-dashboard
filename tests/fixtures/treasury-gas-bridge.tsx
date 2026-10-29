import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO';
import { TestnetAsset } from '../../src/lib/treasury/testnetAsset';
import { MainnetSetup } from '../../src/lib/treasury/mainnetSetup';
import '../../src/styles/global.css';

/** Full App navigation with a saved setup and read-only mocked network checks. */
export function mount(fixture: any) {
  const control = (window as any).gasBridgeTest;
  TestnetAsset.prototype.network = async () => fixture.network;
  if (fixture.network.assetProvisioning) MainnetSetup.prototype.validate = async () => {};
  DeploymentIO.prototype.rpc = async (chain, method, params = []) => {
    if (method === 'eth_getBalance') return chain === 'l2' ? control.l2Gas : '0xde0b6b3a7640000';
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x1', blockHash: fixture.state.completed[0].blockHash };
    if (method === 'eth_getBlockByNumber') return { number: params[0] === '0x1' ? '0x1' : '0x10', hash: fixture.state.completed[0].blockHash, timestamp: '0x65000000' };
    throw Error('Unexpected setup read: ' + method);
  };
  createRoot(document.getElementById('root')!).render(<App />);
}
