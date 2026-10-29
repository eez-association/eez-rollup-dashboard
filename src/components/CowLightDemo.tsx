import { useEffect, useRef, useState } from 'react';
import { encodeFunctionData, erc20Abi } from 'viem';
import { config, DISCOVERED_CHAIN_IDS, L1_CHAIN, L2_CHAIN } from '../config';
import type { useWallet } from '../hooks/useWallet';
import { rpcCall } from '../rpc';
import { ExplorerLink } from './ExplorerLink';
import { CowTokenList } from './CowTokenList';
import { cowScope, displayAmount, minimumOutput, orderData, orderTypes, requireFreshQuote, sellAmount,
  type CowConfig, type CowOrder, type CowQuote, type CowToken } from '../lib/cowLight';
import styles from './CowLightDemo.module.css';

const apiRoot = `${import.meta.env.BASE_URL}cowdemo/api`;
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiRoot + path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.status === 'deployment_required'
    ? 'CoW Light needs a verified deployment for the current network. Trading is disabled.'
    : data.error || 'CoW Light is not available for this network yet.');
  return data as T;
}
type Wallet = ReturnType<typeof useWallet>;
type Allowance = { balance: string; allowance: string };
type Pending = { signature: string; validTo: number };

export function CowLightDemo({ ready, wallet }: { ready: boolean; wallet: Wallet }) {
  const [cfg, setCfg] = useState<CowConfig | null>(null);
  const [tokens, setTokens] = useState<CowToken[]>([]);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => { controller.abort(); if (active) setLoadError('CoW Light did not respond. Try again.'); }, 15000);
    setCfg(null); setLoadError('');
    void (async () => {
      try {
        const demo = await api<CowConfig>('/config', { signal: controller.signal });
        if (!DISCOVERED_CHAIN_IDS.l1 || !DISCOVERED_CHAIN_IDS.l2
          || BigInt(demo.l1ChainId) !== BigInt(DISCOVERED_CHAIN_IDS.l1)
          || BigInt(demo.l2ChainId) !== BigInt(DISCOVERED_CHAIN_IDS.l2)) {
          throw new Error('CoW Light is configured for a different network. It cannot be opened on this dashboard.');
        }
        const catalog = await api<{ tokens: CowToken[] }>('/tokens', { signal: controller.signal });
        if (!catalog.tokens.length) throw new Error('No swap tokens are configured for this network.');
        if (active && !controller.signal.aborted) { setTokens(catalog.tokens); setCfg(demo); }
      } catch (e) { if (active && !controller.signal.aborted) setLoadError((e as Error).message); }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [ready, attempt]);
  return <section className={styles.demo} aria-label="CoW Light demo">
    <header className={styles.heading}><div><span className={styles.eyebrow}>[ CROSS-CHAIN SWAP ]</span>
      <h2>CoW Light</h2><p>Swap assets on {L2_CHAIN.chainName} using liquidity on {L1_CHAIN.chainName}.</p></div>
      <span className={styles.badge}>{cfg?.network || 'Network configuration'}</span></header>
    {cfg ? <Trading key={cowScope(cfg)} cfg={cfg} tokens={tokens} wallet={wallet} />
      : <div className={styles.card}><p role="status">{loadError || 'Checking CoW Light availability…'}</p>
        {loadError && <button type="button" onClick={() => setAttempt(x => x + 1)}>Retry</button>}</div>}
  </section>;
}

