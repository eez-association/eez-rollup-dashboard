import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import type { BridgeAsset, BridgeDirection, TokenMeta } from "../hooks/useBridge";
import { useBridgeTokens } from "../hooks/useBridgeTokens";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { resolveBridgeTokenPair } from "../lib/bridgeTokenPair";
import { isTokenAddress, readBridgeToken } from "../lib/bridgeTokens";
import styles from "./BridgeTokenPicker.module.css";

interface Props {
  direction: BridgeDirection;
  walletAddress: string | null;
  asset: BridgeAsset;
  tokenAddress: string;
  recentTokens: TokenMeta[];
  disabled: boolean;
  onSelect: (address: string, pair?: [TokenMeta, TokenMeta]) => void;
  onClose: () => void;
}

export function BridgeTokenPicker({ direction, walletAddress, asset, tokenAddress, recentTokens, disabled, onSelect, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const chain = direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN;
  const chainId = Number(BigInt(chain.chainId));
  const rpc = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
  const network = direction === "l1-to-l2" ? config.l1NetworkName : config.rollupName;
  const query = search.trim().toLowerCase();
  const address = isTokenAddress(query) ? search.trim() : "";
  const catalog = useBridgeTokens(!!query && !address, direction, walletAddress, recentTokens);
  const sourceBridge = direction === "l1-to-l2" ? config.l1Bridge : config.l2Bridge;
  const destination = direction === "l1-to-l2" ? L2_CHAIN : L1_CHAIN;
  const destinationRpc = direction === "l1-to-l2" ? config.l2Rpc : config.l1Rpc;
  const destinationBridge = direction === "l1-to-l2" ? config.l2Bridge : config.l1Bridge;
  const destinationChainId = Number(BigInt(destination.chainId));
  const destinationName = direction === "l1-to-l2" ? config.rollupName : config.l1NetworkName;
  const saved = recentTokens.filter(token => token.chainId === chainId && (!token.bridgeAddress || token.bridgeAddress.toLowerCase() === sourceBridge.toLowerCase()));
  const matches = (token: TokenMeta) => [token.symbol, token.name, token.address].some(value => value.toLowerCase().includes(query));
  const tokens = saved.filter(matches).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const discovered = query ? catalog.tokens.filter(token => matches(token)
    && !saved.some(item => item.address.toLowerCase() === token.address.toLowerCase())) : [];
  const native = chain.nativeCurrency;
  const showNative = !query || [native.name, native.symbol, "native"].some(value => value.toLowerCase().includes(query));
  const findCounterpart = (token: TokenMeta) => token.counterpart?.chainId === destinationChainId
    ? recentTokens.find(t => t.chainId === destinationChainId && t.address.toLowerCase() === token.counterpart!.address.toLowerCase()
      && t.bridgeAddress?.toLowerCase() === destinationBridge.toLowerCase()) : undefined;
  const needsLookup = !!address && !tokens.some(token => findCounterpart(token));
  const lookupKey = `${chainId}:${rpc}:${sourceBridge}:${destinationChainId}:${destinationRpc}:${destinationBridge}:${address}:${retry}`;
  const [lookup, setLookup] = useState<{ key: string; pair?: [TokenMeta, TokenMeta]; error?: string } | null>(null);
  const result = lookup?.key === lookupKey ? lookup : null;

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!needsLookup) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    const timer = window.setTimeout(async () => {
      try {
        const token = await readBridgeToken(rpc, address, chainId, controller.signal);
        const pair = await resolveBridgeTokenPair(token, {rpc,bridge:sourceBridge,chainId},
          {rpc:destinationRpc,bridge:destinationBridge,chainId:destinationChainId},controller.signal);
        if (!cancelled) setLookup({ key: lookupKey, pair });
      } catch (error) {
        if (!cancelled) setLookup({ key: lookupKey, error: error instanceof Error && error.message.includes("does not support") ? error.message : `Couldn’t add this token. Check its address on ${network} and the connection to both networks.` });
      } finally { window.clearTimeout(timeout); }
    }, 250);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [needsLookup, lookupKey, rpc, address, chainId, network, sourceBridge, destinationRpc, destinationBridge, destinationChainId]);

  const choose = (token: TokenMeta) => {
    const counterpart = findCounterpart(token);
    if (counterpart) onSelect(token.address, [token, counterpart]);
    else setSearch(token.address);
  };

  const row = (token: TokenMeta & { balance?: bigint }, isSaved: boolean) => <li key={token.address.toLowerCase()}>
    <button type="button" className={styles.token} disabled={disabled}
      aria-label={`${isSaved ? "Select" : "Add"} ${token.symbol} ${token.address}`}
      aria-pressed={asset === "erc20" && token.address.toLowerCase() === tokenAddress.toLowerCase()}
      onClick={() => choose(token)}>
      <span className={styles.icon} aria-hidden="true">{token.symbol.slice(0, 2)}</span>
      <span className={styles.tokenText}><strong>{token.symbol}</strong><span>{token.name}{token.predicted ? " · Not deployed yet" : ""}</span>
        <code title={token.address}>{token.address.slice(0, 6)}…{token.address.slice(-4)}</code></span>
      <span className={styles.trailing}>{!isSaved ? "Add" : token.balance !== undefined ? formatUnits(token.balance, token.decimals) :
        asset === "erc20" && token.address.toLowerCase() === tokenAddress.toLowerCase() ? "✓" : ""}</span>
    </button>
  </li>;

  return <div className={styles.picker} role="group" aria-label="Bridge asset choices">
    <div className={styles.header}><div><strong>Select a token</strong><p>From {network}</p></div>
      <button type="button" className={styles.close} aria-label="Close token picker" onClick={onClose}>×</button></div>
    <input ref={input} className={styles.search} aria-label="Search tokens" placeholder="Search name or paste address"
      autoComplete="off" spellCheck={false} value={search} onChange={e => setSearch(e.target.value)} disabled={disabled} />
    <ul className={styles.tokens}>
      {showNative && <li><button type="button" className={styles.token} disabled={disabled} aria-label={`Select ${native.symbol} native token`}
        aria-pressed={asset === "eth"} onClick={() => onSelect("")}>
        <span className={`${styles.icon} ${styles.nativeIcon}`} aria-hidden="true">{native.symbol === "ETH" ? "Ξ" : native.symbol.slice(0, 2)}</span>
        <span className={styles.tokenText}><strong>{native.symbol}</strong><span>{native.name} · Native token</span></span>
        {asset === "eth" && <span className={styles.trailing}>✓</span>}
      </button></li>}
      {tokens.length > 0 && <li className={styles.sectionLabel}>Saved tokens</li>}
      {tokens.map(token => row(token, true))}
      {!address && discovered.length > 0 && <li className={styles.sectionLabel}>Search results</li>}
      {!address && discovered.slice(0, 100).map(token => row(token, false))}
    </ul>
    {needsLookup && <div className={styles.import}>
      {!result ? <p className={styles.hint} role="status">Looking up token…</p> : result.error ? <><p className={styles.error} role="status">{result.error}</p><button type="button" className={styles.add} onClick={() => setRetry(value => value + 1)}>Try again</button></> : result.pair && <>
        <div className={styles.tokenText}><strong>{result.pair[0].symbol}</strong><span>{result.pair[0].name}</span></div>
        <code className={styles.address}>{result.pair[0].address}</code>
        <p className={styles.hint}>Also added on {destinationName}{result.pair[1].predicted ? " · Not deployed yet" : ""}</p>
        <code className={styles.address}>{result.pair[1].address}</code>
        <button type="button" className={styles.add} disabled={disabled} onClick={() => onSelect(result.pair![0].address, result.pair)}>Add token & select</button>
      </>}
    </div>}
    {query.startsWith("0x") && !address && <p className={styles.error} role="status">Enter a complete token contract address.</p>}
    {!query && !tokens.length && <p className={styles.empty}>No saved tokens yet. Search by name or paste a token address to add one.</p>}
    {query && !address && catalog.loading && <p className={styles.hint} role="status">Searching tokens…</p>}
    {query && !address && !catalog.loading && !tokens.length && !discovered.length && !showNative && !query.startsWith("0x") &&
      <p className={styles.empty}>No tokens found. Try pasting the token’s contract address.</p>}
    <p className={styles.footer}>Token pairs are saved in this browser.</p>
  </div>;
}
