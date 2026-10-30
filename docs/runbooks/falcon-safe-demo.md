# Falcon Safe demo

Falcon Safe is a native, lazy-loaded dashboard tab immediately after CoW Light.
Use the existing **Ctrl+Alt+Shift+T** shortcut (**Cmd+Option+Shift+T** on macOS)
outside an editable field, then select **Falcon Safe Demo**. The shared hidden-demo
preference is per browser session. `#/falcon-demo` alone never enables it.
Hiding is a navigation preference, not an authorization boundary.

## Network and wallet

The initial integration targets the verified **EEZ-X 916969, rollup 4 / Chiado
10200** deployment from `falcom-devcon-poc`. Public addresses, code hashes and
chain checkpoints are in
[`crossChainDeployment.ts`](../../src/lib/falcon/crossChainDeployment.ts).
The dashboard's discovered chain IDs, registry, L2 manager and rollup ID must
match before contract actions appear. Chain discovery failure does not fall
back to default IDs. Another network can still use browser signing and backups.
Adding a deployment requires its verified public bindings; changing only a
chain ID does not migrate controllers or Safe ownership.

Use the dashboard header to connect Rabby or MetaMask. The Falcon workflow uses
that selected EIP-1193 provider for reads and sends, and only switches between
already-configured networks. It never adds or replaces wallet RPC URLs. The
wallet's L2 broadcast endpoint must route through Composer; discovery checks
its echoed nonce and deployment identity before the Safe flow.

The existing runtime configuration supplies `l2FrontUrl`, `l2FeesEnabled: true`
and the positive decimal-wei `l2FeeMaxTotalWei` ceiling. The demo shares
`src/lib/fees/l2-fees.mjs`; it has no second SDK or standalone fee endpoint
configuration. Rabby selects legacy; MetaMask selects EIP-1559. Safe calls quote
through `eez_quoteFee` before sending, without `eth_estimateGas` first. Quote
errors, intent/expiry/fee-limit failures and changed wallet sessions stop the
send. Each send obtains a fresh quote and forwards only its validated wallet
fields. Estimated execution fee and maximum reservation are separate; the
transfer value is not a fee. Ordinary L2 verifier/controller-creation calls
retain their separate gas estimation path.

## Rehearsal

1. Reveal the tab and connect the gas wallet in the dashboard header.
2. Generate a Falcon key, unlock the saved key, or import an encrypted backup.
   Save/download an encrypted copy before leaving the tab.
3. Use **Load my Safe**. The factory maps the Falcon public-key hash to one L2
   controller; the controller has its own replay nonce. Create that controller
   if absent. The on-chain workflow checks routing, code and key authority.
4. Sign Safe creation with Falcon if no Safe exists. Review the fee and send
   through the header's selected wallet. The controller's L1 proxy becomes the
   Safe's sole owner. The dashboard Treasury demo is a separate wallet workflow.
5. Check L2 inclusion, then **Check L1 execution**. A source receipt alone is not
   proof of canonical L1 execution. For transfers, the UI also checks the exact
   Safe operation, success event and consumed nonce. Fund the displayed Safe
   only on its indicated L1 network before rehearsing a transfer.
6. Sign a transfer, estimate/send, check L1 execution and demonstrate replay
   rejection. The [cost comparison](../falcon/cost-comparison.md) appears after
   a verified L2 transfer receipt; it is separate from the wallet fee quote.

If a wallet broadcast is ambiguous, use its activity hash and **Recover
transaction**. The demo checks that hash against the submitted intent instead
of resending automatically. Switching keys does not cancel an open extension
prompt: a late returned hash is retained while the tab stays mounted. Leaving
the tab or reloading clears in-memory transaction tracking; keep the wallet's
transaction hash for inspection before sending again.

This demonstrates post-quantum application signatures, not an end-to-end
quantum-safe chain or audited wallet. The rollup's settlement/proof trust
assumptions still apply. No new backend, contract deployment, worker restart or
live transaction is required to merge this UI integration. Existing controller
source verification remains the deployment's worker responsibility.

## Keys and compatibility

The signer is `@noble/post-quantum@0.7.1`'s `falcon512padded`: Round-3
Falcon-512/SHAKE256, a 897-byte public key and 666-byte padded signature. Do not
substitute a different Falcon variant without updating the verifier contract.

The v1 encrypted backup schema and `falcom-devcon-poc:keystore:v1` browser key
remain unchanged. PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM protect the
saved key; private key bytes stay inside the feature's hook, outside dashboard
state, RPC requests and telemetry. **Switch key**, leaving the tab and hiding
the demos clear the plaintext session. Reload requires the password again.
Removing a saved key affects only that storage entry, including cross-tab
cancellation of pending unlocks.

Browser storage is scoped to the origin. A POC at `localhost:5173` cannot share
storage automatically with the hosted dashboard: download its encrypted backup
and import once on the dashboard. Same-origin saved keys remain compatible.
HTTPS or localhost and Web Crypto are required; downloading a backup remains
available if browser persistence fails.

## Validation

Use the repository's `.nvmrc` and locked dependencies:

```bash
npm ci
npm test
npm run build
```

With a disposable preview running (for example port 8083), execute:

```bash
EEZ_UI_URL=http://127.0.0.1:8083/dashboard npm run test:falcon:browser
```

CI runs these browser checks alongside the existing CoW regressions. They cover
hidden navigation/deep links, bundle loading, network gating, unmount cleanup,
320/390px layouts, encrypted storage/restore, cancellation and both injected
wallet formats. Wallet tests verify actual browser signatures independently
in Node, exercise account/chain changes during reads, reject per-option quote
failures and check exact quoted sends and late hashes. RPC and receipt data are
test doubles; they do not establish live settlement or installed-extension
compatibility. Unit tests cover fee limits/expiry/nonce changes, signature and
receipt binding, independent interoperability vectors and cost accounting.
Contracts and protocol pins are unchanged; no Solidity rebuild, follower replay
or live Safe transfer is claimed for this PR.
