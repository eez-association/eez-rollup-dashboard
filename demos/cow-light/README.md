# EEZ cross-chain CoW Light demo

This directory is the complete, minimal demo stack. It is deliberately
separate from the dashboard's monitor and treasury applications:

```text
deployment/   idempotent deployment helpers and manifests
contracts/    route contracts, Chiado-only liquidity bootstrap, local tests
backend/      quote API, signed-order queue and settlement status API
solver/       restart-safe inventory-free GPv2 solver
ui/            static wallet UI
config/       L1 Uniswap-V2 token catalog (no secrets)
runtime/      generated queue/logs (gitignored)
```

The solver submits one standard GPv2 settlement to the L2 Composer. Its
pre-interactions transfer the user's L2 WETH to the route, call the canonical
L2→L1 proxy, swap on the configured L1 Uniswap-V2 pair, bridge the purchased
token back and let GPv2 pay the deterministic L2 wrapper. The solver has no
token inventory. The L2 token may have no code before settlement.

## Run locally

### Docker Compose

The default Compose stack runs the API alongside the dashboard. It connects the dashboard to `http://cow-api:8787`
on the internal Docker network; no API or solver ports are published.
The API receives only the public configuration variables listed in the Compose
file, not the whole `.env` or a signing key.

Select a `COW_DEPLOYMENT_ENV` profile or set `COW_NETWORK=mainnet` (or `chiado`)
in the root `.env`, keeping the dashboard's RPC/bridge settings for that same
network. An explicit `COW_NETWORK` overrides the profile; without either, the
standalone default is mainnet. Shared RPC endpoints
must be reachable from containers: use service names or `host.docker.internal`
for host services, not `localhost`. `COW_PUBLIC_L1_RPC` and
`COW_PUBLIC_L2_FRONT` must instead be reachable from the user's browser.

```bash
docker compose up -d --build
docker compose logs cow-api
```

Docker creates the `cow-runtime` named volume automatically, with ownership
for the image's non-root user. It stores deployment manifests, signed-order
queues and logs across container recreation. No host `demos/cow-light/runtime`
directory or UID/GID configuration is needed for a fresh Docker installation.
Back up this volume; `docker compose down -v` deletes it.

Paths inside demo configuration are **container paths**, relative to `/app`
when not absolute, for example `runtime/mainnet/cow-deployment.json`.
Existing host runtime files are not imported automatically. Before switching
from a host process, stop its API and worker and import its records once:

```bash
# Run before starting the container services; do not overwrite an active queue.
tar -C demos/cow-light/runtime -cf - . | \\
  docker compose run --rm -T --no-deps cow-api \\
  tar --no-same-owner -xf - -C /app/runtime
```

External snapshots/catalogs must also be copied into the volume and configured
using their container paths. Do not point two workers at the same queue.

The API can start without deployment manifests, but trading validation fails
closed until valid manifests for the existing contracts are installed. Missing
records do not mean contracts need redeploying. Starting this API alone does
not simulate or execute orders: it can queue signed orders once deployment
checks pass, and those orders may execute when a worker is subsequently enabled.

The solver is a separate service under the **`cow-solver` profile**, off by
default. Enable it only after validating the deployment and solver authorization:

1. Supply the existing CoW and route manifests under `runtime/<network>/`.
2. Build route ABI artifacts with `forge build --root demos/cow-light/contracts`.
   This compiles locally; it does not deploy contracts.
3. Set `COW_UPSTREAM_ARTIFACTS_DIR` to a host directory containing the upstream
   `GPv2Settlement.json` ABI. `COW_ROUTE_ARTIFACTS_DIR` defaults to
   `./demos/cow-light/contracts/out`.
4. Set `SOLVER_PRIVATE_KEY=0x...` in the root `.env`. Compose passes it only to
   `cow-solver`, never the API or dashboard. Keep `.env` out of git and restrict
   its permissions (`chmod 600 .env`). Docker administrators can inspect container
   environment values, and rendered Compose configuration includes this secret;
   do not paste unfiltered `docker compose config` or inspection output.
5. Review `COW_SOLVER_MAX_FEE_WEI` (default `5000000000000000`) and ensure the
   authorized solver has gas funds. Enabling this service executes queued orders.

