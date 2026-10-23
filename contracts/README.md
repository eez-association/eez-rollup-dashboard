# Treasury demo contracts

**Warning: The custom treasury contracts are unaudited demo code and are not ready
for production use, including the Ethereum mainnet integration.** Source
verification and passing tests do not constitute a security audit.

## Contract layout

- `src/l1/StandardBridgeDelegate.sol`: the Ethereum Safe's bounded spending delegate.
- `src/l1/TestUSDC.sol`: permissionless test faucet for the normal bridge; not real USDC.
- `src/l2/StandardBridgeTreasuryPolicy.sol`: normal-bridge payment coordinator on EEZ-X.
- `src/l2/TreasuryPolicyBase.sol`: inherited payment checks, not a separate deployment.
- `src/l2/L1Owners.sol`: the mirror Safe's contract owner, checking live L1 signatures.
- `src/shared/`: deployment helpers used on either chain.
- `src/interfaces/`: shared external ABIs.
- `src/chiado/`: retained custom-bridge demo and its legacy faucet/claim helper.

### Simplified test faucet

Deploy `TestUSDC` on L1, then its creator calls `registerBridge(normalL1Bridge)`
once. Only the L1 bridge address is stored. Anyone may call
`mint(recipient, amount)` repeatedly, or
`claimOnL2(recipient, amount, destinationRollup)` to mint to the token contract,
approve the normal bridge, and deposit for the recipient. Amounts use six decimals;
both entry points accept 0 < amount <= 1,000 tokens per request. Calls remain
permissionless and repeatable. The destination is an EEZ rollup ID, not an EIP-155
chain ID. Initial supply is zero.
There is no separate dispenser, fixed claim allocation, per-wallet limit or claim
helper in this path. Failed bridging reverts minting and approval. Existing token
balances at the token contract are preserved; no bridge approval remains afterward.

The normal bridge can `transferFrom` the token contract's own balance. OpenZeppelin
ERC20 does not reject `from == address(token)` or `from == to`; it still checks
balances and allowances. Internal `_approve(address(this), bridge, amount)` is
required here: an internal call to public `approve` would use the user's address.

The Ethereum treasury continues to use real USDC. This test faucet is for isolated
rehearsals or test deployments using the normal bridge. Existing Chiado UI plans
and immutable release bundles retain their original contracts. Regenerate a new
source release before deploying the reorganized contracts; this source change
does not migrate a live network or change the dashboard's configured asset.

The application uses `L1Owners` for live L1 owner verification and
`TreasuryPolicy` for payments through the shared Chiado test bridge.
`StandardBridgeTreasuryPolicy` and its bounded Ethereum delegate use the existing
mainnet bridge and USDC. Both support payments initiated by either Safe, split
funding to either chain with exact owner-approved contributions.

The [shared-network runbook](../docs/runbooks/treasury-shared-network.md) covers
predeployed test infrastructure and wallet-approved Safe setup. Setup does not
fund the Safes. The [mainnet runbook](../docs/runbooks/treasury-mainnet.md) covers
the existing Ethereum bridge, isolated native rehearsal, real-USDC fork tests
and remaining release checks. The packaged test bridges are not production
bridges. Independent contract review and actual wallet-extension/Safe-app
acceptance remain outstanding.

The [isolated launcher](../tests/integration/README.md) deploys and funds its own
Safes and six-decimal test tokens. Initially, 300 tokens are held by the L1 Safe
and 150 are bridged to its EEZ-X mirror. The hidden UI uses real transfers,
counters and canonical payment events in that environment. Test funding and
controlled invoice failures belong to that harness, not normal setup. Without
bindings, supported dashboard networks show the Safe chooser; other networks
show a configuration prompt.

## Exact payment allocation

`TreasuryPolicy` and `StandardBridgeTreasuryPolicy` inherit
`paySplit(recipient, amount, onL1, epoch, fromL1)` for fixed payments. Safe signatures bind the exact L1 contribution; L2 supplies
`amount - fromL1`. Authorization, recipient checks, shared debit, allowances and
bridge execution share the existing payment path. Capacity changes reject the
chosen split. `Paid` must match the signed amounts before the UI reports success.

`paySplit` is the only production payment entry point and uses the immutable asset.
New policies expose `SPLIT_VERSION = 2`; new manifests record payment `version: 2`.
The single `GLOBAL_LIMIT` bounds both a payment and total spending per epoch.
Bootstrap construction takes only the actions; the creating wallet is its owner.
Saved setups continue loading their immutable build and original constructor.
Existing manifests retain their token-bearing payment ABI at the saved-record boundary;
approvals cannot be translated across these selectors.

