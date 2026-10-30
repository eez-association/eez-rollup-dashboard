import { useEffect, useRef } from 'react';
import { isAddress, toHex, type Address, type Hex } from 'viem';
import type { useWallet } from './useWallet';
import { errorCode, UnknownFeeSubmission, walletQuantity, type FeeTransaction } from '../lib/falcon/l2Fees.ts';
import { useWalletNetworkSetup, networkErrorCode, type WalletNetwork as Network } from './useWalletNetworkSetup';

export type FalconWallet = ReturnType<typeof useFalconWallet>;
export class WalletConnectionError extends Error {}
/** Stop waiting on stale extension reads; EIP-1193 cannot cancel the underlying wallet request. */
function readWallet(provider: EthereumProvider, args: Parameters<EthereumProvider['request']>[0], signal: AbortSignal) {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  return new Promise<unknown>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new WalletConnectionError('Wallet RPC timed out. Check your configured devnet connection.')), 20_000);
    Promise.resolve().then(() => provider.request(args)).then(resolve, reject);
  }).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}

/** Reuse the dashboard's selected connection; explicitly offer setup for missing networks.
 * Provider events invalidate in-flight work before React renders the new account/chain.
 */
export function useFalconWallet(wallet: ReturnType<typeof useWallet>) {
  const active = useRef<{ provider: EthereumProvider; address: Address } | null>(null);
  const revision = useRef(0);
  const observedChain = useRef<bigint | null>(null);
  const connection = useWalletNetworkSetup(wallet);
  const provider = wallet.provider;
  const address = wallet.isConnected && wallet.address && isAddress(wallet.address) ? wallet.address : null;
  if (active.current?.provider !== provider || active.current?.address !== address) {
    active.current = provider && address ? { provider, address } : null;
  }

  useEffect(() => {
    observedChain.current = null;
    if (!provider) return;
    const invalidateAccount = () => { revision.current++; active.current = null; };
    const invalidateChain = (value: unknown) => {
      let chain: bigint | null = null;
      try { chain = walletQuantity(value); } catch { /* Unknown events invalidate the session. */ }
      // A delayed/duplicate notification for the chain already confirmed by RPC
      // is not a new switch. Away-and-back events still advance the revision.
      if (chain === null || chain !== observedChain.current) revision.current++;
      observedChain.current = chain;
    };
    provider.on('accountsChanged', invalidateAccount);
    provider.on('chainChanged', invalidateChain);
    provider.on('disconnect', invalidateAccount);
    return () => {
      revision.current++;
      provider.removeListener('accountsChanged', invalidateAccount);
      provider.removeListener('chainChanged', invalidateChain);
      provider.removeListener('disconnect', invalidateAccount);
    };
  }, [provider]);

  async function getSession(signal: AbortSignal, network: Network) {
    if (connection.isConnecting()) throw new WalletConnectionError('Finish adding the network in your wallet, then try again.');
    const wantedChain = toHex(network.chainId);
    const session = active.current;
    const assertAccount = () => {
      signal.throwIfAborted();
      if (!session || active.current !== session) throw new WalletConnectionError('Wallet or account changed. Connect your wallet and try again.');
    };
    assertAccount();
    const provider = session!.provider;
    const chain = await readWallet(provider, { method: 'eth_chainId' }, signal);
    assertAccount();
    if (walletQuantity(chain) !== BigInt(network.chainId)) {
      try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wantedChain }] }); }
      catch (cause) {
        assertAccount();
        if (networkErrorCode(cause) !== 4902) throw cause;
        const message = `${network.chainName} is not in your wallet. Use Add ${network.chainName} above, then try again.`;
        connection.reportMissing(network);
        throw new WalletConnectionError(message);
      }
      assertAccount();
    }
    const validateIdentity = (actualChain: unknown, accounts: unknown) => {
      if (walletQuantity(actualChain) !== BigInt(network.chainId)) throw new Error(`Switch your wallet to ${network.chainName} before continuing.`);
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== session!.address.toLowerCase()) throw new Error('Wallet account changed. Review and try again.');
    };
    // Establish the session only after a stable chain/account read. Some wallets
    // deliver the requested switch event after wallet_switchEthereumChain resolves.
    // Retry only these read-only checks; never replay a sign/send request.
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = revision.current;
      const actualChain = await readWallet(provider, { method: 'eth_chainId' }, signal);
      const accounts = await readWallet(provider, { method: 'eth_accounts' }, signal);
      assertAccount();
      if (revision.current !== before) continue;
      validateIdentity(actualChain, accounts);
      observedChain.current = BigInt(network.chainId);
      stable = true;
      break;
    }
    if (!stable) throw new WalletConnectionError('Wallet network is still changing. Finish the network switch, then try again.');
    const initialRevision = revision.current;
    const assertCurrent = () => {
      assertAccount();
      if (revision.current !== initialRevision) throw new WalletConnectionError('Wallet network or account changed. Review and try again.');
    };
    const request = async (args: Parameters<EthereumProvider['request']>[0]) => {
      assertCurrent();
      const result = await readWallet(provider, args, signal);
      assertCurrent();
      return result;
    };
    const assertNetworkAndAccount = async () => {
      const actualChain = await request({ method: 'eth_chainId' });
      const accounts = await request({ method: 'eth_accounts' });
      validateIdentity(actualChain, accounts);
    };
    await assertNetworkAndAccount();
    connection.clear(network);
    return {
      account: session!.address,
      provider: { request },
      assertCurrent,
      async sendExactTransaction(tx: FeeTransaction, isCurrent: () => boolean, validate: () => void): Promise<Hex> {
        // The quote SDK has just read chain/account/nonce through this guarded session.
        // No asynchronous work may separate its final validation from opening the wallet prompt.
        assertCurrent();
        if (!isCurrent()) throw new Error('Signature or key changed. Review and try again.');
        if (tx.from.toLowerCase() !== session!.address.toLowerCase() || BigInt(tx.chainId) !== BigInt(wantedChain)) throw new Error('Quoted wallet session changed.');
        validate();
        try {
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
          if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Missing transaction hash.');
          // Retain even if the key/account changes while the extension owns the prompt.
          return hash as Hex;
        } catch (error) {
          if ([4001, -32602, 'l2_tip_underfunded'].includes(errorCode(error) ?? '')) throw error;
          throw Object.assign(new UnknownFeeSubmission('The wallet did not confirm a transaction hash. Check its activity and recover the transaction below before sending again.'), { cause: error });
        }
      },
      async sendTransaction(tx: { to: Address; data: Hex; gas: Hex; value?: Hex; nonce?: Hex }, isCurrent: () => boolean): Promise<Hex> {
        await assertNetworkAndAccount();
        if (tx.nonce !== undefined && walletQuantity(await request({ method: 'eth_getTransactionCount', params: [session!.address, 'pending'] })) !== BigInt(tx.nonce)) {
          throw new Error('Wallet nonce changed before submission. Review and try again.');
        }
        assertCurrent();
        if (!isCurrent()) throw new Error('Signature or key changed. Review and try again.');
        // A transaction prompt can outlive locking/account changes. Retain its hash for receipt lookup.
        try {
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, from: session!.address, chainId: wantedChain, value: tx.value ?? '0x0' }] });
          if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Wallet did not return a transaction hash.');
          return hash.toLowerCase() as Hex;
        } catch (error) {
          if ([4001, -32602].includes(errorCode(error) as number)) throw error;
          if (errorCode(error) === -32601) throw new WalletConnectionError('Your wallet cannot submit transactions on this network.');
          throw new UnknownFeeSubmission('The wallet did not confirm a transaction hash. Check its activity before sending again.');
        }
      },
    };
  }

  // Rabby advertises MetaMask compatibility too; check its identity first.
  const transactionType = provider?.isRabby || /rabby/i.test(wallet.walletName ?? '') ? '0x0' as const : '0x2' as const;
  return { address, chainId: wallet.chainId, name: wallet.walletName, transactionType, getSession, networkSetup: connection.setup, connectNetwork: connection.connect,
    l1Balance: wallet.l1Balance, l2Balance: wallet.l2Balance, refreshBalances: wallet.refreshBalances, hasNetwork: connection.hasNetwork };
}