```bash
docker compose --profile cow-solver up -d --build cow-api cow-solver
```

The image contains no deployment journals, runtime queues, environment files,
keys or contract build output. Solver artifacts are read-only mounts.
Both services run as a non-root UID with a read-only container filesystem.
The API health check checks HTTP availability, not on-chain deployment readiness.
For the existing mainnet deployment, the signed-order Composer simulation and
confirmation of operational solver access remain prerequisites for activation.

File-based signing remains supported by the worker. To use it instead, leave
`SOLVER_PRIVATE_KEY` empty and add a private Compose override:

```yaml
services:
  cow-solver:
    environment:
      SOLVER_KEY_FILE: /run/secrets/cow-solver
    secrets:
      - cow-solver
secrets:
  cow-solver:
    file: /absolute/path/to/solver.key
```

The file contains `SOLVER_PRIVATE_KEY=0x...` and must be readable by the
container user (UID 1000). No key file is required for environment-based signing.

### Without Docker

```bash
cd demos/cow-light
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a; . .env; set +a
mkdir -p runtime
python3 backend/server.py                 # UI/API on :8787
python3 solver/worker.py                  # separate process
```

Open `http://127.0.0.1:8787/`. The browser only signs the EIP-712 order;
settlement is performed by the worker.

For a local dashboard, set `EEZ_UI_COW_UPSTREAM=http://127.0.0.1:8787`
when starting Vite. The API can use the existing network's remote RPCs; no
local blockchain is required. With network/bridge settings but no CoW token
or settlement bindings, the API stays available for health checks and returns
`deployment_required` for trading and token requests. Supply verified CoW and
route manifests for that exact network before enabling the solver; running
the API alone does not make swaps operational.

Set `EEZ_UI_RUNTIME_CONFIG` to the same runtime JSON used by Vite to share its
RPCs, Composer endpoints, registry, manager, bridges, rollup ID and explorers
with the CoW API, solver and deployment tools. Relative paths resolve from the
dashboard repository root. For example, a local `COW_ENV_FILE` can contain:

```dotenv
EEZ_UI_RUNTIME_CONFIG=.runtime/eez-dev.json
COW_DEPLOYMENT_ENV=config/deployments/eez-dev-699169-r2.json
```

The network-specific CoW profile contains application bindings and paths;
shared dashboard addresses do not need to be copied into it. Restart the CoW
processes after editing the shared runtime file. Explicit environment overrides
remain supported. Deployment manifests retain the identity observed on chain
and reject mismatches; they do not choose the active network.

The verified EEZ-X deployment and restore instructions are documented in
[`deployment/EEZ-dev-r2.md`](deployment/EEZ-dev-r2.md).

The dashboard provides a native React swap form in its hidden **CoW Light Demo** tab. Press
**Ctrl+Alt+Shift+T** (**Cmd+Option+Shift+T** on macOS) outside a text field to
reveal both Treasury and CoW Light tabs; press again to hide them. Configure
the dashboard's `EEZ_UI_COW_UPSTREAM` to reach this API. Its chain IDs must match
the dashboard before trading opens. The tab reuses the dashboard's selected
wallet, network configuration, design tokens, explorer links and execution
inspector. It talks to the same API and solver as the standalone developer UI;
it does not load that page in an iframe or create another wallet connection.
Its primary action advances from connection through quote, exact-amount
approval and signing. Changing accounts invalidates the quote; ambiguous
submissions are retained locally and reconciled against the order queue without
automatically posting another order. Activity is filtered to the connected
wallet and labels the signed minimum separately from actual settlement output.
The visual liquidity browser uses compact token rows beside the swap form: search
token symbols, names or addresses and select a token row.
The list and receive selector share one selection; changing it clears the quote.
Pair addresses are omitted. Rows show a compact catalog WETH reserve; pools
below 0.01 WETH are excluded from both the list and receive selector. Missing
reserve data is labeled unknown and is not treated as zero. These are catalog
snapshots, not live liquidity readings.
Each token also shows **Bridged**, **Not bridged**, **Checking…**, or
**Unavailable**, based on the canonical L2 wrapper lookup. Deployed wrappers
are detected directly through the official bridge registry, without predicting
future wrapper addresses. Failed reads are never shown as unbridged.
The catalog checks at most three tokens concurrently and refreshes after each
completed round; the same status is retained while filtering the list.

