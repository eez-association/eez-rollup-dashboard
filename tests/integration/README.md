# Treasury owner and bidirectional payment integration

The active dashboard now uses only the paired-policy release on both networks.
Run `node tests/integration/treasury-paired-setup.mjs` for the current planner's
isolated EVM deployment, activation and payment checks, and
`node tests/treasury-paired-asset-browser.mjs` for the fixed faucet and pending
request browser checks. Browser tests require Chromium's sandbox. The older
shared-policy, invoice and variable-faucet walkthroughs below are historical;
they are not active dashboard deployment paths. Native `--ui` remains gated.

`npm run test:treasury:browser` uses the actual setup component to deploy all
four preparation batches and approve both Safe configuration batches, then
checks activation, the generated manifest and all four payment routes. Every
pending step is reloaded, and wallet cancellation must not consume a nonce or
leave a pending request. Anvil supplies the actual contracts, receipts and Safe
signature checks. Network discovery and fee pricing are controlled fixtures;
the final L1 alias request is checked but sent directly to the logical L2 Safe.
This is browser/EVM coverage, not native Composer or proof validation.

This scenario runs the dashboard's Safe-signing helpers and `L1Owners` through
EEZ's native process fixture. The fixture starts a new embedded development L1,
Composer, real proof signer, and independent L2 follower. It leases loopback ports
and uses its own genesis, public test wallets and datadirs. It does not read the
dashboard's `.env` or connect to its deployed endpoints.

From the dashboard repository root:

```bash
npm run test:treasury:integration -- --runtime /path/to/rollupX
```

Use `--safe-version 1.3.0 --ui test` to run the same owner and payment rehearsal
with the published **1.3.0+L2** singleton on both chains. The default remains
1.4.1. The fixture verifies the official runtime hash before use, records the
selected version in both evidence files, and includes the pinned package fixture
in the application source inventory. This tests the older execution-event
layout through actual signing, settlement, browser recovery and independent
follower replay. It does not upgrade or replace an existing public Safe.

After owner-add/remove/replay checks, the native scenario submits actual Safe
transactions from both chains. L1→L2 pays 110 (10 from L1 + 100 from L2), followed
by payments through each remaining source/destination combination. It verifies
recipient/Safe balances, the shared 150 cap, allowances and independent follower
state. Invalid caller and exhausted-budget cases are rejected during composition;
L1 signature replay is a canonical failed ordinary Safe transaction with GS026.
The browser scenario also selects the L1 Safe, signs with actual fixture keys,
clears approvals when source changes, submits through L1 Composer and recovers
the matching L2 payment after reload.

The pinned native runtime exposes queue status on its L2 node, whereas the shared
runtime exposes it through Composer. The loopback test adapter forwards only
`eez_getCrossChainTransaction` to the explicitly configured fixture node. All
submission/discovery traffic still uses the selected source Composer. No status,
receipt, signature, proof or settlement result is synthesized by this adapter.

The native mock builder inserts bundle members into a fee-ordered mempool; it
cannot guarantee atomic bundle ordering. The dashboard harness sets the existing
`EEZ_L1_POSTBATCH_MIN_PRIORITY_FEE` to 2 gwei, above the fixture wallets' 1 gwei
source tip, so idle epochs do not reorder the Safe transaction ahead of its batch.
The browser test asserts the actual mined ordering. This fixture configuration
does not establish production builder guarantees or change shared-network fees.

Prerequisites: initialized dashboard contract submodules and npm dependencies;
Foundry 1.7.1; Node 26; Rust 1.95.0 and the runtime's native build dependencies
(LLVM 22, Polly, Clang 22, protobuf, OpenSSL and pkg-config). The runtime checkout
must be at `fa916b13254a36423cad130080dde367bb18a7d6`, with core
`855fe0602484750861b4c31502a1a91355d33ed6` initialized. The runner records local
runtime source changes and refuses protocol edits or source changes during the
run. It builds with the runtime lockfile; it does not update runtime dependencies
or source files. An optional `--cargo-target-dir /path/to/existing/target` reuses
an existing compilation cache. Freshly built executables are copied and hashed
before they are launched.

For subsequent runs, `--reuse-run .runtime/treasury-integration/<successful-run>`
can reuse a recorded successful run's native executables. The runner requires
matching runtime and protocol revisions, the complete current runtime-source
inventory and every reused executable hash. A mismatch fails before starting the
devnet. The Rust harness executable is reused only when its source hash matches;
otherwise the runner compiles the current dashboard harness with the pinned lockfile. Application contracts and browser code still
use the current dashboard sources. This is useful when another build owns the
shared Cargo cache; it does not substitute arbitrary cached binaries.

