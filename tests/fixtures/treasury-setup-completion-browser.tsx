// UI lifecycle fixture. Contract verification is controlled here; deployment
// tests separately exercise the real receipt, code and allowance checks.
import { DeploymentIO } from "../../src/lib/treasury/deploymentIO";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TreasuryMainnetSetup } from "../../src/components/TreasuryMainnetSetup";
import { MainnetSetup, readMainnetSetup, mainnetSetupKey, mainnetManifestKey } from "../../src/lib/treasury/mainnetSetup";
import "../../src/styles/global.css";

export function mount(fixture: any) {
  const control = (window as any).completionTest = { checks: 0, walletCalls: 0, callbacks: 0, locks: [], confirm: false,
    failure: fixture.failure, release: undefined, unmount: undefined };
  DeploymentIO.prototype.rpc = async (_chain, method, params = []) => {
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000' as any;
    if (method === 'eth_getTransactionReceipt') { const tx = fixture.state.completed.find((x: any) => x.hash === params[0]); return tx ? {status:'0x1',blockNumber:tx.number,blockHash:tx.blockHash} : null; }
    const tx = fixture.state.completed.find((x: any) => x.number === params[0]);
    return (tx ? {number:tx.number,hash:tx.blockHash,timestamp:'0x1'} : {number:'0x0',hash:fixture.state.salt,timestamp:'0x1'}) as any;
  };
  MainnetSetup.prototype.reconcile = async function (state) {
    if (!control.confirm || !state.pending) return state;
    return { ...fixture.state, pending: undefined };
  };
  MainnetSetup.prototype.manifest = async function (state) {
    control.checks++;
    control.locks.push((await navigator.locks.query()).held?.some(lock => lock.name === mainnetSetupKey));
    if (fixture.deferred) await new Promise(resolve => { control.release = resolve; });
    if (control.failure) throw new Error(control.failure);
    if (state.pending || state.completed.length !== 6) throw new Error("Incomplete fixture");
    return fixture.manifest;
  };
  const wallet: any = { address: fixture.wallet, provider: { request() { control.walletCalls++; throw new Error("Unexpected wallet request"); } },
    walletOptions: [], switchToL1: async () => false, switchToL2: async () => false };
  function Harness() {
    const [, setRevision] = useState(0);
    const manifest = localStorage.getItem(mainnetManifestKey);
    return <main style={{ maxWidth: 1000, margin: "30px auto", padding: 20 }}>{manifest
      ? <h2>Shared treasury</h2>
      : <TreasuryMainnetSetup wallet={wallet} target={fixture.target} onComplete={() => {
        if (!readMainnetSetup(localStorage.getItem(mainnetSetupKey)) || !localStorage.getItem(mainnetManifestKey)) throw new Error("Missing verified treasury");
        control.callbacks++; setRevision(value => value + 1);
      }} />}</main>;
  }
  const root = createRoot(document.getElementById("root")!);
  control.unmount = () => root.unmount();
  root.render(<Harness />);
}
