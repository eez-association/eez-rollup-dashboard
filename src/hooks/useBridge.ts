import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { config, ESTIMATION_SENDER, L1_CHAIN, L2_CHAIN } from "../config";
import { rpcCall } from "../rpc";
import { estimateGas, estimateBridgeGas, GasEstimateError, gasToHex, getEip1559Fees } from "../lib/gasEstimation";
import { prepareNativeBridgeMax } from "../lib/bridgeMax";
import { readBridgeManager } from "../lib/bridgeManager";
import { loadBridgeTokens, readBridgeToken, saveBridgeToken } from "../lib/bridgeTokens";
import type { CrossChainFeeQuote } from "../lib/fees/payment.mjs";

type Logger = (msg: string, type?: "ok" | "err" | "info") => void;
type SendTx = (params: Record<string, string>, onQuote?: (quote: CrossChainFeeQuote) => void) => Promise<string>;
type QuoteFees = (source: "l1" | "l2", tx: Record<string, string>, signal?: AbortSignal) => Promise<CrossChainFeeQuote>;

export type BridgeDirection = "l1-to-l2" | "l2-to-l1";
export type BridgeAsset = "eth" | "erc20";
export type BridgePhase =
  | "idle"
  | "approving"
  | "approve-pending"
  | "sending"
  | "tx-pending"
  | "confirmed"
  | "failed";

export interface TokenMeta {
  chainId?: number;
  predicted?: boolean;
  isProxy?: boolean;
  origin?: { address: string; chainId?: number; networkName: string; rollupId: string };
  bridgeAddress?: string;
  counterpart?: { address: string; chainId: number };
  name: string;
  symbol: string;
  decimals: number;
  address: string;
}

export interface BridgeGasState {
  status: "idle" | "estimating" | "estimated" | "error" | "unsupported";
  estimate: number | null;
  gasLimit: number | null;
  gasHex: string | null;
  method: string | null;
  errorMessage: string | null;
}

export interface BridgeState {
  phase: BridgePhase;
  direction: BridgeDirection;
  asset: BridgeAsset;
  amount: string;
  /** Custom destination address. Empty string means "use my wallet address" */
  destinationAddress: string;
  tokenAddress: string;
  tokenMeta: TokenMeta | null;
  txHash: string | null;
  error: string | null;
  sourceBalance: string | null;
  sourceBalanceRaw: bigint | null;
  allowance: bigint | null;
  tokenNeedsApproval: boolean | null;
  tokenReadError: string | null;
  l1BridgeReady: boolean | null;
  l2BridgeReady: boolean | null;
  l1BridgeError: string | null;
  l2BridgeError: string | null;
  gas: BridgeGasState;
  fees: BridgeFeeState;
  gasOverrideHex: string | null;
  maxPending: boolean;
  maxError: string | null;
}

export interface BridgeFeeState {
  status: "idle" | "loading" | "ready" | "error" | "expired";
  requestKey: string | null;
  quote: CrossChainFeeQuote | null;
  errorMessage: string | null;
}

const EMPTY_FEES: BridgeFeeState = { status: "idle", requestKey: null, quote: null, errorMessage: null };


// Bridge ABI selectors (verified via `forge inspect Bridge methodIdentifiers`)
const BRIDGE_ABI = {
  // Current Bridge uses uint64 rollup IDs.
  bridgeEther: "0x5d81310b",
  bridgeTokens: "0xd2c2fa0f",
  // wrappedTokenInfo(address) returns (address originalToken, uint64 originalRollupId)
  wrappedTokenInfo: "0x3e38ac74",
};

// ERC20 ABI selectors
const ERC20_ABI = {
  // balanceOf(address) view returns (uint256)
  balanceOf: "0x70a08231",
  // allowance(address owner, address spender) view returns (uint256)
  allowance: "0xdd62ed3e",
  // approve(address spender, uint256 amount) returns (bool)
  approve: "0x095ea7b3",
  // name() view returns (string)
  name: "0x06fdde03",
  // symbol() view returns (string)
  symbol: "0x95d89b41",
  // decimals() view returns (uint8)
  decimals: "0x313ce567",
};

function pad32(hex: string): string {
  return hex.replace("0x", "").padStart(64, "0");
}

