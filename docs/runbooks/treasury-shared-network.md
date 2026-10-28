# Treasury on the dashboard networks

**Warning: The custom treasury contracts are unaudited demo code and are not ready
for production use, including the Ethereum mainnet integration.** Source
verification and passing tests do not constitute a security audit.

Target the existing Chiado **10200** and EEZ-X **699069**, rollup **1**. All code,
checks and deployment records belong in this repository. The running protocol,
operator wallets and chain data are not redeployed for this demo.

Choose the deployment wallet using the dashboard's normal wallet selector.
Choose **Use an existing Safe** to retain a verified Safe /
SafeL2 1.3.0, 1.4.1 or 1.5.0 implementation, including **1.3.0+L2**, with its
current owners and threshold. Existing EEZ-X mirrors support 1.3.0 and 1.4.1. On EEZ-X,
deploy a mirror Safe using the L1 owner adapter or reuse an existing compatible
Safe. Add owners later by entering their addresses in **Shared owners**; the
current Chiado quorum approves each change. Keep **100 per Safe / 150 global** per ten minutes, with no Guard.
New setups use one predeployed six-decimal **Test USDC** asset and sealed treasury
bridge pair. Setup only connects the Safes and configures spending; it does not
require a token balance, request token approvals or transfer tokens. Fund either
Safe separately with the matching canonical or wrapped asset when ready to pay.
There is no funding or faucet screen in treasury setup.
Completed testnet setups retain a network-selection hint scoped to the configured
endpoints, bridges, token and protocol profile. On reload it may restore the saved
Safe addresses immediately; it never caches balances, owners, nonces or approvals.
Fresh owner/balance reads run together before the full treasury validation, while
the network-ready gate remains closed. Wallet actions also await a fresh network
selection check, then the usual journal lock and action-specific validation.
Malformed, changed, incomplete or restarted setups do not use the hint.
The ready badge and payment controls wait for both network-selection and treasury
validation. A queued action rechecks its validation context and the complete saved
manifest under the journal lock, even when the Safe instance ID is unchanged.
Independent owner/balance failures preserve successful display reads but keep
actions blocked. The reload browser regression covers these cases, changed live
network identity, leaving the screen during validation and journal preservation.
Validation and the local UI rollout are recorded in the
[setup-without-funding audit](../audits/2026-10-21-treasury-no-funding/README.md).

The shared infrastructure is predeployed and canonically verified on both chains.
Its addresses, transaction receipts and current checks are recorded in the
[wallet-funding audit](../audits/2026-10-21-treasury-wallet-funding/README.md).
Infrastructure deployment is separate from each treasury setup and from
real-wallet/Safe-app acceptance. The linked audit records the state observed at
the time; the dashboard verifies the selected treasury before opening it.

## Optional payment expiry (paired policy version 2)

New setups use `PAIR_VERSION = 2`. The fourth `paySplit` argument is an optional
Unix-second deadline, and the dashboard demo explicitly signs **0 (no expiry)**.
Crossing a ten-minute budget reset no longer invalidates these approvals. A
nonzero deadline remains supported and is checked on both chains. Safe nonce,
owner signatures, balances and spending limits are still enforced.

Each Safe's 100-token allowance is checked in its own execution-time period.
The shared 150-token budget is counted once in L2's execution-time period;
`Paid` reports that L2 period even when initiated on L1. UI capacity display, review and pre-submission checks use L2 `latest` state,
with balances, allowances, timestamps and spending pinned to the same observed
block per chain and block hashes rechecked afterward. No extra reads are added.
A stalled latest block does not reset capacity merely because wall-clock time
passed. Settlement and recovery retain their safe/canonical evidence.
Version-2 reconciliation matches the signed deadline
in the exact peer call rather than requiring the preview period in the event.

A new immutable release contains this behavior. Already deployed version-1
policies are unchanged and keep epoch-bound signing/reconciliation. Fresh
setups use the new release; no automatic on-chain upgrade or revocation of old
allowances is performed. Do not treat a changed frontend as a policy migration.

## Create both Safes from the dashboard

Alternatively choose **Create new Safes**. This uses the same six-step
paired setup and current release; no new Solidity contract is introduced:

1. On L1, deploy or reuse identical Safe infrastructure through the verified
   deterministic deployer, then create the Safe with the selected wallet as sole
   owner, threshold 1, at the address reserved for both chains.
2. On L2, prepare `L1Owners` and create another Safe with that same wallet owner
   and threshold 1. It is not yet governed by the adapter.
3. Deploy the L2 allowance module and paired policy.
4. Deploy the L1 allowance module and policy, and provision the L1 aliases for
   the L2 Safe, adapter and policy. Keeping these deployments here avoids the
   contract-creation size limit in step 1.
5. The L1 Safe approves its peer connection and local allowance.
6. The wallet signs the L2 Safe's first transaction (nonce 0). Its call-only batch
   first calls `swapOwner(sentinel, wallet, L1Owners)`, then configures the peer and
   allowance and activates both policies. The signature is an ordinary EOA Safe
   signature on L2; the outer submission still uses the L1 Composer route.