All new scripts and tests live here. The small Rust harness imports the external
runtime's `eez-testkit` without copying its protocol deployment, proxy setup,
port leasing, builder/Beacon fixtures or process lifecycle code. The launcher
creates its temporary Cargo package under `.runtime/treasury-integration`, derives
its lock from the runtime lock, and checks that external dependency identities
have not changed. Contract build outputs, generated genesis/configuration, logs
and execution evidence are also retained under that dashboard directory. Failed
native runs retain their datadirs; successful fixtures clean up their processes
and disposable databases.

The JavaScript scenario:

1. Deploys unmodified Safe v1.4.1 singleton/factory contracts and both Safes.
2. Deploys `L1Owners` after provisioning the L1 Safe's L2 proxy, then provisions
   the adapter's L1 alias before any static verification.
3. Verifies that B+C cannot authorize a Safe call before C is an L1 owner.
4. Adds C to the L1 Safe with a normal A+B owner-authorized transaction.
5. Uses B+C's approvals, packed by the dashboard helper, to execute an L2 Safe
   action through the Composer. It checks canonical inclusion and the same block,
   action state, caller and Safe nonce on the independent follower.
6. Rejects replay, removes C on L1, and rejects the already signed B+C approval
   without changing the action or Safe nonce.
7. Executes an A+B approval after removal and verifies independent replay again.

Negative checks submit signed source transactions through the Composer. They
require terminal `PoolDiscarded`, no receipt and unchanged state/nonces. The
existing opt-in Composer gas trace must show execution reverting in the L1 Safe;
a separate L1 call checks the same signature/preimage for `GS026`. Queue status
does not expose revert bytes. Ordinary `eth_estimateGas` cannot simulate this
cross-chain signature path at the tested runtime revision.

The Rust harness additionally checks safe-prefix convergence, recomputes the
public-input hash of a posted batch and verifies its attester signature, and
checks both nodes for divergence failures. `summary.json` only records success
after those checks finish. `scenario.json` records each positive and negative
case, deployment code hashes, owner-management transactions and settled L2
identities. A failure exits nonzero and preserves diagnostics.

This is process-level validation on a private development chain. The native
fixture uses a development miner, a local bundle-forwarding relay and a Beacon
sidecar fixture; it does not validate production PBS ordering or wallet-extension
UX. Negative cases are composition rejections, not L1 settlement rollback tests.
The browser scenario below additionally exercises the shared budget and
bridge routes to both destinations with exact signed funding splits. The scripted owner scenario remains focused on owners;
the browser scenario also exercises the invoice settlement-failure act using the existing native relay barrier. The original proved post and blob bytes are unchanged.

The [2026-10-20 evidence record](../../docs/audits/2026-10-20-treasury-owner-integration/README.md)
contains the passing five-case run, exact identities, prior harness failures and
the remaining scope limits.

## Full wallet and Safe application rehearsal

Follow the [presenter runbook](../../docs/runbooks/treasury-rehearsal.md) to attach
the pinned official Safe frontend/backend to the selected interactive devnet.
It uses the dashboard's existing wallet integration for payments and Safe for L1
owner administration. The stack verifies devnet and bytecode identities, derives
owner state from L1 traces, and links the dashboard only after readiness checks.
The scripted `treasury-owner.mjs` helper below remains useful for automated tests;
it is not the presenter’s owner-management UI.

## Connected treasury UI

The hidden Treasury Demo defaults to **Payments** with the isolated launcher's
runtime manifest. Without a manifest, supported dashboard networks show the
Safe chooser; other networks show a configuration prompt. **Owner demo** executes
`TreasuryOwnerAction.setValue` through the fixture's EEZ-X Safe.

The launcher deploys `TreasuryPolicy`, the official AllowanceModules and the
dashboard-owned sealed `SharedTreasuryBridge` pair extending the pinned test bridge. The
extension locks canonical tokens on L1 without an L2 callback, then mints the
matching representation locally on EEZ-X. Its caller, receipt and consumed nonce
bind each deposit to this pair. Normal Safe transactions grant 100 USDC per Safe per
ten minutes; the policy's immutable global limit is 150 per matching period.
Its six-decimal **SharedTestUSDC** faucet is a real private-chain test token, not
Circle-issued USDC. The fixture wallet explicitly approves 450 tokens, then a
batch uses standard ERC-20 `transferFrom` to debit it, transfers 300 to SafeL1
and locks 150 in L1 escrow to mint 150 for SafeL2. The test checks that the
canonical supply is unchanged and the wallet allowance is fully consumed. Neither the policy nor its alias has Safe module power. No Guard
is installed, and owners retain authority outside the payment policy.