**Your swaps** reuses the Treasury payment-history layout: newest-first rows,
outcome counts and filters, refresh, transaction/block links and expandable
rollup → L1 liquidity → rollup details. The most recent order opens by default.
The output amount shown is explicitly the signed minimum; the API does not
currently report measured trade output. A submitted transaction remains pending
until the solver records canonical settlement evidence.

### Mainnet sell asset

The swap form shows compact, read-only max gas price and priority fee text only
during L2 approval/wrap transactions. Rates are refreshed before each wallet submission,
and the displayed values are the exact fee fields passed to the wallet. Failed
fee reads block sending. Swap order signing costs no gas; solver settlement
costs are separate and are not represented by these wallet fee rates.

This route sells **bridged Ethereum WETH** on the L2 (`WETH_L2`), which must
match the official bridge's wrapper for `WETH_L1`. Start with WETH on Ethereum
(wrap ETH there if necessary), then bridge that ERC20 token to the rollup.
The route bridges it back to Ethereum for the V2 pool swap.

`NATIVE_WETH_L2` is a separate locally wrapped native-ETH token. Bridging native
ETH and wrapping it on the L2 does not produce this route's sell asset. The
dashboard labels the mainnet sell asset **Bridged WETH**, explains the
distinction and hides native wrapping unless its configured contract equals
the configured sell token. Supporting native L2 WETH would require an explicit
conversion route and separate validation; the current route is unchanged.

### Get test tokens on Chiado

The Chiado tab labels its sell asset **ctWETH** and provides **Get test tokens**.
First select **Switch to Chiado** and approve the network switch in your wallet;
this step does not submit a faucet transaction. The dashboard verifies the
wallet's active Composer RPC before enabling **Get test tokens**. Click that
button separately to confirm one Chiado faucet transaction. A network is added
only if the wallet reports it missing. Progress distinguishes RPC checks, fee
preparation, wallet confirmation and bridge delivery; **Switch back** returns
to the rollup only when clicked. The wallet needs Chiado native currency for
the claim transaction's gas. The funded
faucet bridges **0.01 ctWETH + 0.0002 native tokens** to the same address on
the configured rollup, using its official bridge. Requests have a 24-hour
per-wallet cooldown. The faucet distributes existing test supply; it cannot
mint tokens, has no server signing key and is never offered on mainnet.

The selected CoW profile supplies `COW_FAUCET_L1`; an explicit environment
override is also supported. The read-only faucet API checks
its token, bridge and rollup against the active deployment before advertising
amounts, inventory or eligibility. Pending wallet requests and transaction
hashes are kept per network and account across reloads. The UI checks a
canonical successful Chiado receipt with the expected `Claimed` event, then
waits to observe the requested increase in both destination balances. This
does not assert consensus finality. Spending from another app while delivery
is being checked can delay that balance observation.

Operators can deploy for another configured Chiado rollup with
`python deployment/deploy_faucet.py` using the same environment and protected
deployer key as other deployment commands, after building the contracts.
The script funds 0.5 ctWETH and 0.01 native tokens (50 requests), writes durable
transaction journals beside `COW_MANIFEST`, and safely resumes recorded
transactions. It never automatically refills the public faucet. To refill,
explicitly transfer existing ctWETH and native test currency on Chiado to its
address. The public ROG record is `deployment/records/rog-916969-r4-faucet.json`.

## Settlement status and recovery

The worker durably saves the signed transaction hash before broadcast, then
reconciles that same hash on subsequent passes. A successful L2 execution
receipt only reaches `awaiting_settlement`. `settled` requires a matching
canonical indexed L2 block and a successful L1 posting receipt in the current
L1 block. This is canonical inclusion, not consensus finality.