New setups require the same code-hash-verified deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) on both networks. It uses CREATE2
to deploy the released Safe singleton and SafeProxyFactory with identical initcode
and salt, giving those helpers matching addresses too. Safe creation then uses
the same explicit wallet initializer and persisted random salt on both chains.
The owner is never the bootstrap executor or `msg.sender`. Occupied Safe addresses,
mismatching infrastructure code and changed plans fail closed. No new Solidity
code or rewritten release bundle is needed. The deployer interface follows the
[deterministic deployment proxy](https://github.com/Arachnid/deterministic-deployment-proxy).
Before handover, the L2 Safe must still have its initial wallet owner, threshold 1
and nonce 0. Afterward its only owner is `L1Owners`, and payments use the normal
adapter signature path. A failed setup batch rolls back the ownership replacement
within the Safe transaction. Source publication and setup recovery cover both
new Safes, including reloads before the first L1 address is available.

New **Create new Safes** setups guarantee the same planned address on both
chains. They are independent instances with separate balances, nonces and signing
domains. Older saved create-both plans retain their original, possibly different
addresses; an already deployed Safe cannot be moved to a different address.
No funding or token claims are part of this path. The original existing-Safe path
still creates its mirror directly with the adapter owner.

Local validation: `node tests/integration/treasury-matching-safes.mjs` verifies
matching addresses and independent state on two isolated EVMs, L2 owner handover,
plan integrity, collision rejection and deployer checks.
`node tests/integration/treasury-paired-setup.mjs --create-both` separately exercises
the earlier saved-plan shape and executes released contracts, handover, setup-failure rollback, reload recovery and
all four payment routes on an isolated EVM. This does not validate native EEZ relay
or cross-chain rollback. A read-only plan check also confirms supported factory
availability on the configured live testnet. The first matching-address batch
also passes a live gas estimate without broadcasting a deployment. These checks
do not establish a complete native cross-chain run of the new matching path.

### Next iteration: combine deployment steps (deferred)

Status: design proposal only. Keep the current six-step flow for user testing;
do not enable this path or change its deployment/signing behavior yet.

First evaluate merging steps 2 and 3 into one L2 deployment batch. If safe within
the creation-size and gas limits for the selected infrastructure, this reduces
setup to five steps without predicting contracts across transactions.

Then evaluate merging L1 steps 1 and 4 by predicting the L2 Safe, owner adapter
and policy addresses before any deployment. The proposed four-step flow is:

1. Prepare/create the L1 Safe and policy, and provision the L2 connections.
2. Deploy the L2 Safe, adapter, allowance module and policy together.
3. Approve L1 peer connection and allowance through the L1 Safe.
4. Approve L2 setup, including the first-transaction ownership handover for fresh
   Safes, and activate both policies.

Address predictions are exact only for fixed deployment inputs. The current
bootstrap uses CREATE (wallet address and wallet nonce); its deployed helpers
use CREATE (bootstrap address and creation nonce). SafeProxyFactory uses CREATE2
with its actual creation code, singleton, initializer and salt. Changing wallet
nonces, infrastructure reuse, owners or action order can invalidate the plan.

Before implementing, freeze and persist both chains' full deployment plans;
verify factory code and CREATE2 derivation; test whether the protocol permits
provisioning proxies before their remote contracts exist; check collisions,
batch size/gas limits, nonce drift, reorgs and recovery after only one chain
completes. Evaluate a verified CREATE2 factory for helpers to remove dependence
on wallet nonces. This would be a separately reviewed deployment design, not a
change to existing immutable releases. Matching addresses for new Safes are
implemented independently of this deferred step-combining proposal.

The simplified contract build targets fresh treasury setups. It does not migrate
existing policy contracts or preserve earlier constructor layouts.

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


## Shared EEZ-X Safe infrastructure

New treasuries reuse the Safe implementation, proxy factory, call-only batch
helper and allowance module. Setup discovers the existing bootstrap creation
logs, matches exact release bytecode at a stable block and rechecks the selected
code before submission. Missing contracts are prepared from the connected wallet
in the usual setup batches; later wallets discover the same confirmed contracts.
Each Safe's allowances remain independent. An already-enabled module is omitted
from the signed configuration batch, and a change to enablement invalidates the
review. RPC errors stop setup instead of triggering another deployment.

## Token display in explorers

The shared Test USDC uses six decimals, like USDC. A raw amount of `450000000`
represents 450 tokens. Query `name()`, `symbol()` and `decimals()` on the deployed
contract when an explorer shows unnamed tokens or raw integers; its indexed
metadata may be incomplete. Do not redeploy the token or alter its precision to
work around an explorer record.

The Chiado token source was fully verified on 2026-10-21, but its ERC-20 metadata
was still missing from Blockscout after verification. The remaining refresh must
happen in the explorer's token indexer. See the
[metadata verification record](../audits/2026-10-21-treasury-explorer-metadata/README.md)
for the exact token, public checks and outstanding limitation.

## Automatic contract source verification

New setups pin an immutable build ID and automatically queue source verification
when each deployment transaction is confirmed. No extra wallet approvals or
per-contract commands. The background worker checks the canonical receipt,
discovers top-level and nested creations (including Safe factories), matches
runtime bytecode including metadata, and submits the retained standard JSON
compiler input. Only compiler-declared immutable locations may differ.

Opening a configured or saved paired treasury also automatically queues its
existing contract addresses, including reused tokens, allowance modules, Safe
implementations, bridges and protocol bindings. Address verification reads code
at a fixed canonical block; it does not require a creation transaction, so it
also covers genesis contracts and old deployments whose receipts are unavailable.
Known proxy layouts reveal their implementation, and normal bridges reveal their
local manager and counterpart proxy. Dependency discovery is bounded to 16
addresses per job and never accepts caller-supplied RPC URLs or compiler inputs.

Verification-only inputs for already deployed protocol revisions are retained in
`verification/supplemental/`, independently recompiled, and matched including
metadata and constructor immutable references. Adding these inputs does not
upgrade deployed contracts, change the dashboard's protocol dependency pin, or
rewrite an immutable treasury release. Unsupported bytecode remains visibly
`source-unavailable`; it is never published using an approximate source match.

Build with `npm run build:treasury-release` and check with
`npm run check:treasury-release`. The release builder compiles portable source
paths, retains each exact compiler/version/settings/source input, and independently
recompiles the smaller per-contract verification inputs before accepting them.
`build:treasury-artifacts` / `check:treasury-artifacts` now use this release path.
The frozen legacy bundles are only for resuming existing setups. Keep them
unchanged; the release builder produces new immutable bundles separately.

`src/lib/treasury/current-build.json` selects the new build. Keep all published
`src/lib/treasury/builds/<id>.json` and `verification/builds/<id>/manifest.json`
files in releases: saved setups select their original bytes. Factory dependency
inputs live in `verification/dependencies/` and are also recompiled exactly.
`npm run build` checks the packaged deployment/verifier identities; it needs no
Solidity compiler inside the frontend image.

Docker Compose starts `verification` alongside `ui`; it uses the UI's existing
runtime RPC/explorer settings. No signing keys are needed. Optionally set
`ETHERSCAN_API_KEY` in the server's local `.env` to publish Ethereum mainnet
sources through Etherscan V2. Compose passes it only to `verification`; it is
never included in browser configuration or build arguments. Restart that service
after changing the key. For a standalone worker, export it in that process's
environment (the Node worker does not load `.env` itself).
Its `/data` volume (`treasury-verification`) preserves jobs across restarts. It
shares the UI network namespace, listens only on loopback port 18081, and is
proxied at `/treasury-verification/`. When recreating the UI, recreate the worker
with it. For a Vite session on port 8080, run `npm run treasury:verification` in a
second terminal; local jobs stay in `.runtime/treasury-verification/jobs`.

The browser saves verification intent with confirmation and retains an outbox
before a setup can be replaced. Delivery is immediate, idempotent and retried;
a handed-off job continues after the browser closes. An undelivered outbox is
retried when the dashboard is opened again. One failed delivery keeps its intent
for retry while later requests continue independently. Publication never adds a transaction
confirmation or blocks treasury use. The compact **Contract source verification**
disclosure reports address-specific progress and explorer links.

Jobs retry provider errors with bounded backoff. A queued submission, verified
twin or partial match never counts as full verification. Exact Sourcify runtime
verification on Chiado/Ethereum is recorded separately from explorer publication;
creation matches are also separate. With `ETHERSCAN_API_KEY`, Ethereum source
links point to Etherscan; without it they point to public Blockscout. EEZ and
Chiado continue using their configured Blockscout explorers. Etherscan requests
use the official fixed V2 endpoint, are paced, and persist submission IDs for
status polling after restarts. Queued responses and similar-contract matches
never count as full verification. API failures retain retryable jobs and expose
only generic errors, never credential-bearing URLs. Constructor arguments are
left to Etherscan detection; deployments it cannot resolve remain pending rather
than being reported verified. Source publication and status polling follow the
[Etherscan verification API](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode).
Completed jobs are periodically rechecked
against canonical chain state. Jobs for another configured network remain stored
but cannot run through a mismatching RPC. Unknown build IDs and unconfirmed
transaction hashes cannot enter the public queue. Transaction admission requires at least
one newly observed deployment with exact retained bytecode. Address admission
requires a match against retained compiler output; already fully verified third-party
contracts can be reported without allocating queue capacity. Configuration-only
confirmations return `not-applicable`; unknown code returns a visible
`source-unavailable` result without allocating a persistent job. Events naming
already existing contracts do not establish a new deployment. Candidate discovery
is capped at 128 addresses, and nginx limits verification requests to two per
second per peer with a burst of 20; excess requests retry with HTTP 429.

At the 10,000-job limit, the oldest completed results can be removed to admit new
work. Active, unresolved and partially published jobs are retained. Redelivery of
an expired completed result checks the chain and explorer again. A completed job
being rechecked cannot be evicted underneath its worker. Existing queue files
remain compatible; older empty confirmations are reclassified as `not-applicable`
instead of reported as verified. Roll back UI and worker together to preserve
matching source catalogs; preserve the job volume throughout.

New Chiado treasury plans use version 10 and Ethereum plans version 2 so old UIs
reject them. Existing setup records keep their original artifact selection,
calldata, signatures and transaction history. Do not downgrade while using a new
build. Old contract backfilling is out of scope for this workflow.

An inherited factory can create a new address using older bytecode. The release
includes exact inputs for official Safe 1.3.0/1.4.1 proxy factories and the pinned
core proxy. If a factory produces a different metadata identity, the job reports
**Source build needs attention**; it does not publish approximate sources. The
existing Chiado registry's older alias metadata is one known such limitation.
Exact original inputs are required to clear it. Public Chiado explorer verifier
errors can also leave explorer publication pending despite an exact Sourcify
result. See the [historical verification inventory](../audits/2026-10-22-treasury-source-verification/README.md)
for those inherited service/provenance issues; this change does not retry its old
contracts. See the [automation validation record](../audits/2026-10-22-treasury-auto-verification/README.md)
for the new build and queue tests.

## Reusing Safe 1.3.0+L2

Paste its address into the existing-Safe field. The dashboard checks the proxy,
exact official singleton bytecode and live owners; no Safe upgrade is required.
The app's **+L2** label identifies the event-emitting variant, whose on-chain
`VERSION()` is `1.3.0`. New mirror Safes still deploy version 1.4.1. A 1.3.0 L1
Safe can authorize its 1.4.1 mirror through the same `L1Owners` adapter.

Setup, owner changes and payments recognize both versions' execution events,
including recovery when the wallet's transaction hash response is lost. Existing
journals and signed requests require no migration. Older dashboard builds reject
1.3.0 treasuries; keep the updated build while using one. Guards and unsupported
contract-owner quorums remain explicit setup blockers.

## Reusing Safe 1.5.0 on the base chain

A verified Safe or SafeL2 1.5.0 can be the Chiado or Ethereum Safe. Its current
EOA quorum authorizes the 1.4.1 mirror through the retained legacy
`checkSignatures(bytes32,bytes,bytes)` overload. The new proxy runtime and both
singleton runtimes are checked against published artifacts. A nonzero 1.5.0 module
Guard blocks setup, like a transaction Guard; setup never removes either.

The EEZ-X mirror must still be 1.3.0 or 1.4.1: a 1.5.0 mirror expects the modern
ERC-1271 contract-owner interface, which the current adapter does not implement.
This dashboard update does not deploy or upgrade any Safe, adapter or policy and
requires no journal migration. Earlier dashboard builds reject 1.5.0 treasuries;
retain the compatible UI while using one. See the
[compatibility validation](../audits/2026-10-22-treasury-release/README.md#safe-150-compatibility).

## Shared asset lifecycle and compatibility

The operator deploys `SharedTestUSDC` and two `SharedTreasuryBridge` contracts
once, before treasury creation. Three transactions create the Chiado contracts,
create/pair/seal the EEZ-X bridge, then pair/seal the Chiado bridge and publish the
registration. A 0.000001-token deposit creates the backed wrapped representation;
the remaining constructor allocation is returned to the operator. No Safe is
created or funded by this operation. Both bridge administrators are permanently
zero after completion. The normal dashboard bridge is unchanged.

Discovery scans canonical registration logs from the network checkpoint in
bounded ranges, then verifies both code identities, managers, rollups, frozen
peers and wrapped mint authority. A missing registration or failed read stops
new setup; it never authorizes implicit infrastructure deployment. The asset
binding also records the canonical ERC-20 code hash and requires six decimals.
Explicit Ethereum manifest support and real-USDC fork checks are covered by the
[mainnet preparation runbook](treasury-mainnet.md). A production bridge and an
Ethereum-anchored rollup remain required; changing the token address alone does
not enable a mainnet treasury. No new `.env` variables are needed.

New setups use a flat version-11 journal. Selecting an existing Chiado Safe
inspects it, discovers verified reusable infrastructure and the predeployed
asset, and freezes one deployment plan before the first wallet request. It does
not run earlier setup migrations, create tokens or bridges, approve token funding,
or transfer balances. The owner-connection transaction registers the verifier's
Chiado alias and closes the executor; budget and allowance configuration follow.
Balances may be zero. Obtain tokens and fund either Safe separately.

Saved versions keep their original plan and immutable artifact build. Their
addresses, salt, recorded receipts, signed reviews and pending calldata are never
converted to current creation bytes. Historical funding and private-bridge calls
are reconstructed only for an already-saved plan, using archived artifacts; new
selections cannot enter those paths. The retired bridge wrapper Solidity sources
are no longer compiled. Shared bridge reuse still admits the exact reviewed
historical runtimes and verifies their immutable bindings, sealed peers and wrapped
mint authority. No contract, balance or policy migration is performed.

Keep the selected journal and its archived build when upgrading the UI. Older UIs
reject version 11 and the new payment format; do not downgrade or copy a completed
journal over an unresolved request. Missing wallet responses remain pending until
the exact sender/nonce/calldata is found and its canonical receipt is verified.
A reload never resends the transaction. Source publication and transaction history
continue using their original records. No new `.env` setting is required.

## Requesting more Test USDC

On Chiado, after setup, choose **Get Test USDC**. This control is hidden on Ethereum. Enter a positive amount with up to six
decimals, any recipient address (wallet or Safe), and **Chiado** or **EEZ-X**.
Each delivery adds exactly that amount, regardless of existing balances or prior
requests. There is no wallet cap or cooldown. The submitting wallet pays Chiado
gas; the EEZ-X option locks canonical tokens in the existing shared bridge and
credits its backed representation to the selected EEZ-X address.

To claim for an account without gas, enter that account as the recipient and
connect a different wallet that has test xDAI on Chiado. Only the connected
submitting wallet signs and pays gas. Switching that wallet preserves the draft
amount, recipient and destination; switching back to an unresolved request
restores that request's original locked selection. The recipient never needs gas
to receive these tokens.

The first request has two wallet transactions: **Prepare faucet** creates the
reusable dispenser; after it confirms, **Request Test USDC** sends the selected
amount. Subsequent requests reuse the dispenser. All requests stay outside
treasury setup. Choosing a Safe as recipient funds that Safe without touching
its spending allowance or shared-budget counter.

The immutable shared token still issues fixed 450-token claims to fresh callers.
`TestUSDCFaucet` combines `TestUSDCClaim` allocations as needed and retains excess
for later public requests. It accepts no user deposits and holds no Safe authority.
Failed delivery reverts that request's claims and bridge lock. Very large requests
can exceed the transaction gas limit; request a smaller amount in that case.
This is an explicit test-token facility, not a mainnet minting path.

The call-only fee quote profile requires the one-time deployment to precede an
EEZ-X request. The latter uses a quote bound to the exact call. A canonical
receipt, matching dispenser bindings, delivery event and exact transfer/lock are
required before confirming a new request. Pending work is tracked automatically;
amount, recipient and destination are persisted and locked until resolved.

Before a new, independent request, the client verifies the current dispenser,
token and bridge bindings. It does not require RPC access to receipts for every
previously completed claim or the old dispenser deployment. An unresolved request
still blocks another request until its exact transaction is reconciled; this change
does not clear pending work or rewrite saved history.

The existing wallet-specific journal keeps legacy `faucetClaim` / `faucetMint_*`
calldata and hashes intact. New `faucetPrepare_*` / `faucetRequest_*` entries add
request parameters; older UIs reject these identifiers. Do not downgrade while a
new request is pending. Uncertain wallet responses do not permit a duplicate
send. The token, bridge pair and current treasury remain unchanged.

See the [configurable faucet audit](../audits/2026-10-21-treasury-faucet-amounts/README.md)
for validation, and the [earlier fixed-claim audit](../audits/2026-10-21-treasury-repeatable-faucet/README.md)
for the legacy path.

## Initiating a payment

Select **Start from → Chiado Safe / EEZ-X Safe** independently of the recipient
chain. Review shows the source Safe and funding contributions. Switching source
invalidates approvals. Chiado initiation signs the L1 Safe domain and nonce,
then calls the policy's L1 alias. EEZ authenticates the L1 Safe as its L2 proxy;
the policy debits the same global counter used by local SafeL2 calls. EEZ-X
initiation retains live L1 owner verification through `L1Owners`. Neither route
bypasses the two official allowances or the shared budget.

L1 submission is sent through the L1 Composer. Tracking checks its canonical Safe
success and a unique `L1PaymentAuthorized(nonce + 1, keccak256(calldata))` marker
plus matching payment events in the canonical L2 safe chain. An L1 receipt alone
does not establish the L2 payment. Invalid L1 signatures may fail before reaching
EEZ and be mined as ordinary failed transactions, consuming submitter gas/nonce.

New journals set `bidirectional: true`; older journals keep their original policy
artifact, calldata, signatures and progress. The browser bundle freezes that
artifact in `contracts/legacy/artifacts/TreasuryPolicy.json`. Existing manifests
without `l1Initiation` continue to offer L2 initiation. Existing deployed policies
are immutable: a new policy and explicit allowance configuration are required
for L1 initiation. No active counter, grant or deployment is silently replaced.
Do not open new bidirectional journals in older UI builds: those builds do not
understand the policy selection. Retain this build for pending submissions.

Completed payments unlock the form automatically. Their identity remains in
**Payment history**. Each transaction-style row shows the actual contribution
from each Safe, transactions and blocks on Chiado (Ethereum on mainnet) and
EEZ-X. Expanding a row shows the same connected flow as the payment result:
owner verification → shared budget → parallel funding branches → recipient.
Each branch shows its amount, percentage, and direct or bridged delivery.
Explorer links sit within the relevant nodes. The initiating Safe transaction
remains distinct from settlement when they have different hashes. There is no
separate EEZ-X settlement transaction. Missing or stale settlement index data
withholds optional links; it does not alter payment verification. A shared,
sequential lookup refreshes links for both collapsed history and the diagram.
The connected view hides setup Transaction History but retains its stored
records. **Add an owner** is inside **Shared owners**.

Run `node tests/treasury-view-browser.mjs` for controlled browser checks of
completion/reorg handling, history persistence, transaction links and mobile
layout, and `node --test tests/treasury-settlement.test.mjs` for canonical link
validation. These checks submit no blockchain transactions.

## Moving funds to the mirror Safe

In payment review, select **Move to EEZ-X Safe**, enter an amount, and choose
**Review transfer**. The destination is this treasury's mirror Safe. Approve with
the current Chiado owner quorum, then submit through the existing wallet flow.
The reviewed transfer signs the Chiado Safe's domain and nonce. A move can use
its full token balance; the 100-per-Safe and 150-shared payment limits do not apply.
The UI explains this before signatures are collected. Merchant payments remain
subject to those limits and cannot name either treasury Safe as their recipient.

The source Safe delegates to Safe's verified official MultiSendCallOnly 1.3.0
helper. Its runtime hash is checked before approval and preparation. The batch
resets the token allowance, approves exactly the requested amount, calls the
existing shared bridge for the mirror's address, and clears the allowance.
No Safe, policy, bridge or token is deployed or replaced. No automatic fallback
from a rejected policy payment is performed. This internal transfer currently
supports **Chiado to EEZ-X**; merchant payments still support both directions.

Tracking requires the canonical source transaction, matching Safe execution hash,
exact token lock, and a unique protocol call linking it to the destination mint.
The destination block must be canonically included by the source Chiado block.
Missing or ambiguous evidence stays unresolved. History and the completed flow
show both transaction/block links and the amount received, without claiming a
payment-budget debit. An L1 receipt alone is insufficient.

The new `transfer` intent is stored using the existing pending/history mechanism.
Do not downgrade to a UI that does not understand it while a transfer is pending.
Old completed payments and faucet history remain intact. See the
[recovery validation record](../audits/2026-10-22-treasury-recovery/README.md).

## Before deployment

From the dashboard repository root, set `TREASURY_DEPLOYER_ADDRESS` to the public
address selected in your wallet:

```bash
npm run build:treasury-release
npm run check:treasury-release
npm test
npm run build
node scripts/treasury-network.mjs \
  --dashboard http://127.0.0.1:8080 \
  --owner "$TREASURY_DEPLOYER_ADDRESS"
```

The check reads the dashboard configuration, both chain identities, protocol
proxy/implementation code, rollup IDs, wallet-compatible Composer discovery,
fee settings and the owner's gas balances. It does not deploy, fund, sign or
submit. Its `deploymentVerified: false` result means no application deployment manifest
was supplied or verified. It does not discover all contracts already on these chains. Optional `--output` writes a new report; an existing
report is not overwritten.

Fund the **selected deployment wallet** with test xDAI on both networks.
After setup starts, that wallet is recorded as deployer. Shared bridge
connections are sealed permanently during operator predeployment; the deployment wallet
does not retain authority to re-pair shared bridges. Other owners can sign Safe steps without gas; any funded wallet
can submit a fully approved Safe transaction. The existing dashboard wallet selector and
native bridge are the normal user entry points. Do not import the public isolated fixture keys
or use the running node's posting/proof keys for this task.

The shared node has a different protocol pin from the isolated native tests.
Verify proxy implementation bindings, not only proxy code or a `development`
version label. The observed identities and source comparison are in the audit.
Preserve the existing protocol and deployment settings.

## Predeploy the shared infrastructure once

Use a specifically selected, funded test deployment account. It needs test xDAI
on **both** chains. Keep its key in an owner-only file (`chmod 600`); the CLI does
not load operator `.env` files. Never use a proof-signing or active posting key.
A shared test-workload account also requires its existing workload lock for the
entire operation; coordinate that selection explicitly with the operator.

Prepare read-only, then broadcast the reviewed three-transaction plan:

```bash
node scripts/treasury-infrastructure.mjs \
  --dashboard http://127.0.0.1:8080 \
  --address "$TREASURY_DEPLOYER_ADDRESS"
node scripts/treasury-infrastructure.mjs \
  --dashboard http://127.0.0.1:8080 \
  --key-file "$TREASURY_DEPLOYER_KEY_FILE" --broadcast
```

The default journal is `.runtime/treasury-network-predeployment/state.json`,
separate from browser treasury state. `--state` selects a different explicit
journal. Keep the same journal when resuming. Each exact signed transaction hash
is saved before broadcast; an uncertain response leaves that request pending.
Rerun the same command to track it. The CLI never automatically replaces an
uncertain transaction with a new deployment. A timeout, reverted transaction or
conflicting wallet nonce requires investigating the saved request and canonical
receipts. Preserve the journal; do not delete it and start a second deployment.
The journal's `.lock` prevents concurrent processes; remove a stale lock only
after confirming its recorded process has exited.

Successful completion prints `ready: true` and writes a `.binding.json` next to
the journal with both bridges, both token addresses and canonical registration
identity. The browser discovers that registration without changing runtime
configuration. If verified infrastructure already exists, read-only preparation
reports reuse; no fresh token or bridge is required for another treasury.

## Deploy through the dashboard

Open [the local dashboard](http://127.0.0.1:8080/dashboard/), reveal the treasury
with **Ctrl+Alt+Shift+T** (macOS: **Cmd+Option+Shift+T**), and use its existing
**Connect Wallet** to select the deployment wallet. The hidden example shows **Set up your shared
treasury** when the exact shared network is selected and no manifest is saved.
It checks network references, protocol proxy and implementation code before
allowing setup. Both network fee settings must be enabled. Use the dashboard's
Composer RPC definitions in the selected wallet on both networks. An existing
wallet entry may retain its old RPC when the dashboard adds/switches that chain;
follow the dashboard's Composer status guidance if discovery does not succeed.

Enter your existing Chiado Safe address, then choose **Deploy a mirror Safe** or
**Use an existing Safe** on EEZ-X and click **Start setup**. Ownership consequences
appear beside each choice. Each step shows its calls under a visible heading
explaining their purpose, with limits shown at spending configuration. Review the imported
addresses, owners, thresholds and the explicit EEZ-X owner change before starting. Setup rejects
wrong-chain/non-Safe addresses, unsupported implementations, transaction Guards,
and a contract-owner quorum that the wallet signer cannot satisfy. An EEZ-X
Safe already using `L1Owners` must match the chosen L1 Safe and manager.

For an existing EEZ-X Safe, its old quorum approves one atomic owner-adoption
transaction through Safe's `MultiSendCallOnly`. The Safe address, assets,
existing modules and fallback handler stay in place. Its subsequent ordinary
owner approvals come from the current L1 owner set. Existing modules still retain
their own authority. This is an administrative change, not just importing an
address into the UI.

Use **Approve next deployment step** for ordinary transactions. With an existing
Chiado Safe and no occupied EEZ-X creation addresses, new setup takes **five
transactions**. Safe owner signatures are separate prompts for the two spending
configurations; network switches may also prompt. Token funding is outside setup.

| Transaction | Chain | Work |
| --- | --- | --- |
| 1 | Chiado | Deploy the alias reader and allowance module for the existing Safe, reusing verified Safe infrastructure. |
| 2 | EEZ-X | Create missing infrastructure, owner proxy/adapter, mirror Safe and call-only helper. Reuse the predeployed bridge. |
| 3 | Chiado | Register the owner-verification alias and close the setup executor. |
| 4 | EEZ-X | Reuse or prepare the shared allowance module, deploy the policy, execute the owner-approved spending configuration and close its executor. |
| 5 | Chiado | Execute the owner-approved alias/module/delegate/100-token allowance configuration. |

The browser checks occupied EEZ-X CREATE addresses for the selected wallet's
pending nonce. Up to two required local proxy calls can advance those nonces
without overwriting existing contracts or changing node state; this adds wallet
transactions when necessary. More than two occupied addresses stops preparation.
No transaction count is hardcoded for a particular wallet.

Older saved setups that create an L1 Safe may include a separate implementation
transaction. The existing-Safe path retains its supplied L1 Safe; the current
**Create new Safes** path is described above. Existing EEZ-X Safes that
need owner adoption add one current-quorum Safe transaction and its signatures.
The exact remaining plan is shown after review; no wallet batch extension or
account delegation is required. Creation batches check the 49,152-byte EVM input
bound; ordinary gas estimation and cross-chain fee quoting still precede signing.

Each `TreasuryBootstrap` belongs to the selected deployment wallet and only
executes its calls. It never becomes a Safe owner or module. New setup sends no
tokens to either executor. Only legacy version-6 recovery retains an atomic
funding batch. `SharedTreasuryBridge` uses the same payment implementation and permanently
disables peer administration after pairing. Existing version-4 setups retain
`BootstrapTreasuryBridge` and its wallet admin handoff. Closing an executor permanently disables further batches.

Safe's pinned official deployment catalog is checked against live canonical
bytecode. Chiado supplies its 1.3.0 factory and `MultiSendCallOnly`; the treasury
still uses Safe **1.4.1**, including an implementation already deployed by the
selected wallet. The official factory's proxy runtime and non-indexed creation
event are covered by integration tests. Official 1.4.1 infrastructure is reused
where its exact code is present. The older official allowance deployments are
not substituted for the pinned AllowanceModule 1.0.0. Missing EEZ-X infrastructure
is created inside the selected wallet's deployment batch. This catalog does not enable
Ethereum mainnet as a dashboard treasury target.

Each Safe's module/delegate/100-token allowance is configured in one atomic
`MultiSendCallOnly` transaction with its current owner quorum. The L1 batch also
provisions the policy alias when it has not already been provisioned. An old
partially completed configuration includes only its remaining calls. The UI
lists the calls in each batch; signatures and the submission confirmation are
separate wallet prompts. The screen switches to the appropriate
network. At a Safe step, use **Review Safe step**, then collect **Approve Safe
step** signatures by switching connected owners until its current quorum is met.
Use **Submit approved Safe step** from a funded wallet. Nonce or owner changes
require **Refresh Safe step review** and fresh approvals. Cross-chain steps obtain
a bound Composer fee quote. Gasless signing is separate from funded submission.
**Change setup** is available only before any transaction is pending or confirmed.

The [current release](../../src/lib/treasury/current-build.json) comes from
`npm run build:treasury-release`. Rebuild after contract changes and run
`npm run check:treasury-release`; the Docker frontend build consumes the retained
artifacts and verification inputs without compiling Solidity. Published builds
are immutable. Keep the legacy bundle for saved setups, as described above. The [network profile](../../src/lib/treasury/shared-network.json) contains
public network identities; its old `initialOwner` field is used only to recover
version-1 journals. New setup uses the selected wallet. RPC URLs and fee caps
come from the normal dashboard configuration.

The named transactions implement this application setup sequence:

1. Inspect the supplied Chiado Safe and retain its implementation, owners and
   threshold. New setup has no L1 singleton, factory or Safe creation transaction.
   Reuse verified Safe infrastructure on EEZ-X where available; create and
   initialize a new EEZ-X Safe atomically when requested.
2. Provision the L2 proxy for the L1 Safe, deploy `L1Owners`, provision its L1
   alias, and create a new L2 Safe with the adapter as its sole owner, or collect
   the existing L2 quorum to install it atomically. Reuse a matching adapter.
   The normal payment setup omits the owner-demonstration action contract.
3. Deploy the L1 `TreasuryAliasReader(registry)` and verify the already registered
   Test USDC and sealed bridge pair. The normal payment setup omits the invoice
   merchant; existing private-asset setups retain their original plan.
4. Register the owner verifier's L1 alias and close the Chiado setup executor.
   Do not request token approval or move tokens. Empty Safes can complete setup;
   balances remain available for separate ordinary transfers.
5. Deploy `TreasuryPolicy` with the **alias reader address** as its fourth
   constructor argument. The eight-argument constructor has no merchant argument,
   and the public policy has no invoice entry point. Invoice demonstrations use
   a separate fixture policy only on an isolated devnet.
6. Through normal Safe administration, enable only the official allowance
   modules, add the policy/alias as delegates, and grant each 100 tokens with
   reset interval 10 minutes and reset base 10. Group the remaining calls in one
   Safe batch per chain (the EEZ-X batch shares its transaction with policy creation); no custom contract is a module.
7. Capture contract code hashes, counterpart/manager bindings, both Safe owner
   sets, allowance configuration and chain references. Produce a new treasury
   deployment manifest; do not replace an isolated instance's identity.

After all steps confirm, verification runs automatically, including when resuming
completed setup after a reload. No further wallet approval or open button is needed.
If a check fails, the saved setup is retained; **Retry verification** repeats the
read-only checks without resubmitting transactions. Verification requires the configured owner adapter, deployed code and implementation bindings,
both 100-token allowances and zero spending. Current setup accepts any Safe
balance, including zero. Already funded legacy journals keep their original
funding checks. The resulting manifest is
saved in this browser on this origin. Existing L1 Safes retain their current
quorum. Only resumed legacy journals may still create an L1 Safe. The live treasury then opens automatically.
A different browser does not inherit this deployment record.
The UI transition, reload, failure/retry and cancellation checks run with
`node tests/treasury-setup-completion-browser.mjs`. Its controlled verification
fixture tests the browser lifecycle; it does not broadcast chain transactions.

## Start a new treasury with the same wallet

Keep your wallet connected and use **Start new treasury** below the setup or
live treasury. This returns to **Choose your Safes**. Enter an existing Chiado
Safe and choose **Deploy a mirror Safe** or connect an existing EEZ-X Safe,
then **Start setup**. The same wallet
stays connected; no transaction or signature is requested by the restart button.
Each later deployment still needs its normal wallet approval. Existing
contracts, funds and allowances stay on-chain, including any tokens held by an
unfinished deployment executor. Before any deployment is confirmed, use
**Change setup** to return to these choices.

There is no archived-treasury collection or download step. To use existing
Safes, enter their addresses; setup validates them and requires their current
owner quorum. This starts a new policy setup, not restoration of an old
application manifest or history.

A pending setup request blocks restart, including a missing wallet response.
For a completed treasury, a verified payment/action automatically releases its
saved pending request while retaining payment history; finish an owner change and click
**Done**. The original receipt/settlement checks still decide completion. Restart
and wallet actions share the setup Web Lock across tabs, and stale tabs cannot
sign or submit for a treasury that is no longer selected.

Restart writes an empty active journal in one storage operation. If that write
fails, the current setup remains active. The empty journal selects the chooser
and suppresses legacy fallback; a subsequent reviewed journal selects its own
salt and Safe addresses. An older retained manifest cannot select a different
instance. Previously stored archives and history are left untouched, but are
not read or extended by restart. Keep the restart-aware build or later: older
UI builds lack that selection check and may reopen a retained old manifest.

## Local UI build selection

The local UI was updated with an image-only overlay at
`.runtime/treasury-shared-infrastructure-20261021/ui.compose.yml`, appended after the existing
operator Compose files. No `.env` or network configuration was changed. Keep
that final overlay when operating this build: the existing operator overlay
pins the previous image and overrides `EEZ_UI_IMAGE`. Inspect the running UI's
Compose file list and image before a later restart. The complete deployment-batch
validation is in the [deployment batch audit](../audits/2026-10-20-treasury-deployment-batches/README.md).
The [initial restart record](../audits/2026-10-21-treasury-restart/README.md)
describes the earlier archive implementation. The
[design review record](../audits/2026-10-21-treasury-design/README.md) records the
subsequent simplified chooser and design checks. The
[treasury UX record](../audits/2026-10-21-treasury-ux/README.md) covers contextual
setup, the payment layout and the preceding local UI deployment.
The current chooser explains EEZ’s dynamic L1 owner verification below
**Choose your Safes**, above both network choices. It removes the earlier bold
owner callout and redundant instruction below the form; the existing-Safe
approval note and pending transaction statuses remain visible. The production
build, desktop/mobile visual checks, and read-only setup/recovery browser check
passed. No contract or native E2E tests were rerun for this presentation-only
change. Local screenshots and deployment checks are in
`.runtime/treasury-owner-explanation-20261021/`. The preceding chooser checks are
in `.runtime/treasury-shared-owners-20261021/`, and the earlier UX diagnostics
remain in `.runtime/treasury-ux-20261021/`.
The subsequent emphasis update highlights “both Safes stay in sync automatically.”
inside that explanation. Its production build and desktop/mobile visual checks
passed; local evidence is in `.runtime/treasury-sync-highlight-20261021/`.
The current button is **Start setup**. The label update passed the production
build and read-only setup browser check; local evidence is in
`.runtime/treasury-start-setup-20261021/`.
The **Setup details** disclosure has since been removed. The production build
and read-only desktop/mobile setup browser check passed, including saved
progress and pending-request recovery. Local evidence is in
`.runtime/treasury-remove-setup-details-20261021/`.
The earlier automatic transaction discovery and then-collapsed manual recovery
control are validated in the [tracking record](../audits/2026-10-21-treasury-tracking/README.md).
The earlier tracking build and browser evidence are in
`.runtime/treasury-auto-tracking-20261021/`. The shared-infrastructure refresh is
recorded in the [shared infrastructure audit](../audits/2026-10-21-treasury-shared-infrastructure/README.md).
The setup cleanup labels the Safe implementation deployment explicitly and removes
manual recovery controls and the duplicate confirmation paragraph. Its production
build and read-only desktop/mobile browser checks passed, including automatic
hash discovery and reload persistence. Local-only evidence is retained in
`.runtime/treasury-setup-cleanup-20261021/`.
Setup and faucet transaction links now open the configured chain block explorer
in a new tab. The incorrect setup destination was reproduced before the fix;
the production build and read-only browser checks of both L1 and L2 destinations
passed afterward. Local-only evidence is in
`.runtime/treasury-explorer-links-20261021/`.

## Recovery and configuration

The dashboard fee helper must match the deployed Composer’s 64 KiB calldata
profile. The budget deployment plus approved Safe configuration carries about
32 KiB; the older 12 KiB helper rejected it as `Invalid calldata` before asking
the wallet to submit. After updating the UI, reload the same origin and retry
**Submit approved Safe step**. The saved setup and owner approvals are retained;
current-owner and nonce checks still apply. No new treasury or additional setup
transaction is needed. See the [calldata regression record](../audits/2026-10-21-treasury-calldata/README.md).

Progress is saved before each wallet request and updated after an exact matching,
successful canonical receipt and the step’s contract checks. Setup does not wait
for the `safe` checkpoint. The receipt block is checked again after validation;
new completions retain their block number and hash. Keep this browser's local
storage and origin throughout setup. A reload resumes confirmation; it never
silently repeats a deployment. Web Locks serialize wallet requests, receipt
reconciliation and recovery across tabs. A rejected wallet prompt clears only
that unsent request.

Returned transaction hashes are checked automatically every four seconds,
including after reload. If a wallet response is missing or a transaction is sped
up, setup also searches the latest 512 canonical blocks for the saved sender and
nonce. Historical account nonces narrow the search to one block; an unchanged
head hash reuses the previous lookup. Recheck that head before accepting a lookup. A discovered hash is saved before the existing
canonical receipt and deployment checks run. It does not itself complete a step.

The setup UI’s **Transaction History** lists all recorded setup transactions,
oldest first, with their action, chain, block, time and chain-specific explorer
link. It stays available after setup and reload. `Included` means inclusion on
the source chain; `Finalized` requires that chain’s observed finalized head.
Finality is displayed in the background and does not block setup. Missing or
reorganized receipts show `Rechecking`; RPC failures show `Unavailable`. There
is no manual hash-entry form or separate confirmation paragraph. If a missing hash is older
than the search window or the RPC cannot provide the required history, the request
remains pending for diagnosis. Discovery requires the original sender, nonce,
recipient, calldata and zero value. A cancellation, different transaction, or
on-chain revert does not advance setup. Discovery never sends a transaction or clears a pending request.
Before later Safe approvals, wallet submissions or setup completion, the UI
rechecks completed receipts. Missing, failed, moved or unavailable inclusions
block that action without clearing progress or resending. Safe configuration
and final setup checks use current canonical state. Payment settlement
verification remains separate from setup inclusion.

Existing version-2 through version-8 journals remain compatible. Journals without
inclusion metadata are checked against their current canonical receipts. Older
UI builds can read the journal and retain its optional metadata but may restore
the safe-checkpoint delay. The [inclusion and history record](../audits/2026-10-21-treasury-inclusion-history/README.md)
describes the checks and their limits.
Preserve the saved request and transaction record for diagnosis; do not delete
storage to bypass a pending or reverted step. Changing the profile or artifacts
mid-setup also requires reviewing the existing deployment first. In particular,
a pruned L1 checkpoint must be replaced only after verifying network continuity
and preserving/migrating any existing journal and manifest.

Active version-1 fixed-A journals first migrate to version 2 without changing
their deployer, salt, pending request or completed history. Version-2 plans then
upgrade automatically to version 3 once no wallet request or Safe review is
outstanding. A saved review keeps its original transaction until completed;
no collected signature is repurposed. Pending transactions keep their exact
calldata and receipt recovery. A previous policy constructor is recognized only
by its pinned initcode hash and exact canonical CREATE receipt.

Before replacing an old plan, the UI archives its original journal under the
network deployment key with suffix `:before-simplification:<salt>`. A storage
failure stops the replacement. Version 3 records the retained original prefix
and verified official infrastructure. Confirmed addresses, hashes, wallet and
salt stay unchanged; completed calls are never batched again. Older manifests
and fully completed setups remain readable. Keep this UI version while a
version-3 setup is active: an older build cannot interpret the reduced plan.
There is one active setup per network in this browser.

Version 4 additionally groups contract creation. Early version-2/3 journals
upgrade only with no outstanding wallet request or Safe review; their original
journal is archived under `:before-deployment-batches:<salt>` before replacement.
The complete prior plan is retained as a frozen source for the completed prefix.
The first wallet-address check also archives the prior version-4 journal under
`:before-wallet-preparation:<salt>` before adding any necessary proxy calls.
These calls use the selected wallet and require its explicit transaction approval.
New addresses are recorded only after the exact canonical batch receipt, creation
and execution events, expected code, executor owner/sequence and allowance state
are checked. Reconciliation verifies the bridged wrapped token before advancing.
Use this build while version 4 is active; older builds cannot interpret it.

An older setup that already created its test token continues on its existing
plan, because its wallet-owned token and bridge administration cannot silently
be transferred into a new executor. Fully completed manifests remain usable.
Earlier confirmed phases remain in place. If a grouped transaction reverts,
none of the deployments or calls within that transaction count as complete; keep the exact saved request for diagnosis and do not restart setup.


A shared `TreasuryConfig` uses `environment: "dashboard-testnet"`, the exact
normal dashboard RPC URLs, and `fees.maxTotalWei` equal to its L2 fee cap. L1 may
use `checkpoint: { number, hash }` for a retained finalized block instead of a
`genesis` field. A failed checkpoint read fails closed; refreshing an expired
reference requires checking it against the same intended network. Payment
bindings include both protocol implementation slots/code hashes, the deployed
`aliasReaderL1` and its code hash, and asset label
`Test USDC`. Omit both `invoiceMerchant` and `invoiceControl` on this network.

Transaction ownership/status (`eez_getCrossChainTransaction`) uses `l2.front`,
the Composer endpoint. Receipt, block and contract reads use `l2.rpc`; the regular
chain RPC does not expose Composer methods. A status lookup failure keeps a
submission unresolved. Reload the updated UI on the same origin to resume
verification of a saved submission; do not clear its storage or resend it.

The Safe configuration service lists Chiado, but that does not prove a newly
deployed Safe 1.4.1 is indexed or recognized by the hosted app. The canonical
1.4.1 singleton and factory queried during inspection had no code on this
Chiado deployment. Validate Safe-app support before publishing its link. The
dashboard's ordinary L1 owner administration does not require a Safe service.

## Owner and payment rehearsal after deployment

Use the dashboard's existing **Connect Wallet**, and reveal the hidden treasury
example with **Ctrl+Alt+Shift+T**. On the connected treasury:

1. For new Safes, verify the deployment wallet is the only L1 owner and threshold
   is 1. For reused Safes, verify the retained owner set and threshold. Complete
   a payment with that quorum and check canonical settlement. Owner-demo actions
   are available only in older or isolated setups that include their fixture.
2. In the **Add an owner** card, enter the **New owner address**. Keep the
   existing owner connected. **Required approvals** defaults to the current
   threshold; review the address and resulting threshold before approving.
3. Switch to L1 and collect approvals from the current L1 quorum. Submit the
   ordinary Safe owner change and wait for canonical confirmation. The new
   owner cannot approve its own initial addition.
4. Return to EEZ-X. With threshold 1, the new owner can approve a payment alone;
   otherwise collect the required quorum. The dashboard reads the current L1 owners.
5. Use **Amount (USDC)**, **Recipient chain** and **Use available funds** in the payment form. Pay 40 on EEZ-X; then split 110 to Chiado (100 Chiado + 10 EEZ-X); reject another 1
   on EEZ-X while its allowance still has 50 available. Wait for natural budget
   reset before paying 30 to Chiado and splitting 110 to EEZ-X (10 Chiado + 100 EEZ-X).
6. Inspect history and reload to verify recovery. Unknown submissions remain
   locked; missing receipts or diagnostics do not authorize a second send.

Owner changes also advance on verified canonical L1 inclusion, without waiting
for the `safe` checkpoint. Verification checks the saved transaction, successful
Safe execution event, resulting owners and threshold, then rechecks the receipt
and its canonical block. The card reports **Owner change included** and keeps
checking until **Done**; missing, moved or unavailable observations keep the
saved request unresolved. A reverted transaction is shown as a failure. Inclusion
is not finality. Existing saved owner submissions remain compatible; reload the
same dashboard origin to resume them without another submission.

To inspect the mirror, read `SafeL2.getOwners()` and `getThreshold()` on EEZ-X:
the expected result is the `L1Owners` adapter as sole owner, with threshold 1.
Read the adapter's `safeL1()` binding on EEZ-X, then that Safe's `getOwners()` and
`getThreshold()` through the L1 RPC for the human signers and approval quorum.
The **Shared owners** card uses those L1 reads for its wallet list and
**Approval threshold** (for example, **2 of 3 owners**). Payment approvals are a
separate count. The card refreshes after a verified owner addition and polls for
changes made through the Safe app. If reads fail, the last verified list stays
visible with a retry message. Reorganization of an observed addition triggers a
fresh read, and owner/threshold changes invalidate any unsubmitted payment review
and signatures. During an L2 transaction,
the adapter uses EEZ's synchronous call to the L1 Safe's `checkSignatures`.
There is no copied human-owner list on L2.

The wallet pays actual network fees separately from Safe test-token transfers.
The fee quote must bind to the exact transaction; unavailable pricing stops the
send. This first shared-network rehearsal does not use the isolated fixture's
invoice-closing endpoint or claim a deterministic L1 rollback demonstration.


<a id="enable-either-safe-on-an-existing-treasury"></a>
<a id="enable-custom-splits-on-an-existing-treasury"></a>

## Payment split on a new treasury

Fresh setup deploys `TreasuryPolicy`; no separate activation or upgrade is
needed. In **Review a payment**, set the amount and recipient chain, then move
**Payment split** to choose each Safe's contribution. Review the exact USDC
amounts before signing. **Use available funds** restores destination-first
allocation within observed capacities.

The slider signs exact token amounts, so 100 + 10 remains exact even though its
percentages are rounded for display. It supports all-Chiado, all-EEZ-X and mixed
funding, independently of the initiating Safe and recipient chain. An unavailable
selected contribution rejects the payment instead of silently rebalancing it.

The dashboard no longer starts or executes policy handovers. Historical journals
and receipts remain available without modifying their signed requests. An old
policy does not gain `paySplit` by updating the UI; use a fresh treasury setup for
the current demo. Saved setup plans retain their reviewed bytecode.

If an earlier handover is already unresolved, retain the previous dashboard
build to finish it. Do not clear its journal or resend uncertain transactions.
Existing guards keep that treasury's actions blocked until its replacement
manifest is verified. This removal does not undo any on-chain allowance changes.
The historical [policy-upgrade audit](../audits/2026-10-21-treasury-policy-upgrade/README.md)
records that retired flow; it is not a current setup procedure.