function encodeUint256(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function decodeUint256(hex: string): bigint {
  const clean = hex.replace("0x", "");
  if (!clean || clean === "0".repeat(64)) return 0n;
  return BigInt("0x" + clean.slice(0, 64));
}

/** Format a raw bigint balance to a human-readable string with up to 4 decimal places */
function formatBalance(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0");
  // Trim trailing zeros, keep up to 4 decimal places
  const trimmed = fracStr.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

/** Parse a decimal string to raw bigint amount */
function parseAmount(amount: string, decimals: number): bigint | null {
  try {
    const parts = amount.split(".");
    if (parts.length > 2) return null;
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
  } catch {
    return null;
  }
}

/** Build the same sender, calldata and value for estimation and submission. */
function bridgeTransaction(state: BridgeState, from: string): { from: string; to: string; data: string; value: string } {
  const { direction, asset, amount, tokenAddress, tokenMeta, destinationAddress } = state;
  const rollupId = encodeUint256(direction === "l2-to-l1" ? 0n : BigInt(config.rollupId));
  const destination = destinationAddress || from;
  const rawAmount = parseAmount(amount, asset === "eth" ? 18 : tokenMeta?.decimals ?? 18)!;
  return {
    from,
    to: direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge,
    data: asset === "eth" ? BRIDGE_ABI.bridgeEther + rollupId + pad32(destination) :
      BRIDGE_ABI.bridgeTokens + pad32(tokenAddress) + encodeUint256(rawAmount) + rollupId + pad32(destination),
    value: asset === "eth" ? "0x" + rawAmount.toString(16) : "0x0",
  };
}

interface TxReceipt {
  status?: string;
  gasUsed?: string;
}

/** Try to get a revert reason by replaying the tx via eth_call */
async function fetchRevertReason(rpcUrl: string, txHash: string): Promise<string> {
  try {
    const tx = (await rpcCall(rpcUrl, "eth_getTransactionByHash", [txHash])) as {
      from?: string; to?: string; data?: string; input?: string;
      value?: string; blockNumber?: string;
    } | null;
    if (!tx?.to) return "";
    const result = (await rpcCall(rpcUrl, "eth_call", [
      { from: tx.from, to: tx.to, data: tx.input || tx.data, value: tx.value },
      tx.blockNumber || "latest",
    ])) as string;
    return result || "";
  } catch (e) {
    const msg = (e as Error).message || "";
    const match = msg.match(/revert(?:ed)?:?\s*(.*)/i) || msg.match(/reason:\s*(.*)/i);
    if (match?.[1]) return match[1].trim();
    if (msg.length < 200) return msg;
    return "Reverted (reason unknown)";
  }
}

export function useBridge(
  log: Logger,
  sendTx: SendTx,
  sendL2ProxyTx: SendTx,
  sendL1Tx: SendTx,
  sendL1ProxyTx: SendTx,
  walletAddress: string | null,
  configLoaded: boolean,
  quoteFees: QuoteFees,
) {
  const defaultGas: BridgeGasState = {
    status: "idle", estimate: null, gasLimit: null,
    gasHex: null, method: null, errorMessage: null,
  };

  const [state, setState] = useState<BridgeState>({
    phase: "idle",
    direction: "l1-to-l2",
    asset: "eth",
    amount: "",
    destinationAddress: "",
    tokenAddress: "",
    tokenMeta: null,
    txHash: null,
    error: null,
    sourceBalance: null,
    sourceBalanceRaw: null,
    allowance: null,
    tokenNeedsApproval: null,
    tokenReadError: null,
    l1BridgeReady: null,
    l2BridgeReady: null,
    l1BridgeError: null,
    l2BridgeError: null,
    gas: defaultGas,
    fees: EMPTY_FEES,
    gasOverrideHex: null,
    maxPending: false,
    maxError: null,
  });

  const [recentTokens, setRecentTokens] = useState<TokenMeta[]>(loadBridgeTokens);

  const stateRef = useRef(state);
  stateRef.current = state;
  const estimatedRequest = useRef<string | null>(null);
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;
  const maxOperation = useRef(0);
  const [feeRefresh, setFeeRefresh] = useState(0);
  const refreshFees = useCallback(() => setFeeRefresh(value => value + 1), []);
  useEffect(() => {
    maxOperation.current++;
    setState(s => ({ ...s, maxPending: false, maxError: null }));
    return () => { maxOperation.current++; };
  }, [walletAddress, state.direction, state.asset, state.amount, state.tokenAddress,
    state.tokenMeta?.decimals, state.destinationAddress, state.gasOverrideHex, configLoaded]);

  // Configuration loads asynchronously. Unknown or failed reads must not be
  // presented as a confirmed missing deployment.
  useEffect(() => {
    if (!configLoaded) return;
    let cancelled = false;
    let checking = false;
    setState((s) => ({ ...s, l1BridgeReady: null, l2BridgeReady: null,
      l1BridgeError: null, l2BridgeError: null }));

    async function checkBridge(rpcUrl: string, bridgeAddr: string): Promise<{
      ready: boolean | null; error: string | null;
    }> {
      if (!bridgeAddr) return { ready: false, error: null };
      try {
        const code = await rpcCall(rpcUrl, "eth_getCode", [bridgeAddr, "latest"]);
        if (code === "0x" || code === "0x0") return { ready: false, error: null };
        if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code)) {
          throw new Error("Invalid contract code response");
        }
        const manager = await readBridgeManager(data => rpcCall(rpcUrl, "eth_call", [
          { to: bridgeAddr, data }, "latest",
        ]));
        return { ready: BigInt(manager) !== 0n, error: null };
      } catch (error) {
        return { ready: null, error: (error as Error).message || "RPC check failed" };
      }
    }

    async function checkBoth() {
      if (checking || cancelled) return false;
      checking = true;
      try {
        const [l1, l2] = await Promise.all([
          checkBridge(config.l1Rpc, config.l1Bridge),
          checkBridge(config.l2Rpc, config.l2Bridge),
        ]);
        if (!cancelled) {
          setState((s) => ({ ...s, l1BridgeReady: l1.ready, l2BridgeReady: l2.ready,
            l1BridgeError: l1.error, l2BridgeError: l2.error }));
        }
        return l1.ready === true && l2.ready === true;
      } finally {
        checking = false;
      }
    }

    // Missing deployments and transient RPC errors are rechecked. Successful
    // initial checks do not have to wait for this retry interval.
    const interval = setInterval(async () => {
      if (await checkBoth()) clearInterval(interval);
    }, 10000);
    void checkBoth().then((ready) => { if (ready) clearInterval(interval); });
    return () => { cancelled = true; clearInterval(interval); };
  }, [configLoaded, config.l1Rpc, config.l2Rpc, config.l1Bridge, config.l2Bridge]);

  // Fetch balance and allowance
  useEffect(() => {
    if (!walletAddress) {
      setState((s) => ({ ...s, sourceBalance: null, sourceBalanceRaw: null, allowance: null, tokenNeedsApproval: null, tokenReadError: null }));
      return;
    }

    let cancelled = false;
    const { direction, asset, tokenAddress } = state;
    setState(s => ({ ...s, sourceBalance: null, sourceBalanceRaw: null, allowance: null, tokenNeedsApproval: null, tokenReadError: null }));

    async function fetchBalances() {
      const sourceRpc = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
      const bridgeAddr = direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge;

      try {
        if (asset === "eth") {
          const bal = (await rpcCall(sourceRpc, "eth_getBalance", [
            walletAddress, "latest",
          ])) as string;
          const raw = BigInt(bal);
          if (!cancelled) {
            setState((s) => ({
              ...s,
              sourceBalance: formatBalance(raw, 18),
              sourceBalanceRaw: raw,
              allowance: null,
              tokenNeedsApproval: null,
              tokenReadError: null,
            }));
          }
        } else if (tokenAddress && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
          if (stateRef.current.tokenMeta?.predicted) {
            const code = await rpcCall(sourceRpc, "eth_getCode", [tokenAddress, "latest"]);
            if (code === "0x" || code === "0x0") {
              if (!cancelled) setState(s => ({ ...s, sourceBalance: "0", sourceBalanceRaw: 0n, allowance: 0n, tokenNeedsApproval: false, tokenReadError: null }));
              return;
            }
            const meta = await readBridgeToken(sourceRpc, tokenAddress, Number(BigInt(direction === "l1-to-l2" ? L1_CHAIN.chainId : L2_CHAIN.chainId)));
            if (!cancelled) {
              setState(s => ({ ...s, tokenMeta: { ...s.tokenMeta, ...meta, predicted: false } }));
              setRecentTokens(tokens => saveBridgeToken({ ...meta, predicted: false }, tokens));
            }
          }
          const decimals = stateRef.current.tokenMeta?.decimals ?? 18;

          // Fetch balance
          const balResult = (await rpcCall(sourceRpc, "eth_call", [
            {
              to: tokenAddress,
              data: ERC20_ABI.balanceOf + pad32(walletAddress!),
            },
            "latest",
          ])) as string;
          const raw = decodeUint256(balResult);

          // The bridge burns its own wrapped tokens directly; only native
          // tokens go through transferFrom and need an ERC20 allowance.
          const tokenInfo = await rpcCall(sourceRpc, "eth_call", [
            { to: bridgeAddr, data: BRIDGE_ABI.wrappedTokenInfo + pad32(tokenAddress) }, "latest",
          ]);
          if (typeof tokenInfo !== "string" || !/^0x0{24}[0-9a-fA-F]{40}[0-9a-fA-F]{64}$/.test(tokenInfo)) {
            throw new Error("Invalid bridge token information response");
          }
          const tokenNeedsApproval = decodeUint256(tokenInfo) === 0n;
          let allowance = 0n;
          if (tokenNeedsApproval) {
            const allowResult = await rpcCall(sourceRpc, "eth_call", [
              { to: tokenAddress, data: ERC20_ABI.allowance + pad32(walletAddress!) + pad32(bridgeAddr) }, "latest",
            ]);
            if (typeof allowResult !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(allowResult)) throw new Error("Invalid token allowance response");
            allowance = decodeUint256(allowResult);
          }

          if (!cancelled) {
            setState((s) => ({
              ...s,
              sourceBalance: formatBalance(raw, decimals),
              sourceBalanceRaw: raw,
              allowance,
              tokenNeedsApproval,
              tokenReadError: null,
            }));
          }
        }
      } catch (error) {
        if (!cancelled && asset === "erc20") setState(s => ({ ...s, allowance: null, tokenNeedsApproval: null,
          tokenReadError: (error as Error).message || "Unable to check token balance and approval" }));
      }
    }

    fetchBalances();
    const interval = setInterval(fetchBalances, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [walletAddress, state.direction, state.asset, state.tokenAddress, state.tokenMeta?.decimals, configLoaded, config.l1Bridge, config.l2Bridge, config.l1Rpc, config.l2Rpc]);

  // Fetch token metadata on address change (debounced)
  useEffect(() => {
    const { tokenAddress, asset, direction } = state;
    if (!configLoaded || asset !== "erc20" || !tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
      setState((s) => ({ ...s, tokenMeta: null }));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const sourceRpc = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
      const chainId = Number(BigInt(direction === "l1-to-l2" ? L1_CHAIN.chainId : L2_CHAIN.chainId));
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const meta = await readBridgeToken(sourceRpc, tokenAddress, chainId, controller.signal);
        if (controller.signal.aborted) return;
        setState(s => ({ ...s, tokenMeta: { ...s.tokenMeta, ...meta, predicted: false } }));
        setRecentTokens(tokens => saveBridgeToken({ ...meta, predicted: false }, tokens));
      } catch {
        // A failed lookup must never save a guessed token or decimal precision.
      } finally { clearTimeout(timeout); }
    }, 300);

    return () => { controller.abort(); clearTimeout(timer); };
  }, [state.tokenAddress, state.asset, state.direction, configLoaded]);

  const bridgeCompleted = state.phase === "confirmed";

  // Gas estimation effect — runs when bridge params change
  useEffect(() => {
    const { direction, asset, amount, tokenAddress, tokenMeta } = state;
    const bridgeAddr = direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge;

    estimatedRequest.current = null;
    if (bridgeCompleted || !configLoaded || !walletAddress || !bridgeAddr || !amount) {
      setState((s) => ({ ...s, gas: defaultGas }));
      return;
    }
    if (state.destinationAddress && !/^0x[0-9a-fA-F]{40}$/.test(state.destinationAddress)) {
      setState(s => ({ ...s, gas: defaultGas }));
      return;
    }

    const decimals = asset === "eth" ? 18 : (tokenMeta?.decimals ?? 18);
    const rawAmount = parseAmount(amount, decimals);
    if (!rawAmount || rawAmount === 0n) {
      setState((s) => ({ ...s, gas: defaultGas }));
      return;
    }

    if (asset === "erc20" && (!tokenMeta || tokenMeta.predicted || !tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress))) {
      setState((s) => ({ ...s, gas: defaultGas }));
      return;
    }

    // Locking an original ERC20 cannot succeed until its allowance is ready.
    // Show the approval action without estimating a transfer that must revert.
    if (asset === "erc20" && (state.tokenNeedsApproval === null ||
        state.tokenNeedsApproval && (state.allowance === null || state.allowance < rawAmount))) {
      setState(s => ({ ...s, gas: defaultGas }));
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setState((s) => ({
      ...s,
      gas: { ...defaultGas, status: "estimating" },
    }));

    const timer = setTimeout(async () => {
      let requestKey: string | null = null;
      try {
        const transaction = bridgeTransaction(state, walletAddress);
        const rpcUrl = direction === "l1-to-l2" ? config.l1ProxyRpc : config.l2ProxyRpc;
        requestKey = rpcUrl + JSON.stringify(transaction);
        const result = await estimateBridgeGas({ rpcUrl, ...transaction, signal: controller.signal });
        if (!cancelled) {
          estimatedRequest.current = requestKey;
          setState((s) => ({
            ...s,
            gas: {
              status: "estimated",
              estimate: Number(result.rawEstimate),
              gasLimit: Number(result.rawEstimate),
              gasHex: gasToHex(result.rawEstimate),
              method: "Composer",
              errorMessage: null,
            },
          }));
        }
      } catch (e) {
        if (!cancelled) {
          const unsupported = e instanceof GasEstimateError && e.type === "unsupported";
          estimatedRequest.current = unsupported ? requestKey : null;
          setState((s) => ({
            ...s,
            gas: {
              ...defaultGas,
              status: unsupported ? "unsupported" : "error",
              errorMessage: (e as Error).message || "Gas estimation failed",
            },
          }));
        }
      }
    }, 400);

    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [bridgeCompleted, state.direction, state.asset, state.amount, state.tokenAddress, state.tokenMeta?.decimals, state.tokenMeta?.predicted, state.destinationAddress, state.allowance, state.tokenNeedsApproval, walletAddress, configLoaded, config.l1Bridge, config.l2Bridge, config.rollupId, config.l1ProxyRpc, config.l2ProxyRpc]);

  const feeSource = state.direction === "l1-to-l2" ? "l1" : "l2";
  const feeRpc = feeSource === "l1" ? config.l1ProxyRpc : config.l2ProxyRpc;
  const feeChain = feeSource === "l1" ? L1_CHAIN : L2_CHAIN;
  const feesEnabled = feeSource === "l1" ? config.l1FeesEnabled : config.l2FeesEnabled;
  let feeTransaction: Record<string, string> | null = null;
  if (!bridgeCompleted && configLoaded && feesEnabled && walletAddress && state.amount &&
      (state.gas.status === "estimated" || state.gas.status === "unsupported" && state.gasOverrideHex)) {
    const amount = parseAmount(state.amount, state.asset === "eth" ? 18 : state.tokenMeta?.decimals ?? 18);
    const approved = state.asset === "eth" || state.tokenNeedsApproval === false ||
      state.tokenNeedsApproval === true && state.allowance !== null && amount !== null && state.allowance >= amount;
    if (approved && amount && amount > 0n) {
      const transaction = bridgeTransaction(state, walletAddress);
      if (estimatedRequest.current === feeRpc + JSON.stringify(transaction)) {
        feeTransaction = { ...transaction, gas: state.gasOverrideHex ?? state.gas.gasHex! };
      }
    }
  }
  const feeRequestKey = feeTransaction ? JSON.stringify([feeRpc, feeChain.chainId, feeTransaction]) : null;
  const feeRequestRef = useRef(feeRequestKey);
  feeRequestRef.current = feeRequestKey;

  useEffect(() => {
    if (!feeRequestKey || !feeTransaction) {
      setState(s => ({ ...s, fees: EMPTY_FEES }));
      return;
    }
    // Freeze the final quote while the user copies its values into the wallet.
    // A background preview must never replace the quote being signed.
    if (!["idle", "failed"].includes(state.phase)) return;
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    setState(s => ({ ...s, fees: { ...EMPTY_FEES, requestKey: feeRequestKey, status: "loading" } }));
    const timer = setTimeout(async () => {
      try {
        const quote = await quoteFees(feeSource, feeTransaction!, controller.signal);
        if (controller.signal.aborted) return;
        setState(s => ({ ...s, fees: { status: "ready", requestKey: feeRequestKey, quote, errorMessage: null } }));
        expiryTimer = setTimeout(() => {
          setState(s => ({ ...s, fees: { ...EMPTY_FEES, requestKey: feeRequestKey, status: "expired" } }));
        }, Math.max(0, Number(BigInt(quote.expiresAt) * 1000n) - Date.now()));
      } catch (error) {
        if (!controller.signal.aborted) setState(s => ({ ...s, fees: {
          ...EMPTY_FEES, requestKey: feeRequestKey, status: "error", errorMessage: (error as Error).message,
        } }));
      }
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(expiryTimer); };
  }, [feeRequestKey, feeRefresh, quoteFees, state.phase]);

  const setGasOverride = useCallback((hex: string | null) => {
    setState(s => ({ ...s, gasOverrideHex: hex }));
  }, []);

  const setDirection = useCallback((dir: BridgeDirection) => {
    setState(s => {
      const chainId = Number(BigInt(dir === "l1-to-l2" ? L1_CHAIN.chainId : L2_CHAIN.chainId));
      const sourceChainId = Number(BigInt(s.direction === "l1-to-l2" ? L1_CHAIN.chainId : L2_CHAIN.chainId));
      const selected = recentTokens.find(t => t.chainId === sourceChainId && t.address.toLowerCase() === s.tokenAddress.toLowerCase()
        && t.bridgeAddress?.toLowerCase() === (s.direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge).toLowerCase());
      const paired = selected?.counterpart?.chainId === chainId ? recentTokens.find(t =>
        t.chainId === chainId && t.address.toLowerCase() === selected.counterpart!.address.toLowerCase()
        && t.bridgeAddress?.toLowerCase() === (dir === "l1-to-l2" ? config.l1Bridge : config.l2Bridge).toLowerCase()) : undefined;
      return { ...s, direction: dir, tokenAddress: paired?.address ?? s.tokenAddress,
        tokenMeta: paired ?? null, sourceBalance: null, sourceBalanceRaw: null,
        allowance: null, tokenNeedsApproval: null, tokenReadError: null, phase: "idle", txHash: null, error: null };
    });
  }, [recentTokens]);

  const setAsset = useCallback((asset: BridgeAsset) => {
    setState((s) => ({
      ...s,
      asset,
      tokenAddress: "",
      tokenMeta: null,
      amount: "",
      sourceBalance: null,
      sourceBalanceRaw: null,
      allowance: null,
      tokenNeedsApproval: null,
      tokenReadError: null,
      phase: "idle",
      txHash: null,
      error: null,
    }));
  }, []);

  const setAmount = useCallback((amt: string) => {
    // Only allow valid decimal format
    if (amt && !/^\d*\.?\d*$/.test(amt)) return;
    setState((s) => ({ ...s, amount: amt }));
  }, []);

  const setDestination = useCallback((addr: string) => {
    setState((s) => ({ ...s, destinationAddress: addr }));
  }, []);

  const setTokenAddress = useCallback((addr: string, pair?: [TokenMeta, TokenMeta]) => {
    if (pair) setRecentTokens(tokens => saveBridgeToken(pair[1], saveBridgeToken(pair[0], tokens)));
    setState((s) => ({
      ...s,
      tokenAddress: addr,
      tokenMeta: pair?.[0] ?? null,
      sourceBalance: null,
      sourceBalanceRaw: null,
      allowance: null,
      tokenNeedsApproval: null,
      tokenReadError: null,
    }));
  }, []);

  const setMax = useCallback(async () => {
    const snapshot = stateRef.current;
    const from = walletRef.current;
    if (!from || snapshot.sourceBalanceRaw === null || !["idle", "confirmed", "failed"].includes(snapshot.phase)) return;
    if (snapshot.destinationAddress && !/^0x[0-9a-fA-F]{40}$/.test(snapshot.destinationAddress)) {
      setState(s => ({ ...s, maxError: "Enter a valid recipient address before using MAX." }));
      return;
    }
    if (snapshot.asset === "erc20") {
      // Display balances are rounded; MAX must use the complete raw token balance.
      setState(s => ({ ...s, amount: formatUnits(snapshot.sourceBalanceRaw!, snapshot.tokenMeta?.decimals ?? 18), maxError: null }));
      return;
    }
    const operation = ++maxOperation.current;
    setState(s => ({ ...s, maxPending: true, maxError: null }));
    const current = () => operation === maxOperation.current && from === walletRef.current &&
      ["direction", "asset", "amount", "tokenAddress", "destinationAddress", "gasOverrideHex"].every(key =>
        stateRef.current[key as keyof BridgeState] === snapshot[key as keyof BridgeState]);
    try {
      const sourceRpc = snapshot.direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
      const composerRpc = snapshot.direction === "l1-to-l2" ? config.l1ProxyRpc : config.l2ProxyRpc;
      const [balanceHex, fees] = await Promise.all([
        rpcCall(sourceRpc, "eth_getBalance", [from, "latest"]), getEip1559Fees(sourceRpc),
      ]);
      const balance = BigInt(balanceHex as string);
      const gasOverride = snapshot.gasOverrideHex ? BigInt(snapshot.gasOverrideHex) : null;
      const minimumReserve = snapshot.direction === "l1-to-l2"
        ? (config.l1FeesEnabled ? BigInt(config.l1FeeMaxTotalWei) : 0n)
        : (config.l2FeesEnabled ? BigInt(config.l2FeeMaxTotalWei) : 0n);
      const result = await prepareNativeBridgeMax({ balance, feeCap: BigInt(fees.maxFeePerGas!), gasOverride, minimumReserve,
        estimate: async value => {
          if (!current()) throw new Error("Bridge parameters changed.");
          const transaction = bridgeTransaction({ ...snapshot, amount: formatUnits(value, 18) }, from);
          try { return (await estimateBridgeGas({ rpcUrl: composerRpc, ...transaction })).rawEstimate; }
          catch (error) {
            if (gasOverride && error instanceof GasEstimateError && error.type === "unsupported") return gasOverride;
            throw error;
          }
        },
      });
      if (current()) setState(s => ({ ...s, amount: formatUnits(result.amount, 18),
        sourceBalance: formatBalance(balance, 18), sourceBalanceRaw: balance, maxPending: false, maxError: null }));
    } catch (error) {
      if (current()) setState(s => ({ ...s, maxPending: false, maxError: `Unable to set MAX: ${(error as Error).message}` }));
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, phase: "idle", error: null, txHash: null,
      ...(s.phase === "confirmed" ? { amount: "", fees: EMPTY_FEES, gas: defaultGas } : {}) }));
  }, []);

  /** Approve ERC20 spending for the bridge */
  const approve = useCallback(async () => {
    const { direction, tokenAddress, tokenMeta, amount, asset, phase } = stateRef.current;
    const bridgeAddr = direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge;
    if (!bridgeAddr || !tokenAddress || !tokenMeta || asset !== "erc20" ||
        !["idle", "failed"].includes(phase) || stateRef.current.tokenNeedsApproval !== true) return;
    const approvalAmount = parseAmount(amount, tokenMeta.decimals);
    if (approvalAmount === null || approvalAmount <= 0n || approvalAmount >= (1n << 256n)) return;

    setState((s) => ({ ...s, phase: "approving", error: null, txHash: null }));
    log(`Approving token spending for bridge...`, "info");

    try {
      const data = ERC20_ABI.approve + pad32(bridgeAddr) + encodeUint256(approvalAmount);
      const send = direction === "l1-to-l2" ? sendL1Tx : sendTx;
      const rpcUrl = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;

      let gasHex: string | undefined;
      try {
        const est = await estimateGas({
          rpcUrl,
          to: tokenAddress,
          data,
          from: walletRef.current || ESTIMATION_SENDER,
        });
        gasHex = gasToHex(est.gasLimit);
      } catch {
        // Estimation failed — let the node use its default
      }

      const txHash = await send({
        to: tokenAddress,
        data,
        ...(gasHex ? { gas: gasHex } : {}),
      });

      setState((s) => ({ ...s, phase: "approve-pending", txHash }));
      log(`Approval tx: ${txHash.slice(0, 18)}...`);

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash])) as TxReceipt | null;
          if (receipt) {
            if (receipt.status === "0x1") {
              setState((s) => ({ ...s, phase: "idle", txHash: null, allowance: approvalAmount }));
              log("Token approval confirmed", "ok");
            } else {
              const reason = await fetchRevertReason(rpcUrl, txHash);
              setState((s) => ({
                ...s,
                phase: "failed",
                error: reason ? `Approval reverted: ${reason}` : "Approval transaction reverted",
              }));
              log("Approval reverted", "err");
            }
            return;
          }
        } catch { /* not mined */ }
      }

      setState((s) => ({ ...s, phase: "failed", error: "Approval: no receipt after 30s" }));
    } catch (e) {
      const msg = (e as Error).message;
      setState((s) => ({ ...s, phase: "failed", error: msg }));
      log(`Approval failed: ${msg}`, "err");
    }
  }, [log, sendTx, sendL1Tx]);

  /** Main bridge action */
  const bridge = useCallback(async () => {
    const { direction, asset, amount, tokenMeta } = stateRef.current;
    const bridgeAddr = direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge;
    const ready = direction === "l1-to-l2" ? stateRef.current.l1BridgeReady : stateRef.current.l2BridgeReady;
    if (!bridgeAddr || !amount || ready !== true) return;

    const decimals = asset === "eth" ? 18 : (tokenMeta?.decimals ?? 18);
    const rawAmount = parseAmount(amount, decimals);
    if (!rawAmount || rawAmount === 0n) {
      setState((s) => ({ ...s, phase: "failed", error: "Invalid amount" }));
      return;
    }

    if (asset === "erc20" && (!tokenMeta || tokenMeta.predicted || stateRef.current.tokenNeedsApproval === null || stateRef.current.sourceBalanceRaw === null ||
        stateRef.current.sourceBalanceRaw < rawAmount || stateRef.current.tokenNeedsApproval &&
        (stateRef.current.allowance === null || stateRef.current.allowance < rawAmount))) {
      setState(s => ({ ...s, phase: "failed", error: s.tokenReadError || "Check your token balance and required approval before bridging" }));
      return;
    }
    const from = walletRef.current;
    if (!from) return;
    if (stateRef.current.destinationAddress && !/^0x[0-9a-fA-F]{40}$/.test(stateRef.current.destinationAddress)) {
      setState(s => ({ ...s, phase: "failed", error: "Enter a valid recipient address before bridging." }));
      return;
    }
    const transaction = bridgeTransaction(stateRef.current, from);
    const composerRpc = direction === "l1-to-l2" ? config.l1ProxyRpc : config.l2ProxyRpc;
    const gasOverrideHex = stateRef.current.gasOverrideHex;
    const gasReady = stateRef.current.gas.status === "estimated" && !!stateRef.current.gas.gasHex ||
      stateRef.current.gas.status === "unsupported" && !!gasOverrideHex;
    if (!gasReady || estimatedRequest.current !== composerRpc + JSON.stringify(transaction)) {
      setState((s) => ({ ...s, phase: "failed", error: s.gas.errorMessage || "Wait for a valid Composer gas estimate before bridging" }));
      return;
    }
    const submittedFeeKey = feeRequestRef.current;
    setState((s) => ({ ...s, phase: "sending", error: null, txHash: null,
      fees: { ...EMPTY_FEES, requestKey: submittedFeeKey, status: "loading" } }));
    try {
      // An explicit override can also unblock a Composer with known missing estimation support.
      const resolvedGas = gasOverrideHex ?? stateRef.current.gas.gasHex!;
      const sourceRpc = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
      const feesEnabled = direction === "l1-to-l2" ? config.l1FeesEnabled : config.l2FeesEnabled;
      const fees = feesEnabled ? {} : await getEip1559Fees(sourceRpc);
      const gasParam = { gas: resolvedGas, gasLimit: resolvedGas, ...fees };
      if (walletRef.current !== from || estimatedRequest.current !== composerRpc + JSON.stringify(transaction)) {
        throw new Error("Bridge transaction changed; wait for a new Composer gas estimate");
      }
      const symbol = asset === "eth" ? (direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol : tokenMeta?.symbol || "tokens";
      log(`Bridging ${amount} ${symbol} ${direction === "l1-to-l2" ? "L1 → L2" : "L2 → L1"}...`, "info");
      const onQuote = (quote: CrossChainFeeQuote) => {
        if (walletRef.current === from && feeRequestRef.current === submittedFeeKey) {
          setState(s => ({ ...s, fees: { status: "ready", requestKey: submittedFeeKey, quote, errorMessage: null } }));
        }
      };
      const txHash = direction === "l1-to-l2"
        ? await sendL1ProxyTx({ ...transaction, ...gasParam }, onQuote)
        : await sendL2ProxyTx({ ...transaction, ...gasParam }, onQuote);

      setState((s) => ({ ...s, phase: "tx-pending", txHash }));
      log(`Bridge tx: ${txHash.slice(0, 18)}...`);

      // Poll for receipt
      if (direction === "l1-to-l2") {
        // L1→L2: same pattern as useCrossChain — tx goes through L1 proxy
        let txSeenOnL1 = false;
        const rpcUrl = config.l1Rpc;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash])) as TxReceipt | null;
            if (receipt) {
              if (receipt.status === "0x1") {
                setState((s) => ({ ...s, phase: "confirmed", error: null, fees: EMPTY_FEES }));
                log("Bridge transaction confirmed on L1 — L2 delivery atomic", "ok");
              } else {
                const reason = await fetchRevertReason(rpcUrl, txHash);
                setState((s) => ({
                  ...s,
                  phase: "failed",
                  error: reason ? `Reverted: ${reason}` : "Bridge transaction reverted",
                }));
                log(`Bridge tx reverted${reason ? `: ${reason}` : ""}`, "err");
              }
              return;
            }
          } catch { /* not mined */ }

          if (i > 0 && i % 12 === 0 && !txSeenOnL1) {
            try {
              const tx = await rpcCall(rpcUrl, "eth_getTransactionByHash", [txHash]);
              if (tx) {
                txSeenOnL1 = true;
                log("Transaction seen on L1, waiting for confirmation...");
              } else if (i >= 36) {
                setState((s) => ({
                  ...s,
                  phase: "failed",
                  error: "Transaction not broadcast to L1 — composer may be unable to submit batches",
                }));
                log("Composer may be stuck", "err");
                return;
              }
            } catch { /* ignore */ }
          }
        }

        const finalMsg = txSeenOnL1
          ? "L1 transaction pending but not confirmed after 60s"
          : "Transaction not broadcast to L1 after 60s — check composer health";
        setState((s) => ({ ...s, phase: "failed", error: finalMsg }));
        log(finalMsg, "err");
      } else {
        // L2→L1: simpler receipt polling
        const rpcUrl = config.l2Rpc;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash])) as TxReceipt | null;
            if (receipt) {
              if (receipt.status === "0x1") {
                setState((s) => ({ ...s, phase: "confirmed", error: null, fees: EMPTY_FEES }));
                log("Bridge transaction confirmed on L2", "ok");
              } else {
                const reason = await fetchRevertReason(rpcUrl, txHash);
                setState((s) => ({
                  ...s,
                  phase: "failed",
                  error: reason ? `Reverted: ${reason}` : "Bridge transaction reverted",
                }));
                log(`Bridge tx reverted${reason ? `: ${reason}` : ""}`, "err");
              }
              return;
            }
          } catch { /* not mined */ }
        }

        setState((s) => ({ ...s, phase: "failed", error: "No receipt after 30s" }));
        log("Bridge tx: no receipt after 30s", "err");
      }
    } catch (e) {
      const msg = (e as Error).message;
      setState((s) => ({ ...s, phase: "failed", error: msg }));
      log(`Bridge failed: ${msg}`, "err");
    }
  }, [log, sendL1ProxyTx, sendL2ProxyTx]);

  return {
    state: { ...state, fees: state.fees.requestKey === feeRequestKey ? state.fees : EMPTY_FEES },
    recentTokens,
    setDirection,
    setAsset,
    setAmount,
    setDestination,
    setTokenAddress,
    setMax,
    approve,
    bridge,
    dismiss,
    setGasOverride,
    refreshFees,
  };
}
