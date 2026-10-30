import { decodeAbiParameters, type Hex } from "viem";
import type { TokenMeta } from "../hooks/useBridge";
import { rpcCall, RpcError } from "../rpc.ts";

const STORAGE_KEY = "bridgeRecentTokens";
export const isTokenAddress = (value: string) => /^0x[0-9a-f]{40}$/i.test(value);

export function isSavedBridgeToken(value: unknown): value is TokenMeta {
  if (!value || typeof value !== "object") return false;
  const token = value as TokenMeta;
  return typeof token.address === "string" && isTokenAddress(token.address)
    && Number.isSafeInteger(token.chainId) && Number(token.chainId) > 0
    && typeof token.name === "string" && !!token.name.trim()
    && typeof token.symbol === "string" && !!token.symbol.trim()
    && (token.bridgeAddress === undefined || typeof token.bridgeAddress === "string" && isTokenAddress(token.bridgeAddress))
    && (token.counterpart === undefined || !!token.counterpart && typeof token.counterpart.address === "string" && isTokenAddress(token.counterpart.address) && Number.isSafeInteger(token.counterpart.chainId))
    && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 77;
}

export function loadBridgeTokens(): TokenMeta[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(isSavedBridgeToken) : [];
  } catch { return []; }
}

export function saveBridgeToken(token: TokenMeta, current: TokenMeta[]): TokenMeta[] {
  // Another tab may have imported tokens since this hook loaded its state.
  const persisted = loadBridgeTokens();
  const existing = [...persisted, ...current.filter(t => !persisted.some(saved =>
    saved.chainId === t.chainId && saved.address.toLowerCase() === t.address.toLowerCase()))];
  const previous = existing.find(t => t.chainId === token.chainId && t.address.toLowerCase() === token.address.toLowerCase());
  const tokens = [{ ...previous, ...token }, ...existing.filter(t => t.chainId !== token.chainId || t.address.toLowerCase() !== token.address.toLowerCase())];
  // Keep the selection usable for this session if browser storage is unavailable.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens)); } catch { /* private browsing / quota */ }
  return tokens;
}

function decodeText(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Missing token metadata");
  const decoded = decodeAbiParameters([{ type: "string" }], value as Hex)[0];
  if (!decoded.trim()) throw new Error("Missing token metadata");
  // Constructor strings must match the bridge payload byte-for-byte for CREATE2.
  return decoded;
}

/** Resolve metadata on the source chain before accepting a custom token. */
export async function readBridgeToken(rpc: string, address: string, chainId: number, signal?: AbortSignal): Promise<TokenMeta> {
  if (!isTokenAddress(address)) throw new Error("Invalid token address");
  const read = (data: string) => rpcCall(rpc, "eth_call", [{ to: address, data }, "latest"], signal);
  // Match Bridge._getSafeTokenMetadata for optional getters that revert.
  // Transport failures and malformed successful responses remain errors.
  const readText = async (selector: string, fallback: string) => {
    let value: unknown;
    try { value = await read(selector); }
    catch (error) {
      if (error instanceof RpcError && (error.code === 3 || /revert/i.test(error.message))) return fallback;
      throw error;
    }
    return decodeText(value);
  };
  const [name, symbol, rawDecimals] = await Promise.all([
    readText("0x06fdde03", "Unknown Token"), readText("0x95d89b41", "UNKTKN"), read("0x313ce567"),
  ]);
  if (typeof rawDecimals !== "string" || !/^0x[0-9a-f]{64}$/i.test(rawDecimals)) throw new Error("Missing token decimals");
  const decimals = Number(BigInt(rawDecimals));
  if (decimals < 0 || decimals > 77) throw new Error("Unsupported token decimals");
  return { address, chainId, name, symbol, decimals };
}