Start a private devnet and keep its dashboard running:

```bash
npm run dev:treasury -- --runtime /path/to/rollupX --cargo-target-dir /path/to/rollupX/target
```

The launcher creates a fresh run directory under `.runtime/treasury-integration`
and prints its dashboard URL. Reveal Treasury Demo with **Ctrl+Alt+Shift+T**
(**Cmd+Option+Shift+T** on macOS). Each invocation has its own data, ports and
runtime configuration; it does not change `.env`, `.runtime/config.json` or the
normal dashboard deployment. `EEZ_UI_RUNTIME_CONFIG` selects the generated Vite
configuration for this process only. The UI fixture uses L1 chain ID **1337** and
EEZ-X chain ID **420691** so a wallet does not confuse it with Ethereum mainnet.
The UI verifies genesis and deployed-code identities as well as chain IDs.

The pinned runtime exposes `eez_composerInfo`, but not the newer virtual
`eth_call` discovery probe used by browser wallets. This launcher starts a
loopback compatibility adapter for each Composer front. It answers that probe
by querying the actual upstream metadata, chain ID and genesis and checking
this deployment's bindings; all other RPCs, including signed submissions, go
to that same fixed Composer front. It does not emulate execution or change
proof validation. Use the generated `/composer/l2` wallet URL, which includes
this adapter. This read-route check cannot prove a wallet extension will use
the same route for its own simulation or submission; rehearse the intended
wallet extension before a presentation.

In the printed run directory:

- `ui-session.json` contains the dashboard URL, exact deployment and stop file.
- `public-test-wallets.json` contains the **public fixture keys** for owners A,
  B and C. Import those as disposable test accounts into your browser wallet.
  Each is funded with one test ETH on both devnet chains. The application does
  not contain those keys or sign on your behalf.
- `ui-config.json` is the generated browser/proxy configuration. Do not copy it
  over the normal dashboard configuration.

To exercise the flow:

1. Connect owner A or B through the existing wallet selector and select
   **Switch to treasury devnet**. The wallet's RPC must be the Composer URL
   shown under **Wallet network details**. An already saved wallet network may
   need its URL updated after restarting the devnet; the application verifies
   the selected wallet's Composer and genesis before signing/submitting.
2. In **Payments**, check 300 held on L1 and 150 on EEZ-X, zero spending,
   and the next reset time. Complete the following sequence in one ten-minute
   period. The presets fill the form; review before signing. A period rollover
   invalidates an unsigned or partially signed review. An idle L2 need not post
   an empty batch for the UI to advance: effective allowances follow the current
   L1 period using the module's reset rules and settled L2 storage.
3. Choose **Pay 40 on EEZ-X**, review, sign as A, switch to B and sign again.
   Submit once and wait for **Settled on L1**. L2 spending and the global counter
   both become 40. Local payments on L1 are also available through the form.
4. Once the form unlocks automatically, choose **Split 110 to L1**. Review 100 from L1 plus 10
   from EEZ-X. Obtain A+B approvals and submit. The recipient receives 110 on L1
   in the same settlement transaction; Safe balances become 200 / 100 and
   spending becomes 100 / 50 / 150. The UI shows actual settled contributions.
5. Choose **Try another 1**, then review. The shared budget
   rejects it while L2 still has 50 of allowance. Waiting for the next period
   resets the allowances and policy budget, but does not replenish balances.
   Starting the launcher again creates a fresh funded fixture for another full
   walkthrough.
6. After the next reset, select **Fixed amount**, enter **30**, choose the base
   chain as recipient chain and **Use available funds**. Review 30 funded from
   its Safe. Collect A+B approvals and submit once. Safe balances become
   170 / 100 and spending becomes 30 / 0 / 30.
7. Once the form unlocks automatically, enter **110**, select **EEZ-X** and choose **Use available funds** and review **10 from L1 +
   100 from EEZ-X**. Sign as A+B and submit once. The recipient gets 100 from the
   local Safe and 10 newly minted tokens backed by an additional 10 in L1 escrow.
   Safe balances become 160 / 0, spending is 40 / 100 / 140 in the new period,
   and the policy alias retains no tokens or approval from the payment.
