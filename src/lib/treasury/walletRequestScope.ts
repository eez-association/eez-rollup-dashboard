/** A read/quote may finish after its screen was left. Check the originating
 * screen immediately before each provider request, including signature prompts.
 * Already-open wallet requests still return normally so their hashes can be saved.
 */
export function guardWalletRequests(provider: EthereumProvider, assertActive: () => void): EthereumProvider {
  // Delegate instead of proxying/altering extension objects: some wallets expose
  // non-configurable methods, which a Proxy get trap cannot safely replace.
  return {
    get isMetaMask() { return provider.isMetaMask; },
    get isRabby() { return provider.isRabby; },
    get providers() { return provider.providers; },
    request: args => { assertActive(); return provider.request(args); },
    on: (event, handler) => provider.on(event, handler),
    removeListener: (event, handler) => provider.removeListener(event, handler),
  };
}