New setup uses one frozen version-11 plan without intermediate migrations.
`SharedTreasuryBridge` now initializes its manager/admin directly; the obsolete
`ConfiguredTreasuryBridge` and `BootstrapTreasuryBridge` sources are removed.
Their immutable historical build inputs remain available for pending setups.
Existing shared bridges retain their reviewed runtime identities and are reused.

Fresh Chiado setups use this artifact and expose the allocation slider
without a separate activation. Executable policy handovers and their upgrade
contracts have been removed. Historical deployment bytecode and verification
inputs remain immutable for pending journals and explorer reproduction. The
[setup runbook](../docs/runbooks/treasury-shared-network.md#payment-split-on-a-new-treasury)
describes the fresh-deployment requirement and outstanding legacy journals.

## Sources and builds

The contract builds are self-contained in this repository. The separate process
integration runner uses an explicitly supplied runtime checkout. Initialize the pinned submodules:

```bash
git submodule update --init --recursive contracts/lib/safe contracts/lib/safe-modules contracts/lib/eez-core-protocol
npm run build:contracts
npm run test:contracts
npm run test:treasury-signatures
```

Run from the dashboard repository root. Use Foundry 1.7.1; Foundry selects the two
pinned Solidity compilers. The npm commands compile the legacy artifacts first,
so tests never rely on an artifact left over from an earlier dependency pin.

| Dependency | Pin | Compilation |
| --- | --- | --- |
| Safe smart account v1.4.1 | `bf943f80fec5ac647159d26161446ac5d716a294` | Solidity 0.7.6, Istanbul, optimizer off |
| Safe AllowanceModule v1.0.0 | `c95f03900bff99be090dadb9de1c74b162365485` (`allowances/v1.0.0`) | Solidity 0.7.6, Istanbul, optimizer off |
| EEZ core | `855fe0602484750861b4c31502a1a91355d33ed6` | Solidity 0.8.34, optimizer runs 1, via IR |
| forge-std | Vendored by the EEZ pin above | Test/script dependency only |

[legacy/src/Artifacts.sol](legacy/src/Artifacts.sol) imports the original 0.7.6
sources. The 0.8.34 tests deploy their compiled artifacts through interfaces;
they do not port or recompile the allowance implementation with another language
version. These are reproducible local builds, not a claim of bytecode identity
with a particular existing public-chain deployment. Verify reused deployment
bytecode and implementation bindings before the connected rehearsal.

## Owner adapter

[L1Owners.sol](src/l2/L1Owners.sol) implements `isValidSignature(bytes,bytes)` and
returns `0x20c13b0b`, the interface used by Safe v1.3.0 and v1.4.1. It passes the full Safe
transaction preimage and its hash to the L1 Safe's `checkSignatures`. That Safe
checks its current owner list and threshold. No owner list is cached on L2.

The constructor accepts the local EEZ-X manager and original L1 Safe address.
It derives the L1 Safe's local proxy using that manager and checks deployed code
and the registry's original address/rollup binding. Provision the proxy first;
also provision the adapter's L1 alias through the L1 registry before verification.
New mirror setup can reuse an existing adapter for the same original Safe and
local manager. Discovery verifies its runtime, all immutable bindings and its
registered Safe proxy at one canonical block; creation logs alone cannot authorize
reuse. Each mirror keeps its own Safe signature domain and nonce.
A signature check cannot create a missing proxy inside STATICCALL. The manager is a trusted
deployment input, not a security root established by this constructor.

The L1 caller during verification is the adapter's alias. Merely submitting the
L2 transaction from an L1 owner's EOA does not satisfy Safe's `v = 1` implicit
approval. Explicit L1 `approveHash` is covered separately. The demo signing
helper accepts EOA EIP-712 signatures; contract owners with further cross-chain
calls are outside that helper and need additional runtime validation.

The [deployment script](script/DeployL1Owners.s.sol) provisions the L2 proxy and
adapter. Its L1 alias is a separate setup call; the process runner handles both. It does not create/fund Safes, grant allowances or install a Guard.
Its inputs are separate from the dashboard operator settings:

| Environment variable | Meaning |
| --- | --- |
| `TREASURY_L2_CHAIN_ID` | Expected EIP-155 chain ID |
| `TREASURY_ROLLUP_ID` | Expected nonzero EEZ rollup ID |
| `TREASURY_L2_MANAGER` | Local manager address |
| `TREASURY_L2_MANAGER_CODEHASH` | Expected local runtime keccak256 |
| `TREASURY_SAFE_L1` | Independently verified original L1 Safe address |
| `TREASURY_L2_RPC_URL` | Intended isolated EEZ-X RPC |

After setting these for the prepared environment, run a dry run:

```bash
forge script --root contracts script/DeployL1Owners.s.sol:DeployL1Owners --rpc-url "$TREASURY_L2_RPC_URL"
```

The command omits `--broadcast`. For an upgradeable manager, checking the proxy's
runtime hash alone does not authenticate its implementation: verify that binding
and the agreed protocol revision independently. Any real deployment must record
both chain IDs, manager/implementation identity, Safe code and threshold, proxy
identities and resulting adapter address. The process test deployed these only
on its disposable private devnet; the dashboard deployment is unchanged.

## Setup implementation

[DeploymentIO](../src/lib/treasury/deploymentIO.ts) owns contract reads, artifact
checks and bounded discovery of missing or replacement transaction hashes.
Chiado setup and Ethereum setup share it while retaining separate network
validation, plans and journals. A discovered hash is only a tracking hint;
each setup must verify canonical execution before advancing. Safe inspection
and mirror-call lookup depend only on the read methods they need.

## Signing integration

[safeTransactions.ts](../src/lib/treasury/safeTransactions.ts) provides immutable
reviewed Safe typed data, exact JSON for `eth_signTypedData_v4`, owner recovery,
quorum/duplicate checks, address ordering, the legacy contract-signature wrapper,
and `execTransaction` calldata. The signing domain uses the initiating Safe and
its chain, independently of the recipient chain. Payments use Call; setup and
internal transfers use DelegateCall to the verified `MultiSendCallOnly` helper.
They share one inner-call encoder: every inner operation is Call with zero native
value. Safe native value, `safeTxGas`, `baseGas` and `gasPrice` remain zero, with no
refund receiver. Network gas remains payable by the submitter.

The observed L1 owners and Safe nonce must be refreshed before submission.
Changing the reviewed fields invalidates prior approvals; runtime verification
is still authoritative. Collecting signatures does not establish settlement.
The hidden [connected screen](../src/components/TreasuryConnected.tsx) uses these
helpers for owner actions and payments with the selected wallet. Payment approvals
bind the canonical token, recipient, destination, budget epoch and Safe nonce.
The configured asset is immutable in the signed policy target.
Payments bind the exact amount and each Safe's contribution. A changed epoch
requires a new review and fresh signatures.

## Shared-network compatibility

The observed shared runtime uses core `f46af7c9833ac12a54f14d52f4da1f318a0f6525`;
the local integration continues to use the pinned `855fe06` source. The newer
core rejects remote calls whose destination is the protocol manager itself.
[TreasuryAliasReader.sol](src/chiado/TreasuryAliasReader.sol) performs alias derivation
through a local L1 registry call, reached through the helper's cross-chain proxy.
**TreasuryPolicy constructor argument 4 is the L1 helper address**, replacing
the registry argument in the earlier private deployment. Deploy a new policy
and manifest; old deployed policies cannot acquire this compatibility in place.
The helper owns no funds and has no module or administrative permissions.
This reader is specific to the Chiado bridge policy. The standard-bridge policy
reads its alias from its Safe-bound funding delegate instead.

[SharedTreasuryBridge.sol](src/chiado/SharedTreasuryBridge.sol) binds manager,
local rollup and administrator in its constructor. The inherited first-caller
initializer then rejects further initialization, removing a takeover window on
the shared testnet. Counterpart configuration still precedes funding. This does
not turn the inherited demo bridge into a production bridge or alter the
normal dashboard bridge. See the [shared validation record](../docs/audits/2026-10-20-treasury-shared-network/README.md).

Build a new immutable deployment/source release with
`npm run build:treasury-release`, then `npm run check:treasury-release`. Each
release retains ABI, exact creation/runtime bytecode, compiler immutable offsets,
all three dependency pins and the standard JSON source inputs. The builder
recompiles each verification input to reproduce its deployment bytes, including
metadata. Runtime checks mask only compiler-declared immutable locations; final
manifest validation checks constructor and application bindings.

New setup transactions queue source verification automatically. Existing setup
journals continue using their original artifact build. See the
[source-verification workflow](../docs/runbooks/treasury-shared-network.md#automatic-contract-source-verification)
for worker persistence, deployment, retry semantics and inherited factory limits.

## Payment policy

[TreasuryPolicyBase.sol](src/l2/TreasuryPolicyBase.sol) implements authorization,
aligned allowance checks, budget accounting, exact splits and events once. Both concrete policies inherit it without an extra deployment.
[TreasuryPolicy.sol](src/chiado/TreasuryPolicy.sol) handles Chiado's lock-then-mint bridge;
[StandardBridgeTreasuryPolicy.sol](src/l2/StandardBridgeTreasuryPolicy.sol) handles
the generic bridge through its bounded Ethereum delegate. Their existing
submission paths and token custody checks remain distinct. See the
[fixed-payment validation record](../docs/audits/2026-10-23-treasury-fixed-payments/README.md)
for current source identity, coverage and bytecode trade-offs.

Both accept the configured EEZ-X Safe and the manager-registered proxy of the L1
Safe. The L1 Safe verifies its normal signatures; the EEZ-X Safe retains
`L1Owners` verification. The L1 path emits a nonce/calldata marker for canonical
receipt matching. EOAs and arbitrary proxies cannot authorize policy payments.

The policy recognizes one immutable canonical asset and its bridge-verified wrapped
representation. The global and per-payment ceilings are fixed at 150 USDC; each
period is 600 seconds. No deployment admin, Guard or arbitrary-call method is
introduced. Only the official AllowanceModule is enabled on each Safe: the policy
is its L2 delegate. The Chiado policy's authenticated alias is its L1 delegate;
the standard-bridge policy uses `StandardBridgeDelegate`, bound to its alias by
the L1 Safe. Owners retain direct spending and administrative authority outside
this policy.

`paySplit` executes exactly the two signed contributions, including zero from
either Safe. The UI can suggest destination-first funding before signing.
Capacity is the minimum of the Safe's balance and effective allowance; execution
rejects an allocation that no longer fits instead of changing it.
For an L1 recipient, the L2 module transfers its contribution to the policy,
which burns it through the bridge; L1 escrow
releases the same amount to the recipient. The L1 module pays directly.

For an EEZ-X recipient, the L2 module pays directly first. On the Chiado bridge
path, the L1 module then transfers its contribution to the policy's L1 alias. A policy-originated token
call approves exactly that contribution to the L1 bridge. The policy calls
`TreasuryBridge.bridgeFromL1` locally; that bridge calls the terminal L1
`lockForL2`, then mints the matching wrapped amount to the recipient. None of
these L1 operations calls back into L2. The policy checks that its alias retains
no contribution and the exact approval is fully consumed. All required failures
propagate; the shared counter is debited before transfers.

On the standard-bridge path, the L1 module pays through the bounded
`StandardBridgeDelegate`. It approves and calls the existing L1 bridge, whose
callback credits the EEZ-X recipient. Both signing origins are submitted through
an L1 entry point to fit the pinned signer's supported call profile. The delegate
also rejects residual custody and unconsumed approvals.

Percentage-of-holdings payments and their automatic allocation are removed from
new policies and the UI. Fixed payments keep the same ABI, signing domains and
settlement event. Existing contracts are immutable: deploying this dashboard
does not change their code. Saved fixed, internal-transfer and invoice requests
keep their original identities. Old percentage requests are unsupported and are
rejected without conversion or deletion; resolve any pending request with its
original release before switching the UI. Retained build archives reproduce old
deployments and remain unchanged.

The isolated invoice fixture computes its own split and calls the same checked
payment path, then requires merchant acceptance. This test-only routing does not
add an entry point or automatic allocation to production policies.

[TreasuryBridge.sol](src/chiado/TreasuryBridge.sol) inherits the pinned **test-only**
bridge without modifying core. The token and destination rollup are immutable.
Only the configured L2 bridge's authenticated L1 alias can lock a deposit;
that bridge binds the payer to its actual local caller. L1 derives the payer's
alias and takes tokens from that alias. Each pair-wide nonce is consumed once.
The returned receipt binds both bridges, rollup, asset, payer, recipient, amount
and nonce. L2 validates it and mints only inside that same call after a successful
lock; there is no independent receipt-redemption endpoint. Exact escrow credit
is required, and existing burn/release uses the same escrow and wrapped asset.
The inherited initialization/admin and generic token paths retain the pinned
fixture's limitations; this is not a production bridge.

For an isolated fixture, deploy a fresh compatible pair and wrapped token. New
shared-network treasuries reuse the registered sealed pair. The policy requires
the extension and pins its configured L1 counterpart. Existing
bridge deployments and their wrapped assets are not upgraded or remapped.
The manifest's optional `combinedL2: true` enables the reverse route only after
the client checks deployed code identity, both bridge counterparts, managers,
rollup, canonical token and wrapped mapping. Old configs without the capability
retain their prior routes. Pending intents remain scoped to their original
instance; restarting this disposable devnet creates a new deployment.

Set both official allowances to 100 USDC, reset time 10 minutes and the same
aligned base (`resetBaseMin = 10` in this fixture). The policy refuses a grant
whose effective period differs from its own. Owners can change their grants;
100 is the fixture's configured ceiling, while 150 is fixed in this policy.
Provision the policy's L1 alias before its first remote read. The setup uses the
registry's derivation API and normal owner-authorized Safe administration.

[payments.ts](../src/lib/treasury/payments.ts) reads canonical balances and
counters, parses exact six-decimal amounts, builds the immutable Safe transaction
and checks the exact `Paid` event, including the signed amount and contributions,
before reporting settlement. The current budget period comes from L1.
When an idle L2's settled block predates that period, the reader applies the
module's aligned reset rule to its historical allowance: grant and nonce stay
the same, effective spending resets, and settled token balances are preserved.
The policy counter is read for the new epoch from settled storage. This avoids
blocking the first payment after an idle period. Funding previews are advisory; execution
recalculates the contribution using authenticated reads. No funds or counters
are deducted optimistically by the UI. A submitted request is saved before the
wallet broadcast and remains unresolved until a canonical outcome is verified.

## Isolated invoice fixture and rollback

[`InvoiceTreasuryPolicy`](test/fixtures/InvoiceTreasuryPolicy.sol) extends the
Chiado policy only for isolated tests. Its `payInvoice` uses the combined router
to pay an L1 recipient, then calls its immutable
[`InvoiceMerchant`](test/fixtures/InvoiceMerchant.sol) through an EEZ proxy.
The signed fields bind the invoice ID, asset, recipient, amount, epoch and Safe nonce. The merchant accepts
only its one-time configured policy alias and exact open-invoice terms. Closing
or paying an invoice prevents reuse. `InvoicePaid` is emitted only after required
acceptance succeeds. There is no arbitrary external-call parameter.

Neither fixture is included in the current public deployment release. Both public
policy variants have no invoice fields, proxy, constructor argument or entry point.

The fixture controller owns invoice creation/closure but has no Safe module or
payment authority. It cannot provide owner approvals. For the failure act it
holds the already proved posting request at the native relay's existing test
barrier and prepends a separate signed closure. The post and native blob bytes
are unchanged. The test requires the closure and post to execute, in order, in
the intended target block; a missed ordering is unverified, never a rollback pass.

The hidden UI's **Invoice rollback** preset opens a 110-USDC test invoice in a
fresh budget period. Owners review and sign normally. The payment bridges 10
from EEZ-X, transfers 100 from the L1 Safe, then encounters `InvoiceNotOpen`.
Only a trace containing both successful token calls before this exact error in
a shared reverted frame establishes that earlier legs executed. The UI checks
canonical block anchors, receipts, the trace, and before/after balances, escrow,
supply, allowance spending/nonces, global spending, Safe nonces and temporary
funds. It also waits for terminal Composer reconciliation. The separate closure
remains committed; fees and the submitter's network nonce are outside rollback.

A known closed invoice is a separate preparation rejection. Missing receipts,
missing `L2TxSkipped`, timeouts or an incomplete fixture report do not establish
rollback. The standard dashboard does not serve the fixture control endpoints.
The fixture constructor pins the merchant. Use a fresh isolated deployment;
public-network manifests reject both `invoiceMerchant` and `invoiceControl`.

See the [invoice validation record](../docs/audits/2026-10-20-treasury-invoices/README.md)
for executed checks, inclusion evidence and remaining limitations.

## Validation and limits

| Check | What it establishes |
| --- | --- |
| [L1Owners.t.sol](test/L1Owners.t.sol) | Real 0.7.6 Safes: quorum, addition/removal, threshold changes, duplicate/insufficient signatures, chain/Safe/nonce isolation, calldata fuzzing, eth_sign, explicit vs implicit approved hashes, full contract-owner preimages, constructor binding and Safe failure/nonce behavior |
| [L1OwnersEEZ.t.sol](test/L1OwnersEEZ.t.sol) | Real pinned EEZL2/proxy route from Safe signature verification; manually loaded static entries derived from real L1 Safe outcomes; missing, stale, wrong-position/identity and failed-result cases |
| [AllowanceModule.t.sol](test/AllowanceModule.t.sol) | Official module accepts contract and EEZ proxy delegates with empty signatures, rejects other callers, enforces its own ceiling, resets at an aligned boundary and checks token returns while preserving counters/nonces on failure |
| [BidirectionalTreasuryPolicy.t.sol](test/BidirectionalTreasuryPolicy.t.sol) | Both initiating Safes, both destinations, shared counters, forged proxy and EOA rejection, L1 signature replay and later-transfer rollback; shares the payment fixture |
| [TreasuryPolicy.t.sol](test/TreasuryPolicy.t.sol) | Exact 40 / 110 / rejected 1 sequence, bridge backing, balance-limited routing, aligned reset and stale-epoch rejection, caller/asset/amount/recipient bounds, final-transfer/terminal-lock failure rollback, reverse lock/mint, alias approval consumption, authenticated payer/bridge, receipt and nonce rejection, amount fuzzing, both destinations, unchanged signed amount after a balance change, shared counters, removed-selector rejection |
| [StandardBridgeTreasuryPolicy.t.sol](test/StandardBridgeTreasuryPolicy.t.sol) | Both signing origins and destinations, exact splits, shared budget, peer/delegate bindings, later-transfer and lock failure rollback |
| [TreasurySplit.t.sol](test/TreasurySplit.t.sol) | Signed contributions remain exact; insufficient capacity, invalid amounts and replay reject rather than reallocating |
| [TreasuryInvoice.t.sol](test/TreasuryInvoice.t.sol) | Isolated fixture invoice terms, authorization and rollback after both contributions |
| [Native process scenario](../tests/integration/README.md) | Real Composer/signer/L1 settlement and independent follower; owner addition, removal, replay rejection, Safe nonce and application state; browser invoices exercise actual L1 inclusion failure and distinct preparation rejection |
| [Safe signature vector](test/fixtures/safe-signature.json) | Frontend hash and packed bytes independently checked by real Safe Solidity code; matching frontend tests cover edits, invalid/removed/duplicate owners, thresholds and exact integers |

The owner/policy fixture routes reads and mutable deliveries directly between two logical managers in one EVM.
The EEZ-specific suite uses a real manager with **manually loaded tables**; it
neither obtains a proof nor invokes the production Composer/signer/follower.
Allowance alias tests supply the trusted manager delivery explicitly. These are
contract tests, not L1 settlement rollback evidence. The separate native scenario
uses isolated genesis-funded public test wallets and actual runtime processes.

Local validation on 2026-10-20 passed 52 Solidity tests (three 256-case fuzz tests),
222 dashboard tests and the TypeScript/Vite build. The build retains its existing
large-chunk warning. The [owner integration](../docs/audits/2026-10-20-treasury-owner-integration/README.md)
and [connected owner UI](../docs/audits/2026-10-20-treasury-connected-ui/README.md)
records preserve the earlier evidence. The new
[payment evidence](../docs/audits/2026-10-20-treasury-payments/README.md) records the
real browser sequence, same-L1-transaction split, contract-level rejection,
bridge accounting, independent replay and exact tested identities. The [reverse-route record](../docs/audits/2026-10-20-treasury-reverse-payments/README.md)
tracks the paired extension and reverse browser path. The [percentage-rule record](../docs/audits/2026-10-20-treasury-rules/README.md)
preserves validation of the now-removed percentage feature. The local
contract failure fixture demonstrates rollback within a single-EVM mock delivery;
it does not establish failure after L1 inclusion. The [invoice record](../docs/audits/2026-10-20-treasury-invoices/README.md) separately records the controlled native inclusion failure and its canonical trace/state evidence.

Checks before committing changes:

```bash
forge fmt --check --root contracts
forge fmt --check --root contracts/legacy
npm run test:contracts
npm test
npm run build
git diff --check
```

Use the [full rehearsal runbook](../docs/runbooks/treasury-rehearsal.md) for
connected payments through the dashboard and L1 owner changes through the local
Safe app. Actual wallet-extension approvals remain a human rehearsal step.
The connected UI now retains browser-local payment history; see its
[scope and validation](../docs/audits/2026-10-20-treasury-history/README.md).
Remaining rehearsal requirements are in the
[proposal](../docs/proposals/one-treasury-two-safes.md).


## Selected-wallet setup and existing Safes

The [shared-network setup](../docs/runbooks/treasury-shared-network.md) can reuse
verified Safe / SafeL2 1.3.0 and 1.4.1 implementations. The exact upstream singleton hashes
come from `safe-deployments` revision `e9cc9798ab834e7fe515d361566eb4a28c65387f`
([Safe](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.4.1/safe.json),
[SafeL2](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.4.1/safe_l2.json));
local pinned 1.4.1 builds are also recognized. Safe 1.3.0 EVM hashes use the same
registry revision's [GnosisSafe](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.3.0/gnosis_safe.json)
and [GnosisSafeL2](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.3.0/gnosis_safe_l2.json)
entries; the latter is shown as **1.3.0+L2** in the Safe app. New Safes retain 1.4.1.
Proxy matching compares executable code
without compiler metadata; manifests bind the full observed code hashes and
Safe singleton slots. `VERSION()` alone never establishes compatibility.
Execution tracking handles 1.3.0's non-indexed hash and 1.4.1's indexed hash with
strict complete log layouts. Recovery filters both execution result topics, then
matches the expected Safe and transaction hash before verifying the receipt.
For an imported `L1Owners`, repeated compiler-declared immutable slots must agree;
its `safeL1Proxy` must equal the manager's computed and registered L1 Safe proxy.
This prevents accepting code whose getters describe the expected Safe but whose
signature check calls a different proxy.

The browser collects the current quorum's typed signatures. To adopt an existing
L2 Safe, it delegates one call-only batch to Safe's unmodified `MultiSendCallOnly`:
remove the old linked-list heads and replace the last owner with `L1Owners`.
The entire transaction reverts on failure (`safeTxGas = gasPrice = 0`). No token,
module, handler or Safe address migration is involved. A Guard or an unsupported
contract-owner quorum stops setup; it is not removed or bypassed.

`npm run test:treasury:setup` builds the artifacts and runs
[the setup test](../tests/integration/treasury-setup.mjs) on two owned Anvils with
dynamic ports. It exercises real Safe creation, retained-quorum administration,
owner adoption and rollback, using the production TypeScript approval and receipt
paths. Protocol identity/discovery are fixtures, and intermediate application
setup steps are explicitly omitted. It does not establish cross-chain settlement;
use the separate native process/browser regression for that evidence.
Run `EEZ_TEST_SAFE_VERSION=1.3.0 npm run test:treasury:setup` for official 1.3.0
bytecode. The [fixture](../tests/fixtures/safe-130-runtime.json) comes from
`@gnosis.pm/safe-contracts@1.3.0` (LGPL-3.0); it records package integrity and the
pinned deployment hashes. Tests assert those runtime hashes before execution.
The package contains the corresponding upstream source; no dependency pin or
production deployment artifact is changed.

## Simplified shared setup

[Version-3 shared setup](../docs/runbooks/treasury-shared-network.md) reuses
[official Safe infrastructure](../src/lib/treasury/official-safe-deployments.json)
only after exact on-chain code verification. The reviewed Safe deployment catalog
revision is retained in that file. Chiado's 1.3.0 factory creates the same
executable proxy body used by the pinned 1.4.1 Safe; it emits a non-indexed
`ProxyCreation` event. Newly deployed Safe singletons remain 1.4.1; imports may use either supported version.

Each Safe delegates an atomic zero-value CALL batch to an exact-code-verified
`MultiSendCallOnly`. The current quorum signs the entire batch; inner calls
retain the Safe as caller. Configuration failure reverts its earlier module,
delegate, allowance and alias changes. Real official runtime fixtures cover this
on owned Anvil networks. Native rehearsal additionally executes both batches
through the actual Composer/signer and owner adapter.

New payment deployments omit `TreasuryOwnerAction` and invoice contracts. The
public policies have eight constructor arguments and no invoice entry point.
The isolated fixture extends the Chiado payment path to test invoice failure;
production rollback tests instead make a later token or bridge leg fail.

See the [validation record](../docs/audits/2026-10-20-treasury-simplified-setup/README.md)
for source identity, migration coverage, rollback evidence and deployment limits.


## Batched contract deployment

Version 4 uses [TreasuryBootstrap](src/shared/TreasuryBootstrap.sol) for atomic CREATE
and CALL sequences. Each executor is created from the selected wallet, has an
immutable owner and exact sequence check, rejects reentrancy, and permanently
closes at completion. It has no Safe owner/module role and permits no delegatecall.
Expected creation addresses and optional return hashes make changed nonces and
false token/Safe results revert the entire transaction. The L1 executor temporarily
holds 150 newly minted test tokens until bridging; its final balance and approval
are zero. The archived `BootstrapTreasuryBridge` artifact returns its temporary
administrator to that wallet. Its source wrapper is no longer compiled; existing
version-4 journals keep the exact artifact recorded by their original release.

The browser predicts each CREATE from the executor nonce and each Safe from its
factory's exact creation bytes. The legacy compiler embeds different proxy CBOR
metadata inside `SafeProxyFactory` than in the standalone proxy artifact. The
artifact generator extracts that unique literal, checks that only the metadata
span differs, and the live-factory integration checks the getter byte-for-byte.
Do not substitute a metadata-stripped hash for CREATE2 address derivation.

Before the wallet creates its EEZ-X executor, the planner checks its pending
nonce and prospective CREATE addresses. The observed shared wallet A starts at
nonce 0 although its first two CREATE addresses already contain protocol code.
Two required manager proxy calls consume those nonces before creation. This is
an ordinary wallet-approved flow, not a node nonce override. Tests inject occupied
addresses into their owned Anvil and execute the same preparation transactions;
ordinary wallets have no extra calls.

Run `node tests/integration/treasury-deployment-batches.mjs` after building the
contracts/artifacts. It uses one owned Anvil and the test-only read-through EEZ
managers, switching chain ID before each phase. Real contract deployment, Safe
quorums, bridge transfers and receipt checks run; this is not proof/Composer
validation. The native rehearsal separately groups L1 funding and L2 module/policy
creation plus Safe approval under the actual Composer, signer and follower.
See the [evidence and limitations](../docs/audits/2026-10-20-treasury-deployment-batches/README.md).

## Shared treasury token and bridge pair

New wallet setups use `SharedTestUSDC` and `SharedTreasuryBridge`. The faucet
issues 450 units once per setup executor (permissionless test supply), retaining
300/150 initial funding and 100/100/150 policy limits. The first pair is connected
and sealed before its on-chain registration; later setups verify and reuse it.
The extended `bridgeFromL1`/`lockForL2` path and ordinary burn/release path are
unchanged. `TreasuryPolicy` remains immutable and treasury-specific.

`tests/integration/treasury-deployment-batches.mjs` exercises legacy recovery,
then creates two treasuries with different wallets using one shared asset and
pair. It checks independent balances, limits, both payment destinations, escrow
backing and rejection. Its protocol managers are read-through fixtures, not
proof validation. The native browser scenario in
[the integration guide](../tests/integration/README.md) uses the shared contracts
with real Composer, signer and follower, including the invoice rollback act.
See [the shared-network runbook](../docs/runbooks/treasury-shared-network.md) for
canonical discovery, first-install coordination and journal compatibility.

## Separate funding and retained setup recovery

Current shared-network setup uses predeployed Test USDC and sealed bridges. It
requires no wallet token balance, token approval, mint or funding transaction.
Fund either Safe separately after setup. The test-token faucet is an explicit
Chiado-only action; Ethereum uses the existing canonical USDC and bridge.

Older saved setup plans may contain a reviewed 450-token approval and funding
batch. Recovery preserves those exact bytes: ERC-20 `transferFrom` debits the
wallet, 300 stays in its L1 Safe and 150 is bridged to its mirror. Tests retain
that path, including insufficient-balance rejection, consumed allowances and
unchanged token supply. It is not offered by new setup plans.

The operator's shared test infrastructure batches and recovery journal live in
[`treasury-infrastructure.mjs`](../scripts/treasury-infrastructure.mjs); see the
[runbook](../docs/runbooks/treasury-shared-network.md#predeploy-the-shared-infrastructure-once)
for predeployment and saved-plan compatibility.

## Configurable test-token faucet

[`TestUSDCFaucet`](src/chiado/TestUSDCFaucet.sol) delivers an exact six-decimal amount to
any recipient on Chiado or through the existing shared bridge to EEZ-X. It pools
fresh `TestUSDCClaim` allocations from the immutable test token and retains excess
for future permissionless requests. It never spends from a Safe. Request failure
reverts refills, transfers and locks; the bridge allowance is zero after success.
The one-time constructor validates the token/bridge binding but does not mint.
Delivery is a separate call so EEZ-X requests use the existing fee quote profile.

The UI validates the deployed dispenser runtime and immutable bindings, persists
the selected request before sending, and checks canonical receipts and exact
transfer/delivery events. Old fixed claims retain their bytecode and journal
identity. No shared token, bridge or treasury migration is required. See the
[runbook](../docs/runbooks/treasury-shared-network.md#requesting-more-test-usdc).
