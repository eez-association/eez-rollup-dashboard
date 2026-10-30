import { useEffect, useRef, useState } from 'react';
import { decodeEventLog, encodeFunctionData, parseAbi } from 'viem';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import type { useWallet } from '../hooks/useWallet';
import { rpcCall } from '../rpc';
import { sendCrossChainWithFees } from '../lib/fees/payment.mjs';
import { cowScope, displayAmount, type CowConfig } from '../lib/cowLight';
import { ExplorerLink } from './ExplorerLink';
import styles from './CowLightDemo.module.css';
import { cowApi } from '../lib/cowApi';
import { ComposerStatus } from './ComposerStatus';
import { useWalletNetworkSetup, networkErrorCode } from '../hooks/useWalletNetworkSetup';
import { WalletNetworkSetup } from './WalletNetworkSetup';

const abi = parseAbi(['function claim()', 'event Claimed(address indexed recipient, uint256 tokenAmount, uint256 gasAmount)']);
type Status = { address: string; owner: string; tokenAmount: string; gasAmount: string; funded: boolean; eligible: boolean;
  nextClaimAt: number; cooldown: number; l2TokenBalance: string; l2GasBalance: string };
type Request = { hash?: string; faucet: string; owner: string; tokenAmount: string; gasAmount: string; beforeToken: string; beforeGas: string };
type Wallet = ReturnType<typeof useWallet>;
async function status(owner: string): Promise<Status> {
  return cowApi<Status>(`/faucet?owner=${encodeURIComponent(owner)}`, undefined, 'Test-token faucet is unavailable.');
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
  const [phase, setPhase] = useState<'checking' | 'preparing' | 'confirming' | null>(null);
  const busy = phase !== null;
  const networkSetup = useWalletNetworkSetup(wallet);
  const onL1 = wallet.chainId !== null && BigInt(wallet.chainId) === BigInt(cfg.l1ChainId);
  const composerOnL1 = wallet.composerConnection.chainId !== null
    && BigInt(wallet.composerConnection.chainId) === BigInt(cfg.l1ChainId);
  const composerReady = composerOnL1 && wallet.composerConnection.status === 'detected';
  const checkingConnection = onL1 && (wallet.checkingComposer || !composerOnL1 || wallet.composerConnection.status === 'idle');
  const [revision, setRevision] = useState(0);
  const rpcRequiredMessage = `Use the ${L1_CHAIN.chainName} Composer RPC in your wallet before requesting test tokens.`;
  const current = useRef({ wallet, key }); current.current = { wallet, key };
  const running = useRef(false);
  const delivered = useRef(onDelivered); delivered.current = onDelivered;
  useEffect(() => {
    setInfo(null); setError(''); setReadError(''); setMessage('');
    try { setPending(JSON.parse(localStorage.getItem(key) || 'null')); }
    catch { setPending(null); setReadError('Unable to read the saved faucet request.'); }
  }, [key]);
  useEffect(() => {
    setError(previous => previous === rpcRequiredMessage ? '' : previous);
  }, [key, wallet.provider, wallet.chainId, rpcRequiredMessage]);
  useEffect(() => {
    const connection = wallet.composerConnection;
    if (connection.status === 'detected' && connection.chainId && BigInt(connection.chainId) === BigInt(cfg.l1ChainId)) {
      setError(previous => previous === rpcRequiredMessage ? '' : previous);
    }
  }, [wallet.composerConnection, cfg.l1ChainId, rpcRequiredMessage]);
  useEffect(() => { onPending(busy || networkSetup.busy || wallet.connectingComposer || !!pending); return () => onPending(false); },
    [busy, networkSetup.busy, wallet.connectingComposer, pending, onPending]);
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
    if (running.current || networkSetup.isConnecting() || wallet.connectingComposer || wallet.checkingComposer
      || disabled || pending || !onL1 || !composerReady || !wallet.address || !wallet.provider || !info) return;
    running.current = true; setPhase('checking'); setError(''); setMessage('');
    const account = wallet.address, provider = wallet.provider, requestKey = key;
    const assertCurrent = () => {
      if (current.current.key !== requestKey || current.current.wallet.provider !== provider) throw new Error('Wallet changed. Review the test-token request again.');
    };
    let saved = false;
    try {
      assertCurrent();
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      const chain = await provider.request({ method: 'eth_chainId' }) as string;
      if (accounts[0]?.toLowerCase() !== account.toLowerCase() || BigInt(chain) !== BigInt(cfg.l1ChainId)) throw new Error('Wallet account or network changed.');
      const composer = await wallet.verifyComposer();
      assertCurrent();
      if (composer.status !== 'detected' || !composer.chainId || BigInt(composer.chainId) !== BigInt(cfg.l1ChainId)) {
        throw new Error(rpcRequiredMessage);
      }
      setPhase('preparing');
      const s = await status(account); assertCurrent();
      if (!s.funded || !s.eligible || s.address.toLowerCase() !== info.address.toLowerCase()) throw new Error('Faucet is empty, cooling down or has changed. Refresh before requesting.');
      const request: Request = { faucet: s.address, owner: account, tokenAmount: s.tokenAmount, gasAmount: s.gasAmount,
        beforeToken: s.l2TokenBalance, beforeGas: s.l2GasBalance };
      const tx = { from: account, to: s.address, data: encodeFunctionData({ abi, functionName: 'claim' }), value: '0x0', chainId: L1_CHAIN.chainId };
      // Use the dashboard fee path with the reviewed provider/account, even if
      // the header's selected wallet changes while a fee request is pending.
      const guarded = { ...provider, request: async (args: Parameters<EthereumProvider['request']>[0]) => {
        assertCurrent();
        if (args.method === 'eth_sendTransaction') {
          // Persist only when a wallet submission is actually about to open.
          // Fee/RPC failures before this point are safe to retry normally.
          const [accounts, chain] = await Promise.all([
            provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }),
          ]);
          assertCurrent();
          if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== account.toLowerCase()
            || BigInt(String(chain)) !== BigInt(cfg.l1ChainId)) throw new Error('Wallet account or network changed.');
          localStorage.setItem(requestKey, JSON.stringify(request)); saved = true; setPending(request);
          setPhase('confirming');
        }
        return provider.request(args);
      } };
      const hash = config.l1FeesEnabled
        ? await sendCrossChainWithFees({ tx, from: account, chainId: L1_CHAIN.chainId, wallet: guarded,
          rpc: (method: string, params: unknown[]) => rpcCall(config.l1ProxyRpc, method, params),
          maxTotalFee: BigInt(config.l1FeeMaxTotalWei), onQuote: assertCurrent })
        : await guarded.request({ method: 'eth_sendTransaction', params: [tx] }) as string;
      const submitted = { ...request, hash }; localStorage.setItem(requestKey, JSON.stringify(submitted));
      if (current.current.key === requestKey) { setPending(submitted); setMessage('Request submitted. Checking the receipt and destination balances…'); }
    } catch (e) {
      const cancelled = networkErrorCode(e) === 4001;
      if (saved && cancelled) { localStorage.removeItem(requestKey); if (current.current.key === requestKey) setPending(null); }
      if (current.current.key === requestKey) setError(cancelled ? 'Request cancelled in your wallet. No test-token request was submitted.' : (e as Error).message);
    } finally { running.current = false; setPhase(null); }
  }
  return <section className={styles.faucet} aria-label="Get test tokens">
    <h4>Get test tokens</h4>
    <p className={styles.hint}>{info ? `${displayAmount(info.tokenAmount)} ctWETH + ${displayAmount(info.gasAmount)} ${cfg.l2NativeSymbol} for gas` : 'ctWETH and gas'} → {L2_CHAIN.chainName}.</p>
    <ol className={styles.faucetSteps} aria-label="Test-token request steps">
      <li>Switch your wallet to <strong>{L1_CHAIN.chainName}</strong>. This only changes the selected network.</li>
      <li>Confirm one faucet transaction in your wallet. You pay {L1_CHAIN.chainName} gas.</li>
      <li>Receive tokens and gas on <strong>{L2_CHAIN.chainName}</strong>, then switch back to swap.</li>
    </ol>
    <p className={styles.hint}>The official bridge delivers to your connected address. Test tokens have no monetary value.</p>
    {wallet.address && <p className={styles.hint}>Recipient: <ExplorerLink chain="l2" value={wallet.address} /></p>}
    {info && <p className={styles.hint}>One request per wallet every {info.cooldown / 3600} hours. {!info.funded ? 'The faucet needs refilling.' : !info.eligible ? `Available again ${new Date(info.nextClaimAt * 1000).toLocaleString()}.` : ''}</p>}
    {!onL1 && !pending && info?.eligible && <WalletNetworkSetup address={wallet.address} chainId={wallet.chainId}
      network={{ chainId: cfg.l1ChainId, chainName: L1_CHAIN.chainName }} setup={networkSetup.setup}
      disabled={disabled || busy || wallet.connectingComposer}
      onConnect={() => void networkSetup.connect({ chainId: cfg.l1ChainId, chainName: L1_CHAIN.chainName })} />}
    {(onL1 || !!pending) && <button disabled={disabled || busy || networkSetup.busy || wallet.connectingComposer || !!pending
      || !wallet.isConnected || !composerReady || checkingConnection || !info?.funded || !info.eligible || !!readError} onClick={() => void claim()}>
      {phase === 'checking' || checkingConnection && !pending ? 'Checking wallet RPC…'
        : phase === 'preparing' ? 'Preparing request…' : phase === 'confirming' ? 'Confirm in wallet…'
        : pending ? 'Checking delivery…' : 'Get test tokens'}</button>}
    {onL1 && !pending && !busy && !networkSetup.busy && composerReady && !checkingConnection && info?.eligible
      && <p role="status" className={styles.hint}>Connected to {L1_CHAIN.chainName}. Click Get test tokens to open the transaction confirmation.</p>}
    {phase && <p role="status" className={styles.hint}>{phase === 'checking' ? 'Checking the active wallet connection…'
      : phase === 'preparing' ? 'Checking faucet availability and preparing transaction fees…'
      : `Confirm the faucet transaction in ${wallet.walletName || 'your wallet'}. Tokens are requested only after you approve it.`}</p>}
    {onL1 && composerOnL1 && <ComposerStatus connection={wallet.composerConnection}
      checking={wallet.checkingComposer || busy || networkSetup.busy} onRecheck={wallet.recheckComposer} walletName={wallet.walletName} variant="notice"
      onConnectNetwork={wallet.connectComposer} connectingNetwork={wallet.connectingComposer} setupMessage={wallet.composerSetupMessage} />}
    {onL1 && !pending && info && !info.eligible && <button disabled={disabled || busy || networkSetup.busy || wallet.connectingComposer}
      onClick={() => void networkSetup.connect({ chainId: cfg.l2ChainId, chainName: L2_CHAIN.chainName })}>
      {networkSetup.busy ? 'Check your wallet…' : `Switch back to ${L2_CHAIN.chainName}`}</button>}
    {!wallet.isConnected && <p className={styles.hint}>Connect your wallet using the dashboard or swap form first.</p>}
    {(error || readError) && <p role="alert" className={styles.error}>{error || readError}</p>}
    {readError && <button onClick={() => setRevision(x => x + 1)}>Retry faucet check</button>}
    {message && <p role="status" className={styles.hint}>{message}</p>}
    {pending?.hash && <ExplorerLink chain="l1" type="tx" value={pending.hash} label="Test-token request" />}
    {pending && !pending.hash && !busy && <><p className={styles.hint}>The wallet request has no transaction hash. Check your wallet before clearing it; this action will not resend it.</p>
      <button onClick={() => { localStorage.removeItem(key); setPending(null); setRevision(x => x + 1); }}>Clear unresolved wallet request</button></>}
  </section>;
}
