import { useEffect, useRef, useState } from 'react';
import { toHex } from 'viem';
import { config, L1_CHAIN, L2_CHAIN } from '../config';
import type { useWallet } from './useWallet';
import { walletSetupRequest } from '../lib/walletSetupRequest';

export type WalletNetwork = { chainId: number; chainName: string };
export type NetworkSetup = { network: WalletNetwork; status: 'missing' | 'connecting' | 'ready'; message: string; needsAdd?: boolean };
// UI hints only. Every action still validates the wallet's current chain/account,
// and an unknown-chain response invalidates this hint immediately.
const confirmedNetworks = new WeakMap<EthereumProvider, Set<bigint>>();
export function networkErrorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: number; cause?: unknown; data?: { originalError?: unknown } };
    if (typeof value.code === 'number' && value.code !== -32603) return value.code;
    error = value.data?.originalError ?? value.cause;
  }
}

/** User-triggered network setup only; mounting this hook never opens a wallet prompt. */
export function useWalletNetworkSetup(wallet: Pick<ReturnType<typeof useWallet>, 'provider' | 'address' | 'isConnected' | 'chainId'>) {
  const [setup, setSetup] = useState<NetworkSetup | null>(null);
  const active = useRef(wallet); active.current = wallet;
  const mounted = useRef(false), running = useRef<AbortController | null>(null), revision = useRef(0);
  const remember = (chainId: bigint) => {
    if (!wallet.provider) return;
    const networks = confirmedNetworks.get(wallet.provider) ?? new Set<bigint>();
    networks.add(chainId); confirmedNetworks.set(wallet.provider, networks);
  };
  useEffect(() => {
    if (!wallet.isConnected || !wallet.chainId) return;
    try {
      const chain = BigInt(wallet.chainId);
      remember(chain);
      setSetup(current => current?.needsAdd && BigInt(current.network.chainId) === chain ? null : current);
    } catch { /* Unknown chain IDs are not remembered. */ }
  }, [wallet.provider, wallet.isConnected, wallet.chainId]);
  useEffect(() => {
    mounted.current = true; setSetup(null);
    const cancel = () => {
      revision.current++;
      running.current?.abort();
      running.current = null;
    };
    const invalidate = () => { cancel(); setSetup(null); };
    wallet.provider?.on('accountsChanged', invalidate);
    wallet.provider?.on('disconnect', invalidate);
    return () => {
      mounted.current = false; cancel();
      wallet.provider?.removeListener('accountsChanged', invalidate);
      wallet.provider?.removeListener('disconnect', invalidate);
    };
  }, [wallet.provider, wallet.address, wallet.isConnected]);
  const reportMissing = (network: WalletNetwork) => {
    if (wallet.provider) confirmedNetworks.get(wallet.provider)?.delete(BigInt(network.chainId));
    setSetup({ network, status: 'missing', needsAdd: true, message: `${network.chainName} is not in your wallet. Add it below to continue.` });
  };
  const clear = (network: WalletNetwork) => {
    remember(BigInt(network.chainId));
    setSetup(current => current?.network.chainId === network.chainId ? null : current);
  };

  async function connect(network: WalletNetwork) {
    if (running.current || !wallet.provider || !wallet.address || !wallet.isConnected) return;
    const operation = new AbortController();
    const provider = wallet.provider, address = wallet.address, version = revision.current;
    const current = () => mounted.current && running.current === operation && !operation.signal.aborted
      && revision.current === version && active.current.provider === provider
      && active.current.address === address && active.current.isConnected;
    const check = () => { if (!current()) throw new Error('Wallet or account changed. Try connecting again.'); };
    running.current = operation;
    const request = (args: Parameters<EthereumProvider['request']>[0], timeoutMs?: number) =>
      walletSetupRequest(provider, args, operation.signal, timeoutMs);
    let needsAdd = false;
    setSetup({ network, status: 'connecting', message: `Approve the switch to ${network.chainName} in your wallet.` });
    try {
      const definition = [L1_CHAIN, L2_CHAIN].find(chain => BigInt(chain.chainId) === BigInt(network.chainId));
      if (!definition) throw new Error('This network is not configured in the dashboard.');
      const chainId = toHex(network.chainId);
      try { await request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        check();
        if (networkErrorCode(error) !== 4902) throw error;
        needsAdd = true;
        confirmedNetworks.get(provider)?.delete(BigInt(network.chainId));
        const explorer = definition === L1_CHAIN ? config.l1Explorer : config.l2Explorer;
        const currency = { ...definition.nativeCurrency, symbol: [100, 10200].includes(network.chainId) ? 'XDAI' : definition.nativeCurrency.symbol };
        const params = { chainId, chainName: network.chainName, rpcUrls: [...definition.rpcUrls], nativeCurrency: currency,
          ...(explorer ? { blockExplorerUrls: [explorer] } : {}) };
        setSetup({ network, status: 'connecting', message: `Approve adding ${network.chainName} in your wallet, then approve the network switch.` });
        try { await request({ method: 'wallet_addEthereumChain', params: [params] }); }
        catch (error) {
          check();
          if (networkErrorCode(error) !== -32602 || !/nativeCurrency\.symbol does not match currency symbol/.test((error as Error).message)
            || !['XDAI', 'xDAI'].includes(currency.symbol)) throw error;
          await request({ method: 'wallet_addEthereumChain', params: [{ ...params,
            nativeCurrency: { ...currency, symbol: currency.symbol === 'XDAI' ? 'xDAI' : 'XDAI' } }] });
        }
        check();
        await request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
      check();
      const chain = await request({ method: 'eth_chainId' }, 20_000);
      const accounts = await request({ method: 'eth_accounts' }, 20_000);
      check();
      if (BigInt(String(chain)) !== BigInt(network.chainId)) throw new Error(`Select ${network.chainName} in your wallet, then try again.`);
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== address.toLowerCase()) throw new Error('Wallet account changed. Try connecting again.');
      remember(BigInt(network.chainId));
      setSetup({ network, status: 'ready', message: `Connected to ${network.chainName}.` });
    } catch (error) {
      if (!current()) return;
      const code = networkErrorCode(error);
      setSetup({ network, status: 'missing', needsAdd, message: code === 4001 ? 'Network setup cancelled. Try again when you are ready.'
        : code === -32002 ? 'A wallet request is already open. Finish it, then try again.'
        : error instanceof Error ? error.message.split('\n')[0]! : 'Could not connect the network. Check your wallet and try again.' });
    } finally {
      // An obsolete request must not unlock a newer wallet's setup operation.
      if (running.current === operation) running.current = null;
      operation.abort();
    }
  }
  return { setup, connect, reportMissing, clear, isConnecting: () => running.current !== null, busy: setup?.status === 'connecting',
    hasNetwork: (chainId: number) => !!wallet.provider && (confirmedNetworks.get(wallet.provider)?.has(BigInt(chainId)) ?? false) };
}
