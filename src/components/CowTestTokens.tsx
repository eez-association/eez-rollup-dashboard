import { useEffect, useRef, useState } from 'react';
import { decodeEventLog, encodeFunctionData, parseAbi } from 'viem';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import type { useWallet } from '../hooks/useWallet';
import { rpcCall } from '../rpc';
import { sendCrossChainWithFees } from '../lib/fees/payment.mjs';
import { cowScope, displayAmount, type CowConfig } from '../lib/cowLight';
import { ExplorerLink } from './ExplorerLink';
import styles from './CowLightDemo.module.css';

const abi = parseAbi(['function claim()', 'event Claimed(address indexed recipient, uint256 tokenAmount, uint256 gasAmount)']);
type Status = { address: string; owner: string; tokenAmount: string; gasAmount: string; funded: boolean; eligible: boolean;
  nextClaimAt: number; cooldown: number; l2TokenBalance: string; l2GasBalance: string };
type Request = { hash?: string; faucet: string; owner: string; tokenAmount: string; gasAmount: string; beforeToken: string; beforeGas: string };
type Wallet = ReturnType<typeof useWallet>;
async function status(owner: string): Promise<Status> {
  const response = await fetch(`${import.meta.env.BASE_URL}cowdemo/api/faucet?owner=${owner}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Test-token faucet is unavailable.');
  return data;
}

export function CowTestTokens({ cfg, wallet, disabled, onPending, onDelivered }: {
  cfg: CowConfig; wallet: Wallet; disabled: boolean; onPending: (pending: boolean) => void; onDelivered: () => void;
}) {
  const key = `eez:cow:faucet:${cowScope(cfg)}:${wallet.address?.toLowerCase()}`;
  const [info, setInfo] = useState<Status | null>(null);
  const [pending, setPending] = useState<Request | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const current = useRef({ wallet, key }); current.current = { wallet, key };
  const running = useRef(false);
  const delivered = useRef(onDelivered); delivered.current = onDelivered;
  useEffect(() => {
    setInfo(null); setError(''); setMessage('');
    try { setPending(JSON.parse(localStorage.getItem(key) || 'null')); }
    catch { setPending(null); setReadError('Unable to read the saved faucet request.'); }
  }, [key]);
  useEffect(() => { onPending(busy || !!pending); return () => onPending(false); }, [busy, pending, onPending]);
  useEffect(() => {
    if (!wallet.address) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const owner = wallet.address;
    const poll = async () => {
      try {
        const s = await status(owner);
        if (!active) return;
        setInfo(s); setReadError('');
        if (pending?.hash) {
          if (s.address.toLowerCase() !== pending.faucet.toLowerCase()) throw new Error('Faucet changed. Inspect your saved transaction before continuing.');
          const receipt = await rpcCall(config.l1Rpc, 'eth_getTransactionReceipt', [pending.hash]) as {
            status: string; blockNumber: string; blockHash: string; logs: { address: string; topics: `0x${string}`[]; data: `0x${string}` }[];
          } | null;
          if (!active || !receipt) return;
          const block = await rpcCall(config.l1Rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash: string } | null;
          if (!active || block?.hash !== receipt.blockHash) return;
          if (BigInt(receipt.status) !== 1n) {
            localStorage.removeItem(key); setPending(null); setError('Test-token request reverted. No delivery was confirmed.'); return;
          }
          const claimed = receipt.logs.some(log => {
            if (log.address.toLowerCase() !== pending.faucet.toLowerCase()) return false;
            try {
              const event = decodeEventLog({ abi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
              return event.args.recipient.toLowerCase() === pending.owner.toLowerCase()
                && event.args.tokenAmount === BigInt(pending.tokenAmount) && event.args.gasAmount === BigInt(pending.gasAmount);
            } catch { return false; }
          });
          if (!claimed) throw new Error('The receipt does not contain the expected faucet delivery.');
          if (BigInt(s.l2TokenBalance) >= BigInt(pending.beforeToken) + BigInt(pending.tokenAmount)
            && BigInt(s.l2GasBalance) >= BigInt(pending.beforeGas) + BigInt(pending.gasAmount)) {
            localStorage.removeItem(key); setPending(null);
            setMessage(`Received ${displayAmount(pending.tokenAmount)} ctWETH and ${displayAmount(pending.gasAmount)} ${cfg.l2NativeSymbol} on ${L2_CHAIN.chainName}.`);
            delivered.current();
          } else setMessage(`Included on ${L1_CHAIN.chainName}. Waiting to observe tokens and gas on ${L2_CHAIN.chainName}.`);
        }
      } catch (e) { if (active) setReadError((e as Error).message); }
      finally { if (active) timer = setTimeout(poll, 10000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [wallet.address, key, pending, revision, cfg.l2NativeSymbol]);

  async function claim() {
    if (running.current || !wallet.address || !wallet.provider || !info) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    const account = wallet.address, provider = wallet.provider, requestKey = key;
    const assertCurrent = () => {
      if (current.current.key !== requestKey || current.current.wallet.provider !== provider) throw new Error('Wallet changed. Review the test-token request again.');
    };
    let saved = false;
    try {
      if (BigInt(wallet.chainId || '0') !== BigInt(cfg.l1ChainId) && !await wallet.switchToL1()) throw new Error('Network switch cancelled.');
      assertCurrent();
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      const chain = await provider.request({ method: 'eth_chainId' }) as string;
      if (accounts[0]?.toLowerCase() !== account.toLowerCase() || BigInt(chain) !== BigInt(cfg.l1ChainId)) throw new Error('Wallet account or network changed.');
      const s = await status(account); assertCurrent();
      if (!s.funded || !s.eligible || s.address !== info.address) throw new Error('Faucet is empty, cooling down or has changed. Refresh before requesting.');
      const request: Request = { faucet: s.address, owner: account, tokenAmount: s.tokenAmount, gasAmount: s.gasAmount,
        beforeToken: s.l2TokenBalance, beforeGas: s.l2GasBalance };
      localStorage.setItem(requestKey, JSON.stringify(request)); saved = true; setPending(request);
      const tx = { from: account, to: s.address, data: encodeFunctionData({ abi, functionName: 'claim' }), value: '0x0', chainId: L1_CHAIN.chainId };
      // Use the dashboard fee path with the reviewed provider/account, even if
      // the header's selected wallet changes while a fee request is pending.
      const guarded = { ...provider, request: async (args: Parameters<EthereumProvider['request']>[0]) => {
        assertCurrent(); return provider.request(args);
      } };
      const hash = config.l1FeesEnabled
        ? await sendCrossChainWithFees({ tx, from: account, chainId: L1_CHAIN.chainId, wallet: guarded,
          rpc: (method: string, params: unknown[]) => rpcCall(config.l1ProxyRpc, method, params),
          maxTotalFee: BigInt(config.l1FeeMaxTotalWei), onQuote: assertCurrent })
        : await guarded.request({ method: 'eth_sendTransaction', params: [tx] }) as string;
      const submitted = { ...request, hash }; localStorage.setItem(requestKey, JSON.stringify(submitted));
      if (current.current.key === requestKey) { setPending(submitted); setMessage('Request submitted. Checking the receipt and destination balances…'); }
    } catch (e) {
      if (saved && (e as { code?: number }).code === 4001) { localStorage.removeItem(requestKey); if (current.current.key === requestKey) setPending(null); }
      if (current.current.key === requestKey) setError((e as Error).message);
    } finally { running.current = false; setBusy(false); }
  }
  return <section className={styles.faucet} aria-label="Get test tokens">
    <h4>Get test tokens</h4>
    <p className={styles.hint}>{info ? `${displayAmount(info.tokenAmount)} ctWETH + ${displayAmount(info.gasAmount)} ${cfg.l2NativeSymbol} for gas` : 'ctWETH and gas'} → {L2_CHAIN.chainName}.</p>
    <p className={styles.hint}>Your connected wallet pays {L1_CHAIN.chainName} gas. The official bridge delivers to that same address on {L2_CHAIN.chainName}. Test tokens have no monetary value.</p>
    {wallet.address && <p className={styles.hint}>Recipient: <ExplorerLink chain="l2" value={wallet.address} /></p>}
    {info && <p className={styles.hint}>One request per wallet every {info.cooldown / 3600} hours. {!info.funded ? 'The faucet needs refilling.' : !info.eligible ? `Available again ${new Date(info.nextClaimAt * 1000).toLocaleString()}.` : ''}</p>}
    <button disabled={disabled || busy || !!pending || !wallet.isConnected || !info?.funded || !info.eligible || !!readError} onClick={() => void claim()}>
      {busy ? 'Confirm in wallet…' : pending ? 'Checking delivery…' : 'Get test tokens'}</button>
    {!wallet.isConnected && <p className={styles.hint}>Connect your wallet using the dashboard or swap form first.</p>}
    {(error || readError) && <p role="alert" className={styles.error}>{error || readError}</p>}
    {readError && <button onClick={() => setRevision(x => x + 1)}>Retry faucet check</button>}
    {message && <p role="status" className={styles.hint}>{message}</p>}
    {pending?.hash && <ExplorerLink chain="l1" type="tx" value={pending.hash} label="Test-token request" />}
    {pending && !pending.hash && !busy && <><p className={styles.hint}>The wallet request has no transaction hash. Check your wallet before clearing it; this action will not resend it.</p>
      <button onClick={() => { localStorage.removeItem(key); setPending(null); setRevision(x => x + 1); }}>Clear unresolved wallet request</button></>}
  </section>;
}