Timeouts, missing index data and RPC outages leave the submission pending;
they do not fail the order or trigger a new transaction. Restarting the worker
continues checking the saved hash, including after the signed order expires.
An explicit Composer rejection or a revert in a canonically settled block
marks the order failed. Ambiguous submissions that never reach Composer need
operator inspection; the worker intentionally does not create replacement
transactions automatically, including fee/nonce replacements. Historical orders
marked settled by the old receipt-only solver are rechecked using their saved
transaction hashes before being presented as canonically settled.
Before broadcast, a recognized payout/slippage revert plus a lower fresh pool
quote keeps the same signed order queued. Composer's matching diagnostic option
supplies the actual revert when the public option only says unsupported transaction.
The worker rebuilds clearing prices, calldata and fee quotes on each attempt;
it checks the signed order owner and GPv2 fill/invalidation state first.
Retries use 5/10/20/40/60-second backoff, capped at eight retries. Simulation
availability and fee-preparation errors also use this bounded pre-send policy.
An output below the signed minimum waits at 60-second intervals until recovery
or the signed expiry, without sending. Delayed orders do not block other orders.
Unknown execution reverts remain terminal; a recorded transaction hash always
takes the reconciliation path and is never cleared for an automatic retry.

This improves recovery from stale quotes; exact execution can still fail when
prices move after simulation. Automatic replacement after a terminal submitted
transaction or rejected bundle remains outside this change. Live ROG evidence
for a deliberately stale first quote followed by successful settlement is in
`deployment/records/rog-916969-r4-solver-retry.json`. No contracts changed.

## Network profiles

Every Python entry point uses `network_config.py`. Select `COW_NETWORK=mainnet`
(the default, preserving the original Ethereum/EEZ addresses) or
`COW_NETWORK=chiado` (Chiado 10200 / the configured EEZ deployment). Public defaults live in
`config/networks/<name>.json`; another network can use another JSON profile.
Chain IDs identify EVM networks; `L2_ROLLUP_ID` is the bridge's destination
rollup ID and is distinct from the L2 chain ID. L1 remains bridge rollup 0.

Precedence is profile, then the selected GPv2 deployment manifest, then explicit
environment overrides. The solver queries `vaultRelayer()` on that settlement.
All relative paths resolve from this demo directory, including artifact paths.
The API and solver check RPC chain IDs before use; deployment tools check the
chains they use. Catalogs require `chainId` and `weth` matching the selected L1.
Manifests must match the selected chain, and a route cannot reference a different
settlement. Restart services after changing configuration or deploying contracts.

Queues, logs and manifests default to `runtime/<name>/`. `ORDER_QUEUE`,
`SOLVER_LOG`, `COW_MANIFEST` and `ROUTE_MANIFEST` can override those paths; never
point different networks at the same files. Existing mainnet runtime files are
not moved automatically: copy them into `runtime/mainnet/` while services are
stopped, or explicitly set their old paths. Browser activity is also scoped by
network, chain IDs and settlement; old unscoped browser history is not imported.

The generic Chiado profile is a configuration scaffold. The ROG 916969
deployment has completed a live cross-chain swap (see its deployment record).
For another EEZ testnet, copy
`.env.chiado.example` to `.env` and fill its RPCs and infrastructure addresses.
Use the reusable Chiado bootstrap below to deploy test assets and a funded
Uniswap V2 pool and generate a catalog, or configure an existing test deployment
in `config/token-catalog.chiado.json` (the same token entry format as the mainnet
catalog). Deploy GPv2 first, then the route. To
derive wrappers before their first bridge, configure `COW_WRAPPER_EXPLORER_API`
with the active L2's Blockscout API v2 base URL, for example
`https://rollup.example/explorer/api/v2`. The official bridge must already have
registered the configured `WETH_L2` wrapper. Existing wrappers and bridge-status
badges do not need explorer access. Chiado never inherits mainnet addresses or
token liquidity.

Wrapper prediction no longer calls `debug_traceTransaction` or uses
`WRAPPER_REFERENCE_TX` / `WRAPPER_PREFIX_LEN`. The API reads the reference WETH
wrapper from the official bridge and fetches its creation and runtime bytecode
from Blockscout. Before using it, the API verifies the reported runtime against
live code, the constructor metadata and bridge argument, the CREATE2 address,
and that the creation-code prefix is embedded in the current bridge code (or its
EIP-1967 implementation). These checks fail closed for incompatible bridge builds,
incorrect explorer data, missing wrappers, and unavailable RPC/explorer reads.
This validates the prediction input; it does not constitute source verification
or a contract audit.