function Trading({ cfg, tokens, wallet }: { cfg: CowConfig; tokens: CowToken[]; wallet: Wallet }) {
  const [tokenAddress, setTokenAddress] = useState(tokens[0]!.address);
  const selected = tokens.find(t => t.address === tokenAddress)!;
  const [amount, setAmount] = useState('0.001');
  const [slippage, setSlippage] = useState('3');
  const [quote, setQuote] = useState<CowQuote | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [wrapper, setWrapper] = useState<{ wrapper: string; deployed: boolean } | null>(null);
  const [buyBalance, setBuyBalance] = useState<string | null>(null);
  const [orders, setOrders] = useState<CowOrder[]>([]);
  const [readError, setReadError] = useState('');
  const [ordersError, setOrdersError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [approval, setApproval] = useState('');
  const [now, setNow] = useState(Date.now());
  const [refresh, setRefresh] = useState(0);
  const [walletChoice, setWalletChoice] = useState('');
  const [wrapAmount, setWrapAmount] = useState('0.001');
  const storageKey = `eez:cow:pending:${cowScope(cfg)}:${wallet.address?.toLowerCase()}`;
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef({ wallet, amount, tokenAddress, slippage, wrapAmount });
  current.current = { wallet, amount, tokenAddress, slippage, wrapAmount };
  const mounted = useRef(true), actionLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    setQuote(null); setAllowance(null); setBuyBalance(null); setError(''); setMessage(''); setApproval('');
    try { setPending(JSON.parse(localStorage.getItem(storageKey) || 'null')); }
    catch { setPending(null); setError('Could not read pending order history.'); }
  }, [wallet.address, wallet.provider, storageKey]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setWrapper(null); setAllowance(null); setBuyBalance(null);
    const poll = async () => {
      try {
        const w = await api<{ wrapper: string; deployed: boolean }>(`/wrapper?token=${tokenAddress}`);
        const a = wallet.address ? await api<Allowance>(`/allowance?owner=${wallet.address}`) : null;
        const b = wallet.address ? await api<{ selected?: { balance: string } }>(`/balances?owner=${wallet.address}&token=${tokenAddress}`) : null;
        if (active) { setWrapper(w); setAllowance(a); setBuyBalance(b?.selected?.balance ?? null); setReadError(''); }
      } catch (e) { if (active) { setAllowance(null); setReadError((e as Error).message); } }
      finally { if (active) timer = setTimeout(poll, 15000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [wallet.address, tokenAddress, refresh]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<{ orders: CowOrder[] }>('/orders');
        if (active) {
          setOrders(data.orders); setOrdersError('');
          if (pending && data.orders.some(o => o.signature === pending.signature)) {
            localStorage.removeItem(storageKey); setPending(null); setRefresh(x => x + 1);
          }
        }
      } catch (e) { if (active) setOrdersError((e as Error).message); }
      finally { if (active) timer = setTimeout(poll, 5000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [pending, storageKey]);
  const ownOrders = orders.filter(o => o.signer?.toLowerCase() === wallet.address?.toLowerCase()).sort((a, b) => b.receivedAt - a.receivedAt);
  const unresolved = ownOrders.some(o => !['settled', 'failed', 'expired', 'rejected', 'reverted'].includes(o.solverDebug?.state || o.status));
  const fresh = !!quote && now - quote.fetchedAt < 60000;
  let amountWei = 0n, minimum = '', inputError = '';
  try { amountWei = sellAmount(amount); minimum = minimumOutput(quote?.amountOut || '0', slippage); } catch (e) { inputError = (e as Error).message; }
  const insufficient = !!allowance && BigInt(allowance.balance) < amountWei;
  const needsApproval = !!allowance && BigInt(allowance.allowance) < amountWei;
  const wrongChain = wallet.isConnected && BigInt(wallet.chainId || '0') !== BigInt(cfg.l2ChainId);
  const locked = !!busy || !!pending || unresolved;
  const sellSymbol = 'WETH';

  async function action(kind: 'quote' | 'approve' | 'sign' | 'wrap') {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(kind); setError(''); setMessage('');
    const snapshot = current.current;
    const account = snapshot.wallet.address, provider = snapshot.wallet.provider;
    const assertCurrent = () => {
      const c = current.current;
      if (!mounted.current || c.wallet.address !== account || c.wallet.provider !== provider
        || c.amount !== snapshot.amount || c.tokenAddress !== snapshot.tokenAddress || c.slippage !== snapshot.slippage || c.wrapAmount !== snapshot.wrapAmount) {
        throw new Error('Wallet or swap selection changed. Review the swap again.');
      }
    };
    const assertWallet = async () => {
      assertCurrent();
      if (!provider || !account) throw new Error('Connect your wallet first.');
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      const chain = await provider.request({ method: 'eth_chainId' }) as string;
      assertCurrent();
      if (accounts[0]?.toLowerCase() !== account.toLowerCase() || BigInt(chain) !== BigInt(cfg.l2ChainId)) throw new Error('Wallet account or network changed. Review the swap again.');
    };
    let signedLocally = false, postAttempted = false;
    try {
      if (kind === 'quote') {
        const q = await api<CowQuote>(`/quote?token=${selected.address}&amount=${sellAmount(amount)}`);
        assertCurrent(); setQuote({ ...q, fetchedAt: Date.now() }); return;
      }
      if (kind !== 'wrap') {
        if (!quote || !wrapper) throw new Error('Request a fresh quote first.');
        requireFreshQuote(quote);
      }
      if (wrongChain && !await snapshot.wallet.switchToL2()) throw new Error('Network switch cancelled.');
      await assertWallet();
      const live = await api<CowConfig>('/config');
      if (cowScope(live) !== cowScope(cfg) || live.vaultRelayer.toLowerCase() !== cfg.vaultRelayer.toLowerCase()) throw new Error('Deployment changed. Reload before trading.');
      await assertWallet();
      if (kind !== 'wrap') requireFreshQuote(quote!);
      if (kind === 'approve' || kind === 'wrap') {
        if (kind === 'wrap' && (!cfg.nativeWethL2 || cfg.nativeWethL2 !== live.nativeWethL2 || cfg.l2NativeSymbol !== 'ETH')) throw new Error('Native wrapping is not configured.');
        const tx = kind === 'wrap'
          ? { from: account, to: cfg.nativeWethL2, data: '0xd0e30db0', value: `0x${sellAmount(wrapAmount).toString(16)}` }
          : { from: account, to: cfg.wethL2, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.vaultRelayer as `0x${string}`, BigInt(quote!.amountIn)] }) };
        const hash = await provider!.request({ method: 'eth_sendTransaction', params: [tx] }) as string;
        if (mounted.current) { setApproval(hash); setMessage('Transaction submitted. Checking inclusion…'); }
        for (let i = 0; i < 60; i++) {
          const receipt = await rpcCall(config.l2Rpc, 'eth_getTransactionReceipt', [hash]) as { status: string } | null;
          if (receipt) {
            if (BigInt(receipt.status) !== 1n) throw new Error('Transaction reverted.');
            assertCurrent(); setRefresh(x => x + 1); setMessage(kind === 'wrap' ? 'Native ETH wrapped.' : 'Sell amount approved. Review and sign your order.'); return;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!mounted.current) return;
        }
        throw new Error('Confirmation is still pending. Check its transaction before trying again.');
      }
      const order = orderData(cfg, quote!, wrapper!.wrapper, account!, slippage);
      const typed = { domain: { name: 'Gnosis Protocol', version: 'v2', chainId: cfg.l2ChainId, verifyingContract: cfg.settlement },
        types: { ...orderTypes, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] },
        primaryType: 'Order', message: order };
      localStorage.setItem(storageKey, 'null');
      const signature = await provider!.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] }) as string;
      const signed = { signature, validTo: order.validTo };
      localStorage.setItem(storageKey, JSON.stringify(signed));
      signedLocally = true;
      if (mounted.current && current.current.wallet.address === account) setPending(signed);
      await assertWallet(); requireFreshQuote(quote!);
      postAttempted = true;
      await api('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order, signature, l1Token: selected.address }) });
      if (mounted.current) { setQuote(null); setMessage('Order submitted. Tracking settlement below.'); }
    } catch (e) {
      // A signature that never left this browser cannot be in the solver queue.
      if (signedLocally && !postAttempted) {
        localStorage.removeItem(storageKey);
        if (mounted.current && current.current.wallet.address === account) setPending(null);
      }
      if (mounted.current) setError((e as Error).message);
    }
    finally { actionLock.current = false; if (mounted.current) setBusy(''); }
  }

  return <>
    <div className={styles.layout}>
      <section className={styles.card} aria-label="Swap form"><h3>Swap</h3>
        <fieldset disabled={locked} className={styles.fields}>
          <div className={styles.asset}><div className={styles.row}><label htmlFor="cow-amount">You sell · {L2_CHAIN.chainName}</label><span>{sellSymbol}</span></div>
            <input id="cow-amount" className={styles.amount} inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} />
            <span className={styles.hint}>Balance: {allowance ? displayAmount(allowance.balance) : '—'}</span></div>
          <div className={styles.direction} aria-hidden="true">↓</div>
          <div className={styles.asset}><label htmlFor="cow-token">You receive · {L2_CHAIN.chainName}</label>
            <div className={styles.row}><strong className={styles.amount}>{fresh ? displayAmount(quote!.amountOut, selected.decimals) : '—'}</strong>
              <select id="cow-token" value={tokenAddress} onChange={e => { setTokenAddress(e.target.value); setQuote(null); }}>
                {tokens.map(t => <option key={t.address} value={t.address}>{t.symbol}</option>)}</select></div>
            <span className={styles.hint}>Balance: {buyBalance === null ? '—' : displayAmount(buyBalance, selected.decimals)}</span></div>
          <div className={styles.row}><label htmlFor="cow-slippage">Maximum slippage (%)</label>
            <input id="cow-slippage" className={styles.slippage} inputMode="decimal" value={slippage} onChange={e => setSlippage(e.target.value)} /></div>
        </fieldset>
        {fresh && <dl className={styles.metrics}><div><dt>Minimum received</dt><dd>{minimum ? displayAmount(minimum, selected.decimals) : '—'} {selected.symbol}</dd></div>
          <div><dt>Price impact</dt><dd>{(quote!.priceImpactBps / 100).toFixed(2)}%</dd></div><div><dt>Quote expires in</dt><dd>{Math.max(0, Math.ceil((60000 - (now - quote!.fetchedAt)) / 1000))}s</dd></div></dl>}
        <p className={styles.hint}>Recipient: {wallet.address ? <ExplorerLink value={wallet.address} /> : 'Your connected wallet'}</p>
        {wrongChain && <p className={styles.hint}>Your wallet will ask to switch to {L2_CHAIN.chainName} before approval or signing.</p>}
        {inputError && <p className={styles.warning}>{inputError}</p>}
        {insufficient && <p className={styles.warning}>Insufficient {sellSymbol} balance for this swap.</p>}
        {quote && !fresh && <p role="status" className={styles.hint}>Quote expired. Request a fresh quote.</p>}
        {!wallet.isConnected ? <>
          {wallet.walletOptions.length > 1 && <select aria-label="Choose wallet" value={walletChoice} onChange={e => setWalletChoice(e.target.value)}><option value="">Choose wallet</option>{wallet.walletOptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
          <button className={styles.primary} disabled={!wallet.hasProvider || wallet.walletOptions.length > 1 && !walletChoice} onClick={() => void wallet.connect(walletChoice || undefined)}>Connect wallet <span aria-hidden="true">→</span></button>
          {!wallet.hasProvider && <p className={styles.hint}>Install a wallet to connect and swap.</p>}
        </> : <button className={styles.primary} disabled={locked || !!inputError || !!readError || !!ordersError || (fresh && (!allowance || insufficient || !wrapper))}
          onClick={() => void action(!fresh ? 'quote' : needsApproval ? 'approve' : 'sign')}>
          {busy === 'quote' ? 'Getting quote…' : busy === 'approve' ? 'Approving sell amount…' : busy === 'sign' ? 'Signing order…' : pending ? 'Checking submitted order…' : unresolved ? 'Settlement pending…' : !fresh ? 'Get quote' : needsApproval ? 'Approve sell amount' : 'Sign order'} <span aria-hidden="true">→</span></button>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {readError && <p role="alert" className={styles.error}>{readError} <button onClick={() => setRefresh(x => x + 1)}>Retry balances</button></p>}
        {message && <p role="status" className={styles.hint}>{message}</p>}
        {approval && <ExplorerLink value={approval} type="tx" label="Wallet transaction" />}
        {pending && <p role="status" className={styles.hint}>A signed order is being checked. Do not sign another while its submission is uncertain.
          {now > pending.validTo * 1000 && <button onClick={() => { localStorage.removeItem(storageKey); setPending(null); }}>Dismiss expired submission</button>}</p>}
      </section>
      <aside className={styles.card} aria-label="Tokens and swap route">
        <CowTokenList tokens={tokens} selected={tokenAddress} locked={locked} onSelect={address => {
          if (address !== tokenAddress) { setTokenAddress(address); setQuote(null); }
        }} />
        <details><summary>How the swap settles</summary>
        <ol className={styles.route}><li><span>{L2_CHAIN.chainName}</span><p>Approve the sell amount, then sign your swap order.</p></li>
          <li><span>{L1_CHAIN.chainName}</span><p>The solver swaps through the selected liquidity pool.</p></li>
          <li><span>{L2_CHAIN.chainName}</span><p>Receive {selected.symbol} in your connected wallet when settlement succeeds.</p></li></ol></details>
        <details><summary>Liquidity and contracts</summary><dl className={styles.metrics}>
          <div><dt>Liquidity pool</dt><dd><ExplorerLink chain="l1" value={selected.pair} /></dd></div>
          <div><dt>Sell token</dt><dd><ExplorerLink value={cfg.wethL2} /></dd></div>
          <div><dt>Receive token</dt><dd>{wrapper ? <ExplorerLink value={wrapper.wrapper} /> : 'Checking…'}</dd></div>
          <div><dt>Settlement</dt><dd><ExplorerLink value={cfg.settlement} /></dd></div></dl>
          {wrapper && !wrapper.deployed && <p className={styles.hint}>The receive token wrapper will be deployed by the first inbound bridge.</p>}
          {quote && <p className={styles.hint}>Quoted at {L1_CHAIN.chainName} block {quote.block.toLocaleString()}.</p>}</details>
        {cfg.nativeWethL2 && cfg.l2NativeSymbol === 'ETH' && <details><summary>Wrap native ETH</summary>
          <p className={styles.hint}>Wrap native ETH on {L2_CHAIN.chainName}. This is a separate wallet transaction.</p>
          <label htmlFor="cow-wrap">ETH amount</label><input id="cow-wrap" inputMode="decimal" value={wrapAmount} disabled={locked} onChange={e => setWrapAmount(e.target.value)} />
          <button disabled={locked || !wallet.isConnected} onClick={() => void action('wrap')}>Wrap ETH</button>
          <p><ExplorerLink value={cfg.nativeWethL2} label="Native WETH contract" /></p></details>}
      </aside>
    </div>
    <section className={styles.card} aria-label="Swap activity"><h3>Your swaps</h3>
      {ordersError && <p role="alert" className={styles.error}>Activity could not refresh: {ordersError}</p>}
      {!wallet.address ? <p className={styles.hint}>Connect your wallet to see its swaps.</p> : !ownOrders.length ? <p className={styles.hint}>No orders submitted by this wallet yet.</p> : ownOrders.slice(0, 25).map(o => {
        const d = o.solverDebug, state = d?.state || o.status, tx = d?.settlement || d?.txHash;
        return <article className={styles.order} key={o.id}><div className={styles.row}><strong>{displayAmount(o.order.sellAmount)} {sellSymbol} → {o.quote?.tokenSymbol || 'Token'}</strong>
          <span className={state === 'settled' ? styles.success : styles.badge}>{state.replace(/_/g, ' ')}</span></div>
          <p className={styles.hint}>Signed minimum: {displayAmount(o.order.buyAmount, o.quote?.tokenDecimals ?? 18)} {o.quote?.tokenSymbol} · {new Date(o.receivedAt * 1000).toLocaleString()}</p>
          <div className={styles.links}>{tx && <><ExplorerLink value={tx} type="tx" label={`${L2_CHAIN.chainName} execution`} /><a href={`#/visualizer?mode=trace&chain=l2&tx=${tx}`}>Inspect execution</a></>}
            {d?.l1Tx && <ExplorerLink value={d.l1Tx} chain="l1" type="tx" label={`${L1_CHAIN.chainName} settlement`} />}</div>
          <details><summary>Settlement details</summary><p className={styles.hint}>{d?.message || 'Waiting for the solver.'}</p>
            {d?.error != null && <p className={styles.error}>{typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}</p>}<p className={styles.hint}>Order {o.id}</p></details>
        </article>;
      })}
    </section>
  </>;
}
