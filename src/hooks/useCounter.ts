import { useCallback, useEffect, useRef, useState } from "react";
import { config, COUNTER_ABI, COUNTER_BYTECODE } from "../config";
import { rpcCall } from "../rpc";

type Logger = (msg: string, type?: "ok" | "err" | "info") => void;
type SendTx = (params: Record<string, string>) => Promise<string>;
export type CounterChain = "l1" | "l2";
export interface TxStatus {
  phase: "idle" | "sending" | "pending" | "confirmed" | "failed";
  action: "deploy" | "increment" | null;
  hash: string | null;
  error: string | null;
}
const IDLE_TX: TxStatus = { phase: "idle", action: null, hash: null, error: null };
const validAddress = (address: string) => /^0x[0-9a-f]{40}$/i.test(address);
interface TxReceipt { contractAddress?: string; status?: string; }

export function useCounter(log: Logger, sendTx: SendTx, options: {
  chain: CounterChain; senderAddress: string | null; ready: boolean; active: boolean;
}) {
  const { chain, senderAddress, ready, active } = options;
  const rpc = chain === "l1" ? config.l1Rpc : config.l2Rpc;
  const network = chain === "l1" ? config.l1NetworkName : config.rollupName;
  // Preserve the existing L2 cache; L1 counters have an independent entry.
  const storageKey = chain === "l1" ? "counterAddressL1" : "counterAddress";
  const [address, setAddressState] = useState(() => localStorage.getItem(storageKey) || "");
  const currentAddress = useRef(address);
  const readGeneration = useRef(0), inFlight = useRef(false);
  const [count, setCount] = useState<bigint | null>(null);
  const [prevCount, setPrevCount] = useState<bigint | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<TxStatus>(IDLE_TX);

  const setAddress = useCallback((value: string) => {
    if (inFlight.current) return;
    const next = value.trim();
    currentAddress.current = next; readGeneration.current++;
    setAddressState(next); setCount(null); setPrevCount(null); setReadError(null);
    if (validAddress(next)) localStorage.setItem(storageKey, next);
    else localStorage.removeItem(storageKey);
  }, [storageKey]);

  // Clear wiped-chain caches only after configuration is loaded. RPC errors retain them.
  useEffect(() => {
    if (!ready || !active) return;
    const cached = localStorage.getItem(storageKey);
    if (!cached || !validAddress(cached)) return;
    let cancelled = false;
    void rpcCall(rpc, "eth_getCode", [cached, "latest"], AbortSignal.timeout(10_000)).then(code => {
      if (!cancelled && currentAddress.current === cached && (code === "0x" || code === "0x0")) setAddress("");
    }).catch(() => { /* Keep saved addresses during temporary RPC failures. */ });
    return () => { cancelled = true; };
  }, [ready, active, rpc, storageKey, setAddress]);

  const refresh = useCallback(async () => {
    if (!ready || !validAddress(address)) return;
    const generation = ++readGeneration.current;
    try {
      const result = await rpcCall(rpc, "eth_call", [{ to: address, data: COUNTER_ABI.getCount }, "latest"], AbortSignal.timeout(10_000));
      if (generation !== readGeneration.current || currentAddress.current !== address) return;
      if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) throw new Error(`This address does not return a counter value on ${network}`);
      const next = BigInt(result);
      setReadError(null);
      setCount(previous => { if (previous !== null && previous !== next) setPrevCount(previous); return next; });
    } catch (error) {
      if (generation !== readGeneration.current || currentAddress.current !== address) return;
      setCount(null); setReadError(error instanceof Error ? error.message : String(error));
    }
  }, [ready, address, rpc, network]);

  useEffect(() => {
    if (!active) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 3000); };
    void poll();
    return () => { stopped = true; clearTimeout(timer); readGeneration.current++; };
  }, [refresh, active]);

  const run = useCallback(async (action: "deploy" | "increment") => {
    if (inFlight.current || !ready || !senderAddress) return;
    if (action === "increment" && (!validAddress(address) || count === null)) return;
    inFlight.current = true;
    let hash: string | null = null;
    setTxStatus({ phase: "sending", action, hash, error: null });
    try {
      const transaction = { from: senderAddress, data: action === "deploy" ? COUNTER_BYTECODE : COUNTER_ABI.increment,
        value: "0x0", ...(action === "increment" ? { to: address } : {}) };
      // Ordinary counter work estimates on its deployment chain. Contract creation omits `to`.
      const estimate = await rpcCall(rpc, "eth_estimateGas", [transaction]);
      if (typeof estimate !== "string" || !/^0x[0-9a-f]+$/i.test(estimate) || BigInt(estimate) <= 0n) throw new Error("RPC returned an invalid counter gas estimate");
      hash = await sendTx({ ...transaction, gas: estimate, gasLimit: estimate });
      setTxStatus({ phase: "pending", action, hash, error: null });
      let receipt: TxReceipt | null = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [hash]) as TxReceipt | null; }
        catch { /* Continue polling after temporary read failures. */ }
        if (receipt) break;
      }
      if (!receipt) throw new Error(`No receipt after 60s on ${network}. Check the transaction in the explorer.`);
      if (receipt.status !== "0x1") throw new Error(`Transaction reverted on ${network}`);
      if (action === "deploy") {
        if (!receipt.contractAddress || !validAddress(receipt.contractAddress)) throw new Error("Deployment receipt contains no contract address");
        currentAddress.current = receipt.contractAddress; readGeneration.current++;
        setAddressState(receipt.contractAddress); setCount(null); setPrevCount(null); setReadError(null);
        localStorage.setItem(storageKey, receipt.contractAddress);
      } else await refresh();
      const confirmed: TxStatus = { phase: "confirmed", action, hash, error: null };
      setTxStatus(confirmed);
      setTimeout(() => setTxStatus(current => current === confirmed ? IDLE_TX : current), 5000);
      log(`Counter ${action === "deploy" ? "deployed" : "incremented"} on ${network}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTxStatus({ phase: "failed", action, hash, error: message }); log(message, "err");
    } finally { inFlight.current = false; }
  }, [ready, senderAddress, address, count, rpc, network, sendTx, storageKey, refresh, log]);

  return { address, setAddress, count, prevCount, readError, txStatus,
    busy: txStatus.phase === "sending" || txStatus.phase === "pending",
    deploy: () => run("deploy"), increment: () => run("increment"), refresh,
    reset: () => setTxStatus(IDLE_TX) };
}
