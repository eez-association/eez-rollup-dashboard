# Falcon Safe demo

Falcon Safe is a native, lazy-loaded dashboard tab immediately after CoW Light.
Use the existing **Ctrl+Alt+Shift+T** shortcut (**Cmd+Option+Shift+T** on macOS)
outside an editable field, then select **Falcon Safe Demo**. The shared hidden-demo
preference is per browser session. `#/falcon-demo` alone never enables it.
Hiding is a navigation preference, not an authorization boundary.

## Network and wallet

The demo supports two verified deployments, both paired with **Chiado 10200**:

- **EEZ-X Testnet 699169, rollup 2** at `https://eez.dev`.
- **EEZ-X Devnet 916969, rollup 4** at `https://eez.asuscomm.com`, from `falcom-devcon-poc`.

Public addresses, code hashes and
chain checkpoints are in
[`crossChainDeployment.ts`](../../src/lib/falcon/crossChainDeployment.ts).
The dashboard's discovered chain IDs, registry, L2 manager and rollup ID must
match before contract actions appear. Chain discovery failure does not fall
back to default IDs. Another network can still use browser signing and backups.
Adding a deployment requires its verified public bindings; changing only a
chain ID does not migrate controllers or Safe ownership.

Use the dashboard header to connect Rabby or MetaMask. Signing and transaction
submission use that selected EIP-1193 provider. Safe balances and post-submission
confirmation use the dashboard's configured read RPCs and Composer endpoint;
these reads never ask the wallet to switch networks. Before a network has been
confirmed in the current wallet session, Falcon and CoW offer **Switch to EEZ-X
Testnet** (or the required network's name). Once confirmed, temporarily using
Chiado for funding does not show the setup banner again; the next action requests
its network switch when needed. Only a wallet-reported unknown network shows an
**Add** action. Opening the demo never opens a wallet prompt. Setup uses the dashboard's Composer
RPC, chain ID, native currency and explorer; it does not send a transaction.
Existing network entries are not re-added or replaced automatically. The
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
3. The Safe is looked up automatically when a Falcon key is generated, unlocked
   or imported. This uses read-only RPCs and never opens a wallet prompt. The
   factory maps each Falcon key to its controller; routing, code and authority
   are checked before the account is shown.
4. If no Safe exists, click **Create Safe**. The app prepares the Falcon
   authorization, obtains a fresh fee quote and opens the selected gas wallet
   for transaction approval. For a brand-new key it also creates the L2 controller,
   so first-time setup can require two wallet confirmations. The controller's L1 proxy becomes the Safe's sole
   owner. Empty Safe balance and nonce fields stay hidden before creation.
   A known pending creation is checked automatically instead of sending another
   request. The dashboard Treasury demo is a separate wallet workflow.
5. L2 inclusion and L1 execution are checked automatically. A source receipt
   alone is not proof of canonical L1 execution: the UI also checks settlement,
   Safe ownership and, for transfers, the exact operation, success event and
   consumed nonce. Transient read failures retry without resending. Use **See in
   trace decoder** to inspect the submitted transaction; manual receipt and
   replay-diagnostic buttons are omitted.
6. The gas wallet card shows separate L1 and L2 balances. **Fund Safe** sends a
   native-token transfer from that wallet to the Safe on Chiado, with an editable
   amount defaulting to **0.01 xDAI**. The wallet requests the necessary network
   switch and transaction approval. Funding confirmation and balance refresh are
   automatic. This does not sign a Falcon action or transfer from the Safe.
   If the wallet's submission response is unclear, further funding is blocked
   until the transaction hash from wallet activity is recovered and its sender,
   recipient, amount and network are checked.
7. Once loaded, the Safe account shows its address with a copy button, balance
   and funding controls. In **Send transaction**, enter **To** and **Amount**.
   Expand **Data (optional)** for contract calldata; zero-value calls require
   nonempty data. The signature, Safe hash and receipt check bind these exact bytes.
8. Click **Sign with Falcon**. Fees are estimated automatically after signing
   and refreshed before **Send transaction** opens the wallet confirmation.
   Editing the recipient, amount or data invalidates the signature and quote.
   Confirmation is automatic, with one trace button and small L1/L2 hash links.
   The [cost comparison](../falcon/cost-comparison.md) shows the actual paid fee
   first, then the same gas usage at the L1 gas price fetched once when the
   comparison is first calculated. That price is kept without refreshing. The comparison is labelled
   as estimated. xDAI uses $1 per token; ETH uses a live ETH/USD quote.
   Chiado/Gnosis are the xDAI fallback; other networks default to ETH.

Funding and first-time controller setup save public recovery details before
opening the wallet, including the sender, nonce, destination, amount, and data.
Pending records survive navigation and reloads; they never include a Falcon
secret or signature. Recovery display and blocking are scoped to the connected
sender and unlocked Falcon key. Locking the key or switching wallets/keys hides
unrelated requests without deleting them; returning restores automatic checks.
Legacy deployment-wide records migrate to their recorded sender and key under
the journal lock. Late wallet replies still update that original context.
Safe discovery uses the Falcon public key, so another gas wallet can pay for
the same Safe. Recovery checks the exact nonce as well as
the transaction contents, so an older identical transfer is not accepted.
Confirmation clears the pending record after verifying the canonical outcome.
The same recovery input accepts a mined cancellation or replacement with the
recorded sender and nonce. A different confirmed payload closes the original
request without reporting that original funding or setup succeeded; pending or
reorganized replacements do not clear it. A late wallet reply cannot overwrite
a hash explicitly selected through recovery.

If a page was reloaded before an unsent wallet request was rejected, cancel all
remaining wallet prompts and check wallet activity. For a record without a
hash, confirm the checkbox and use **Check and clear unsent request**. This
checks mined and pending nonces on both configured RPC endpoints before
clearing the saved request. It does not cancel a signed transaction, and nonce
reads alone cannot prove that a signed transaction will never be broadcast.

If a Safe-call broadcast is ambiguous, use its activity hash and **Recover
transaction**. The demo checks that hash against the submitted intent instead
of resending automatically. Switching keys does not cancel an open extension
prompt: a late returned hash is retained while the tab stays mounted. Leaving
the tab or reloading clears in-memory Safe-call tracking; keep the wallet's
transaction hash for inspection before sending again.

This demonstrates post-quantum application signatures, not an end-to-end
quantum-safe chain or audited wallet. The rollup's settlement/proof trust
assumptions still apply. The UI uses the existing Composer and wallet connection;
it does not introduce a backend service. Source verification for controllers
created later remains the deployment's worker responsibility.

The eez.dev deployment was added on 2026-10-30. Its verifier and controller
factory were compiled with Solidity 0.8.34 from the original explorer-verified
sources, reproducing the original creation bytecode before deployment. Both new
contracts are fully source-verified on the eez.dev explorer. Existing Chiado
Safe contracts were reused after checking their runtime code hashes. The gas
wallet does not gain authority over Falcon controllers or user Safes.
See the [deployment and live validation record](../falcon/deployments/eez-dev-699169.json).
Signature verification and controller creation simulation passed; no user Safe
creation or cross-chain Safe transfer was broadcast as part of this deployment.

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
The original devnet deployment and protocol pins remain unchanged. The eez.dev
addition deploys the same verifier/controller source to the second network;
it does not include follower replay or a live Safe transfer rehearsal.


Page reloads and pagehide lock the private key; unlock the saved encrypted copy
before signing again. Visibility changes alone do not lock an unlocked key.
The key manager reconciles its display after a development refresh so a cleared
secret cannot leave an unlocked-looking UI. Transaction edits and actual key
changes produce distinct signing errors.


Normal setup does not show transaction-hash recovery inputs. A saved setup or funding request with
no hash is looked up automatically by its recorded sender and nonce; matching
transactions resume confirmation, and only a canonical replacement/cancellation
can close a different intent. Unresolved recovery controls stay collapsed under
**Earlier setup needs attention**. Missing transactions never cause automatic
resubmission or automatic clearing based on absence alone. The send form is shown
only after the L1 Safe has been verified, and locked keys have a prominent red
unlock instruction.

The signature playground starts as a compact row. Click its heading (or focus it
and press Enter) to expand or collapse the signing and verification controls.
Transaction costs and trace links follow the sending wallet, Falcon key and
deployment. The comparison uses the entire user-paid L2 fee and the same gas
usage at L1 prices for subsequent Falcon-authorized Safe transactions only.
Controller/Safe creation, funding and discovering an existing Safe do not
create cost comparison results.

Safe setup shows two fixed steps: **Create Falcon controller** deploys an L2
contract bound to the public key, then **Create Safe** creates the L1 Safe
controlled through that contract. The active step is highlighted, completed
preparation is crossed out, and the steps disappear after canonical L1
confirmation reveals the account. A key with an existing controller starts
with the first step already complete. Errors remain visible beside the steps.
