import { transferAbi } from "../../src/lib/treasury/transfers";
// Controlled RPC/state responses exercise the real owner snapshot, receipt
// checks and React lifecycle. This fixture never connects to a chain or wallet.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { decodeFunctionData, encodeFunctionResult, toHex } from "viem";
import { TreasuryTestnet } from "../../src/components/TreasuryTestnet";
import { TestnetAsset } from "../../src/lib/treasury/testnetAsset";
import { TreasuryConnected } from "../../src/components/TreasuryConnected";
import { TreasuryClient } from "../../src/lib/treasury/client";
import { allowanceAbi, paymentAbi, tokenAbi } from "../../src/lib/treasury/payments";
import "../../src/styles/global.css";

export function mount(f: any) {
  const control = (window as any).ownersTest = {
    owners: [...f.owners], threshold: 1, timestamp: "0x3a98", receipt: "pending", unavailable: false,
    balanceFailure: !!f.balanceFailure, holdNext: false, release: undefined as undefined | (() => void),
    reads: 0, capacityTags: [] as string[], approvals: 0, walletCalls: [] as string[], unmount: () => {},
    chainId: f.chainId ?? toHex(f.config.l2.chainId), address: f.disconnected ? undefined : f.owners[0],
    switchMode: "accept", switches: [] as string[], signatures: [] as any[], prepared: [] as any[],
    releaseSwitch: undefined as undefined | (() => void), selectWallet: undefined as any,
  };
  const snapshot = TreasuryClient.prototype.snapshot;
  const validationReady = f.holdValidation ? new Promise<void>(resolve => { (control as any).releaseValidation = resolve; }) : Promise.resolve();
  TreasuryClient.prototype.validate = async () => { await validationReady; if ((control as any).validationFailure) throw new Error("Controlled validation failure"); };
  if (f.useTestnet) TestnetAsset.prototype.network = async () => {
    if (f.holdNetwork) await new Promise<void>(resolve => { (control as any).releaseNetwork = resolve; });
    if ((control as any).networkFailure) throw new Error("Controlled network failure");
    return (control as any).networkResult ?? f.network;
  };
  TreasuryClient.prototype.snapshot = async function (source) {
    const next = await snapshot.call(this, source);
    control.reads++;
    if (control.holdNext) {
      control.holdNext = false;
      await new Promise<void>(resolve => { control.release = resolve; });
    }
    return next;
  };
  TreasuryClient.prototype.read = async function (_url, _address, _abi, name) {
    if (control.unavailable) throw new Error("Controlled owner read failure");
    const values: any = { getOwners: [...control.owners], getThreshold: BigInt(control.threshold), nonce: 4n, value: 42n };
    if (!(name in values)) throw new Error(`Unexpected contract read: ${name}`);
    return values[name];
  };
  TreasuryClient.prototype.rpc = async function (url, method, params: any = []) {
    if (control.unavailable) throw new Error("Controlled owner read failure");
    if (url === f.config.l2.rpc && method === "eth_getBlockByNumber" && ["latest", "safe"].includes(params[0])) control.capacityTags.push(params[0]);
    if (method === "eth_getTransactionReceipt") return (control.receipt === "pending" ? null : f.receipt) as any;
    if (method === "eth_getTransactionByHash") return { from: f.pending.sender, to: f.config.safeL1, input: f.pending.data, nonce: f.pending.sourceNonce } as any;
    if (method === "eth_getBlockByNumber") return { number: "0x106", hash: control.receipt === "orphan" ? f.orphanHash : f.blockHash, timestamp: control.timestamp } as any;
    if (method === "eth_getCode" && f.helperRuntime) return f.helperRuntime;
    if (method === "eth_call") {
      if (control.balanceFailure) throw new Error("Controlled balance read failure");
      const abi = [...tokenAbi, ...allowanceAbi, ...paymentAbi, ...transferAbi];
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      const result = functionName === "treasuryRollupId" ? 1n : functionName === "balanceOf" ? url === f.config.l1.rpc ? BigInt((control as any).balanceL1 ?? 300_000_000) : BigInt((control as any).balanceL2 ?? 150_000_000)
        : functionName === "getTokenAllowance" ? [100_000_000n, 0n, 10n, 250n, 0n] : 0n;
      return encodeFunctionResult({ abi, functionName, result } as any) as any;
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };
  TreasuryClient.prototype.approve = async function (provider, transaction, _snapshot, owner) {
    if (BigInt(await provider.request({ method: "eth_chainId" }) as string) !== transaction.domain.chainId)
      throw new Error("Fixture forbids signing on the wrong network");
    control.approvals++;
    control.signatures.push({ chainId: String(transaction.domain.chainId), safe: transaction.domain.verifyingContract, data: transaction.message.data, owner });
    return { owner, signature: `0x${"11".repeat(65)}` } as any;
  };
  if (f.networkFlow) {
    TreasuryClient.prototype.prepare = async function (provider, transaction) {
      if (BigInt(await provider.request({ method: "eth_chainId" }) as string) !== transaction.domain.chainId)
        throw new Error("Fixture forbids submission on the wrong network");
      control.prepared.push({ chainId: String(transaction.domain.chainId), safe: transaction.domain.verifyingContract });
      throw new Error("Fixture reached submission preparation");
    };
    TreasuryClient.prototype.outcome = async () => ({ kind: "pending", detail: "Controlled pending request" });
  }
  const provider: any = { request({ method }: any) {
    if (method === "eth_chainId") return Promise.resolve(control.chainId);
    control.walletCalls.push(method); throw new Error("Wallet writes are forbidden in this fixture");
  } };
  const switchNetwork = async (chain: "l1" | "l2") => {
    control.switches.push(chain);
    if (control.switchMode === "reject") return false;
    if (control.switchMode === "defer") await new Promise<void>(resolve => { control.releaseSwitch = resolve; });
    if (control.switchMode !== "noop") control.selectWallet(control.address, toHex(f.config[chain].chainId));
    return true;
  };
  function Harness() {
    const [address, setAddress] = useState(control.address);
    const [chainId, setChainId] = useState(control.chainId);
    control.selectWallet = (address: string | undefined, chain: string) => {
      control.address = address; control.chainId = chain; setAddress(address); setChainId(chain);
    };
    const wallet: any = { address, chainId, provider, walletOptions: [],
      switchToL1: () => switchNetwork("l1"), switchToL2: () => switchNetwork("l2") };
    return <main style={{ maxWidth: 1200, margin: "32px auto", padding: 20 }}>{f.useTestnet ? <TreasuryTestnet wallet={wallet} target={f.target} bridgeL1={f.config.payments.bridgeL1} bridgeL2={f.config.payments.bridgeL2} token={f.config.payments.tokenL1} /> : <TreasuryConnected deployment={f.config} wallet={wallet} payments />}</main>;
  }
  const key = `eez:treasury:owners:${f.config.instance}`;
  if (f.restore) localStorage.setItem(key, JSON.stringify(f.pending));
  if (f.intent) localStorage.setItem(`eez:treasury:submission:${f.config.instance}`, JSON.stringify(f.intent));
  const root = createRoot(document.getElementById("root")!);
  control.unmount = () => root.unmount();
  root.render(<Harness />);
}