Validation reads are pinned to one L2 block. The validated prefix is cached in
memory and reused only while the wrapper metadata/runtime and bridge runtime /
implementation code remain unchanged. An upgrade triggers revalidation; a
reference wrapper built with an older incompatible implementation is rejected.
Selected-token metadata is read from L1, never silently substituted from catalog
labels. Restart the API after setting the explorer URL. The solver does not
derive wrappers through this API path; it uses the signed order's buy-token
address and checks existing canonical registrations before settlement.

The Chiado profile discovers its L2 chain ID with `eth_chainId` from `L2_RPC`;
it does not assume a particular EEZ testnet ID. An explicit `L2_CHAIN_ID` pins
the expected identity instead. Discovery failures stop startup. Existing
manifests are checked against the discovered identity, not used to choose it.
The L2 Composer must report the same chain ID as the read RPC before use.

To share configuration with the dashboard, export its environment before
starting the demo. The loader accepts `EEZ_UI_L1_RPC_UPSTREAM`,
`EEZ_UI_L2_RPC_UPSTREAM`, `EEZ_UI_L2_FRONT_UPSTREAM`, and
`EEZ_UI_L1_EXPLORER_URL` / `EEZ_UI_L2_EXPLORER_URL`. Bridge and manager settings
reuse `EEZ_L1_BRIDGE_SENDER`, `EEZ_L2_BRIDGE_RECEIVER`, `EEZL2_ADDRESS`,
and `EEZ_ROLLUP_ID`. Non-empty demo-specific
settings override these; no environment files are implicitly read or executed.
Use endpoints reachable from the process: a Docker-only hostname is not
automatically translated when running Python on the host.

Alternatively, select the shared `.env` explicitly, without sourcing it:

```bash
COW_NETWORK=chiado COW_ENV_FILE=/absolute/path/to/dashboard/.env \
  COW_DEPLOYMENT_ENV=/absolute/path/to/current-deployment/environment.json \
  python3 backend/server.py
```

Use the same settings for the solver and deployment commands. `COW_ENV_FILE`
reads only allowlisted public network/configuration values, not signing keys.
It accepts literal values and quotes/comments, but rejects shell expansion
instead of executing it. Export signing keys and process controls separately.
Non-empty exported variables override values in the file. Explicit demo-specific
settings override shared aliases; shared settings now override saved deployment
snapshots. Thus a snapshot cannot silently retain an old bridge or rollup ID
when the shared environment changes. Chiado has no default rollup ID.

With `EEZ_UI_RUNTIME_CONFIG`, browser-facing RPC routes are taken from the
dashboard's `browser.l1RpcUrl` and `browser.l2FrontUrl`; backend connections use
its `proxy` endpoints. Without that file, set `COW_PUBLIC_L1_RPC` and
`COW_PUBLIC_L2_FRONT` when the backend uses private or container RPCs. Public
endpoints can be HTTP(S) URLs or paths relative to the dashboard origin.
These only change the endpoints advertised by `/api/config`; backend
reads and solver submissions keep using the internal upstreams. Do not put
credentials in public endpoint URLs. Wallet approval is limited to the current
quote's sell amount.

The current rollup-4 ROG deployment is recorded in
[`deployment/records/rog-916969-r4.json`](deployment/records/rog-916969-r4.json),
with a portable configuration in `config/deployments/rog-916969-r4.json` and
operations notes in [`deployment/ROG-r4.md`](deployment/ROG-r4.md).

New GPv2 and route manifests retain the L2 genesis and their infrastructure/token
bindings. The API checks these before providing trading configuration, quotes,
or accepting orders; the solver checks them before processing orders. Missing
identity, a reset with the same chain ID, changed bindings, or missing code
blocks trading. The dashboard displays a deployment-required state. Old
manifests without identity are intentionally not trusted; do not add the new
genesis to an old manifest to bypass the check. Use a fresh deployment directory
and queue after a reset. The checked-in `rog-916969.json` remains a historical
snapshot pinned to its original genesis, not a configuration for the current ROG.

