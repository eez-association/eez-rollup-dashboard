import { rpcCall } from '../../rpc.ts';

/** Dashboard reads never use wallet routing or open wallet prompts. */
export function falconReadProvider(url: string, signal: AbortSignal, network: string): Pick<EthereumProvider, 'request'> {
  return { async request({ method, params = [] }) {
    signal.throwIfAborted();
    if (!/^(eth_(chainId|blockNumber|get[A-Za-z0-9]+|call|estimateGas|gasPrice)|eez_get[A-Za-z0-9]+|eez_composerInfo)$/.test(method)) {
      throw new Error('Only read-only RPC methods are allowed for confirmation.');
    }
    try { return await rpcCall(url, method, params, AbortSignal.any([signal, AbortSignal.timeout(15_000)])); }
    catch (error) {
      signal.throwIfAborted();
      if ((error as { code?: number }).code === -32601) throw new Error(`${network} RPC does not support ${method}.`);
      // Do not classify observation RPC errors as fee-quote or wallet failures.
      throw new Error(`${network} confirmation read failed. ${error instanceof Error ? error.message.split('\n')[0] : 'Retrying shortly.'}`);
    }
  } };
}

export function confirmationDelay(signal: AbortSignal, milliseconds = 4000) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
