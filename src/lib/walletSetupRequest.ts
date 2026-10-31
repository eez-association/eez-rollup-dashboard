/** Stop waiting on obsolete wallet setup requests without replaying a wallet prompt. */
export async function walletSetupRequest(
  provider: Pick<EthereumProvider, 'request'>,
  args: Parameters<EthereumProvider['request']>[0],
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<unknown>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        reject(new Error('Wallet RPC timed out. Check your wallet connection and try again.'));
      }, timeoutMs);
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return provider.request(args);
      }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