Discovery identifies the chain, not its contracts. Bridge, manager, token and
pool addresses still require configuration and validation for that deployment.
Never reuse an old manifest or queue for a replacement chain: select fresh
runtime paths when changing deployments. The original mainnet profile retains
its pinned chain IDs and addresses for compatibility.

To run both demos, launch each API and worker with its own environment and
distinct `PORT` values (for example API 8787/8788 and worker 8791/8792).
`PORT` applies to the process being started, so don't set one shared port for
the API and worker. Both use the same code and separate profile state.

## Deployment

### Reusable Chiado assets and liquidity

`deployment/bootstrap_chiado.py` reuses the configured bridge pair; it never
deploys or modifies EEZ infrastructure. It creates a pinned Uniswap V2 factory,
two fixed-supply test ERC20s (`ctWETH` and `ctUSD`), and a real V2 pair with
1,000 / 100,000 tokens of initial liquidity. These tokens have no real value;
ctWETH is **not** redeemable for native currency. The deployer receives the LP
tokens and another 1,000 / 100,000 test tokens. One token of each asset is
retained by the setup contract for canonical bridging to the deployer's L2
address, initializing both wrappers. Supply cannot be increased.

From this demo directory, install `requirements.txt` in a virtual environment,
export the intended dashboard environment, and run:

```bash
npm ci --prefix contracts --ignore-scripts
forge build --root contracts
export COW_NETWORK=chiado
# Read-only infrastructure check. No private key is required.
python3 deployment/bootstrap_chiado.py --deployment rog-916969
# Only when ready to spend testnet gas and deploy:
# Provide DEPLOYER_PRIVATE_KEY through a protected environment, not a tracked file.
python3 deployment/bootstrap_chiado.py --deployment rog-916969 --execute
```

The bootstrap reads the registry, bridge/manager settings and L1 Composer from
the shared dashboard runtime JSON. The existing `EEZ_REGISTRY_ADDRESS` and
`EEZ_UI_L1_FRONT_UPSTREAM` environment settings remain supported. It verifies
chain IDs, code presence, reciprocal
bridge peers, and manager/rollup bindings before execution. Both the script
and custom token/liquidity constructors refuse Ethereum mainnet; the constructors
only allow Chiado chain ID 10200. The script is intentionally Chiado-only, not
a general-purpose production token or AMM deployer.

Records live under `runtime/chiado/deployments/<name>/`. Use a new name for each
EEZ deployment. The manifest binds L1/L2 chain IDs, an available finalized L1
checkpoint and the L2 genesis hash, registry,
manager and bridge code identities (including EIP-1967 implementations), build
artifacts, deployer, and transaction hashes. Reruns recheck the saved L1 block;
if it has been pruned, use an archive-capable RPC rather than deleting the binding.
Keep these ignored runtime records
in your deployment backups; the reusable scripts and contracts are versioned.
Do not delete the journal to retry an interrupted deployment.

Every transaction hash is fsynced before broadcast. Reruns reconcile that hash
and require canonical, finalized L1 receipts; they do not re-seed liquidity or
submit replacement transactions. A run may stop while awaiting finalization:
rerun the identical command later. If broadcast was interrupted or a transaction
reverted, inspect it manually; the bootstrap intentionally will not guess a new
nonce or retry with another signed transaction. Run one bootstrap at a time per
deployer; file locking only protects the same deployment directory.
Chiado submissions use EIP-1559 with a 1 gwei minimum priority fee because the
RPC can quote only its tiny base fee. The maximum fee is twice the current base
fee plus the priority fee, capped at 5 gwei; exceeding the cap stops execution.
Each step checks the wallet can cover its full gas limit at that maximum fee.
Cross-chain bridge calls additionally require `eez_quoteFee` from the L1
Composer. The bootstrap validates the quote's exact transaction hash binding,
chain, nonce, gas limit, expiry, fee cap and available balance, then signs its
quoted fee fields unchanged. There is no fallback to an unquoted bridge call:
ordinary L1 priority pricing may not cover EEZ's settlement tariff.

