# One treasury, two Safes

**Warning: The custom treasury contracts are unaudited demo code and are not ready
for production use, including the Ethereum mainnet integration.** Source
verification and passing tests do not constitute a security audit.

*A Safe on Ethereum L1 and a Safe on EEZ-X, operated through one owner set and one payment policy using EEZ's synchronous cross-chain execution.*

| Field | Value |
| --- | --- |
| Design status | Implemented demo with isolated integration evidence. Public explorer acceptance, real-wallet/Safe-app acceptance and independent contract review remain outstanding; see the [release record](../audits/2026-10-22-treasury-release/README.md). |
| Date | Initial design 2026-10-19; status updated 2026-10-23. |
| Demo repository | `eduadiez/eez-rollup-dashboard`. This proposal, UI, application contracts and tooling are prepared on `codex/treasury-demo-release`. |
| UI baseline | `917a365db5b021c970607e3f4c45c35877fcb2b8`: initial hidden preview with simulated data; current connected milestones are recorded below. |
| Runtime baseline | `eduadiez/rollupX`, commit `fa916b13254a36423cad130080dde367bb18a7d6`. The initial review used its `feat/l2-fee-recovery` checkout with pre-existing Composer, node and E2E changes; implementation evidence must identify the exact tested revision and any patches. |
| Protocol baseline | `eez-core-protocol` at `855fe0602484750861b4c31502a1a91355d33ed6`. |
| Safe baseline | Safe v1.4.1 at `bf943f80fec5ac647159d26161446ac5d716a294`; AllowanceModule v1.0.0 at `c95f03900bff99be090dadb9de1c74b162365485`. Both are pinned under `contracts/lib`; setup verifies reused runtime bytecode and bindings. |
| Implemented environments | Isolated development chains and shared Chiado/EEZ-X setup. The existing Ethereum bridge and USDC path has isolated native rehearsal and fork-test evidence; public mainnet wallet/Safe-app acceptance remains separate. |
| Related contracts | [Core protocol](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/CORE_PROTOCOL_SPEC.md), [execution entries](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/EXECUTION_ENTRY_SPEC.md), [static entries](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/STATIC_ENTRY.md), [protocol caveats](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/CAVEATS.md), [signer specification](https://github.com/eduadiez/rollupX/blob/fa916b13254a36423cad130080dde367bb18a7d6/crates/eez-proof-signer/SPEC.md). |

The dated sections below retain the design's evolution. For current setup and
presenter instructions, use the [shared-network](../runbooks/treasury-shared-network.md),
[mainnet](../runbooks/treasury-mainnet.md) and [rehearsal](../runbooks/treasury-rehearsal.md)
runbooks. Evidence from an earlier milestone does not validate a later build.

## Accepted direct setup and payment model (2026-10-23)

New treasuries use one direct plan: inspect the selected L1 Safe, reuse verified
infrastructure and the predeployed asset, deploy/connect its mirror, and configure
both allowance delegates. No historical setup migrations, token creation or Safe
funding run when a new treasury is selected. Fixed payments contain an amount and
an exact L1 contribution; the slider determines that contribution before signing.

Existing treasury addresses and immutable release bindings remain unchanged.
Saved setups resume their original plan; only the saved-record reader can select
that recovery path. Never reconstruct pending transactions with current bytecode,
translate signatures, reset counters or resend a missing wallet response. Existing
token-bearing split deployments retain their selector at the compatibility boundary;
old local/automatic payment formats are available only for recorded-request recovery.
Retain archived build inputs for verification and historical execution identity.

Remove the obsolete ConfiguredTreasuryBridge and BootstrapTreasuryBridge source
contracts; the shared bridge owns its constructor initialization directly. Exact
historical shared-bridge identities remain admissible for reuse, with the same
manager, asset, wrapped token, sealed-peer and canonical-block validation.

Acceptance: current setup has no migration/funding steps; both initiation chains,
both destination chains, exact splits, internal transfers, owners, invoice fixtures,
history and rollback remain covered. Pending/review hashes and creation bytes are
unchanged after reload, including a missing wallet response. No public broadcast
or environment-variable change is part of this work.

Implementation and validation: [direct setup audit](../audits/2026-10-23-treasury-setup-simplification/README.md).

## Accepted fixed-payment simplification (2026-10-23)

Remove percentage-of-holdings payments from both production policies and the UI.
The only production payment entry point is `paySplit`: owners approve the exact
amount, recipient, destination, budget period and each Safe's contribution. The
UI retains the split slider and can suggest a destination-first split before
signing; the contract validates that allocation without recalculating it.

Keep initiation from either Safe, both recipient chains, shared live owner
verification, the 100-per-Safe / 150-global budget, internal transfers, faucets,
payment history, and the isolated invoice rollback scenario. Remove percentage
calculation, its event and capability checks, and automatic allocation from the
production policy. The invoice fixture computes its own destination-first split
before invoking the same checked payment path.

The fixed-payment ABI and saved fixed/transfer/invoice intents stay unchanged.
Existing on-chain policies are immutable and retain their deployed entry points;
new releases omit `payRule`. Previously signed percentage intents are unsupported
by this release and must never be reinterpreted as fixed payments. Browser
journals and operator configuration are not rewritten or discarded. Resolve any
pending percentage request with its original release before switching the UI.

Acceptance: reject both historical `payRule` selectors, preserve the exact signed
split when balances change, reject obsolete rule intents, and rerun contract,
client, build/source-verification and isolated native browser/integration checks
for both bridge paths, including a later-leg rollback. This section supersedes
percentage-payment requirements in the dated milestones below.

## Accepted feature-preserving simplification (2026-10-22)

Use one abstract payment implementation for owner authorization, aligned allowance
checks, exact splits, percentage rules, the shared counter and payment events.
Keep two small bridge adapters: Chiado retains direct EEZ-X submission and its
lock-then-mint route; the standard bridge retains its authenticated Ethereum
delegate and supported relay submission. Inheritance introduces no extra deployed
contract or external call. Forcing both networks through the same transport would
change the existing Chiado submission feature and is outside this simplification.

New policies expose `paySplit` and `payRule`. A fixed payment from one Safe is an
exact split with a zero contribution from the other. Percentage rules continue to
read both balances and route at execution. Never replace a signed split with an
automatically recalculated allocation. Preserve both Safe signing origins, both
destinations, the 100/150 limits, owner updates, internal transfers, payment history,
source verification and atomic failure after an earlier leg.

Remove the old policy-upgrade contracts, executable upgrade workflow and
constructor-only policy wrappers. Keep read-only display of historical receipts.
Retain immutable historical compiler inputs for verification and pending journals; new deployments use the simplified artifacts. Keep the existing
shared Test USDC and its faucet working: replacing that immutable token merely to
remove its claim workaround would change the configured asset and balances.
No public contracts are deployed, no environment variables are added, and no
operator or browser state is migrated by this refactor.

Acceptance: the current contract and client regressions pass against the new
artifacts; add equivalent split/rule/failure coverage for both bridge adapters;
exercise setup and exact-source verification, then the isolated cross-chain
rehearsal with canonical rollback and independent replay. Record the tested build
and any unrun acceptance checks separately from earlier release evidence.
See the [consolidation validation record](../audits/2026-10-22-treasury-policy-simplification/README.md).

## Accepted treasury contract simplification (2026-10-22)

For new setups on both public networks, reuse a verified EEZ-X Safe singleton,
proxy factory, call-only batch helper and allowance module. Bind shared addresses
to the selected chain and manager, check exact runtime identities at one canonical
block, and recheck saved bindings before submission. Reused modules must not be
enabled twice; the reviewed batch must reflect that observed state. Preserve
other delegates, counters and the existing Safe owners and threshold.

New standard-bridge policies obtain the policy alias from the existing Ethereum
funding delegate's one-time Safe-authorized binding. Reject an unbound delegate;
retain the canonical alias and delegate binding checks in the client. Remove the
alias-reader constructor argument, proxy and calls from this policy. Chiado's
demo bridge policy still needs its reader to execute its existing bridge API.

Remove the invoice merchant, invoice proxy, constructor argument and invoice
entry point from new public mainnet **and testnet** policies. The controlled
invoice demonstration belongs only to isolated test fixtures. Exercise real
payment rollback after an earlier leg on both public-network policy variants.

Publish a new immutable contract build. This simplification targets new deployments;
old policy constructor layouts do not need a compatibility path. Keep historical
verification inputs and local operator state intact, without migrating contracts
or changing network identities or environment files.

Discover reusable EEZ-X infrastructure through the existing bootstrap `Created`
events, matching creation hashes and exact deployed runtimes. If a contract is
absent, prepare it from the connected wallet in the normal setup batches. Later
wallets find those confirmed deployments from chain history. Do not introduce a
registry contract, an operator key or new environment settings. Concurrent first
setups can create equivalent copies; reuse does not require global uniqueness.

Acceptance: exact shared-code and canonical-block validation; new selections
reuse infrastructure across wallets; module-enable changes invalidate approvals;
new public-network ABIs exclude invoices; mainnet has no reader dependency; both
initiation and destination chains, explicit splits, percentage rules, 100/150
accounting and later-leg rollback pass contract and isolated native integration
checks. Retained release inputs reproduce the new deployed bytes. No public chain
broadcast is required for validation.

## Accepted shared Ethereum helpers (2026-10-22)

For new mainnet treasuries, reuse the verified Ethereum allowance module and
registry-bound alias reader already deployed by the first setup. Pin their full
runtime identities separately from the existing network identity, verify their
canonical code and registry binding at selection, and carry the hashes into the
manifest. Failed reads or changed code must not fall back to new deployments.
Keep the treasury-specific funding delegate and deployment executor. Preserve
saved setup addresses, transaction bytes and current Chiado behavior.

An already-enabled module must not be enabled twice. Include that observed state
in the reviewed Safe batch and invalidate approvals if it changes; configuring a
new delegate must preserve all existing delegates and counters. Source verification
is complete on an exact Sourcify match even if explorer publication is pending.
Unresolved jobs remain visibly incomplete and continue retrying.

Acceptance: verify the live shared helpers without broadcasts; test reuse across
new selections, rejection of missing/changed code and registry/reorg/RPC failures,
old-plan preservation, module-enable review invalidation, independent allowances
in real Safe/module contracts, and browser completion with pending publication.

## Accepted existing-mainnet-bridge integration (2026-10-22)

Use the bridge pair and canonical USDC discovered from the existing mainnet
dashboard configuration, without new operator environment variables. Preserve
Chiado contracts, setup journals and frozen deployment artifacts. A separate
`StandardBridgeTreasuryPolicy` uses the generic `bridgeTokens` API in both
directions; it does not require the demo bridge's `bridgeFromL1` extension.
A `StandardBridgeDelegate` on Ethereum combines the allowance transfer and
standard bridge operation in one authenticated call. The Ethereum Safe binds its
policy alias once, then grants the delegate its official 100-USDC allowance. Only
that alias can spend it. The EEZ-X policy retains the 150-USDC shared budget and
its own 100-USDC allowance. No custom contract receives Safe module authority.
Balances and consumed approvals are checked before returning. The explicit
owner-authorized internal transfer retains its existing exemption.

The manifest selects `bridgeKind: "standard"`, binds the funding delegate as
`bridgeExecutorL1`, and binds the mirror Safe's L1 alias. Both entry points submit
through Ethereum: owners signing for the mirror still authorize its EEZ-X EIP-712
domain and nonce, then the submitter calls that Safe's L1 alias. This gives the
standard bridge callback an L1-origin execution root within the pinned signer's
supported profile. It does not relax signer checks or change Chiado. Approval
network, submission network and canonical evidence remain distinct in the UI.

Acceptance requires exact deployed bridge/USDC runtime identities, both source
Safes and both destinations, splits, owner changes, shared-limit rejection,
percentage rules, replay rejection, and rollback after an earlier leg in an
isolated native Composer/signer/follower rehearsal. Fork checks establish real
USDC behavior separately. Fixture role initialization and balances are test-only;
no live funds, deployments or mainnet configuration are changed by rehearsal.
Implementation/rehearsal status and any gaps are recorded in the mainnet audit.

## Accepted internal transfer and faucet recovery (2026-10-22)

Keep existing deployed Safes, policy, token, bridge pair and user journals. The
policy intentionally rejects treasury-contract recipients. Offer an explicit
owner-approved **Move to EEZ-X Safe** operation instead of silently bypassing a
rejected payment: the Chiado Safe uses its verified official call-only helper to
approve the exact amount, bridge it to its mirror, then clear the approval. The
shared payment budget is not debited; disclose that before approval. Full-balance
moves are allowed by owners. The initial internal-transfer route is Chiado to
EEZ-X, while ordinary policy payments retain both directions.

Preserve source Safe signatures, nonce and transaction binding, bound fee quotes,
pending-request locks and canonical verification. A matching token amount alone
cannot complete a transfer: correlate the unique protocol call, source lock,
destination mint and canonical settlement. Ambiguous evidence stays pending.
Do not redeploy or weaken the existing policy. Downgrades do not support pending
`transfer` intents; keep the updated UI until they resolve.

An independent faucet request revalidates live dispenser/token/bridge bindings
without requiring all completed historical receipts to remain accessible. Pending
requests still require their existing exact reconciliation. Preserve all journals.
Remove Simulation and expose Get Test USDC only on Chiado.

Acceptance: reproduce the historical-receipt block; reject invalid current
bindings and unresolved requests; exercise real Safe approval/quote packing;
reject altered transfer intents and uncorrelated/reorged receipts; verify a
full-balance quote against the configured Composer without broadcasting; check
wallet review and completed-flow/history behavior on desktop and mobile. See the
[validation record](../audits/2026-10-22-treasury-recovery/README.md).

## Mainnet compatibility preparation (2026-10-22)

Scope: add an explicit Ethereum-mainnet manifest for an existing Ethereum Safe
and its configured EEZ-X mirror. Keep the current Chiado deployment, setup
journals, contract bytecode and payment limits unchanged. Mainnet configuration
must identify the actual Ethereum-anchored EEZ deployment; the Chiado rollup
cannot be retargeted by changing an RPC URL.

Use Circle's canonical Ethereum USDC, six decimals, and a separately verified
wrapped representation. Pin both proxy code and implementation identity for
USDC, protocol contracts, Safes and any supported upgradeable bridge. Check the
bridge's peers, token, rollup and mint authority. Code identity is an operator
trust input, not an audit. Reject the packaged test bridge implementations.
No mainnet faucet, token creation, automatic funding or test-invoice controls.

Mainnet connection uses an explicitly supplied deployment manifest. The existing
Chiado setup wizard remains testnet-only until a production bridge and target
rollup have been selected and validated. Do not silently reuse its contracts or
browser setup state. A new read-only preflight checks the configured deployment;
it cannot sign, broadcast or certify production safety.

Acceptance: reject mixed networks, wrong USDC, missing implementation identities,
proxy upgrades, wrong bridge mappings and fixture controls; retain both signing
domains, bidirectional payments and 100/150 accounting. Exercise existing
Chiado regressions and a separately identified real-USDC fork test when an RPC
is available. A live target rehearsal and independent review of the custom
contracts, bridge and protocol security path remain release requirements.
The alternative of loosening the Chiado allowlist and reusing its test bridge
is rejected because it would relabel fixture infrastructure as production.

## Accepted configurable test faucet (2026-10-21)

The explicit faucet accepts a positive six-decimal amount, a recipient address,
and Chiado or EEZ-X. Existing balances and prior requests never cap eligibility.
It adds exactly the requested amount; choosing a Safe funds that Safe without
changing its allowance or shared-budget counters. The submitting wallet pays
Chiado gas; EEZ-X delivery uses the existing backed bridge and a bound Composer
fee quote. The faucet remains outside treasury setup and mainnet payment flows.

Preserve the immutable shared token and bridge pair. Its legacy `claim()` mints
450 units per fresh caller, so a reusable test-only dispenser combines claims
and retains excess as a reserve for later requests. Prepare that dispenser once,
then send the selected delivery as a separate call: the current fee quote profile
requires a call target. Later requests reuse the dispenser. Each transaction remains
subject to the network gas limit; there is no per-wallet balance cap or cooldown.
Freeze each request's amount, recipient and destination in its journal before
sending. Preserve old direct/fixed claims exactly; uncertain wallet responses
must be tracked without duplicate sends. A failed delivery reverts its mint.

Acceptance: exact fractional and multi-claim amounts, repeat requests with funds
already held, arbitrary recipients and both networks, canonical receipt and
request matching, pending reload/cancellation, malformed inputs, wallet changes,
local/bridged rollback and a native Composer/proof-signer/follower run for EEZ-X.

## Accepted payment allocation slider (2026-10-21)

Replace the fixed-payment funding selector with a slider showing both Safe
percentages and exact USDC contributions. Sign the exact L1 contribution in
`paySplit`; L2 pays the remainder. Endpoints fund entirely from one Safe. The
contract rejects unavailable capacity without silently changing the split.
Percentages are display values; base-unit amounts avoid rounding the required
100 + 10 split for a 110 payment. Default to recipient-chain-first allocation;
once moved, keep the user's choice across live balance refreshes. Rules and the
controlled invoice fixture retain their existing automatic allocation.

The demo assumes a newly deployed payment policy with the slider available
immediately, without a separate activation or policy-upgrade workflow. Setup
version 9 originally used `SplitTreasuryPolicy`; the 2026-10-22 consolidation uses
`TreasuryPolicy` with the same split capability. Earlier immutable policies are
not relabelled as split-capable. Existing creation artifacts and signed journals
remain frozen for historical recovery; retained payment and handover history stays
readable. The executable handover fixture was removed in that consolidation.

Acceptance: both initiation chains and destinations, endpoints and mixed funding,
exact signed calldata and settlement contributions, insufficient-capacity/global
rejection, rollback of earlier transfers, legacy signed-request recovery,
keyboard/mobile slider behavior, frozen review and no activation prompt in a
freshly configured treasury.
Contract tests use real Safe/module/token contracts with test cross-chain proxies;
native Composer validation must be reported separately from those tests.

## Accepted bidirectional initiation and existing L1 Safe increment (2026-10-21)

New setup requires an existing verified L1 Safe address; it keeps that Safe's
owners, threshold and funds. The EEZ-X Safe may be new or imported. Existing
setup journals, signed batches, pending submissions and manifests retain their
original bytecode, addresses and L2-origin behavior.

New policies accept calls from the local SafeL2 or the local manager's registered
proxy for SafeL1 on rollup zero. An L1 payment is an ordinary owner-signed
SafeL1 transaction targeting the policy's L1 proxy; SafeL1 verifies its own
owners before entering EEZ. An L2 payment retains L1Owners verification.
Both entry paths use the same policy counter, recipient checks, reentrancy guard,
allowance delegates and destination-first split. Neither policy is a Safe module.
L1-origin execution requires the exact read/write call tree to pass Composer,
signer, settlement and independent replay; core support alone is not acceptance.

The dashboard signs the selected source Safe's domain and nonce. A missing source
field in saved payments means L2. L1 execution uses standard EOA Safe signatures;
L2 execution wraps them for L1Owners. Source selection, destination, amount and
funding are visible before approval. Settlement requires the exact L1 Safe
receipt plus matching canonical L2 policy events, tied to that Safe nonce and
call data, never a receipt or queue status alone.

Acceptance covers L1 and L2 initiation to both destinations; a necessary split;
a shared-limit rejection across entry paths; forged caller/replay/owner rejection;
rollback after an earlier leg; saved L2 intent and deployment compatibility; and
an existing-Safe-only setup with no L1 singleton/factory/Safe creation. Old deployed
policies are immutable and retain L2 initiation; enabling both entry paths needs
a newly configured policy. No shared-network treasury upgrade is automatic.

This increment is implemented and validated on the isolated native fixture,
including four source/destination routes and the full browser rehearsal. See the
[implementation and evidence record](../audits/2026-10-21-treasury-bidirectional/README.md)
for exact source identities, the native mock-builder ordering boundary, local UI
deployment, and remaining public-network/Safe-app acceptance work.

## Accepted Safe 1.3.0 import compatibility (2026-10-21)

Extend existing-Safe imports to official EVM Safe 1.3.0 and its SafeL2 variant
(displayed as **1.3.0+L2** in the Safe app). New mirror deployments remain 1.4.1.
Accept the exact singleton runtime hashes in the already pinned Safe deployment
registry; a reported version alone does not establish support. Preserve proxy,
Guard, owner-quorum, adapter, singleton-slot and canonical-block checks.

Safe 1.3.0 puts its execution transaction hash in log data; 1.4.1 indexes it.
All setup, owner-change and payment tracking, including recovery of a missing
wallet response, must handle both complete event layouts and match the expected
Safe address and signed transaction hash. Do not infer success from a receipt
without the existing canonical transaction and payment checks.

Acceptance requires real 1.3.0 imports, owner adoption and allowance configuration,
EOA and contract-owner signature paths, both payment initiation directions,
negative receipt cases and continued 1.4.1 coverage. This increment is implemented
and validated by the [Safe 1.3.0 evidence record](../audits/2026-10-21-treasury-safe-130/README.md),
including real setup contracts, the complete isolated browser rehearsal, posted
attestation and independent replay. Existing addresses, funds, journals and signed
requests remain unchanged; rollback to a prior UI cannot operate a newly imported
1.3.0 treasury.

## Selected wallet and existing Safes

The October 21 increment above supersedes L1 Safe creation in the original setup
plan. Creation remains supported only when resuming an already saved journal.

The connected dashboard wallet selects the deployer at setup review. New setup
requires the address of an existing L1 Safe. The recorded
deployer remains fixed once setup starts because it controls the setup executors
and recorded wallet requests; changing the connected wallet does not change it.

The supplied L1 Safe must use verified Safe / SafeL2 1.3.0 or 1.4.1 and keeps its owners
and threshold. The Safe app labels the 1.3.0 L2 variant **1.3.0+L2**. EEZ-X supports either creating or importing a Safe. An existing EEZ-X Safe either already has
the matching `L1Owners` adapter, or its current quorum approves one atomic,
call-only MultiSend that replaces its owner list with the new adapter. This is
an explicit administrative change. The existing address, assets, modules and
fallback handler remain intact. Current owners authorize each subsequent Safe
administration step; any funded wallet may submit collected approvals. Setup
supports an EOA quorum, including EIP-7702 wallets. It does not remove Guards or
synthesize arbitrary contract-owner signatures.

This supersedes the earlier fixed-A setup. With the accepted shared-infrastructure
extension below, new setups reuse one Test USDC asset and extended bridge pair,
add 300 / 150 to their Safes, and set 100 per Safe / 150 shared per ten minutes.
Existing private-asset setups retain their bindings. Code hashes and Safe
singleton slots bind imported Safes to the reviewed implementation.

Acceptance requires actual Safe execution of the imported-owner transition,
quorum and stale-approval rejection, preservation of balances/modules/handler,
and atomic rollback on a later failed batch call. Browser checks must cover
wallet selection, independent reuse choices and journal recovery without writes
to the shared network. Run the existing native payment regression separately;
Anvil-only Safe setup checks do not establish cross-chain settlement.

Version-2 setup journals retain the selected deployer, random salt, imported
identities and owner approvals. Active version-1 fixed-A journals migrate with
their original deployer, salt, pending request and completed transaction history.
Existing manifests remain readable. Do not downgrade the UI during an active
version-2 setup; older builds do not understand its owner approvals or reuse plan.
See the [shared-network runbook](../runbooks/treasury-shared-network.md).

## Accepted repeatable test faucet (2026-10-21)

The same connected wallet may request another 450 Test USDC as often as needed.
Keep this explicit test-only action outside treasury setup, exposed as **Get Test
USDC** on the connected treasury. Do not transfer tokens to either Safe as part
of the claim or reinstate setup funding.

The existing `SharedTestUSDC` is immutable and limits direct claims by caller.
Preserve its deployed identity, bridge pair, asset balances and reviewed creation
bytecode. Each new faucet transaction deploys a small `TestUSDCClaim` whose
constructor claims once and immediately forwards all received tokens to the
connected wallet. Repeated requests use fresh callers and the same canonical
asset. A failed transfer reverts the mint. No admin key, quota, delay, Safe
permission or operator deployment is required. Replacing the token would require
new bridge/policy bindings and would break existing treasuries, so it is outside
this change.

Keep every confirmed faucet transaction in its separate journal, and preserve
outstanding legacy direct-claim calldata. A pending request prevents a second
submission until its canonical receipt is checked. New mint requests bind the
helper creation bytecode and token address exactly; an older UI rejects their
new step identifiers instead of retrying them as direct claims. Acceptance:
an already-claimed wallet can receive two more allocations, reload and resume
tracking, then request more without changing its treasury or bridge backing.

## Accepted setup without funding (2026-10-21)

Treasury setup only connects the Safes and configures the shared budget and
allowances. Remove the funding approval, token transfers, bridge deposit, token
balance requirement, faucet entry and skip control from new setup. Keep the
predeployed shared asset and bridge pair for payments. Funding the Safes is a
separate ordinary ERC-20 operation, before or after setup.

Version 8 automatically replaces unsubmitted version-6 funding work. Preserve
the selected Safes, wallet, asset, confirmed transactions and 100-per-Safe /
150-shared limits. The former funding batch now only registers the owner
verifier's Chiado alias and closes the existing setup executor. A previously
confirmed token approval remains in history; it is never repeated or used to
transfer tokens. Closing the executor prevents later use of that approval.

Retain the complete prior journal before migration. Never reinterpret pending
calldata or a signed review; resolve that work first. Version-7 optional-skip
journals remain readable. Completed funding and later legacy plans keep their
existing receipt and balance checks. Versions 7 and 8 verify contracts, allowances
and counters without requiring preset Safe balances. Older clients must reject
version 8; do not restore an old funding plan after proceeding with this one.
The internal connection step retains its historical identifier so existing
confirmed prefixes and executor sequencing remain valid.

Acceptance: fresh setup and current unsubmitted setup have no funding UI or
token calls; preserve and reload confirmed progress, including any completed
approval; leave pending requests and reviewed work unchanged; prepare and execute
the owner connection without tokens or an ERC-20 allowance; configure both Safes
with zero balances; and allow later ordinary deposits and payments in both
directions. UI-only rollout preserves runtime services and operator settings.
No live Safe transaction is authorized by this change.

## Accepted existing-asset funding increment (2026-10-21)

Historical version-6 behavior below is superseded for new and eligible unsubmitted
setups by **Setup without funding** above. It remains the recovery contract for
already submitted or completed funding.

Predeploy the shared Test USDC and sealed treasury bridge pair once, separately
from treasury creation. New treasury setup requires that existing infrastructure
and uses only standard ERC-20 approval, transfer and transferFrom operations for
funding. The connected deployment wallet explicitly approves exactly 450 tokens;
a wallet-owned batch transfers 300 to its Chiado Safe and bridges 150 to its
EEZ-X Safe. Insufficient balance stops preparation, with no implicit faucet,
mint, balance override or operator-wallet funding. Test faucet claims are a
separate, explicitly test-only action. Mainnet would use an existing canonical
USDC contract and tokens already owned by the funding wallet; enabling mainnet
and validating Circle's implementation are separate work.

Preserve confirmed transactions, selected Safes, deployment wallet and pending
calldata. Migrate an early unsubmitted setup only before its first contract
batch creates or receives test tokens. Later legacy setups retain their original
contracts and funding plan. New version-6 journals are not backward-compatible
with older UI builds; save their previous journal before migration. Network
predeployment uses a separate journal and cannot overwrite the user's treasury.

Acceptance: real ERC-20 wallet debits, exact allowance consumption and no mint in
normal setup; failure with insufficient balance/approval; two treasuries sharing
infrastructure; both payment directions; unchanged pending/confirmed recovery;
separate operator predeployment and explicit faucet controls. Live broadcast
requires an available funded signer, canonical receipts and both-chain binding
verification. An isolated deployment is not evidence of a Chiado deployment.

Implemented and predeployed on Chiado/EEZ-X, with the local UI updated. The
[wallet-funding audit](../audits/2026-10-21-treasury-wallet-funding/README.md) records
the canonical addresses, standard ERC-20 funding checks, preserved setup behavior
and remaining wallet/mainnet rehearsal limits.

## 0. Purpose and scope

The demo presents two standard Safes as one treasury for payments made through a shared policy:

1. **One owner set.** The EEZ-X Safe has one contract owner, `L1Owners`. That contract asks the mainnet Safe to validate the owners' signatures and threshold during execution. Owner administration happens on L1.
2. **One budget.** Each Safe grants a limited allowance to the payment policy. The policy also enforces a shared budget across both chains: 100 USDC per Safe and 150 USDC globally per period.
3. **One payment funded from both.** The user specifies an asset, amount, recipient and destination chain. The policy can draw from both Safes and bridge the remote contribution so the recipient receives the full amount on the chosen chain.

EEZ represents a contract on the other chain through a deterministic cross-chain proxy, called its **alias** here. A call originating from `TreasuryPolicy` on EEZ-X reaches an L1 contract with `msg.sender` equal to the policy's L1 alias. Cross-chain calls and reads participate in the same authenticated execution, subject to the pinned protocol's execution rules and the fork's narrower signer profile.

The intended payment guarantee is: **all required payment steps commit together, or none of their payment effects commit**. The implementation must propagate failures and pass the integration checks below. Same-block execution is a settlement property, not an immediate-finality or wall-clock latency guarantee.

The demo keeps Safe contracts unmodified and uses the official AllowanceModule. New work includes the signature adapter, treasury policy, a bridge extension for payments to EEZ-X, a merchant fixture for failure testing, and the treasury application. The UI is a core demo deliverable, developed alongside each contract capability so the complete payment experience can be rehearsed early.

No Guard is installed. Owners retain administrative authority and direct spending capability on both Safes. The shared budget governs **payments through this policy**; it is not a restriction on every possible owner-authorized transaction.

The target asset is canonical L1 USDC and its EEZ-X representation. The current private-chain implementation uses a clearly labeled six-decimal Devnet USDC fixture; it does not deploy Circle-issued USDC. Native L2 assets, arbitrary token behavior, ETH payments and a production bridge deployment are outside this first demo. The pinned [Bridge contract](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/src/periphery/Bridge.sol) explicitly identifies itself as test periphery. Use that scope when describing the fork/devnet demonstration.

## Accepted treasury restart and design increment (2026-10-21)

**Start new treasury** returns to **Choose your Safes** with the connected wallet
unchanged. Each chain offers a new Safe or an existing Safe address. The user
removed the archive-collection requirement after the initial restart delivery:
there is no archive list, download, or new archive write. Previously stored
records remain untouched. A reviewed fresh setup gets its new salt through the
normal setup flow; restarting changes browser selection without asking the
wallet to sign or submit.

Pending setup, payment and owner-change requests block restarting. Wallet
actions and restart share the setup Web Lock across tabs. One empty-journal
write selects the chooser and masks stale manifests and legacy fallback; a
storage failure retains the previous active setup. Tests cover partial and
completed setups, pending requests, failures, reload, same-wallet selection,
existing-Safe choices and stale-tab exclusion. This changes browser selection
only; contract and protocol behavior remain unchanged.

Follow [DESIGN.md](../../DESIGN.md): a compact secondary restart action, neutral
environment badges, at least 12px control labels and 13px addresses/table data,
visible keyboard focus, network labels with the L1/L2 accents, and transaction
inspection links. Keep the next approval primary and supporting setup details
expandable. Before setup starts, **Change setup** provides the same return to
the chooser without a duplicate restart button.

The accepted UX cleanup removes the standalone deployment-wallet and reused
Safe-infrastructure panels. Explain ownership at Safe selection/creation, token
funding at its step, and the 100-per-Safe / 150-shared limits at configuration.
Use a compact progress indicator, current action and one primary approval;
keep the full call inventory and setup record expandable. The connected view
starts with the shared budget and each Safe balance, followed by payment and
approvals. The payment form uses ordinary amount, percentage, destination and
split controls, with no demo-scenario shortcuts or repeated test-token tagline.
Token movement and technical identifiers are expandable; recipient, amount,
destination and funding remain visible at review.
History retains its verified outcome and recovery behavior. Navigation uses
**Payments**, **Owner demo** and **Simulation**, with the simulated mode explicit.
The owner-verification example appears only when its fixture is deployed;
ordinary owner administration stays in **Add an owner**.

## Accepted inclusion-based setup and transaction history (2026-10-21)

Setup and faucet transactions may advance on a successful canonical receipt,
without waiting for the `safe` checkpoint. Preserve exact sender, nonce, calldata,
Safe execution, deployment events and code checks; recheck the receipt block
before recording completion. Discover missing/repriced hashes against bounded
`latest` history. Dependent Safe reviews and setup completion read current state
at fixed canonical blocks. Payment settlement semantics remain separate.

Save inclusion block identities alongside newly completed setup transactions.
Before another wallet approval, submission or setup completion, recheck earlier
receipts. Missing, failed, reorganized or unavailable observations stop that action
without deleting progress or automatically resending. A newly included transaction
that moves to another block requires revalidation; do not silently reuse its
previously verified effects. Existing journals without inclusion metadata remain
readable and are checked against their current canonical receipts. Older UI
builds retain the optional metadata but may restore the safe-checkpoint delay.

Show all recorded setup transactions, oldest first, using the Bridge & Calls
history layout: action, chain, explorer link, block, observed status and time.
Keep the history available after setup. `Included` is source-chain inclusion;
show `Finalized` only from that chain's observed finalized head. RPC uncertainty
must not become a success badge. History reads never authorize a transaction.
Remove the repeated restart explanation and pending-setup instruction while
retaining the restriction on restarting with an outstanding request.

Acceptance: inclusion before a lagging safe head on both chains; unchanged
mismatch/revert/reorg rejection; prior-inclusion revalidation before signing;
current-state Safe review and final setup verification; ordered history with
pending, included, failed, finalized and unavailable states; reload compatibility;
read-only desktop/mobile browser coverage and the owned Anvil setup integration.
No contracts or runtime services change. No live wallet transactions are required.

## Accepted setup tracking improvement (2026-10-21)

The inclusion-based increment above supersedes this increment’s safe-head wait
and scan boundary; its request-matching and recovery guarantees still apply.

Setup tracks returned transaction hashes automatically and discovers missing or
repriced hashes by the saved sender and nonce. Search only the most recent 512
blocks below the RPC's safe head, using historical account nonces to locate the
consuming block. This bounds RPC work without an indexer or a new persisted scan
cursor. Cache conclusive lookups only for the same safe-head hash and request.
Missing historical state or an older transaction leaves the request pending for
diagnosis.

Discovery must match the exact saved sender, nonce, recipient, calldata and zero
value. A cancellation or different replacement cannot advance setup. The existing
canonical receipt, safe-head, Safe execution, batch-event and deployed-code checks
remain authoritative. Never resend, clear an unresolved request, change a nonce,
or count discovery alone as completion. Receipt validation still runs after hash
discovery. Persist an identified hash before validating receipt effects, so a
reverted deployment remains inspectable after reload.

The UI shows the pending transaction and inspection link. Automatic tracking
continues without a manual hash-entry form or a separate confirmation paragraph.
Existing version-2/3/4 journals need no migration or new fields; an older UI still
understands a discovered hash but lacks automatic discovery. Deploy the new UI independently of contracts
and network services. Acceptance covers lost wallet responses, repricing, exact
request rejection, reorgs, safe confirmation, RPC gaps and bounded searches, plus
read-only browser checks for automatic discovery, reload persistence and the
absence of manual recovery controls. Shared-network transactions are not
authorized by these checks.

## Accepted deployment batching increment (2026-10-20)

The user authorized batching the remaining contract deployments while preserving
the already-confirmed Safe implementation. Implement a wallet-owned deployment
executor on each chain: its constructor groups the first local deployments, and
its remaining setup call groups funding or policy creation. It never becomes a
Safe owner or module. New Safes are initialized atomically with the selected
wallet (L1) or owner adapter (L2). Existing Safes keep their current approval
requirements. Temporary test-token custody and bridge administration belong to
the selected wallet through its executor; return bridge administration and close
the executor after setup. Safe configuration continues to require the current
owner quorum, even when submitted inside a deployment batch.

For a wallet with an available EEZ-X CREATE address, the confirmed-first-step
case needs five remaining transactions plus two Safe typed-data approvals for
the 1-of-1 owner. The observed wallet A has two occupied creation addresses at
its current nonce, so it needs seven remaining transactions: first provision the
required L1 Safe and bridge proxies with two wallet calls. Detect this from live
nonce/code state, retain the confirmed prefix, and archive the prior journal.
Do not replace protocol contracts or patch the wallet nonce on the node.
Separate batches at bridge/funding dependencies and
at the EVM creation-input size bound. Verify actual gas and input sizes; do not
rely on a wallet extension supporting arbitrary call batches or delegated EOA
execution. Missing L1 Safe infrastructure can require an additional transaction.

Version 4 must archive its prior version-2/3 journal, preserve completed hashes,
addresses, deployer and salt, and defer migration while a wallet request or Safe
review is outstanding. Early setup journals can use the grouped flow; an older
setup that already created its test token retains its original ownership and
recovery path. Never automatically rebroadcast. Verify each expected created
address, exact transaction input, executor event and resulting code before
advancing. Fail a whole batch on any failed creation/call or false ERC-20 result.

Acceptance: real EVM execution of all grouped phases; size/gas measurements;
late-call rollback including preceding deployments; unauthorized/reentrant/
replayed executor rejection; preserved first confirmed transaction; pending and
partially completed journals; existing Safe quorum; canonical receipt recovery;
installed browser flow and native cross-chain funding/payment integration.
The implementation and validation record must distinguish isolated evidence
from shared-network wallet deployment.

## Earlier configuration-only simplification (version 3, 2026-10-20)

Reuse exact-bytecode-verified official Safe infrastructure when present. Retain
Safe 1.4.1 implementations and every confirmed deployment; Chiado's official
1.3.0 factory and call-only batch helper can be used without downgrading the
Safe singleton. Missing infrastructure is deployed from the selected wallet.
Batch each Safe's remaining module/delegate/allowance configuration atomically,
with its current owner quorum. The normal payment setup omits the owner-action
and invoice fixtures; isolated invoice rehearsals retain them.

Version-3 journals retain the original completed prefix, addresses, salt, wallet
and transaction hashes. Migration waits for unresolved wallet requests and signed
reviews; it never reinterprets or repeats them. An archived pre-migration journal
is retained in browser storage. Reuse requires pinned catalog identity and live
code verification before approval/submission. Existing Safe owners, signatures,
100/150 limits and zero-refund failure semantics remain unchanged.

Acceptance: real official factory runtime creates a compatible initialized Safe;
both configuration batches reach the intended allowance state, and a late failure
undoes earlier configuration; partial and pending older journals remain resumable;
normal payments and isolated invoice regressions pass. Grouped UI stages must show
the actual remaining transactions and the calls authorized by each batch.

## 1. Components and authority

| Where | Component | Responsibility |
| --- | --- | --- |
| L1 | `SafeL1` | Holds canonical USDC. Starts with A and B as owners and threshold 2. |
| EEZ-X | `SafeL2` | Holds wrapped USDC. Its sole owner is `L1Owners`, threshold 1. |
| Both chains | Official `AllowanceModule` | The module enabled on each Safe. Enforces that Safe's allowance for its policy delegate. |
| EEZ-X | `L1Owners` | Implements the contract-signature interface expected by Safe v1.4.1 and forwards verification to `SafeL1` through its L2 proxy. |
| EEZ-X | `TreasuryPolicy` | In the bidirectional version, authorizes `SafeL2` or the authenticated L2 proxy of `SafeL1`, enforces the shared budget, reads balances and allowances, chooses funding, and executes the route. |
| L1 | Alias of `TreasuryPolicy` | The policy's authenticated L1 caller identity and temporary holder of funds needed for a payment to EEZ-X. This is a protocol proxy. |
| Both chains | Shared demo bridge pair | Burns/releases for EEZ-X-to-L1 payments; adds an authenticated L1 lock followed by local L2 mint for L1-to-EEZ-X payments. |
| L1 | Demo merchant | Receives USDC and exposes an explicit invoice-acceptance operation that can reject a payment in the failure test. |
| Frontend | Treasury demo application | Shows combined holdings and budgets, previews funding, collects owner signatures, submits through the Composer, and tracks payment history through canonical settlement. |

Enable only the AllowanceModule for this payment design. Register `TreasuryPolicy` as its delegate on L2 and the policy's L1 alias as its delegate on L1. Do not enable either policy address as an unrestricted Safe module.

An empty allowance signature authenticates the caller; the registered delegate must match that caller. This permits contract delegates. Transfers, including token return-value checks, pass through the official module. Set its relayer payment to zero. [AllowanceModule implementation](https://github.com/safe-fndn/safe-modules/blob/c95f03900bff99be090dadb9de1c74b162365485/modules/allowances/contracts/AllowanceModule.sol).

The policy may temporarily hold a payment contribution while bridging. Its intended balance returns to its prior value when that payment succeeds. A failed payment must restore the transfer and bridge effects. Therefore the trust statement is that the policy has **bounded allowance access**, not that it never touches funds. A policy bug could misuse its granted allowances, and owners can change those allowances.

## 2. Owner verification and authorization

### Safe contract signatures

Safe v1.4.1 expects the legacy `isValidSignature(bytes,bytes)` contract-owner interface and success value `0x20c13b0b`. Implementing only the `bytes32` overload with `0x1626ba7e` does not satisfy that path. [Signature interface](https://github.com/safe-fndn/safe-smart-account/blob/v1.4.1/contracts/interfaces/ISignatureValidator.sol).

The adapter receives the full L2 Safe transaction preimage. It forwards that data and the inner owner signatures to `SafeL1.checkSignatures`, with `keccak256(data)` as the hash. This lets the L1 Safe apply its current threshold. Keeping the full preimage also preserves contract-owner hash/data consistency checks. [Safe signature verification](https://github.com/safe-fndn/safe-smart-account/blob/v1.4.1/contracts/Safe.sol#L245-L316).

Illustrative adapter shape, omitting deployment checks:

```solidity
interface IRemoteSafeSignatures {
    function checkSignatures(
        bytes32 dataHash,
        bytes calldata data,
        bytes calldata signatures
    ) external view;
}

contract L1Owners {
    // Deployed EEZ-X proxy representing SafeL1 on L1.
    address public immutable safeL1Proxy;

    constructor(address proxy) {
        safeL1Proxy = proxy;
    }

    function isValidSignature(bytes calldata data, bytes calldata signatures)
        external
        view
        returns (bytes4)
    {
        IRemoteSafeSignatures(safeL1Proxy).checkSignatures(
            keccak256(data), data, signatures
        );
        return 0x20c13b0b;
    }
}
```

The `view` call reaches the L1 Safe through the proxy's static-call path. Deploy and verify that proxy before using the adapter; a signature check cannot create it. Bind every proxy to the intended manager, source network and original address. The adapter's cross-chain static read inside Safe's signature check is an early integration acceptance test. [Static-call routing](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/STATIC_ENTRY.md#1-routing-how-a-read-reaches-staticcrosschaincall).

### Signing and submission

1. The application builds an L2 Safe transaction addressed to `TreasuryPolicy`, with operation `Call`, native value zero and the typed payment calldata.
2. The required mainnet owners sign that **L2 Safe transaction hash**, including the L2 chain domain and Safe nonce.
3. The application orders the inner signatures by owner address and wraps them as the single contract-owner signature for `L1Owners`: `v = 0`, `r = address(L1Owners)`, and `s` pointing to the dynamic signature data.
4. The application submits the signed `SafeL2.execTransaction` through the supported Composer/node ingress, which prepares the cross-chain execution.
5. `SafeL2` calls `L1Owners`. Successful verification allows the local Safe call into the policy.

For L1 initiation, the application instead builds and signs a normal `SafeL1`
transaction on L1, addressed to the policy’s L1 alias. `SafeL1` checks its own
signatures before EEZ calls the L2 policy as the authenticated proxy of `SafeL1`.
Both source paths debit the same counter and support either payment destination.

The stage owner set uses EOAs. Test other signature modes separately before advertising them, particularly contract owners that might themselves perform cross-chain calls. Do not assume an EOA submitter becomes the caller of L1 verification; the cross-chain caller is an alias.

Owner changes take effect according to execution order. An owner removed before the relevant L1 verification cannot supply a valid signature toward the threshold. A removal later in the same block is not retroactive. Show removal in a subsequent settled step rather than promising that all same-block signatures are invalidated.

`L1Owners` does not freeze Safe administration. A valid owner quorum can authorize replacing it on `SafeL2`, just as it can change other Safe settings. The demo demonstrates the configured shared owner set. [Safe owner management](https://github.com/safe-fndn/safe-smart-account/blob/v1.4.1/contracts/base/OwnerManager.sol).

### User experience

The application lives in this repository as a **Treasury Demo** tab beside
**Counter Demo**, reusing the dashboard's layout, theme and wallet integration.
It is visible in normal navigation and opens directly at `#/treasury-demo`,
including in a fresh browser session. Its code loads only when the tab is selected;
network and deployment checks still determine which actions are available.

Build one treasury screen around the question “How much can we pay, and where should the recipient receive it?” The user enters one payment and obtains the required owner signatures. Bridging introduces no additional owner approvals per leg. The interactive concept establishes the layout and walkthrough; its simulated data and signature buttons are not an implemented wallet or settlement integration.

| UI area | Required behavior |
| --- | --- |
| Treasury overview | Show combined Safe holdings separately from the shared budget remaining, with spent / 150 USDC and the next reset boundary. Label the period “per 10 minutes.” Holdings are not the amount currently spendable under the policy. |
| Two Safe panels | Show each chain, its Safe balance, allowance spent / 100 USDC, and remaining allowance. Recognize the wrapped representation as the same asset without counting bridge escrow as treasury holdings. |
| Payment form | Enter recipient, destination and either a fixed amount or a percentage of combined Safe holdings. Default rules to 10% and destination-first combined funding. Keep a single-source option for fixed local payments. |
| Funding preview | Show the amount contributed by each Safe, which contribution crosses the bridge, and the full amount the recipient receives on the selected chain. Distinguish a capacity rejection from a shared-budget rejection. |
| Owner approval | Display the current L1 owners, threshold and collected signatures. Collect real wallet signatures for the same L2 Safe transaction; show progress such as “1 of 2 signatures.” Link to the configured L1 Safe app for administration. |
| Payment history | Show recipient, destination, amount, actual contributions when known, and the current approval or execution status. Open a payment to inspect its transaction identifiers and outcome evidence. |
| Optional details | “See token movements” explains the route from the source Safe through any policy custody and bridge steps to the recipient. Additional details expose contract addresses, canonical observations and the failure trace when available. |

The 110-USDC L1 preview should read “100 from Ethereum + 10 from EEZ-X → recipient receives 110 USDC on Ethereum.” After the preceding 40-USDC payment and this split settle, the dashboard shows 300 USDC in combined holdings but zero shared budget remaining. L2 still has 50 USDC of allowance. The next 1-USDC attempt explains: “Shared budget exhausted. EEZ-X still has 50 USDC of allowance remaining.”

#### Approval and execution states

The normal interaction is **enter payment → review funding → collect signatures → submit → await settlement → show result**. Review fixes the transaction being signed. Changing the recipient, amount or percentage, destination, funding preference or other signed fields starts a fresh approval round; recheck the Safe nonce and current owner set before submission. Individual owner signatures must refer to identical transaction data.

The funding preview is an estimate. The policy recomputes capacities during execution, within the signed payment parameters and funding preference, and the settled result shows the actual contributions. For a rule, review shows both observed Safe balances, the percentage and estimated amount; approvals authorize the percentage. Settlement shows the actual observations and recalculated amount, which can differ if holdings changed. Escrow and temporary custody are excluded.

Keep the following outcomes distinguishable in the payment detail and history:

- Awaiting signatures, including the remaining approvals needed.
- Preparing or awaiting settlement, including an unresolved result that still needs reconciliation.
- Rejected before submission or during preparation, with the known reason and whether anything was submitted.
- Settled, with canonical recipient credit, actual funding split and updated balances and counters.
- Failed at settlement, with the confirmed payment outcome. Claim rollback only with the evidence described in Section 6.

Pending contributions may appear in a preview, but must not overwrite settled balances or counters. Refresh effective allowances, the policy epoch and both Safe balances from the connected environment, with observation freshness visible. Stale or unavailable data is not a zero balance. A locally executed L2 transaction or a successful posting receipt alone does not establish that the payment committed. Ordinary standalone simulation cannot be assumed to resolve the cross-chain reads; use Composer-aware simulation.

#### Administration and presentation controls

Use the official Safe app for L1 owner administration where the selected network and backend are supported. A fork rehearsal needs a compatible Safe frontend/backend configuration; a public mainnet UI must not accidentally display live-mainnet state as fork state. The custom treasury application handles EEZ-X signing and submission, so an EEZ-X Safe Transaction Service is not a prerequisite.

Show whether the application is using simulated data or a connected fork/devnet, and identify the connected chains. Use the normal amount, destination, percentage and split controls for the rehearsal sequence. There are no presenter presets in connected mode, and the form cannot reset balances, allowances, epochs or payment history. Any simulated starting-state reset remains explicitly labeled as simulation. Keep routes unavailable until their real integration is ready, and use genuine owner signatures for the connected rehearsal.

## 3. Shared budget and asset accounting

### Limits

| Setting | Demo value |
| --- | --- |
| L1 Safe allowance | 100 USDC per period |
| L2 Safe allowance | 100 wrapped USDC per period |
| Shared policy budget | 150 USDC per period |
| Policy per-payment ceiling | 150 USDC, so it does not mask the shared-budget demonstration |
| Demo period | 10 minutes, with the same reset boundary on both allowances and the policy |
| Daily configuration | Use a one-day period consistently across all three limits |
| Allowance relayer payment | Zero |

All amounts use token base units; USDC uses six decimals. Convert to the module's amount type with checked bounds, never a truncating cast.

Configure both allowances with a ten-minute reset interval and a common reset base aligned to the policy epoch. Read the module's effective allowance, including its reset behavior; derive remaining capacity from amount and spent rather than assuming a `.remaining` ABI field exists. [Allowance configuration and reads](https://github.com/safe-fndn/safe-modules/blob/c95f03900bff99be090dadb9de1c74b162365485/modules/allowances/contracts/AllowanceModule.sol).

Use `epoch = block.timestamp / 600` in the demo policy and verify L2 execution and the bound L1 settlement target agree on the epoch. Test the boundary explicitly; the desired alignment is a deployment and integration requirement, not an assumption about every based rollup. Label the dashboard “per 10 minutes,” not “per day.”

### Canonical assets

Payment APIs accept the canonical L1 asset address. The application resolves a displayed L2 token through the configured bridge mapping before constructing the transaction. The policy verifies the mapping and uses that canonical identifier for every budget, rule, event and debit.

For USDC, L1 payments use canonical USDC and L2 payments use the bridge's corresponding wrapped token. Only recognized mappings are accepted. No address heuristic or user-supplied token pair may create a second budget for the same asset. Tokens native to EEZ-X are excluded.

The router counts available balances in the two Safes. Bridge escrow backs the wrapped supply and is not an additional treasury balance. Temporary policy balances also must not be counted again when evaluating a rule.

### Policy operations

The policy exposes typed operations:

- `pay`: use one specified source Safe and pay on that source's chain.
- `payRouted`: pay a fixed amount on a chosen destination chain, using either or both Safes.
- `payRule`: calculate an amount from the combined Safe balances, then use the same router.
- `payInvoice`: use the same router and require a final merchant acceptance call; this is the demo failure fixture's payment operation.

Every operation requires `SafeL2`, validates the asset and recipient, enforces the per-payment and shared limits, and rejects a zero payment. A rule that rounds down to zero is rejected too. Optional recipient restrictions belong in this common path so rules and routed payments cannot bypass them. Policy configuration changes are also authorized through `SafeL2`; any deployment bootstrap authority ends before funding.

For a payment of `amount`, the router computes:

```text
capacityL1 = min(SafeL1 token balance, effective L1 allowance remaining)
capacityL2 = min(SafeL2 token balance, effective L2 allowance remaining)

require amount <= policy per-payment ceiling
require spent[canonicalAsset][epoch] + amount <= shared budget
require capacityL1 + capacityL2 >= amount

fill the destination chain up to its capacity
take any remainder from the other chain
debit the shared counter once, before any payment transfer
execute the required legs
require merchant acceptance when the signed operation includes an invoice
```

A single-source payment also checks that source's capacity. There is no promise that every rejection occurs before any cross-chain call: signature, allowance and balance reads may already have run. The relevant promise is that no payment transfer commits for a rejected operation.

An explicit funding preference may override the destination-first split when signed by the owners. It cannot bypass either allowance, available balances or the shared budget. The policy rejects failed required steps, checks token-call outcomes and prevents reentry into payment execution. It exposes no unrestricted arbitrary-call escape from these rules.

## 4. Payments to either chain

### Why the Safe only transfers tokens

The allowance beneficiary can request an authorized transfer; it cannot use that permission to make the Safe issue arbitrary bridge calls. The remote contribution therefore moves first to the policy or its alias, which performs the bridge operation. The local contribution can go directly from its Safe to the recipient.

In the tables below, each payment starts as one owner-authorized call on `SafeL2`. Signature verification, reads, policy debit and all payment steps belong to the same composed execution entry. Amounts shown are illustrative contributions to one payment.

### Recipient on L1

Example: 110 USDC, funded by 100 from `SafeL1` and 10 from `SafeL2`.

| Step | Chain | Operation | Token movement |
| --- | --- | --- | --- |
| 1 | EEZ-X | Policy spends its L2 allowance | 10 wrapped USDC: `SafeL2` → `TreasuryPolicy` |
| 2 | EEZ-X | Policy calls the L2 bridge | Bridge burns those 10 wrapped USDC from the policy |
| 3 | L1 | L2 bridge's authenticated call reaches L1 bridge | Bridge releases 10 canonical USDC from escrow to the recipient |
| 4 | L1 | AllowanceModule executes the policy alias's transfer request | 100 canonical USDC: `SafeL1` → recipient |
| 5 | EEZ-X | Policy completes | One payment result records the recipient, destination and both contributions |

The recipient ends with 110 more USDC on L1. `SafeL1` has 100 less; `SafeL2` has 10 fewer wrapped USDC. The policy retains no contribution from this payment. The L1 bridge release is terminal: it does not call back into L2.

This direction uses the existing bridge-out structure, subject to integration validation with the Safe adapter and allowances.

### Recipient on EEZ-X

Example in a fresh period: 110 USDC, funded by 100 from `SafeL2` and 10 from `SafeL1`.

| Step | Chain | Operation | Token movement |
| --- | --- | --- | --- |
| 1 | EEZ-X | Policy spends its L2 allowance | 100 wrapped USDC: `SafeL2` → recipient |
| 2 | L1 | Policy spends its L1 allowance | 10 canonical USDC: `SafeL1` → policy's L1 alias |
| 3 | L1 | Policy calls the token through its L2 proxy | Alias approves the L1 bridge to take exactly this contribution |
| 4 | EEZ-X | Policy invokes the new bridge-in entry point | L2 bridge binds payer, canonical asset, amount and recipient |
| 5 | L1 | L2 bridge calls a new terminal lock operation | 10 canonical USDC: policy alias → L1 bridge escrow; no callback into L2 |
| 6 | EEZ-X | L2 bridge resumes after successful lock | Bridge mints 10 corresponding wrapped USDC to the recipient locally |
| 7 | EEZ-X | Policy completes | One payment result records both contributions |

The recipient ends with 110 more wrapped USDC on EEZ-X. `SafeL2` has 100 less; `SafeL1` has 10 less canonical USDC. The alias retains no contribution from this payment. The new wrapped supply is backed by the additional L1 escrow.

Steps 4–6 use the dashboard-owned [TreasuryBridge extension](../../contracts/src/TreasuryBridge.sol), with validation status in the [reverse-route record](../audits/2026-10-20-treasury-reverse-payments/README.md). They do not use the existing `bridgeTokens` bridge-in path. The current L1 bridge-in operation calls back into L2; putting that call inside a generic multicall does not remove its callback. [Current bridge](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/src/periphery/Bridge.sol).

### Bridge authentication and execution constraints

The extension must bind the L1 payer alias to the authenticated L2 policy caller. The L1 lock operation accepts only the intended L2 bridge's authenticated alias. The L2 bridge validates the asset mapping and mints exactly the amount successfully locked, to the bound recipient. A caller cannot choose another account's approved funds, supply an invented lock result, or reuse a completed lock to mint again.

Deploy, pair and seal the extended bridge once before its first funding, then reuse it and its wrapped token for subsequent treasuries. The bridge owns the wrapped token's mint/burn authority. An unrelated helper cannot mint the existing bridge's token simply because it has observed an L1 transfer. Verify exact escrow, supply, payer and recipient deltas in both success and failure tests.

Here, “multicall” means a sequence of required calls orchestrated by the policy within one entry. It does not mean separate user transactions or independent entries placed in the same block. Keep L1 calls that spend allowances or grant token approval originating from `TreasuryPolicy`, so the observed caller is its registered alias. An ordinary external batching contract would change that caller identity.

The [signer profile](https://github.com/eduadiez/rollupX/blob/fa916b13254a36423cad130080dde367bb18a7d6/crates/eez-proof-signer/SPEC.md#10-outbound-authorization) admits terminal static reads combined with successful mutable roots that have no cross-chain callbacks. The owner verification makes this a mixed read/write execution. Therefore the successful payment path uses terminal L1 operations and resumes on L2 after they return. Ordinary local contract calls within either chain are still allowed.

No signer validation is bypassed or weakened for the demo. Existing nested-call and flashloan coverage does not establish support for every ordering of static reads and callbacks. Validate the exact Safe payment through the Composer, signer and follower.

## 5. Rules over the combined balance

`payRule` takes a canonical asset, destination, recipient and basis-point fraction. It reads the two Safe balances before payment transfers, calculates:

```text
amount = floor((balanceL1 + balanceL2) * bps / 10_000)
```

It then applies the same per-payment ceiling, shared debit, allowance checks, recipient rules and routing used by `payRouted`. Require `0 < bps <= 10_000` and use checked arithmetic. A rule never sends part of the payment to a same-address account on an unintended chain.

The rule measures holdings, not allowance capacity. Sufficient holdings do not guarantee that allowances or the shared budget permit the calculated payment. If capacity is insufficient, reject without committing a partial payment.

L1 `balanceOf(SafeL1)` is read through the token's L2 proxy; the L2 balance uses the configured wrapped token. For this USDC demo, no ETH balance helper is needed. Record both observed balances, the fraction, calculated amount and funding split in the payment result.

Owners sign the rule parameters. Its amount is determined by the authenticated execution reads, so a frontend estimate is not a fixed-amount authorization. A mismatch between composed L1 observations and settlement execution invalidates that attempt; it must not commit a payment using an unverified stale result. Recomposition can produce a different amount under the same signed rule, subject to its limits.

## 6. Failure behavior and rollback evidence

### Required failure propagation

The policy requires every transfer, approval, bridge operation and signed merchant condition to succeed. It must not catch a required failure and continue, and batching must not permit a required leg to fail independently. Core execution can record caught failures without automatically failing an enclosing operation. [Execution semantics](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/EXECUTION_ENTRY_SPEC.md#entry-structure).

Construct demo Safe transactions with `safeTxGas = 0` and `gasPrice = 0`. In Safe v1.4.1, these settings require a failed inner execution to revert the enclosing Safe call, undoing its Safe nonce increment. Other settings can allow a returned failure and a consumed nonce. These fields do not eliminate network gas costs. [Safe execution](https://github.com/safe-fndn/safe-smart-account/blob/v1.4.1/contracts/Safe.sol#L159-L204).

The promised rollback concerns payment effects: Safe and recipient token balances, temporary funds, bridge escrow/supply, invoice state and spending counters. Network transaction fees and the submitting account's transaction nonce are separate.

### A real merchant rejection

Ordinary USDC transfers update token balances without calling the recipient's fallback. A recipient whose fallback reverts can still receive USDC. [USDC transfer implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol).

The fixture instead exposes an explicit invoice-acceptance method. `payInvoice` performs the routed payment and then calls the L1 merchant through that merchant's proxy on EEZ-X. The merchant authenticates the policy alias, marks an open invoice paid, and rejects a closed or already-paid invoice. Invoice identity, recipient, asset, amount and the requirement for acceptance are bound into the owner-authorized operation. This is a typed payment condition, not arbitrary user-supplied execution calldata.

Use a fresh allowance period and a 110-USDC L1 invoice: first bridge 10 from L2, then transfer 100 from L1, then require invoice acceptance. The failure test must demonstrate that execution reached the earlier transfers before the later rejection.

### Invoice implementation scope (2026-10-20)

The dashboard-owned fixture deploys `InvoiceMerchant` on L1 and binds its one-time policy alias after deployment. `TreasuryPolicy` pins this merchant and exposes a typed `payInvoice(token, recipient, amount, invoiceId, expectedEpoch)` operation with combined funding to L1. Invoice acceptance runs after both payment contributions and is required to succeed. The controller can open or close fixture invoices; only the policy alias can accept the exact stored terms. Paid/closed invoice identifiers cannot be reused.

The isolated UI offers a 110-USDC invoice rollback scenario alongside fixed payments and percentage rules. A loopback-only fixture controller opens the invoice and arms the existing native relay barrier before submission. At the barrier it prepends a signed invoice closure with higher priority to the otherwise unchanged proved posting transaction. The original proof, blob payload, parent and target remain unchanged. The test must establish the closure and post landed in that order in the same target block; any other ordering remains an unverified attempt. Neither the protocol nor the signer is modified.

The controller retains the canonical posting receipt, execution trace, source transaction identity and before/after treasury snapshots. The UI presents this fixture evidence separately from Composer status, verifies the canonical block and closed invoice, and keeps an uncertain request locked. The standard dashboard has no fixture-control endpoint. Older deployments without the invoice capability continue to offer their existing payment modes.

### Preparation rejection and settlement failure

Maintain two distinct tests and UI outcomes:

| Case | Setup | What it establishes |
| --- | --- | --- |
| Rejection during preparation | Invoice is already closed when the Composer evaluates the payment | The application refuses an invalid payment without claiming an on-chain rollback. It may never submit a posting transaction. |
| Failure during L1 settlement | Compose a valid payment while the invoice is open; in a controlled test, close it before its execution in the intended L1 target block | Earlier payment operations executed on L1 but did not commit after the required condition failed. This needs actual settlement and replay evidence. |

The second test must preserve the signed L1 parent and target timestamp and coordinate ordering in an isolated harness. If the Composer detects the change, rejects it or recomposes before posting, classify that result as preparation behavior. Do not disable validation to force a demonstration. The signer's mixed static/mutable profile does not authorize precomposed reverted mutable roots; an always-failing trace is not an alternative supported posting path.

Compare rollback against the state immediately before payment execution, accounting separately for the fixture's invoice-closing transaction. That separate transaction remains committed; the payment must not add transfers, budget charges or a paid-invoice state.

For a settlement failure, retain a trace showing the earlier transfers were reached and compare canonical before/after state for:

- Both Safe balances and the recipient's balances on the relevant chains.
- Policy and alias temporary balances; bridge escrow and wrapped supply.
- Both effective allowance counters and allowance nonces, the global counter, and the L2 Safe nonce.
- Merchant invoice state and the L1/L2 settlement outcome.

Unchanged balances alone are insufficient evidence that earlier legs executed. Reverted transfer events also do not survive as receipt evidence; use the trace and state assertions.

`L2TxSkipped` is optional evidence, not a required UI success criterion. The core emits it for certain caught failures, but empty revert data can abort, an all-failed immediate run reverts the post, and any enclosing revert erases earlier logs. [Immediate entry handling](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/docs/EXECUTION_ENTRY_SPEC.md#immediate-entries-proxyentryhash--0--l2tx-entries).

The UI may show “Payment failed; no funds transferred and no budget consumed” only after the relevant outcome is established. Include whether rejection happened during preparation or settlement. While the result is uncertain or reconciliation is pending, show a pending status.

### Accepted payment-history increment (2026-10-20)

Keep a browser-local journal for this isolated deployment. Record submitted payment identities before wallet broadcast and record valid payment reviews rejected by the funding checks as explicitly **not submitted**. Owner-demo actions and simulated preview entries stay outside payment history. Starting a new payment must preserve older entries. Repeated polling and recovered wallet hashes update the same attempt; distinct source attempts must not collapse just because they reuse a Safe nonce.

On reload, validate saved payment identities against the deployment and reconcile submitted entries from canonical receipts, Composer disposition and the invoice fixture's verified evidence. Stored history is not settlement evidence. Unknown, unavailable and reorged results remain visibly unresolved. A generic queue removal cannot establish preparation failure or rollback. Only the closed-before-submission invoice fixture establishes the submitted preparation case; only the verified trace and canonical snapshots establish rollback. Once Composer forgets an old disposition, both the submitter and Safe nonces must have advanced at the same canonical safe block before that historical rollback can be marked complete. A missing queue record alone remains unresolved. History does not enable retries or unlock the active request.

Show newest entries first, status filters, recipient and destination, signed amount or percentage, actual settled funding, transaction identifiers, and expandable rollback evidence. Keep review-time rejection reasons separate from execution results. Preserve the active-request recovery key for compatibility and import its existing payment into the journal. Corrupt or full storage must not silently discard history or permit an unrecorded broadcast. No chain-wide indexer or cross-browser synchronization is introduced.

Acceptance: the existing native browser sequence must retain the settled local, split and rule payments, the closed-invoice preparation rejection, the inclusion rollback and local budget rejection through new payments and reloads; inspect older funding and rollback details. Cover corrupt storage, instance separation, attempt deduplication, unavailable evidence, and no extra wallet broadcasts. Build and test this increment alongside the existing contract/runtime regressions without modifying the external runtime or protocol.

### Accepted wallet and Safe-app rehearsal increment (2026-10-20)

Prepare the full walkthrough using the dashboard's existing wallet selector, owner
approval, submission and history screens. A locally hosted, pinned official Safe
frontend and its backend connect to this same isolated L1 for owner administration.
Use public fixture accounts in a separate browser-wallet profile. Keep contracts,
all setup scripts, readiness checks and presenter instructions in this repository.

The Safe services get separate loopback ports and data under the selected run;
startup must verify the devnet identity. Preserve existing deployments and pending
browser state. No automatic payment signing or changes to the normal dashboard.
Link the configured L1 Safe from the treasury owner panel. Rehearse adding C in
Safe, B+C authorization in the dashboard, the 40 / 110 / rejected 1 sequence,
invoice rollback, the percentage rule, reverse funding and persistent history.

Readiness means the actual Safe backend indexes this Safe and the frontend can
open its owner administration; a synthetic wallet test is insufficient evidence
of wallet-extension UX. Record which checks are automated, which wallet dialogs
were exercised, and which presenter steps still require a human rehearsal.

The [presenter runbook](../runbooks/treasury-rehearsal.md) now covers the complete
sequence, wallet/network switching, expected balances, history and recovery.
`npm run treasury:safe` prepares, starts and checks a pinned local Safe stack
attached to one existing isolated devnet. The dashboard links its L1 Safe after
the backend agrees with chain state. Standard Safe auxiliary contracts are
deployed at their canonical addresses with verified release bytecode. The stock
Safe spending-limit UI does not recognize this custom chain/module deployment;
show the real allowance counters in the dashboard and use Safe for owner
administration. [Readiness evidence](../audits/2026-10-20-treasury-rehearsal/README.md)
does not count as completed human wallet-extension rehearsal.

### Accepted shared-network transition (2026-10-20)

Use the same **Chiado L1 (10200) / EEZ-X (906969), rollup 1** and Composer
endpoints as the normal dashboard. Keep all application work here and preserve
the existing network deployment. New setup now requires an existing L1 Safe
and retains its quorum; the original new-Safe option remains only in saved
legacy plans. This supersedes both the
isolated A+B default and the earlier fixed-A shared deployment plan.

The presenter enters a wallet address in the dashboard's **Add an owner** card.
Current L1 owners approve a standard Safe self-call to add that address; the new
owner does not need to connect. Default to the current threshold, with an explicit
choice to change it. The new owner cannot authorize its own addition. The L2 Safe remains owned by `L1Owners`; the next verified
payment reads the resulting L1 owner set. This administrative flow is separate
from the L2-domain payment approval and persists an unresolved L1 submission
before opening the wallet.

The observed shared runtime labels source `de4209a5e956b432db7a7d37517d9d44d68dfaa4`
and pins core `f46af7c9833ac12a54f14d52f4da1f318a0f6525`, rather than the local
native-test core `855fe0602484750861b4c31502a1a91355d33ed6`. The newer core forbids
a cross-chain destination equal to the runtime manager, including static reads.
`TreasuryPolicy` therefore reads its L1 alias through a stateless
`TreasuryAliasReader` on L1, whose registry lookup is an ordinary local call.
No protocol-manager call is forwarded across chains. The helper has no Safe
module power, token custody or mutable policy state.

Version-5 setups use `SharedTreasuryBridge`, initialized in its constructor,
paired once and sealed before reuse. They share `SharedTestUSDC` and one wrapped
representation. Existing version-3/4 setups retain `ConfiguredTreasuryBridge` /
`BootstrapTreasuryBridge` and their original asset. The dashboard's ordinary
bridge lacks the receipt-bound lock/mint extension and is not substituted.
Limits remain **100 per Safe / 150 per treasury** per ten-minute period, with no Guard.

Use explicit `dashboard-testnet` configuration, matching the dashboard's chains,
RPCs, managers and fee cap. The shared payment path obtains the dashboard's
bound Composer fee quote, including its wallet-specific transaction type, and
fails if pricing is unavailable. Chain identity can use a retained block/hash:
the connected Chiado node prunes history and cannot answer its genesis query.
Keep the isolated deployment's genesis checks and saved histories compatible.
The shared asset is labeled **Test USDC**, not Circle-issued USDC.

The hidden dashboard example includes a resumable setup using the selected
wallet: normally **six total transactions**, including the already-confirmed
initial implementation, with two new Safes. On the checked Chiado/EEZ-X pair,
wallet A needs **eight total (seven remaining)** because of its two occupied
EEZ-X creation addresses. Both cases also require two Safe signature approvals. It reuses official
factory/helper code and groups local deployment, bridge funding and configuration.
See the accepted deployment-batching increment above for migration and fallback
behavior; older setups that already created their test token retain their plan. Each transaction is
named and requires wallet approval;
Safe administration also requires the appropriate Safe typed-data signature.
Local storage records the request before submission; canonical receipt binding
and a cross-tab lock prevent automatic repeats or stale progress overwrites.
The final manifest checks 300/150 initial funding, 100/100 allowances, zero
spending, the selected owner configuration, and deployed Safe implementation,
application and protocol bindings. Imported L1 owners are not replaced.
No shared setup transaction has been broadcast during implementation: funding
and human wallet confirmations remain prerequisites. This is application-only
deployment; it neither replaces the running EEZ protocol nor imports fixture keys.

The controlled invoice-closing relay remains isolated-only. Never expose its
fixture control on Chiado or promise that a deliberate inclusion-time failure
can be scheduled on a shared network. Normal payments, rules, owner changes and
history are the first shared-network rehearsal; retain the isolated rollback
record for the controlled failure act until a separately validated shared-network
procedure exists.

[Shared-network runbook](../runbooks/treasury-shared-network.md) and
[validation record](../audits/2026-10-20-treasury-shared-network/README.md) track
funding, deployment and live evidence separately. Compatibility preparation and
passing isolated tests do not establish a deployed or rehearsed shared treasury.

## 7. One-time setup

| Step | Where | Action |
| --- | --- | --- |
| 1 | Both chains and off-chain | Pin official Safe and AllowanceModule artifacts; deploy the Safe singleton/factory and module where absent, and verify existing deployments where reused. Record source revisions, compiler settings, chain IDs and code hashes. Prepare the isolated fork/devnet and the Safe UI used for the rehearsal. |
| 2 | L1 | Deploy or select the standard `SafeL1`, with owners A and B and threshold 2. |
| 3 | EEZ-X | Deploy the protocol proxy representing `SafeL1`; deploy `L1Owners` with that proxy; deploy a standard `SafeL2` owned by `L1Owners`, threshold 1. |
| 4 | Both | Deploy and initialize the paired demo bridge extension, checking manager, remote bridge and administration bindings before funding. |
| 5 | EEZ-X | Deploy `TreasuryPolicy` with both Safe addresses, allowance modules, bridge bindings and recognized asset configuration. |
| 6 | Both | Compute and verify the policy's L1 alias using the pinned manager's address helper. Provision the L2 proxies needed for L1 reads and calls, and verify their original addresses and rollup IDs. |
| 7 | Both Safes | Enable the official AllowanceModule. Add the appropriate policy delegate and set its 100-USDC allowance with the common reset base. These are normal Safe-authorized administration transactions. |
| 8 | EEZ-X | Through `SafeL2`, set the 150-USDC global and per-payment limits and the ten-minute epoch configuration. End any deployment-only configuration authority. |
| 9 | Both | Fund `SafeL1` with 300 canonical USDC and `SafeL2` with 150 wrapped USDC through the configured bridge. Fund submitting accounts for network fees separately. |
| 10 | L1 and frontend | Deploy/configure the merchant fixture; configure the application's chain and contract bindings and environment label; verify balances, mappings, allowances, reset boundaries, owner signatures and payment-status reconciliation in the UI. |

Use the manager's [proxy derivation and deployment API](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/src/base/EEZBase.sol), not a hard-coded upstream init-code hash. L1 calls use the policy's alias identity; the L2 proxy of an L1 target is a different address with a different role.

Owners approve allowance administration on both Safes. The policy's L1 alias receives a specific allowance and is not enabled as a Safe module. No Guard is installed.

## 8. Demo script

### Initial state

Asset: USDC, shown as canonical USDC on L1 and the configured wrapped representation on EEZ-X. Start at a fresh ten-minute boundary and finish each period's actions before its next reset.

| Item | Initial value |
| --- | --- |
| `SafeL1` balance | 300 USDC |
| `SafeL2` balance | 150 wrapped USDC |
| L1 / L2 / global limits | 100 / 100 / 150 USDC per ten minutes |
| `SafeL1` owners | A and B, threshold 2 |
| `SafeL2` owner | `L1Owners`, threshold 1 |
| Global / L1 / L2 spending | Zero |

### Act 1 — One owner set

1. In the configured L1 Safe app, A and B add C while retaining threshold 2. The L1 Safe is now 2-of-3.
2. Show the EEZ-X Safe's contract owner, `L1Owners`, alongside the application's refreshed owner panel showing A, B and C with two signatures required.
3. Review the next L2 payment in the application and collect B and C's wallet signatures. Show approval progress reaching 2 of 2. Its execution proves that the newly added mainnet owner participates in L2 authorization.

Stage line: “We manage the owners on L1. The EEZ-X Safe asks that Safe to validate the signatures.”

An optional removal demonstration happens later, after the payment sequence: remove C on L1, then submit a fresh transaction signed by B and C and show rejection. A and B remain able to authorize subsequent work. Do not imply retroactive same-block revocation.

### Act 2 — One payment from both Safes and an independent shared budget

Start on the treasury overview: 450 USDC held and 150 USDC available under the shared budget. Show the three limits. Where supported, open the Safe spending-limit views as corroboration; the treasury dashboard shows both chain allowances and the shared counter together.

| Action | L1 spent | L2 spent | Global spent | Safe balances after action, L1 / L2 |
| --- | ---: | ---: | ---: | --- |
| Pay 40 locally on EEZ-X, signed by B and C | 0 | 40 | 40 | 300 / 110 |
| Pay 110 to an L1 merchant: 100 from L1 and 10 bridged from L2 | 100 | 50 | 150 | 200 / 100 |
| Attempt another 1 locally on EEZ-X | 100 | 50 | 150; rejected | 200 / 100 |

Select EEZ-X Safe under **Start from**, use the local-payment option for the first payment, and wait for its settled history entry. For the second payment, select the L1 Safe under **Start from** and enter 110 USDC with Ethereum as the destination. The L1 Safe now verifies the owner signatures before calling the same shared policy on EEZ-X. L1 can contribute 100 and L2 can contribute 60; neither Safe can fund 110 alone. Review “100 from Ethereum + 10 from EEZ-X,” optionally expand the token movements, and obtain the owner signatures for one Safe transaction. Show pending settlement followed by the L1 recipient's canonical USDC balance increasing by 110. Refresh the dashboard to 300 USDC held and zero shared budget remaining. Open **Payment history**: both settled payments remain after **New payment**. Expand the 110-USDC entry to inspect its actual 100/10 funding and Safe/source identifiers.

For the final rejection, L2 still has 50 of its allowance and 100 of its balance available. Only the shared policy prevents the additional 1 USDC. Show “Shared budget exhausted. EEZ-X still has 50 USDC of allowance remaining.” A form or preparation rejection is labeled as such; the contract-level rejection is established by R3's tests.

Stage lines:

> “Neither Safe could fund that payment alone. The recipient received the full amount on L1.”
>
> “This Safe still has allowance left, but the treasury's shared budget is exhausted.”

### Act 3 — A failure with no committed payment

Advance to the next aligned period in the local rehearsal, or wait for it on the stage network. Confirm all three effective spending counters are zero. Keep balances at 200 USDC on L1 and 100 on EEZ-X.

Attempt the 110-USDC invoice payment described in Section 6 through the application. Use the exact failure setup that passed the settlement integration test. Open its current transaction evidence panel to show the settlement failure, its trace reaching the earlier transfers and then the merchant rejection, followed by unchanged canonical balances, allowances and global spending. Keep the status pending until that outcome is conclusive.

If only preparation rejection has been validated, present it with that label. Do not substitute it for the settlement rollback act. A verified recording of the actual settlement test is an acceptable presentation fallback; an unvalidated live rollback claim is not.

Stage line for an established settlement failure: “The merchant rejected the invoice. None of the payment's transfers or budget charges committed.”

### Act 4 — A rule over the combined holdings

Run this act after the invoice attempt has a conclusive outcome in the fresh period. The failed payment does not consume the shared budget; the Safes still hold 200 + 100 = 300 USDC. Select the percentage rule in the application, enter 10% and the grantee on L1, review the calculated preview, then collect signatures and submit.

The policy reads both balances, computes 30 USDC, and pays it from L1 because that destination has sufficient balance and allowance. Show the observations, calculated amount and route. The resulting balances are 170 on L1 and 100 on EEZ-X; spending this period is L1 30, L2 0, global 30.

Stage line: “The rule used what both Safes hold, then chose where to fund the payment.”

### Act 5 — The recipient chooses EEZ-X

After the first-period rejection, wait for the next natural reset, run the invoice act and Act 4
by choosing **Percentage of combined Safe holdings** and entering **10**, then choose **Fixed amount**, enter **110** and select **EEZ-X** as the recipient chain. Its balances and
counters now follow the sequence below. The rule supports either destination;
this preset uses L1 so the second-period routing remains easy to follow.

Use the same payment form to pay 110 USDC to an EEZ-X recipient in the same second period. Select EEZ-X as the destination and review the reversed funding route before signing. The destination-first router uses 100 from `SafeL2` and bridges 10 from `SafeL1` through the new lock-then-mint path.

The recipient receives 110 wrapped USDC. Final Safe balances are 160 on L1 and zero on EEZ-X. Spending this period is L1 40, L2 100, global 140. This sequence also demonstrates that the rule and ordinary routed payment share the same counter.

Stage line: “The recipient chose EEZ-X. The owners still approved one payment.”

### Closing and booth version

Close on the standard Safe contracts and their allowance settings:

> “One owner set, one budget for these payments, two Safes. Safe's contracts are unchanged; EEZ coordinates the execution across chains.”

The 60-second booth version starts from a clearly labeled prepared state: C is already an owner and the 40-USDC L2 payment has already settled. Show the owner display, use the form presets to execute the 110-USDC split, then reject the extra 1 USDC while L2 allowance remains. Presets do not manufacture that starting state on a connected chain. The failure, percentage rule and reverse-direction payment belong to the longer demonstration.

## 9. Development plan

Build the application alongside the contracts from Phase 1. Each phase delivers contract behavior, its corresponding UI, and a demonstrable result through the connected application. Clearly labeled fixtures can unblock layout and interaction work, but a phase's integration milestone requires the real contract/runtime path. Keep the frontend's data, signing and settlement integration explicit and use the supported node/Composer APIs.

Use the hidden dashboard example as the starting point. Its first version is an
isolated, explicitly simulated walkthrough of the 40 / 110 / rejected 1 sequence.
It sends no treasury transactions and does not establish Phase 1 acceptance.
Replace its sample data and simulated approvals as each real integration becomes
available; keep preview history separate from connected payment history.

### Implementation checkpoint — 2026-10-20

The [contract project](../../contracts/README.md) now pins the sources and compiler
settings and implements `L1Owners`, its proxy/deployment checks, Safe transaction
encoding and EOA signature packing. Tests use unmodified Safe and AllowanceModule
artifacts and exercise the actual pinned EEZ static-call route with manually
loaded execution tables. An independent Solidity/TypeScript vector checks the
frontend hash and contract-signature bytes against Safe.

The [dashboard-owned process integration](../../tests/integration/README.md) now
passes on an isolated devnet: B+C is rejected before C is added on L1, succeeds
after addition, cannot replay that approval, and is rejected after C is removed;
A+B can still execute. Both successful calls settle through the real Composer
and proof signer, with matching state/nonces on an independent follower and
canonical L1 traces of the exact Safe signature check. Setup provisions both
cross-chain proxies before verification. The [evidence record](../audits/2026-10-20-treasury-owner-integration/README.md)
identifies the runtime plus existing local edits, executable hashes, prior
harness failures and scope limits.

The hidden tab now also has a **connected owner demo**, enabled only by the
[isolated devnet launcher](../../tests/integration/README.md#connected-treasury-ui).
It displays the real owner list and threshold, builds an immutable Safe review,
collects EIP-712 wallet approvals and submits through the actual Composer. It
verifies the deployment and selected wallet's read route, clears stale approvals,
persists submission identity across reloads, and waits for a canonical Safe
success event before reporting settlement. The browser integration covers owner
addition/removal, wallet cancellation, reload and lost-response recovery, with
independent follower replay and a verified posted attestation. See the
[connected UI evidence](../audits/2026-10-20-treasury-connected-ui/README.md).

Actual wallet-extension dialogs and L1 Safe-app owner management still need a
rehearsal before claiming the **full Phase 1 milestone**. The automated browser
uses an EIP-1193 test wallet that produces genuine signatures; the L1 helper uses
ordinary A+B Safe administration. The runtime's older discovery API is exposed
through a dashboard-owned loopback adapter without changing signer validation.
The **Live USDC payments** screen now implements the Phase 2 routing milestone:
40 locally on EEZ-X, 110 on L1 funded by both Safes, then 1 rejected by the global
limit while 50 of L2 allowance remains. The real Composer/proof-signer/browser
integration checks canonical transfers and both counters, bridge backing, zero
residual policy custody and independent follower replay. The exact signed
payment fields and settlement status survive reload. See the
[payment evidence](../audits/2026-10-20-treasury-payments/README.md).

This implementation recognizes one canonical asset, fixes the global/per-payment
limit at 150 and the period at 600 seconds, and has no configuration authority.
Both official allowances are granted 100 with the same ten-minute base using
normal Safe transactions. Each signed payment includes its expected epoch;
execution in a later epoch requires a fresh review and signatures. The UI uses
the current L1 period and applies the module's aligned reset to settled L2
allowance data if that rollup has been idle. Its token balances remain canonical;
a stale L2 block timestamp does not prevent review in a new period. Setup funds
the bridge before constructing the policy so its wrapped-asset binding can be
verified. The current launcher deploys a fresh dashboard-owned `TreasuryBridge`
pair extending the pinned fixture, and its own wrapped asset, for both payment
directions. These are the concrete implementation choices for the more general
setup and policy described elsewhere in this proposal.

The payment view tracks the active request and keeps a separate browser-local history of submitted payments and preparation checks. Filters and expandable details cover settled funding, rules and verified invoice rollbacks. Reload revalidates identities and reconciles outcomes. The [history increment record](../audits/2026-10-20-treasury-history/README.md) tracks validation and its browser/devnet scope. The typed invoice condition, presenter action and controlled L1 inclusion harness are implemented; their validation status is recorded in the [invoice audit](../audits/2026-10-20-treasury-invoices/README.md). The rule implementation and validation status
are tracked in the [percentage-rule record](../audits/2026-10-20-treasury-rules/README.md). The reverse implementation and its
validation status are tracked in the [Phase 3 record](../audits/2026-10-20-treasury-reverse-payments/README.md).
Contract tests cover rollback of a later failing transfer using a single-EVM
mock delivery. The invoice process test separately requires an unchanged proved post, an earlier closure in the same L1 target block, successful earlier transfer calls in the reverted trace, and unchanged canonical treasury state.
The separate preview remains explicitly simulated. The regular dashboard's
configuration is unchanged.

### Phase 1 — Owner verification and the signing screen

Identify exact Safe and AllowanceModule artifacts and verify code identity on the chosen environment. Use the runtime and protocol revisions recorded above. Keep demo application contracts, scripts and UI work in this repository, with the runtime and core protocol as external dependencies. Record any local patches used for tests.

Deploy the two Safes, their required proxies and `L1Owners`. Implement signature packing and prove that B and C can authorize a simple L2 Safe transaction after C is added on L1. Cover invalid signatures, duplicates, insufficient threshold, removal ordered before verification, wrong domain and nonce replay. Exercise the actual static read from inside Safe's signature check.

In parallel, extend the hidden dashboard tab with the environment indicator, existing wallet connection, owner list, quorum progress and transaction review. Integrate actual owner reads and signature collection as the adapter becomes available. Implement the initial submission and status display, and the handoff to the configured L1 Safe app for owner administration.

The milestone is to add C in the L1 Safe app, refresh the owner panel, collect B and C's signatures in the treasury UI, and settle a Safe transaction through the real Composer and signer, with its canonical result independently replayed. A Solidity mock of the remote read or simulated signature button does not meet that criterion.

### Phase 2 — Shared policy, funding preview and the L1 destination

Implement the canonical asset configuration, shared counters, checked amounts, capacity calculations and typed payment entry points. Install official allowance modules and authenticate the contract delegates using the caller path. Add the L2-to-L1 bridge-out route with temporary custody.

Connect the holdings and budget overview, both Safe panels, payment form, funding preview and token-movement details to these contracts. Add payment history with preparation, pending and settled states. Show the global-limit rejection separately from insufficient balance or allowance. Refresh canonical balances and effective counters after settlement instead of deducting the preview immediately.

The milestone is to run the first-period sequence from the UI exactly: 40 local, 110 split, 1 rejected solely by the global limit. Verify the contract-level rejection despite sufficient L2 capacity and check that the UI's final balances, actual contributions and all spending figures match the script.

### Phase 3 — Bridge extension and the EEZ-X destination in the same form

Implemented: a dashboard-owned `TreasuryBridge` extends the pinned
fixture with `bridgeFromL1` and an authenticated, terminal `lockForL2`. A deposit
binds the pair, canonical asset, rollup, actual L2 caller, recipient, amount and
nonce. The L1 bridge derives the caller's alias and consumes the nonce; the L2
bridge mints only after that lock succeeds. The policy uses an exact L1 approval
and checks that it is consumed and its alias retains no payment contribution.
All L1 calls remain terminal, preserving the current signer's mixed-entry profile.
A compatible extended pair and its wrapped asset are required; new treasuries
reuse the shared pair. The UI route is enabled only
for a deployment that advertises `combinedL2: true` and validates the extension
bindings. The same form previews either destination, collects the selected source Safe’s
approvals and restores the signed destination/funding fields after reload.
The isolated native browser run passes both destinations, including 110 to
EEZ-X funded by 100 locally and 10 from L1 after a natural reset. It verifies
escrow/supply, approval consumption, canonical lock/mint and independent follower
replay using the current signer. See the [Phase 3 evidence](../audits/2026-10-20-treasury-reverse-payments/README.md)
for exact identities and the scope of each result.

Add the authenticated terminal L1 lock and local L2 mint operations described in Section 4. Keep bridge authority and token backing explicit. Deploy a compatible bridge pair and its wrapped asset for the demo.

Connect the reverse route to the destination selector, funding preview, movement details and settlement history. Enable payments funded from L1 to an EEZ-X recipient once this integration works. Keep recipient-chain selection distinct from the selected source Safe’s signing domain.

Verify payer/recipient binding, unauthorized caller rejection, inability to mint without a successful lock, replay rejection, exact supply/escrow deltas and failure propagation. Exercise owner verification plus all routing reads and writes in the same transaction. Confirm the resulting execution shape is accepted by the current signer and follower without changing their supported profile.

The milestone is to fund a payment to each destination from both Safes using the same form and approval flow, then verify the recipient credits and displayed contributions. This phase is required to claim payments to both destination chains; the L1 destination alone does not complete the agreed scope.

### Phase 4 — Rules, invoice failure and outcome evidence

The rule portion is implemented and validated independently of invoice settlement
failure. Owners sign the canonical asset, recipient, destination, basis-point
fraction, epoch and Safe nonce for `payRule`. It reads both Safe holdings before transfers, rounds down
in six-decimal base units and shares the existing router/debit. The UI defaults
to 10%, distinguishes its estimate from execution observations, and reconciles
both `RulePaid` and `Paid` before displaying an actual amount. Capability-gated
fresh deployments preserve fixed-payment and older-config compatibility.
The [rule evidence](../audits/2026-10-20-treasury-rules/README.md) records 49 Solidity
tests, 217 dashboard tests, the build and the full native browser run. The real
300 → 30 rule settles on L1 and is independently replayed; the following 110-USDC
split to EEZ-X totals 140 in the same period. Coverage includes rule rounding,
capacity/budget rejection, signature identity and reload recovery. The initial
address-format assertion failure and corrected full rerun are preserved.

The invoice contract work is implemented: `payInvoice` routes through the common policy and then requires exact-term acceptance from the pinned `InvoiceMerchant`. The merchant only accepts its configured policy alias. Closed/paid invoice identities cannot be reused. The existing rule, routing and shared-budget regressions remain in the full browser suite.

The percentage form distinguishes estimates from settled observations. The invoice preset opens a fixed 110-USDC invoice and uses normal owner review/signing. Its current-request evidence panel shows the ordered transfer/merchant trace and canonical before/after values; reload reconciles that same invoice. The browsable history now retains these identities through new payments and reloads and rechecks the same canonical evidence for older entries. Uncertain results remain pending; a terminal fixture failure is identified as unverified rather than claimed as rollback.

Separate preparation-rejection and L1-settlement-failure tests are implemented. The existing native relay barrier inserts a higher-priority invoice closure before the untouched proved posting transaction. Assertions require inclusion in the intended target block, prior successful transfer calls under a common reverted frame, exact invoice rejection, effective counters, allowance/Safe nonces, bridge accounting, recipient state and independent follower replay. [Executed validation and diagnostics](../audits/2026-10-20-treasury-invoices/README.md) are tracked independently of implementation.

The milestone is to demonstrate the 300-USDC holdings → 30-USDC rule payment and both failure stages through the UI, with displayed statuses and budget effects matching the integration evidence.

History is a separate panel below the current request. Filter by **Settled**, **Preparation rejected** or **Rollback verified**. Inspect an older rollback to compare balances and counters, then reload and wait for verification. A local budget rejection says **Not signed or submitted**; the closed-invoice Composer rejection has a source hash. Loss of RPC or fixture evidence changes the history result to unresolved rather than promoting cached observations to proof. History never resubmits an action.

### Phase 5 — Harden the complete user flow

Exercise the existing screens together with the actual owner quorum. Cover wallet rejection or disconnection, stale owner/nonce data, changed payment fields after signing, an epoch transition, unavailable reads and an unresolved submission. Retain enough local payment identity across reloads to reconcile an outstanding payment before offering resubmission; browser history is not evidence of settlement or durable Composer recovery.

Check amount precision, understandable validation, keyboard access, readable status labels and the presentation viewport. Confirm the Safe-app handoff uses the intended network/backend. Add the presenter form presets, with simulated state clearly separated from connected data. Keep contract and trace details expandable so the normal review presents recipient, destination, amount, funding and approvals.

The milestone is a rehearsal from owner administration through payment outcome without a terminal for ordinary user actions, and without duplicate payment submission after reload or an uncertain response. Controlled failure injection remains part of the test harness, not an ordinary payment control.

### Phase 6 — Rehearse and capture evidence

Run the complete two-period script through the application with the intended binaries and contract artifacts. Retain source and protocol identity, frontend version/configuration, addresses, code hashes, transaction identifiers, concise balance/counter snapshots, failure traces and independent follower results. Match each displayed outcome to its canonical evidence. Rehearse the booth version, period transitions and the presentation fallback for the failure act.

The completion criterion is the full UI walkthrough with the acceptance results below, including both destinations, the independent global-budget rejection and the established settlement-failure outcome.

Use isolated resources and only the rehearsal's own wallets and state. Advancing time or restoring a snapshot is a development procedure, not something an application can do to mainnet. Public-network rehearsal or deployment needs its own prepared environment and authorization.

## 10. Acceptance and validation

| ID | Required result | Evidence |
| --- | --- | --- |
| R1 | L1 owner changes govern subsequent L2 signature verification | Addition/removal and threshold tests using the deployed adapter, actual Composer and signer; verify execution ordering |
| R2 | Both Safes enforce their grants to the correct delegate | Successful delegate calls, wrong-caller rejection, exhausted-allowance rejection and verified Safe module configuration |
| R3 | The global limit independently restricts payments | Exact 40 / 110 / rejected 1 sequence with L2 allowance still available |
| R4 | Both destination chains receive a payment funded by both Safes | One owner-authorized transaction per payment; correct recipient balance, Safe debits, route and canonical settlement on each path |
| R5 | Bridge extension preserves backing and authority | Lock/mint and burn/release deltas; payer/recipient binding; forged-caller, failed-lock and replay cases |
| R6 | Rules use the combined Safe holdings and the common policy | The 300-USDC holdings → 30-USDC payment case, boundary rounding, insufficient-capacity rejection and common counters |
| R7 | A later required failure leaves no committed payment effects | Settlement trace reaching earlier legs, complete before/after assertions, Safe and allowance nonce checks, follower reconciliation |
| R8 | Reset windows agree | Transactions on both sides of an epoch boundary; matching effective L1, L2 and policy epochs and limits |
| R9 | The supported signer profile is preserved | Successful exact mixed read/write paths through production validation; unsupported callback/revert shapes rejected, with no permissive verifier substituted |
| R10 | The user completes the payment flow through the dashboard example | Visible in normal navigation; direct links work in a fresh session; actual wallet quorum, fresh approvals after editing signed fields, both destinations in the same form, owner-administration handoff and the complete demo walkthrough |
| R11 | UI balances, budgets and history reflect the established outcome | Separate holdings and spending capacity; canonical actual contributions; preparation rejection, settled failure and uncertainty distinguished; no premature settled debit; epoch/freshness handling; reload reconciliation without duplicate payment; simulated data visibly separated |

Use three levels of validation: focused Solidity tests for contract behavior, process tests through the actual runtime roles, and a full rehearsal of the chosen environment. Mocked success or a mined posting receipt is not a substitute for semantic assertions and independent replay.

Develop focused frontend checks alongside each phase: amount parsing, route presentation, signature-to-transaction binding, and status transitions that affect the payment decision. Add browser coverage for the 40 / 110 / rejected 1 walkthrough, changing signed fields, and reload during unresolved settlement. Fixture-based browser checks establish UI behavior; the connected rehearsal must establish that real wallet approvals, contract execution and displayed outcomes agree. Check keyboard operation and readability in the intended presentation viewport.

Existing [core flashloan scenarios](https://github.com/eez-association/eez-core-protocol/blob/855fe0602484750861b4c31502a1a91355d33ed6/script/e2e/nested/L1_to_L2/flash-loan/E2EFlashLoan.s.sol) demonstrate other call shapes. Core scenarios omitted from a default `all` run also do not establish this Safe flow's signer compatibility. The exact combined owner-read, allowance and bridge paths need their own process coverage. A core Anvil run using a permissive proof fixture is core execution evidence only.

Follow the dashboard's [checks](../../README.md#checks) for UI work. Run the applicable checks in the external runtime/protocol checkouts according to the runtime repository's [build and validation requirements](https://github.com/eduadiez/rollupX/blob/fa916b13254a36423cad130080dde367bb18a7d6/AGENTS.md#build-and-validate): integration-contract tests, affected protocol checks for a bridge/core integration change, focused node E2E coverage, and the pinned protocol Anvil suite where applicable. Keep the prescribed core exclusions explicit. Choose nonempty test filters and record skips and flakes accurately. Do not run live-environment tests merely by adding `--ignored`.

There is no passing acceptance record for the full proposal yet. The connected owner and payment milestones have isolated process/browser evidence linked above; the separate interactive preview is simulated. Actual wallet/Safe-app rehearsal remains outstanding. Browser-local payment history is implemented, with its incremental checks in the [history record](../audits/2026-10-20-treasury-history/README.md); it is not a chain-wide indexer. Invoice implementation and executed validation are tracked in the [invoice record](../audits/2026-10-20-treasury-invoices/README.md). The rule increment has its own [validation record](../audits/2026-10-20-treasury-rules/README.md); it does not complete the whole failure phase. The reverse-route implementation has its own evidence record linked above. Attach full acceptance when R1–R11 are established; keep implementation, validation and deployment status separate.

## 11. Compatibility and recovery

This design adds application contracts and a paired demo bridge capability while retaining the pinned execution ABI and the signer's supported profile. Safe contracts and the official allowance code remain unmodified. If implementation reveals that core or signer behavior must change, that extension requires its own specification, producer/consumer updates and regressions before it becomes a dependency of the demo.

Record the bridge pair and its wrapped-token mappings together. An old bridge without the new terminal lock path cannot support the new reverse route. Deploy and configure the compatible pair before enabling it in the policy and funding its wrapped asset; do not silently remap already-held wrapped tokens. Turning off the new route does not migrate escrow or existing wrapped balances.

No Guard prevents owners from disabling allowances or moving L1 funds directly. L2 execution and cross-chain exits still depend on the rollup being available. The signature adapter is a configured owner, not an immutable prohibition on future administration.

For pending payments, the frontend tracks the submitted request and reconciles canonical consumption before presenting completion or offering a replacement. Re-read the Safe nonce and payment outcome before resubmitting; do not create a duplicate payment by treating an uncertain response as a confirmed failure. Composer pending work is not a durable recovery queue across restarts. Follow the [RPC failure and settlement ownership contract](https://github.com/eduadiez/rollupX/blob/fa916b13254a36423cad130080dde367bb18a7d6/crates/eez-control-rpc/SPEC.md) for integration.

## 12. Claims for the presentation

Use these claims once the corresponding acceptance checks pass:

- “The L1 Safe validates the owner signatures for payments initiated through the EEZ-X Safe.”
- “Both Safe allowances and a separate shared budget constrain these policy payments.”
- “One payment can draw from both Safes and arrive on the chosen chain in one L1 settlement block.”
- “If a required payment step fails, none of that payment's transfers or budget charges commit.”
- “The Safe contracts and allowance module are unmodified.”

Describe the shared owner set as the current configuration and the shared budget as a payment-policy guarantee. Owners retain direct spending and administration. The proof system is in the security path of the L1 allowance delegated to the rollup policy; enabled allowances do not make the treasury inherently safer.

Label the fork/devnet and bridge fixture accurately. Describe same-block settlement separately from finality, network fees and preparation latency. Identify a rejected simulation as a rejected simulation, and claim settlement rollback only when the integration evidence demonstrates it.

## Earlier shared infrastructure plan (2026-10-21, superseded funding procedure)

The accepted existing-asset funding increment above supersedes the initial
installation and faucet procedure below. Shared contract identity, payment
routing and isolation requirements remain applicable.

New treasuries share one six-decimal Test USDC asset and its extended bridge pair.
The first completed shared setup registers the pair on Chiado; subsequent setups
discover the earliest compatible canonical registration and verify both bridges,
manager/rollup bindings, frozen administration, wrapped token and token code.
Discovery errors never authorize falling back to another deployment. The faucet
issues 450 test tokens once per setup executor: 300 to its Chiado Safe and 150
bridged to its EEZ-X Safe. These are permissionless demo tokens, not Circle USDC.

Keep the existing terminal-lock/local-mint route for EEZ-X recipients and the
burn/release route for Chiado recipients. Safe balances, allowances and shared
budgets remain independent between treasuries. Bridge escrow backs the combined
wrapped supply, and neither bridge can be re-paired after registration.

Only setups without a created token/bridge and without an outstanding wallet
request or Safe review may adopt this plan. Preserve confirmed transactions,
Safe addresses, setup identity and existing wallet selection. Existing completed
or later partial setups retain their original token, bridges and payment flow.
A new journal version prevents older clients from reconstructing shared funding
as a private deployment. Existing version 2–4 journals remain readable.

Acceptance: two treasuries with different wallets reuse all four asset/bridge
addresses; funding is independent; payments in both directions debit only the
selected treasury; an earlier leg rolls back after a later failure; foreign or
unsealed bridge registrations fail verification; pending legacy calldata and
confirmed setup progress survive reload. The first infrastructure setup must
finish before starting another initial setup; global concurrent installation
is not claimed. Deploy only the local UI, retaining network/operator settings.


## Existing-treasury policy handover (accepted scope, 2026-10-21)

Enable initiation from either existing Safe with a policy-only upgrade. Keep the
Safe addresses, owner adapter, modules, token, bridge, balances, instance identity,
and payment history. No token funding or Safe deployment belongs in this flow.

The wallet deploys an inactive migration policy on EEZ-X. A Chiado Safe batch
registers its alias, sets the previous delegate allowance to zero (without
erasing its spent counter), and grants the new delegate 100 per ten minutes.
An EEZ-X Safe batch performs the equivalent handover and activates the policy.
Activation synchronously verifies both revoked allowances and both new grants,
then copies the previous current-period global spending and carries each chain's
spent amount as a capacity offset until that period ends. Spending that happens
between the first and last transaction is included. Activation fails for
inconsistent counters, unaligned grants, an already-used new grant, or a live old
grant. Nothing can spend through the new policy before activation.

These are three transactions when the saved setup has verified Safe batch
helpers. Owner signatures are additional wallet prompts. Missing batch helpers add one helper deployment on the affected chain;
existing helpers are verified by code before use. No replacement Safes are deployed. Owners
retain administration and may deliberately bypass or replace this policy.

A separate resumable journal retains exact transaction identity, canonical
inclusions, and owner approvals. Payment/owner/restart actions are blocked while
the handover is outstanding; stale tabs also check the current policy address.
The old manifest stays active until final activation is verified. The new manifest
retains the previous payment configuration for historical receipt verification.
The optional invoice merchant has a one-time policy binding: its historical
records remain readable but it is not attached to the replacement policy. The
upgrade UI states this when that fixture exists. Ordinary fixed and percentage
payments retain both destinations.

A failed or uncertain wallet response is never permission to resend. Reorgs
block subsequent steps until existing inclusions are canonical. The operator can
resume after reload; once Chiado revocation is confirmed, finish the handover
rather than silently returning to the previous policy. Mainnet deployment would
use the same owner approvals and ERC-20 permissions; no fixture minting, unlocked
accounts, or privileged RPC mutation is used.

Acceptance: preserve both Safe balances during handover, reject early/repeated
activation and unrevoked old delegates, retain current-period caps including
intermediate spending, reset normally next period, authorize both Safe entry
points, retain old history, prevent concurrent stale actions, and verify a real
Composer/signer execution on the isolated native devnet before local UI rollout.

### Ethereum Safe selection (accepted scope, 2026-10-22)

Users select their existing Ethereum Safe in the dashboard and deploy or connect
its mirror. No Safe address or owner is hardcoded into the network configuration.
The connected wallet deploys the application contracts; the selected Safe's
current quorum approves both allowance configurations. Six transactions reuse the
existing bridge/USDC and batch related setup work. There is no automatic funding.
Mainnet journals and new application artifacts are separate from Chiado. See the
[mainnet setup runbook](../runbooks/treasury-mainnet.md#set-up-through-the-dashboard)
and [validation record](../audits/2026-10-22-treasury-mainnet/README.md).

## Automatic source verification for new deployments (2026-10-22)

Status: implemented for new treasury releases; inherited factory metadata and
explorer availability remain explicit publication limits. New treasury
setups use an immutable build identifier. The build retains Solidity sources,
compiler version/settings, creation/runtime bytecode, and compiler-declared
immutable references together. Recompilation must reproduce the deployment bytes,
including metadata, before publishing a deployable bundle. Existing setup journals
keep their original artifacts; historical contract verification is out of scope.

After a confirmed deployment, the UI automatically hands its transaction identity
to a persistent verification worker. The worker discovers top-level and nested
creations, checks canonical chain state and exact runtime identity, then submits
the retained standard JSON input. Requests are deduplicated by network, address and
build. Explorer delays and temporary errors retry with backoff; an accepted job or
partial source match is never displayed as full verification. Source verification
runs separately from transaction confirmation and requires no wallet approval.

Use the dashboard's existing RPC and explorer configuration. No new `.env` inputs
or signing credentials. Preserve build bundles across releases and pending jobs
across worker restarts. A browser outbox survives delivery failures. Exact
Sourcify runtime verification and explorer publication are distinct results.
Acceptance checks cover reproducible builds, metadata mismatch rejection, nested
creations, network isolation, duplicate delivery, restart recovery, reorgs,
provider failures and pending-versus-complete status. Neither source verification
nor passing these checks establishes a contract security audit.


## Accepted interface and owner-adapter simplification (2026-10-23)

Remove the redundant token argument from the two current payment entry points:
`paySplit(recipient, amount, onL1, epoch, fromL1)` and
`payRule(recipient, bps, onL1, epoch)`. The signed policy target fixes the asset
immutably. Keep one global ceiling constant for both individual amount validation
and cumulative accounting. `TreasuryBootstrap(actions)` belongs to its creator;
an owner argument equal to that creator is unnecessary.

For new mirror selection, extend the existing bounded infrastructure search to
reuse `L1Owners` only for the same original Safe and local EEZ manager. Exact
creation-code hashes locate candidates; verified runtime, immutable bindings and
registered proxy identity authorize reuse. Read failures or reorgs never count as
an absent deployment. Sharing an adapter does not share Safe nonces or signature
domains. Keep the verifier, policy and bridge delegate separate.

New immutable releases carry the new ABI, identified by `SPLIT_VERSION = 2` and
manifest `abiVersion: 2`. Existing manifests and in-progress setup journals keep
their original selectors, constructor and build. No public deployment, automatic
migration, new environment variables, Safe replacement or balance movement is
part of this refactor. An old UI cannot operate the new selectors; release the
matching application and source bundle together. Rolling back the application
cannot convert already deployed contracts or pending signatures.

Acceptance: both initiating Safes, both destinations, exact allocations, live
percentage rules, 100-per-Safe/150-global limits and rollback retain their current
behavior. Verify real bootstrap caller ownership and batch protections; prove
shared-adapter signatures cannot replay on another mirror; reject wrong Safe,
manager, proxy and spoofed discovery events; preserve existing setup journals.