8. To demonstrate owner changes, use the helper below to add C on L1, refresh
   owners and approve the next action or payment with B+C. Removing C invalidates
   that quorum. **Owner demo** offers a value-setting action that uses
   no payment budget. The helper uses normal A+B Safe signatures, not a debug
   state mutation.

Review binds the initiating chain, Safe, nonce, policy, recipient, destination,
amount, budget epoch and exact contribution from each Safe. Editing the amount
or split clears existing approvals. The `Paid` event must match before the UI
reports settlement. The application stores submission
identity before opening the wallet and tracks the hash. A speculative L2 receipt
remains pending. **Settled on L1** requires a canonical safe-chain receipt and
exact Safe and payment success events. Reloading restores the signed fields and
resumes that request without resubmitting it.

Set `TREASURY_RUN` to the printed run directory, then:

```bash
node scripts/treasury-owner.mjs "$TREASURY_RUN/ui-session.json" add-c
node scripts/treasury-owner.mjs "$TREASURY_RUN/ui-session.json" remove-c
```

The helper is for this private fixture, not a replacement for the intended L1
Safe-app owner-management experience. Owners are refreshed while the view is
open. Changes to the owner list, threshold, nonce or reviewed action clear stale
approvals. Switching wallet accounts preserves already valid approvals so the
next owner can sign; a response from an account changed mid-signature is ignored.

If submission loses its response, the application keeps the action unresolved
and searches for its exact Safe execution event. Absence of a receipt or queue
record is not failure and does not enable resubmission. Keep the wallet activity
and transaction hash for diagnosis; do not erase the saved pending request to
force a retry. A stopped or replaced devnet fails identity checks and cannot
reuse another instance's pending state.

Stop only this devnet with Ctrl+C in its launcher terminal, or:

```bash
touch "$TREASURY_RUN/stop"
```

The launcher exits normally through fixture cleanup. A new invocation starts a
new devnet; it does not recover this disposable chain's state.

## Browser integration

Install the pinned Playwright browser once, then run the actual browser scenario:

```bash
npx playwright install chromium
npm run test:treasury:ui -- --runtime /path/to/rollupX --cargo-target-dir /path/to/rollupX/target
```

This starts the same private devnet and UI, drives hidden navigation, owner
reads, network selection, EIP-712 approval and submission, then checks canonical
state and independent follower replay. It exercises owner addition/removal,
stale and duplicate approvals, incomplete quorum, wallet signature rejection,
reload reconciliation, a lost response after a real broadcast, and narrow layouts.
It then executes the 40 / 110 / rejected 1 sequence through the payment screen,
including payment reload recovery. The first 110's two recipient transfers must occur
in the same canonical L1 transaction. Assertions cover both Safe/recipient
balances, effective allowances and nonces, global spending, bridge escrow and
wrapped supply, and the policy/alias's zero residual balance. An independent
follower must reproduce the L2 balances, allowance, budget and Safe nonce.

The scenario then waits for the next **natural L1 ten-minute boundary**, including
an idle L2, and pays a fixed 30 to L1. It edits the amount after one approval,
confirms approvals clear, restores 30, signs and reloads after submission. The
`Paid` event must match the signed amount and allocation, with a real 30-USDC L1
transfer. The follower independently replays the receipt and debit. It then pays
110 to EEZ-X: 100 from its Safe and
10 from L1, totaling 140 in the same shared period. It checks the
canonical Safe-to-alias transfer, exact alias approval, alias-to-escrow transfer,
consumed lock nonce, local transfer and matching mint in one L2 receipt. Escrow
and wrapped supply both rise from 140 to 150; the alias approval is zero. The
follower independently reproduces supply, recipient/Safe balances, budget,
allowance, bridge nonce and Safe nonce. Reload restores the L2 destination and
exact split. A final fixed 16-USDC payment is rejected by UI preflight with
only 10 of global budget left. Allow up to a further ten minutes for the reset; the test does
not warp time or overwrite chain state to manufacture a fresh budget.

For the first-period rejection, the test also bypasses UI preflight and submits a
genuinely signed payment to Composer. It requires terminal `PoolDiscarded`, no
receipt, a complete execution trace reaching a revert in the policy, the exact
`GlobalLimit()` error from a direct policy call, and unchanged before/after state.
This establishes application rejection during composition, not rollback during
L1 inclusion. The contract suite separately tests a controlled final-transfer
and later-lock failures with synchronous mock cross-chain delivery.

