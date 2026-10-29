import { useState } from 'react';
import { L1_CHAIN } from '../config';
import { displayAmount, type CowToken } from '../lib/cowLight';
import { ExplorerLink } from './ExplorerLink';
import styles from './CowLightDemo.module.css';

export function CowTokenList({ tokens, selected, locked, onSelect }: {
  tokens: CowToken[]; selected: string; locked: boolean; onSelect: (address: string) => void;
}) {
  const [search, setSearch] = useState('');
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
        return <li key={token.address} className={`${styles.tokenItem} ${active ? styles.selectedToken : ''}`}>
          <button type="button" className={styles.tokenChoice} aria-label={`Select ${token.symbol}`} aria-pressed={active} disabled={locked}
            onClick={() => onSelect(token.address)}>
            <span className={styles.tokenIcon} aria-hidden="true">{token.symbol.slice(0, 2).toUpperCase()}</span>
            <span className={styles.tokenName}><strong>{token.symbol}</strong><span>{token.name}</span></span>
            <span className={styles.tokenSelection}>{active ? 'Selected ✓' : 'Select →'}</span>
          </button>
          <div className={styles.tokenMeta}><span>Uniswap V2 pair <ExplorerLink chain="l1" value={token.pair} /></span>
            {token.wethReserve != null && <span title="Reserve reported by the configured token catalog">Catalog reserve: {displayAmount(token.wethReserve)} WETH</span>}</div>
        </li>;
      })}
    </ul>
    {!visible.length && <p role="status" className={styles.hint}>No tokens match your search. <button onClick={() => setSearch('')}>Clear search</button></p>}
    {locked && <p className={styles.hint}>Token selection is locked while your wallet request or order is pending.</p>}
  </section>;
}
