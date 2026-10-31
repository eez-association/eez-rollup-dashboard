import { useEffect, useRef, useState } from 'react';
import { getAddress, toHex, type Hex } from 'viem';
import type { useWallet } from '../hooks/useWallet';
import type { BridgeDirection } from '../hooks/useBridge';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import { rpcCall } from '../rpc';
import { walletSetupRequest } from '../lib/walletSetupRequest';
import { networkErrorCode } from '../hooks/useWalletNetworkSetup';
import { loadTestTokenArtifact, observeTestToken, parseTestToken, readTestTokenDeployment, testTokenData, testTokenErrorMessage, type TestTokenDeployment } from '../lib/bridgeTestToken';
import styles from './BridgeTestToken.module.css';

type Props = { wallet: Pick<ReturnType<typeof useWallet>, 'address' | 'provider' | 'switchToL1' | 'switchToL2'>;
  direction: BridgeDirection; disabled: boolean };

export function BridgeTestToken(props: Props) {
  const [open,setOpen] = useState(false);
  return <details className={styles.card} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><span>Create test token</span><span className={styles.chevron} aria-hidden="true">⌄</span></summary>
    {open && <TokenPanel {...props} />}
  </details>;
}

function TokenPanel({wallet,direction,disabled}: Props) {
  const side = direction === 'l1-to-l2' ? 'l1' : 'l2';
  const chain = side === 'l1' ? L1_CHAIN : L2_CHAIN;
  const chainId = Number(BigInt(chain.chainId));
  const rpc = side === 'l1' ? config.l1Rpc : config.l2Rpc;
  const bridge = side === 'l1' ? config.l1Bridge : config.l2Bridge;
  const networkName = side === 'l1' ? config.l1NetworkName : config.rollupName;
  const account = wallet.address;
  const key = `eez:bridge:test-token:${chainId}:${bridge.toLowerCase()}:${account?.toLowerCase() ?? ''}`;
  const [name,setName] = useState('Bridge Test Token'), [symbol,setSymbol] = useState('TEST'), [amount,setAmount] = useState('10000');
  const [stored,setStored] = useState<{key:string;request:TestTokenDeployment|null;error:string}>({key:'',request:null,error:''});
  const request = stored.key === key ? stored.request : null;
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [error,setError] = useState('');
  const [progress,setProgress] = useState('');
  const current = useRef({key,provider:wallet.provider,disabled}); current.current = {key,provider:wallet.provider,disabled};
  const mounted = useRef(false), operation = useRef<AbortController|null>(null);
  const refresh = () => {
    if (!mounted.current || current.current.key !== key) return;
    try { setStored({key,request:readTestTokenDeployment(localStorage.getItem(key)),error:''}); }
    catch { setStored({key,request:null,error:'Cannot read the saved token deployment. Preserve browser storage and check your wallet activity.'}); }
  };
  useEffect(()=>{
    mounted.current = true; refresh(); setMessage(''); setError(''); setBusy(false);
    const changed = (event:StorageEvent) => { if (event.key === key || event.key === null) refresh(); };
    const invalidate = () => operation.current?.abort();
    window.addEventListener('storage',changed);
    wallet.provider?.on('accountsChanged',invalidate); wallet.provider?.on('disconnect',invalidate);
    return ()=>{
      mounted.current = false; operation.current?.abort(); operation.current = null;
      window.removeEventListener('storage',changed);
      wallet.provider?.removeListener('accountsChanged',invalidate); wallet.provider?.removeListener('disconnect',invalidate);
    };
  },[key,wallet.provider]);
  const readRpc = (signal:AbortSignal) => (method:string,params:unknown[]=[]) => rpcCall(rpc,method,params,AbortSignal.any([signal,AbortSignal.timeout(15_000)]));
  const mutate = async (change:(saved:TestTokenDeployment|null)=>TestTokenDeployment|null) => {
    if (!navigator.locks) throw new Error('Token deployment requires browser Web Locks support.');
    await navigator.locks.request(key,()=>{
      const next = change(readTestTokenDeployment(localStorage.getItem(key)));
      if (next) { readTestTokenDeployment(JSON.stringify(next)); localStorage.setItem(key,JSON.stringify(next)); }
      else localStorage.removeItem(key);
      refresh();
    });
  };
  const run = async (action:(signal:AbortSignal,assertCurrent:()=>void)=>Promise<void>) => {
    if (operation.current || disabled) return;
    const abort = new AbortController(), provider = wallet.provider;
    operation.current = abort; setBusy(true); setError(''); setMessage(''); setProgress('Checking wallet…');
    const assertCurrent = () => {
      abort.signal.throwIfAborted();
      if (!mounted.current || current.current.key !== key || current.current.provider !== provider || current.current.disabled) throw new Error('Wallet or bridge selection changed. Review and try again.');
    };
    try { await action(abort.signal,assertCurrent); }
    catch (e) { if (!abort.signal.aborted && mounted.current && current.current.key === key) setError(networkErrorCode(e) === 4001 ? 'Deployment cancelled in your wallet.' : testTokenErrorMessage(e)); }
    finally { if (operation.current === abort) { operation.current = null; if (mounted.current) setBusy(false); } }
  };
  useEffect(()=>{
    if (!request?.hash || request.outcome) return;
    const saved = request, abort = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await observeTestToken(readRpc(abort.signal),saved,await loadTestTokenArtifact());
        abort.signal.throwIfAborted();
        if (next.outcome) {
          await mutate(current=>current?.id === saved.id && current.hash === saved.hash ? next : current);
          if (!abort.signal.aborted) setError('');
          return;
        }
      } catch(e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Could not check the deployment yet.'); }
      if (!abort.signal.aborted) timer = setTimeout(()=>void poll(),3000);
    };
    void poll();
    return ()=>{abort.abort();clearTimeout(timer);};
  },[key,request?.id,request?.hash,request?.outcome]);

  const deploy = () => void run(async (signal,assertCurrent)=>{
    if (!account || !wallet.provider) throw new Error('Connect your wallet above first.');
    const input = parseTestToken({name,symbol,amount});
    const data = testTokenData(input,await loadTestTokenArtifact()), provider = wallet.provider;
    assertCurrent();
    setProgress(`Switching to ${networkName}…`);
    if (!await (side === 'l1' ? wallet.switchToL1() : wallet.switchToL2())) throw new Error('Network switch cancelled.');
    const walletRead = (method:string,params:unknown[]=[]) => walletSetupRequest(provider,{method,params},signal,20_000);
    const checkWallet = async () => {
      const [accounts,id] = await Promise.all([walletRead('eth_accounts'),walletRead('eth_chainId')]);
      assertCurrent();
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== account.toLowerCase() || BigInt(String(id)) !== BigInt(chainId)) throw new Error('Wallet account or network changed.');
    };
    await checkWallet();
    setProgress('Estimating deployment gas…');
    const read = readRpc(signal);
    if (BigInt(await read('eth_chainId') as string) !== BigInt(chainId)) throw new Error('The deployment RPC serves a different network.');
    const gas = BigInt(await read('eth_estimateGas',[{from:account,data,value:'0x0'}]) as string);
    const nonce = toHex(BigInt(String(await walletRead('eth_getTransactionCount',[account,'pending']))));
    await checkWallet();
    const draft:TestTokenDeployment = {version:1,id:crypto.randomUUID(),chainId,account:getAddress(account),nonce,
      input:{name:input.name,symbol:input.symbol,amount:input.amount},data};
    await mutate(saved=>{
      assertCurrent();
      if (saved) throw new Error('A token deployment is already saved. Finish or review it first.');
      return draft;
    });
    let submitted = false;
    try {
      await checkWallet();
      if (BigInt(String(await walletRead('eth_getTransactionCount',[account,'pending']))) !== BigInt(nonce)) throw new Error('Wallet nonce changed. Review and try again.');
      assertCurrent(); submitted = true;
      setProgress('Confirm in wallet…');
      // The wallet owns this prompt. Keep its eventual reply even after closing
      // the panel or switching networks; never automatically send another one.
      const hash = await provider.request({method:'eth_sendTransaction',params:[{from:account,chainId:toHex(chainId),data,value:'0x0',nonce,gas:toHex((gas*120n+99n)/100n)}]});
      if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('No transaction hash returned. Check your wallet activity.');
      await mutate(saved=>saved?.id === draft.id && !saved.hash ? {...saved,hash:hash as Hex} : saved);
    } catch(e) {
      if (!submitted || [4001,-32602].includes(networkErrorCode(e) ?? 0)) await mutate(saved=>saved?.id === draft.id && !saved.hash ? null : saved);
      throw e;
    }
  });
  const locked = disabled || busy || stored.key !== key || !!stored.error;
  return <section className={styles.panel} aria-label="Create test token panel">
    <p className={styles.hint}>{networkName} · 18 decimals</p>
    {!request && <>
      <fieldset disabled={locked}>
        <label>Token name<input value={name} maxLength={48} onChange={e=>setName(e.target.value)} /></label>
        <label>Token symbol<input value={symbol} maxLength={12} onChange={e=>setSymbol(e.target.value)} /></label>
        <label>Initial supply<input value={amount} inputMode="decimal" maxLength={97} onChange={e=>setAmount(e.target.value)} /></label>
      </fieldset>
      <button type="button" className="btn btn-solid btn-block" disabled={locked || !account} onClick={deploy}>{busy ? progress : 'Deploy test token'}</button>
      {!account && <p className={styles.hint}>Connect your wallet above to deploy.</p>}
    </>}
    {request && <>
      <p role="status">{request.outcome === 'confirmed' ? 'Token deployed'
        : request.outcome === 'reverted' ? 'Deployment reverted.'
        : request.outcome === 'replaced' ? 'Deployment cancelled or replaced.'
        : request.hash ? 'Deploying…' : busy ? 'Confirm in wallet…' : 'Check your wallet for the deployment.'}</p>
      {request.address && <code className={styles.address}>{request.address}</code>}
      <div className={styles.actions}>
        {request.address && <button type="button" className="btn btn-solid" onClick={()=>void navigator.clipboard.writeText(request.address!).then(()=>setMessage('Address copied.'),()=>setError('Select the address above to copy it.'))}>Copy address</button>}
        {(request.outcome || !request.hash && !busy) && <button type="button" className="btn btn-outline" disabled={locked} onClick={()=>void run(async (_signal,assertCurrent)=>{
          await mutate(saved=>{
            assertCurrent();
            if (saved?.id !== request.id || saved.hash !== request.hash) throw new Error('Deployment changed. Check again.');
            localStorage.setItem(`${key}:completed:${saved.id}`,JSON.stringify(saved)); return null;
          });
        })}>Deploy another token</button>}
      </div>
    </>}
    {message && <p role="status">{message}</p>}
    {(error || stored.error) && <p className={styles.error} role="alert">{error || stored.error}</p>}
  </section>;
}