After both wrapper addresses exist in safe L2 state, the script writes the
token catalog and a non-secret `environment.json`. All existing demo Python
entry points can load that file:

```bash
export COW_DEPLOYMENT_ENV=runtime/chiado/deployments/rog-916969/environment.json
```

Keep the shared RPC environment exported. The generated file provides token
bindings and separate queue, log, catalog and GPv2 / route manifest paths.
Bridge, manager and chain settings continue to come from the shared dashboard
configuration. Explicit demo-specific environment variables override it;
unset stale values before selecting another deployment. Rerun the read-only
bootstrap check before reuse after a network reset or protocol upgrade.
GPv2 and the route/helper are **not** deployed by the asset bootstrap; continue
with the steps below, supplying `DETERMINISTIC_FACTORY_L1` and CoW artifacts.
The V2 factory is not the deterministic CREATE2 deployment factory.

For the existing ROG 916969 asset deployment, a public, non-secret configuration
is also checked in as `config/deployments/rog-916969.json`; select it with
`COW_DEPLOYMENT_ENV=config/deployments/rog-916969.json` to reuse the tokens/pool
without running the bootstrap. GPv2 and route addresses are loaded from the
selected deployment's separate runtime manifests. Never use it for another EEZ
network. The generic `chiado` profile remains free of deployment-specific assets.
Addresses, receipt hashes, verification results and the zero-transaction rerun
check are recorded in `deployment/records/rog-916969.json`. This is a historical
deployment record, including a successful 0.001 ctWETH →
0.099699900599199102 ctUSD swap with canonical L1 posting evidence. It does
not assert consensus finality or establish production readiness. The GPv2,
route/helper and proxy addresses are recorded there; local deployment manifests
remain under the selected runtime directory.

Source verification remains required before using the deployment. Run
`python3 deployment/verify_chiado.py --deployment rog-916969 --submit` to submit
the factory, liquidity setup, tokens and pair using their exact artifact metadata
and hash-checked sources. Run again without `--submit` to check results.
If the compiler verifier rejects an independently exact-matched deployment, use
`--submit --via-sourcify` to request Blockscout's Sourcify import instead. Supply
`L1_RPC` (or its shared dashboard setting) to discover nested creations from
canonical receipts before bootstrap completion and compare explorer bytecode to
live code. Inputs
and submission records are retained in the deployment directory; queued or partial
verification is not success. Wrapper source verification is separate. This tooling
checks full, address-specific Blockscout verification against live L1 bytecode
before initializing wrappers, and stops at this gate until verification succeeds.
Sourcify exact matches are useful independent evidence, but do not bypass this
explorer-publication gate. This tooling
does not constitute a security audit. Local
tests use a synchronous bridge adapter and do not prove live Composer behavior;
a controlled testnet rehearsal is still required.
When verifying bridge-created wrappers, use the bridge build's exact compiler
settings, including its remappings. A separately built WrappedToken artifact can
have identical executable code but different metadata; that is not an exact match.

### Mainnet: configure existing assets and liquidity

For Ledger deployments from a workstation with a separate server-side solver, follow
[the Ledger runbook](deployment/LEDGER.md). It covers signer selection, device
confirmation, quote expiry, manager ownership, and runtime-record transfer.

Read-only profile audit (does not load signing keys or submit transactions):

```bash
python3 deployment/validate_mainnet.py --output mainnet-validation.json
# Add --solver 0x... to verify the intended public solver address is allowlisted.
```

The command writes its evidence and exits nonzero if any required check fails.

The 2026-10-29 audit found the saved chain IDs, Composer, contract code, bridge
peers/rollup/manager, canonical WETH wrapper and all 100 catalog pools/decimals
consistent with live reads. Full deployment validation remains blocked by missing
local mainnet CoW/route manifests and an unspecified intended solver address.
The public mainnet CoW config path returned dashboard HTML, not a CoW API.
These checks do not establish contract security, support for unusual token
transfer behavior, or production readiness. Public observations are saved in
`deployment/records/mainnet-validation-2026-10-29.json`.