Screenshots and JSON are recorded under the run directory. See the
[fixed-payment audit](../../docs/audits/2026-10-23-treasury-fixed-payments/README.md). The test wallet is an EIP-1193 provider backed by real
fixture-key signing in the Node test process; RPCs and contract execution are
real. This is not automation of MetaMask/Rabby dialogs or the official Safe app.
The server and owned devnet processes are stopped after the test.


### Invoice failure rehearsal

On a fresh budget period, with at least 100 USDC in the L1 Safe and 10 in the
EEZ-X Safe, expand **Demo scenarios** in **Payments** and select **Invoice rollback**. This opens an
invoice on the isolated L1; it does not send a payment. Review the fixed 110-USDC
terms, collect both current owners' approvals, then submit once. The private
fixture closes the invoice immediately before the proved payment in the same
L1 target block. The UI keeps the request pending until canonical reconciliation
and displays **Rollback verified** only after checking the trace and state.
Reloading preserves the signed invoice and reconciles the same request.

The result lists the 10-USDC bridge release, 100-USDC Safe transfer, and merchant
rejection, followed by before/after balances and counters. The closure remains
committed and the invoice stays unpaid. Network fees are separate. If the timing
barrier or required observations fail, the UI reports unverified evidence; do
not reinterpret that as rollback or automatically resend the payment.

For the longer stage script, run this after the initial 40 / 110 / rejected 1
sequence and its natural budget reset, before the fixed 30-USDC payment. The automated
browser suite runs it first while allowances are unused, then runs all existing
payment regressions; no chain clock is warped or storage reset. It also submits
an already-closed invoice through Composer and displays preparation rejection,
without claiming an L1 rollback.

The controller exists only in `scripts/treasury-devnet.mjs`'s loopback Vite
instance. Requests require that instance header and a matching browser origin;
no private key is shipped to the application. The relay wrapper only exposes
its invocation's existing test-control directory. Records named `invoice-*.json`
retain the exact original bundle, post trace, canonical anchors and observations
inside the owned run directory. Full native logs and datadirs remain local-only.
See the [invoice audit](../../docs/audits/2026-10-20-treasury-invoices/README.md)
for passing evidence and any diagnostic failures.


## Payment history

The **Payments** screen includes a browser-local history for the current
isolated deployment. Completed payments unlock the form automatically and preserve prior attempts. Expand a row to
see its recipient, destination, signed amount and split, budget period,
actual settled contributions, Safe/source hashes and canonical block. Invoice
rollback rows include the earlier transfer order, before/after state and L1
post/closure hashes. Use **Filter history** to distinguish settlements,
preparation rejections, verified rollbacks and unresolved requests.

A valid review refused by the UI funding checks is recorded as **not signed or
submitted**. The closed-invoice fixture's Composer rejection is a separate entry
with a submitted hash. Generic queue removals are **Request rejected**, unless
the fixture establishes preparation failure; missing receipts, timeouts and
missing fixture evidence cannot establish rollback.

The journal stores identities in `eez:treasury:history:<instance>`, alongside the
existing active-request recovery key. Existing active payment requests are
imported automatically. It does not store asserted chain outcomes: reload and
**Refresh history** check them again, one historical request at a time, while
the active submission continues its normal polling. When an old rollback has lost its Composer diagnostic record, the client also
checks that both the submitter nonce and Safe nonce have advanced at one canonical
L2 safe block, rechecking that block hash after the reads. This closes the old
request without relying on an in-memory queue record; the original rollback
trace and canonical snapshots must still verify. A missing record or nonce
advance alone never proves rollback. The displayed **Last checked**
time identifies the observation. Canonical results remain subject to reorg.
Unavailable reads remove verified history labels; restoring reads and refreshing
reconciles the entries again. History never releases the active submission lock
or resubmits a transaction. Wallet cancellation removes its unsent entry.

This is not a chain-wide or cross-browser indexer. The browser origin and devnet
instance scope its records. The devnet's Composer diagnostics and invoice
controller evidence are in memory and can be lost on restart; an old failed
request may then remain unresolved. Clearing browser storage loses its journal.
Corrupt or full storage is reported, leaves the stored data untouched and blocks
unrecorded submissions; preserve the recovery keys and transaction hashes when
diagnosing it. No pruning or reset button silently discards old attempts.

