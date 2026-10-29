import { useEffect, useState } from 'react';
import { L1_CHAIN, L2_CHAIN } from '../config';
import { type CowToken } from '../lib/cowLight';
import styles from './CowLightDemo.module.css';

export function CowTokenList({ tokens, selected, locked, onSelect }: {
  tokens: CowToken[]; selected: string; locked: boolean; onSelect: (address: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [bridges, setBridges] = useState<Record<string, { deployed?: boolean; wrapper?: string; error?: boolean }>>({});
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next = 0;
      const worker = async () => {
        while (!controller.signal.aborted && next < tokens.length) {
          const token = tokens[next++]!;
          const request = new AbortController();
          const abort = () => request.abort();
          controller.signal.addEventListener('abort', abort, { once: true });
          const timeout = setTimeout(abort, 15000);
          try {
            const response = await fetch(`${import.meta.env.BASE_URL}cowdemo/api/wrapper?statusOnly=1&token=${encodeURIComponent(token.address)}`, { signal: request.signal });
            const data = await response.json() as { token: string; wrapper: string; deployed: boolean };
            if (!response.ok || data.token?.toLowerCase() !== token.address.toLowerCase()
              || typeof data.deployed !== 'boolean' || !/^0x[0-9a-fA-F]{40}$/.test(data.wrapper)) throw new Error('Wrapper check unavailable');
            if (!controller.signal.aborted) setBridges(previous => ({ ...previous, [token.address]: { deployed: data.deployed, wrapper: data.wrapper } }));
          } catch {
            if (!controller.signal.aborted) setBridges(previous => ({ ...previous, [token.address]: { error: true } }));
          } finally {
            clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
          }
        }
      };
      // Large mainnet catalogs must not flood the bridge/RPC with parallel reads.
      await Promise.all(Array.from({ length: Math.min(3, tokens.length) }, worker));
      if (!controller.signal.aborted) timer = setTimeout(poll, 60000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [tokens]);
  const query = search.trim().toLowerCase();
  const visible = tokens.filter(t => `${t.symbol} ${t.name} ${t.address}`.toLowerCase().includes(query));
  return <section aria-label="Available tokens" className={styles.tokenCatalog}>
    <div className={styles.row}><h3>Available tokens</h3><span className={styles.badge}>{visible.length} / {tokens.length}</span></div>
    <p className={styles.hint}>Choose a token from the {L1_CHAIN.chainName} liquidity pools to receive on your rollup.</p>
    <label className={styles.hint} htmlFor="cow-token-search">Search tokens</label>
    <input id="cow-token-search" type="search" placeholder="Symbol, name or address…" value={search} onChange={event => setSearch(event.target.value)} />
    <ul className={styles.tokenList}>
      {visible.map(token => {
        const active = token.address === selected;
        const bridge = bridges[token.address];
        return <li key={token.address} className={`${styles.tokenItem} ${active ? styles.selectedToken : ''}`}>
          <button type="button" className={styles.tokenChoice} aria-label={`Select ${token.symbol}`} aria-pressed={active} disabled={locked}
            onClick={() => onSelect(token.address)}>
            <span className={styles.tokenIcon} aria-hidden="true">{token.symbol.slice(0, 2).toUpperCase()}</span>
            <span className={styles.tokenName}><strong>{token.symbol}</strong><span>{token.name}</span></span>
            <span className={styles.tokenStatus}>
              <span className={`${styles.bridgeBadge} ${bridge?.deployed ? styles.bridgeReady : ''}`}
                title={bridge?.error ? 'Bridge status could not be checked. It will retry automatically.' : bridge?.deployed ? 'Canonical L2 wrapper is deployed.' : 'The first inbound bridge deploys the L2 wrapper.'}>
                {!bridge ? 'Checking…' : bridge.error ? 'Unavailable' : bridge.deployed ? 'Bridged' : 'Not bridged'}
              </span>
              {active && <span className={styles.tokenSelection}>Selected ✓</span>}
            </span>
          </button>
        </li>;
      })}
    </ul>
    {!visible.length && <p role="status" className={styles.hint}>No tokens match your search. <button onClick={() => setSearch('')}>Clear search</button></p>}
    <p className={styles.hint}>Bridged means the canonical token wrapper is deployed on {L2_CHAIN.chainName}. Status refreshes automatically.</p>
    {locked && <p className={styles.hint}>Token selection is locked while your wallet request or order is pending.</p>}
  </section>;
}