Do not run the Chiado bootstrap. Use `.env.example` and the mainnet profile to
configure and validate existing tokens, their canonical wrappers, bridge pair,
and funded Uniswap V2 pairs in the catalog. No test tokens are minted and no
liquidity is seeded. Reuse compatible GPv2 and route/helper deployments where
available; those demo-specific contracts may otherwise need separately reviewed
deployment. The following scripts are separate from the test asset bootstrap.

1. Set RPCs, Composer fronts, chain IDs, rollup ID, bridge/manager/settlement
   addresses and `DEPLOYER_PRIVATE_KEY` in a protected environment.
2. Build the two route contracts with Foundry (`forge build --root
   contracts`).
3. Deploy GPv2 authentication and settlement using externally supplied CoW Swap
   artifacts: `COWSWAP_ARTIFACTS=/path/to/artifacts
   python3 deployment/deploy_cow.py`. The script writes
   `runtime/<name>/cow-deployment.json`. Use the same artifact directory for
   the solver. The deployment currently allowlists the deployer as solver,
   so use that account for the worker or configure the authenticator separately.
4. Run `python3 deployment/deploy_route.py`; it reads the selected settlement
   and writes `runtime/<name>/route-deployment.json`.
5. Verify every newly deployed address on the configured Blockscout verifier
   before using it. Verification is a deployment gate, not an optional
   follow-up.

The route consists of exactly two contracts: `L2UniversalV2Route` on L2 and
`L1UniversalV2BridgeHelper` on L1. The same contracts serve every catalog token.

The route script reuses a completed manifest and checks its configuration.
The GPv2 script refuses to overwrite an existing manifest. Both scripts record
each signed transaction hash durably before broadcast, lock their journal, and
bind it to the L2 genesis, deployer, configuration and contract bytecode.
Rerun an interrupted deployment with the same configuration to reconcile its
recorded transactions; no ambiguous submission is automatically replaced.
Pure L2 deployments require successful canonical L2 receipts. The cross-chain
helper deployment additionally requires canonical L1 posting evidence.
The helper authorizes the L1 manager's proxy for the L2 route, not the route's
L2 address. The manager is resolved from the configured L1 bridge.

Cross-chain deployment and solver sends use fresh, transaction-bound
`eez_quoteFee` responses after fixing gas and nonce. Diagnostic quotes are not
used as signing authority, and there is no unquoted fallback. Total fee budgets
are configured by `COW_DEPLOY_MAX_FEE_WEI` and `COW_SOLVER_MAX_FEE_WEI`
(default 5000000000000000 wei each). Review these explicitly for another
network. Source verification remains required before running a swap.

For systemd, copy `solver/eez-cow-solver.service`, replace `/opt/eez-cow-light`
with this directory, and provide `SOLVER_KEY_FILE` through a protected
EnvironmentFile. Do not put a secret in this repository.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --test tests/ui-network.test.cjs
python3 -m py_compile network_config.py settlement_state.py backend/server.py solver/*.py deployment/*.py
forge build --root contracts
# Install pinned upstream contract artifacts for the local EVM tests:
npm ci --prefix contracts --ignore-scripts
forge test --root contracts -vv
```

`contracts/test/SettlementSlippage.t.sol` characterizes the existing pricing
policy without changing the solver. It deploys the published GPv2 settlement
bytecode from `@cowprotocol/contracts@1.8.0`, a real Uniswap V2 factory/pair from
`@uniswap/v2-core@1.0.1`, and both demo route contracts. Test-only ERC20s and a
synchronous bridge adapter keep the test entirely local; it does not validate
Composer execution, real bridging, or the bytecode of an existing deployment.

Using raw token units, a signed minimum of 97 and a solver quote of 100 are
followed by another trader's V2 swap, reducing the available output to 99.
The route accepts 99, but GPv2's 100-unit payout reverts for insufficient
balance. The test asserts the exact payout error and rollback of user funds,
AMM reserves and order-fill state. Controls verify unchanged-price success,
route-only acceptance of 99, success after re-quoting at 99, and rejection
below the signed minimum. All five tests are expected to pass: the failure
case deliberately asserts the current limitation, rather than fixing it.

The deployment scripts are network tools and are not run as part of the web
build. Use canonical Composer and RPC endpoints when validating a settlement;
an execution-RPC receipt alone is not L1-finality.
