# Preparing an Ethereum treasury

**Warning: The custom treasury contracts are unaudited demo code and are not ready
for production use, including the Ethereum mainnet integration.** Source
verification and passing tests do not constitute a security audit.

The dashboard asks the user to choose an **existing Ethereum Safe**. The selected
wallet deploys or connects its EEZ-X mirror and approves configuration. Safe
addresses belong in that form, not in `.env` or a fixed owner configuration.
**No new `.env` variables are required.** The existing dashboard network settings
select the RPCs, Composer fronts, registry, manager, bridges, explorers and fee
caps. Setup reuses Ethereum USDC and its existing wrapped representation.

The current local deployment still uses Chiado 10200 and EEZ-X 906969. Its operator
configuration, Safes, balances, browser journals and deployed contracts are not
migrated by this work. Ethereum requires a distinct EEZ deployment anchored to
chain 1; changing one RPC URL cannot retarget the Chiado rollup.

The existing [public mainnet dashboard](https://mainnet.eez.dev/dashboard/) was
verified read-only on 2026-10-22: Ethereum chain 1, EEZ-X chain 696990, both
Composer fronts, a bridge pair and an existing USDC representation are available.
The `standard` treasury profile uses this deployment’s generic bridge API. It
does not require the Chiado extension’s canonical-token or treasury-rollup getters. No new environment variables
are needed to discover these public bindings. See the
[deployment check](../audits/2026-10-22-treasury-mainnet/README.md#public-mainnet-deployment-discovery--2026-10-22-follow-up).

The simplified contract build targets fresh treasury setups. It does not migrate
existing policy contracts or preserve earlier constructor layouts.

### RollupX deployment (chain 696991)

`rollupx-mainnet-network.json` adds the deployment served by
`https://rollupx.eez.dev/dashboard/`: Ethereum chain 1, RollupX chain 696991,
rollup ID 2 and bridge `0x95273bf880ae09fdeb8c71d5aa37a0ba70835b55` on both
chains. The previous chain-696990 profile and its saved setup identities remain
unchanged. Both bridge proxies must retain the pinned EIP-1967 implementation
and exact proxy/implementation code hashes. New policies prefer `EEZContract()`
and fall back to `manager()` for older bridges.

At the October 28 inspection, the new bridge had no wrapped Ethereum USDC.
The expected wrapped address and runtime hash were reproduced locally from the
verified `WrappedToken` constructor, CREATE2 salt, Ethereum USDC metadata and
chain ID 696991. This prediction is not a deployed-token claim. Setup stays
blocked until the real wrapped contract, origin, decimals-dependent bytecode
and bridge mint authority match. An operator must provision USDC through the
normal bridge before selecting **Check again**. The dashboard does not submit
that transaction automatically.

Bridge and wrapped-token sources match
[core protocol PR #54](https://github.com/eez-association/eez-core-protocol/pull/54)
at `60d60296616a20dbf7dcd72cf95c36da4feecaf9`; supplemental compiler inputs are
retained for verification. Deploy the dashboard and verification-service images
together so the service has the new policy release and dependency inputs.
L2 source jobs use the live RPC chain ID and the configured `/explorer/api`;
an explorer 404 remains pending and must not be presented as verified.

New setups also reuse a verified owner adapter when another mirror follows the
same original Safe on the same EEZ manager. Otherwise the normal batch creates
it. No wallet address or new environment setting is needed. The selected adapter
must match both bindings and its registered Safe proxy; a discovery RPC failure
requires retrying the read, not assuming that a new deployment is needed.

Current policies omit the token argument from fixed payments;
the signed policy address fixes the asset. Their manifests record `abiVersion: 2`
and verify `SPLIT_VERSION = 2`. Existing manifests retain their original ABI, and
unfinished setups retain their source build and bootstrap constructor. Deploy the
matching dashboard and immutable verification bundle together; updating the UI
does not change an installed policy or convert outstanding approvals.


## What is compatible

Use an existing Ethereum Safe and deploy a new mirror or connect a mirror already
linked to it. Existing Ethereum Safes may use verified **1.3.0, 1.4.1 or 1.5.0**
implementations, including their SafeL2 variants. Imported EEZ-X mirrors support
1.3.0 and 1.4.1; new mirrors use 1.4.1. Safe 1.5.0 retains the legacy signature
verification used by the adapter on Ethereum, but its contract-owner signature
interface cannot use the current adapter as an EEZ-X owner. Both proxy and
singleton bytecode are checked; a version string alone does not establish support.
Transaction Guards, and the module Guard introduced in 1.5.0, must be absent.
The current wallet flow collects EOA approvals; a quorum that needs contract-owner
signatures is not supported. Safe administration and direct spending remain under the owners'
control; this shared budget applies only to policy payments.

Both Safe signing domains, both initiation directions, both payment destinations,
custom splits remain available. Limits stay at 100 USDC per
Safe and 150 shared per ten minutes. No automatic funding, mint or faucet is added
for Ethereum. Fund the Safes separately with the configured assets.

The canonical Ethereum token is
[Circle USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses),
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, with six decimals. The EEZ-X token is
its bridge representation, not a separately Circle-issued token. Changing a symbol
or an address on the Chiado deployment is not a migration.

## Standard bridge payment path

Deploy `StandardBridgeDelegate` on Ethereum with the existing Safe, official
allowance module, USDC, bridge and destination rollup ID. Deploy
`StandardBridgeTreasuryPolicy` on EEZ-X with the existing bridge/token addresses
and that delegate as its final constructor argument. This is an application
integration with the existing bridge; no replacement asset or bridge is deployed.

The Ethereum Safe makes a one-time `bindPolicy(policyAlias)` call and grants its
100-USDC allowance to the delegate. Only that authenticated policy alias can call
it. The delegate executes the allowance transfer and any bridge operation inside
one Ethereum call, checks its final balance and consumed approval, and rejects
reentrancy. It has **bounded allowance access**, never unrestricted Safe module
power. On EEZ-X, the allowance beneficiary remains the policy itself. The policy
reads the Ethereum allowance for the delegate, so the shared budget and UI counters
use the same spending authority that actually pays.

Set `payments.bridgeKind` to `standard`, `bridgeExecutorL1` to the funding delegate
and `safeL2Alias` to the mirror Safe's registered Ethereum alias. Include those
addresses' runtime hashes in `code`. Provision the mirror and policy aliases
through the existing registry before configuring them. The policy creates its
local proxies in its constructor. Enable the official allowance module on both
Safes and configure their respective delegates with 100 USDC, ten-minute resets
and aligned base periods. There is no invoice merchant argument or entry point. The owners'
normal Safe transaction can batch delegate binding and allowance configuration.
No assets are created or funded by dashboard setup.

Both initiation choices use Ethereum for submission. An EEZ-X approval still
signs the mirror Safe's chain ID, contract address and nonce. The wallet signs on
EEZ-X, then switches to Ethereum and submits that Safe execution to its registered
alias. Ethereum Safe approvals and submission both remain on Ethereum. This keeps
the standard bridge's return callback inside an L1-origin execution supported by
the pinned signer. The UI distinguishes the signing and submission networks.

The manifest, explorers and history distinguish the Ethereum submission, EEZ-X
Safe execution and settlement. A receipt alone cannot complete a mirror payment:
the client matches the sender, nonce, exact Safe calldata, protocol call hash, Safe
success, Paid event and the canonical source/destination blocks. Downgrades cannot
read this profile's pending relay intents; keep this version until they resolve.
The Chiado wizard, existing policy contracts and saved transaction bytes retain
their previous behavior.

## Set up through the dashboard

Open the treasury example on the Ethereum-backed dashboard. Enter the Ethereum
Safe address and choose **Deploy a mirror Safe**, or enter an existing mirror
already linked to that Safe. **Start setup** performs read-only network, code,
owner and threshold checks; it does not create an Ethereum Safe or open a wallet
transaction. The connected deployment wallet can differ from the Safe owners.

The six transactions are:

1. Reuse the shared Ethereum allowance module; deploy the setup executor and this Safe’s bounded funding delegate.
2. Deploy or connect the EEZ-X mirror and live owner adapter, reusing verified Safe infrastructure where available.
3. Reuse or prepare the shared EEZ-X allowance module, then deploy the treasury policy using the existing bridge.
4. Register the mirror, adapter and policy aliases on Ethereum.
5. Collect the Ethereum Safe quorum and approve its 100-USDC allowance and delegate binding.
6. Collect the mirror Safe quorum, then submit through Ethereum to approve its 100-USDC allowance.

New Ethereum setups use the predeployed addresses in
[`mainnet-shared-contracts.json`](../../src/lib/treasury/mainnet-shared-contracts.json).
The allowance module keeps independent state for each Safe, delegate and token.
Setup checks its full runtime hash at one canonical block and retains that identity
in the manifest. Mainnet policies read their alias from the funding delegate's
one-time Safe-authorized binding; they have no alias-reader dependency.

For EEZ-X, setup first checks official Safe deployments, then discovers matching
Safe implementations, proxy factories, call-only batch helpers and allowance
modules through bootstrap creation logs. Exact release runtime checks authorize
reuse; a log alone is insufficient. History is read in bounded ranges and checked
against a stable block. A missing contract is prepared by the connected wallet
inside the normal setup batches. Subsequent treasuries, including other wallets,
reuse those deployments. No operator account or `.env` setting is required.
RPC failures or a changed block stop selection rather than treating an uncertain
read as an absent contract. Concurrent first setups may deploy equivalent copies.

A Safe that already has the module enabled skips `enableModule`; the signed batch
still grants the new delegate its own allowance. Changes to module enablement
invalidate a previous review. Existing delegates and spending counters are
retained. Shared code identities are rechecked before preparing a transaction.

The last two steps require Safe signatures in addition to the submitting wallet's
transaction confirmation. The shared limit is 150 USDC per ten minutes. Setup
never mints, approves wallet funding, or transfers funds. Fund either Safe separately.
Each batch is shown before confirmation. Saved exact calldata, sender and nonce
support automatic receipt/replacement tracking; lost wallet responses do not
trigger automatic resubmission. The final mirror step additionally matches the
protocol call and canonical settlement, not just the source receipt.

Mainnet setup/manifest keys have a distinct network identity. They never load,
reset or overwrite Chiado journals. The packaged public network identity in
`src/lib/treasury/mainnet-network.json` binds the reviewed deployment; changes to
protocol, bridge or USDC implementation require review. New application bytecode
is in `mainnet-artifacts.json`; the frozen Chiado bundle stays unchanged.

```bash
npm run build:contracts
npm run check:treasury-release
node --test tests/treasury-mainnet-setup.test.mjs
node tests/treasury-mainnet-setup-browser.mjs
```

The chooser and deployment planner have browser/unit checks. The six wallet
setup transactions have **not been broadcast to Ethereum**. The native rehearsal
below deploys the same policy/delegate and exercises real signatures, payments,
rollback and independent replay on owned chains; it is not a certification of a
wallet extension or the public Safe application.

Source verification runs independently of wallet confirmations. **Contract sources
verified** means every discovered contract has a full explorer verification or
an exact Sourcify match. Explorer publication can continue in the expanded details;
an unresolved verification job still prevents the completion heading.

## Optional operator manifest import

The existing runtime `treasury` field remains supported for an already-provisioned
treasury. It is optional and is not the ordinary Safe-selection workflow.

## Configure and check an existing deployment

Create an unconfigured example without modifying `.env`:

```bash
npm run treasury:mainnet -- --template .runtime/treasury-mainnet.json
```

Replace every `REPLACE_...` and `YOUR_...` placeholder with independently reviewed
public deployment information. Numeric chain and rollup IDs must be JSON numbers.
Use a distinct 32-byte `instance` identifier for this treasury. All endpoints must
match the dashboard's existing public RPC/Composer paths; keep authenticated
provider URLs on the server. Mainnet explorer URLs are bound to the manifest.
The Safe app URL must identify the Ethereum Safe with `safe=eth:<address>`.

Pin each contract's runtime hash, both protocol implementations, both Safe
singletons and USDC's implementation. USDC uses Circle's legacy Zeppelin
implementation slot, `keccak256("org.zeppelinos.proxy.implementation")`, not the
EIP-1967 slot. Before signing and preparing a payment, the client checks that the
implementations still match. An upgrade requires an intentional review/update of
the manifest; it is never silently adopted.

Declare each bridge as `{"kind":"immutable"}` only after reviewing its actual
code. For an EIP-1967 proxy, use `{"kind":"eip1967","address":"<implementation>"}`
and add that implementation to `code`. Other proxy layouts require additional
validation support. Matching supplied hashes establishes identity, not an audit
or a proof that a purported immutable contract cannot delegate execution.

The configured production bridge must implement the interface the policy uses:
`bridgeTokens`, `manager`, `canonicalBridgeAddress`, `rollupId`,
`getWrappedToken` and `wrappedTokenInfo`, with the wrapped token exposing its
`BRIDGE` mint authority. It must preserve synchronous lock/mint and burn/release,
exact amounts, authenticated counterparties and rollback across the complete
payment. An asynchronous bridge is not a drop-in replacement.
The optional owner-approved move from the Ethereum Safe to its EEZ-X mirror also
requires Safe's official MultiSendCallOnly 1.3.0 helper at its verified deployment
address. Receipt tracking uses `TokensBridged`, `WrappedTokensMinted`, ERC-20
`Transfer` and the pinned protocol's outgoing/incoming call events to establish
one canonical delivery. These interface requirements must be validated against
the production bridge. The Chiado transfer checks do not establish a live mainnet
deployment or validate a different bridge's security.

Run the read-only deployment check:

```bash
npm run treasury:mainnet -- --manifest .runtime/treasury-mainnet.json \
  --output .runtime/treasury-mainnet-check.json
```

It checks chain references, code/implementation identities, Safe/adapter/policy
bindings, token metadata and pause state, bridge token origin/mint authority,
rollup identity, both Composer fronts and a signable current owner quorum. The
command accepts no signer or private key and sends no transactions. Incomplete
manifests, changed implementations and the packaged test bridge implementations
fail the check. A successful report explicitly says `productionReady: false`:
these checks do not test the security of the supplied bytecode or execute a payment.

For this optional import, place the reviewed object in the **existing** runtime
`treasury` field. Network IDs, registry/manager, public endpoints and fee caps must
match. Otherwise leave that field absent and use the Safe chooser. The Chiado
wizard remains a separate path and never deploys its fixture asset or bridge on
Ethereum.

## Isolated standard-bridge rehearsal

Capture the existing deployment read-only, then run the dashboard-owned native
fixture. These are CLI inputs; no `.env` edits are needed:

```bash
mkdir -p .runtime/mainnet-rehearsal
node scripts/treasury-mainnet-snapshot.mjs \
  --config https://mainnet.eez.dev/dashboard/config.json \
  --output .runtime/mainnet-rehearsal/snapshot.json
python3 scripts/run-treasury-integration.py \
  --runtime /absolute/path/to/rollupX \
  --standard-bridge-snapshot .runtime/mainnet-rehearsal/snapshot.json
```

The snapshot fixes both public block hashes and captures bridge, USDC proxy and
USDC implementation bytecode. The native fixture deploys identical runtimes with
**fresh local state** and initializes local fixture roles, balances and bridge
bindings. It does not impersonate owners or mint assets on public networks. The
ordinary ERC-20 and bridge APIs then fund the isolated Safes. This is not a fork of
the full live EEZ network. The separate Ethereum fork suite below uses actual
mainnet USDC storage. Both kinds of evidence are needed and reported separately.

The native runner verifies exact runtime source and binary identities, genuine
Safe signatures, posted attestation and independent follower replay. Optional
`--reuse-run` accepts only a successful run with matching source and executable
hashes. Failed attempts and logs are retained; do not treat an earlier success as
validation of changed sources. The browser uses the production client and real
RPCs with a test EIP-1193 wallet; it does not certify a wallet extension or Safe app.

## Real-USDC fork validation

The separate Foundry `mainnet` profile exercises actual USDC code/state with the
pinned Safe and AllowanceModule. It is outside the default `test` directory and
requires an explicit fork; missing prerequisites fail instead of silently skipping.

```bash
npm run build:contracts
FOUNDRY_PROFILE=mainnet TREASURY_USDC_HOLDER=<public-funded-holder> \
  forge test --root contracts --fork-url "$TREASURY_FORK_RPC" \
  --fork-block-number <fixed-block> --chain-id 1 -vv
```

`TREASURY_FORK_RPC` and `TREASURY_USDC_HOLDER` are temporary test-process inputs,
not dashboard `.env` settings. Keep access-bearing URLs out of committed logs.
A holder with at least 300 USDC is impersonated only inside Foundry; USDC's pause
and blacklist roles are also impersonated only inside that local fork. Forge tests
do not broadcast these actions to the source endpoint.

Four checks cover six-decimal transfers through a contract allowance delegate,
the 100-USDC ceiling, paused-token rejection without allowance consumption, and a
blacklisted second transfer undoing an earlier transfer and allowance updates.
This suite does **not** validate EEZ proofs, bridging, L2 owner verification, the
shared policy or a real wallet/Safe-app session. Those require the complete target
rollup and production bridge rehearsal.

On 2026-10-22, all four passed using the supplied Tenderly Ethereum replica,
source chain 9991, block 26082600. Chain ID 1 was applied only inside the local
Foundry fork to exercise Ethereum Safe signatures. This was not a transaction on
Ethereum or a live mainnet EEZ rehearsal. See the
[compatibility record](../audits/2026-10-22-treasury-mainnet/README.md).

## Release boundary and rollback

The packaged `TreasuryBridge` family inherits test-only periphery and remains
unsuitable for real funds. Mainnet release still requires the production bridge,
independent review of custom contracts and the protocol/prover trust path, and a
complete rehearsal with actual deployment bindings, both initiation/destination
pairs, insufficient balances/allowances, USDC failures and canonical recovery.

Old dashboard builds reject `ethereum-mainnet`; do not roll an active mainnet
client back to them. Existing Chiado manifests and journals are unchanged. A
proxy implementation change intentionally blocks new mainnet approvals until
reviewed; retain submitted transaction identities and reconcile them normally.

Current payment manifests use `payments.version = 2` for the asset-bound split
interface. Existing token-bearing split manifests keep their original selector;
the UI reads their old interface identity without rewriting the manifest or any
saved Safe signatures. New requests contain the amount and exact L1 contribution,
with the remaining amount supplied by EEZ-X. Retired `pay`/`payRouted` encodings
remain available only for recorded submission/history recovery. Keep the original
journal and release inputs when updating; earlier UIs cannot submit the new shape.