The browser suite retains four settled payments, the closed-invoice preparation
rejection, two local budget rejections, and the verified inclusion rollback.
On reload it explicitly omits only the old invoice's Composer diagnostic lookup;
all canonical nonces, receipts, traces and state remain real RPC observations.
Diagnostic retention has no fixed expiry deadline. It checks all eight entries,
inspects both destination splits and
the fixed 30-USDC result, opens the old rollback state table and hashes,
and exercises filters at desktop, 390px and 320px widths. It also cancels a wallet
submission and verifies no journal ghost remains, aborts read RPCs to require
unresolved labels, restores reads and rechecks outcomes. The original seven
actual wallet broadcasts remain the only sends. Pure tests cover storage
corruption/quota errors, distinct attempts sharing a Safe hash, deployment scope
and status downgrades; these do not substitute for native settlement evidence.
See the [history increment record](../../docs/audits/2026-10-20-treasury-history/README.md)
for executed results and exact source identities.

## Predeployed assets and separate funding

`node tests/integration/treasury-deployment-batches.mjs --current-release` uses an
owned Anvil instance to exercise the operator infrastructure batches, Safe setup
without funding, and payments after separate funding. It also preserves coverage
for older wallet-funded journals: explicit faucet claims, exact 450-token wallet
debits, unchanged supply and consumed allowances. Independent treasuries share
one sealed bridge pair; payments in both directions cannot spend another
treasury's allowance.

The EEZ managers in this test are fixtures, so it does not establish Composer,
signer or independent follower correctness. Run the native `--ui test` suite
separately for those checks.

`node tests/treasury-shared-browser.mjs` checks preserved journals, predeployed
asset discovery, retained funding requests and the transition to setup without
funding. New setup must not show a funding requirement or faucet shortcut.
The injected wallet and RPC fixtures do not sign or broadcast on Chiado. The
operator CLI and broadcast procedure are in the
[shared-network runbook](../../docs/runbooks/treasury-shared-network.md).

The native browser harness forwards its own loopback HTTP through Playwright's
request client to avoid host-interface churn cancelling Chromium requests with
`ERR_NETWORK_CHANGED`. It forwards actual Vite/RPC responses, with zero retries
and no synthetic chain results. This does not validate Chromium's underlying
network transport or a wallet extension; those remain rehearsal requirements.
The read-only shared-network browser smoke uses the same transport boundary.

## Shared owners UI checks

Run `node tests/treasury-owners-browser.mjs` for the connected treasury's owner
card and refresh lifecycle. The browser uses controlled RPC responses and an
approval fixture with the real owner snapshot and inclusion checks. It verifies
shared thresholds separately from collected payment approvals, automatic updates
for external changes and verified additions, stale-review invalidation, failed
read recovery, and a reorganization while an older snapshot is in flight. It
also checks desktop/mobile layout and preserves the unresolved owner journal.
No chain transactions or wallet requests are made; use the native suite above
for contract, signature, settlement and independent follower evidence.

`node tests/treasury-wallet-browser.mjs` exercises source-network defaults,
network changes within approval/submission, cancellation, account changes during
a prompt and saved-request preservation using the same controlled UI fixture.
Its synthetic approvals and submission preparation never broadcast; native
browser scenarios retain real signature-domain and transaction checks.

## Exact payment split validation

The scripted native scenario upgrades the legacy policy using the retired
version-2 handover test fixture, preserves the same Safes and 40 USDC of prior spending,
then signs explicit allocations for all four source/destination combinations.
It checks actual recipient balances, both Safe contributions, canonical policy
events and independent follower replay. The shared limit, replay and forged
caller rejections still run. `forge test --root contracts` separately exercises
arbitrary splits, endpoints, later-leg rollback and a second policy handover.

`node tests/treasury-wallet-browser.mjs` tests the slider with controlled chain
reads and a mock wallet: exact signing, frozen review, six-decimal recovery,
capacity changes, keyboard endpoints and mobile layout. It does not broadcast.
The dashboard now assumes a fresh policy deployment and no longer has a
handover UI. The retired executable plan lives only in
`tests/fixtures/treasury-policy-upgrade.ts` for historical integration coverage;
production code only reads retained handover receipts. Browser checks do not
replace the native scenario or a human browser-wallet rehearsal on Chiado.

The setup-batch integration (`node tests/integration/treasury-deployment-batches.mjs`)
now exercises direct version-11 selection of an existing L1 Safe, shared asset
reuse, mirror creation/adoption, approvals and receipt recovery. Funding is an
explicit test action after setup. `treasury-saved-payments.test.mjs` and
`treasury-deployment-batches.test.mjs` retain recorded-format recovery regressions;
no test creates a new treasury through the retired migration chain.
