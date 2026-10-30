# EEZ Rollup UI

The self-contained cross-chain CoW Light demo lives in
[`demos/cow-light`](demos/cow-light/README.md). It keeps deployment, the
wallet UI, the signed-order API, and the inventory-free Composer solver
separate from the main dashboard and does not include runtime state or keys.

Standalone Docker-first web interface for an EEZ rollup network. This repository
contains the UI, read-only telemetry and trace services, treasury application
contracts, deployment tooling and demo documentation. Pinned protocol contracts
are a dependency; the node and Kurtosis topology remain in the rollup repository.

The source baseline is the earlier
[`eez-association/sync-rollups-poc`](https://github.com/eez-association/sync-rollups-poc)
UI, adapted to the current EEZ RPC and contract interfaces.

The application preserves the original sync-rollups POC screens:

- Dashboard and generic cross-chain calls
- Counter demo
- Bidirectional native-asset/ERC-20 bridge (xDAI on Chiado/Gnosis, ETH on Ethereum)
- Nested flash loan
- Aggregator
- Network monitor (heads, blobs, commitments, and settlement correlations)
- Execution visualizer
- Quote debugger with direct simulation and verified contract decoding

The top navigation is **Dashboard → Monitor → Visualizer → Debug**. The read-only
[network monitor](src/monitor/README.md) lives at `/monitor/` (legacy `#/monitor`
links still open it) and shares
the dashboard layout, header, footer, and theme. The monitor page mounts inside
the React application, with no embedded page. Its API-only Python collector runs
as an internal Compose service, reached through `/monitor/` on the same origin,
including live WebSockets.

**Debug** opens at `/dashboard/#/debug` (or `#/debug` under a custom build base).
Enter the source chain, sender, target, calldata and value in wei, then choose
**Simulate fee quote**. Gas and nonce are optional; numeric fields accept decimal
or hex. The dashboard sends one unsigned `eez_debugQuoteFee` request with
`{"trace":"calls"}` to that chain's configured Composer front and opens the
result directly. Legacy, EIP-1559 or both formats are available. This does not
sign or broadcast a transaction and requires no wallet. Cancel stops the browser
request; it does not guarantee an already-running Composer calculation stops.

Saved JSON results can still be imported or pasted locally. The nested L1/L2 call
tree has separate runs for gas probes and validation. A failure summary links
recorded failed frames and the last child of a failed frame, without asserting
that child caused the failure. Returned calls rolled back by ancestors are
marked separately. Truncation identifies shortened fields and omitted calls/runs.
A [recorded nested-revert example](public/quote-trace/examples/nested-revert.json)
is included for trying the viewer.

The dashboard embeds the same versioned viewer as RollupX in a sandbox without
access to the parent page or its storage. Its content policy blocks network
connections. A private MessageChannel connects it to the same-origin dashboard.
The dashboard fetches verified ABIs from the configured L1/L2 Blockscout APIs
using only chain and observed code address, then decodes names, arguments,
return values and custom errors locally. Delegate calls use their captured code
address, not an explorer's current proxy implementation. Imports are not uploaded;
only metadata lookups send their contract addresses. Explorer failures, foreign
chains, failed RPC chain-ID discovery, unverified contracts and incomplete bytes
keep raw data visible. Wallet development defaults do not select an explorer.
Explorer verification is not a historical bytecode match for this simulation.
Assets are bundled locally; there is no runtime CDN dependency.
The [source record](public/quote-trace/SOURCE.md) pins their upstream revision.
The small sync script prevents the two repositories' viewers from diverging.

```bash
COMPOSER_RPC='https://YOUR_HOST/composer/l2'
TX='{"from":"0x1111111111111111111111111111111111111111","to":"0x2222222222222222222222222222222222222222","data":"0x","value":"0x0"}'
cast rpc --rpc-url "$COMPOSER_RPC" eez_debugQuoteFee "$TX" \
  '{"transactionTypes":["0x2"],"trace":"calls"}' > quote-trace.json
```

Use `/composer/l1` for an L1 source. Request `"0x0"` for legacy transactions,
or omit `transactionTypes` to simulate both formats. Capture requires a
Composer with RollupX PR #97; older versions reject the trace option.
The dashboard can be upgraded before Composer and still import saved traces.
No fee opt-in, contract, node or protocol change is needed for the form and ABI
decoding. Publish the dashboard and bundled viewer assets together: older viewer
assets do not support the private channel. Rolling back removes direct quoting
and decoding without affecting chain state. Operational error-envelope traces
also need the updated Composer support described in the pinned viewer README.

Imports are limited to 8 MiB. Truncated execution is marked explicitly.
Metadata reads are limited to four concurrent requests and 128 distinct code
addresses per selected run, with an eight-second timeout and 1 MiB response cap.
Changing runs/imports or leaving Debug cancels obsolete work. Quote responses
are limited to 8 MiB with a two-minute browser timeout; form calldata to 128 KiB.
Unknown custom errors retain their raw selectors. Source maps, executed source
lines and ABI uploads are outside this version. Traces describe simulations, not mined transactions.
Revisiting Debug starts a fresh import; trace contents are not persisted.

Run `npm test` and `npm run test:debug` to validate decoding and the built dashboard
in Chromium, including direct quotes, metadata, cancellation and local imports.
Set `EEZ_UI_BASE_PATH=/` to also check a root deployment. The test mocks the
dashboard's RPCs and never broadcasts; `EEZ_TEST_LOG_DIR` can point to a RollupX
tracing process run to additionally import all its `quote-traces/*.json` exports.

Dashboard combines asset transfers on the left with proxy creation and cross-chain calls
on the right, followed by shared transaction history. Smaller screens stack
Bridge above the proxy workflow. Saved `#/bridge` links open this combined view;
gas settings are collapsed by default and contain the estimate and editable gas
limit. Pending transactions and their confirmations appear in a dismissible
popup; closing pending status does not stop receipt polling. Proxy selection
and call preparation share a panel, while bridge recipients default to the
connected wallet with an optional address editor. Transaction history supports
All, Bridge, and Calls filters, including previously saved bridge records.

Cross-Chain Calls supports L1 → L2 and L2 → L1, including contract and EOA
destinations. Selecting a proxy switches the connected wallet to its source
network; a rejected switch preserves the current selection. Existing L1 proxy
mappings remain in `crossChainProxies`, with L2 proxies stored separately in
`crossChainProxiesL2`. These browser-saved mappings are checked against the
source manager's computed proxy address and `eth_getCode` when selected and
before sending. Confirmed mismatches or missing code clear stale mappings;
RPC errors retain saved data but prevent unverified selection or submission.
Contract names and ABIs come from the destination explorer.
Detected proxies can be saved explicitly. To import an existing proxy, select
its source network and paste the proxy address; the source manager's
`authorizedProxies` registry supplies its destination automatically. The lookup
checks the destination network, computed proxy address, and deployed code before
preparing a call. Invalid addresses or failed lookups prevent call preparation;
older lookup responses cannot replace a newer input. Saving remains explicit
and verifies the mapping and deployed code without sending a transaction.
Removing a saved row only clears
its browser entry; removing the selected proxy also clears the call form.
The saved-proxy table pairs the origin-network logo with its proxy address,
then an arrow separates the destination-network logo and destination address.
Row actions follow; mobile rows stack the two pairs with a downward arrow.
Prepare Call shows both network names and shortened source/destination addresses,
with full addresses available in tooltips, explorer links, and clipboard copies.
Recent addresses reflow within the form rather than overlapping call preparation.
Raw calls accept empty calldata (`0x`) and an optional native-currency value.
Calls use the source Composer's gas estimate or an explicit manual limit, and
poll the source chain for confirmation. Gas settings are collapsed by default;
estimation errors remain visible and prevent submission. Proxy creation and calls show wallet
signing, pending status, confirmation, and errors in the same popup as Bridge.
Closing pending status keeps polling active; the final result reopens the popup
and stays visible until dismissed. The ABI editor has a fixed size.

Counter Demo uses the same responsive two-column layout: the counter is on the
left and cross-chain call preparation is on the right. Choose the counter's
network to deploy or select a SimpleCounter on L1 or L2; calls originate on the
opposite network. Counter addresses are saved independently (`counterAddress`
for the existing L2 cache, `counterAddressL1` for L1). Counts and read functions
use the deployment chain's read RPC. Direct deployments and increments estimate
and confirm on that chain; deployment estimates omit `to`, and reverted receipts
are shown as failures. Proxy calls use the source Composer's raw gas estimate,
the selected wallet, and the shared collapsed gas controls and transaction popup.
Missing source proxies can be created from the demo; existing proxies are
verified before use. Cross-chain history records the actual call direction.

The experimental **Treasury Demo**, **CoW Light Demo** and **Falcon Safe Demo** are hidden from the normal dashboard. Press
**Ctrl+Alt+Shift+T** (or **Cmd+Option+Shift+T** on macOS), outside an editable field,
to reveal the tabs beside Counter Demo and open Treasury. Falcon follows CoW Light. Press the same shortcut again
to hide all three; any open hidden demo returns to Counter Demo. Visibility is kept in
`sessionStorage` for this browser tab's session and survives reloads. A fresh
session starts hidden; `#/treasury-demo`, `#/cow-demo` and `#/falcon-demo` do not enable the tabs. This is a
navigation preference, not access control: anyone who knows the shortcut can
open the example, and its code ships with the application.

[Falcon Safe](docs/runbooks/falcon-safe-demo.md) integrates browser Falcon-512 signing,
encrypted key backups/storage, L2 verification and L1 Safe control. It reuses the
header wallet and compact fee SDK. Its cryptography loads only when the tab opens;
leaving the tab clears the unlocked key. Contract actions require the pinned
916969/Chiado deployment; browser signing works on other dashboard networks too.

CoW Light uses the native dashboard tab and the API in `demos/cow-light`, proxied through
`/dashboard/cowdemo/`. Run its API and solver for the dashboard's network;
`EEZ_UI_COW_UPSTREAM` selects the API upstream (Vite defaults to
`http://127.0.0.1:8787`; Compose defaults to `http://cow-api:8787`).
The default Compose stack starts the API on its internal network. The tab checks both chain IDs before opening the trading UI and
shows an unavailable state if the API is not running. This proxy does not
start the API, deploy contracts, or expose the solver's control endpoint.

`docker compose up -d --build` includes the `cow-api` service and automatically
creates its persistent `cow-runtime` volume. The solver stays disabled unless
its `cow-solver` profile is enabled.
See [CoW Docker setup](demos/cow-light/README.md#docker-compose) for runtime
storage, configuration and solver activation.

The dashboard deploys and operates only the current paired-contract release.
Both Ethereum and Chiado use the same `PairedTreasuryPolicy` setup engine. It
connects an existing L1 Safe to a new or existing `L1Owners` mirror, deploys one
policy on each chain, grants each local policy 100 tokens per ten minutes, and
activates the pair in the final Safe batch. L2 counts the shared 150-token budget
once. Local contributions transfer first, then the authenticated peer contributes.
Normal bridge submissions use L1 while signatures retain the initiating Safe's
domain and nonce. Ethereum uses its existing Circle USDC and normal bridges.

Before each of the final two setup submissions, four parallel RPC reads check
the pinned protocol implementation on each chain and the latest recorded setup
block hash on each chain. A failed check preserves the journal and collected
approvals without opening wallet confirmation. These checks run once per
submission attempt, not while collecting owner signatures; they supplement the
existing simulation and final deployment validation.

On **Chiado 10200 / EEZ-X 699069**, configure the normal bridges and an existing
`treasuryTokenAddress` in the local runtime configuration. The configured
`TestUSDC` and its normal-bridge wrapped representation must already exist.
The user supplies an existing L1 Safe and creates or reuses its L2 mirror;
the six Safe setup steps neither deploy the token nor require a faucet claim.

After setup, **Get USDC from faucet** appears beside each Safe only when the
configured token matches the current `TestUSDC` bytecode and bridge bindings.
It is hidden for ordinary tokens and Ethereum-mainnet configurations. Clicking
the L1 button calls `claim(safeL1)`; the L2 button calls `claimOnL2(safeL2)` through
the normal bridge. Each sends exactly **1,000 test tokens**, with a normal wallet
confirmation and gas paid on Chiado. Each Safe has its own claim journal and pending button. The other faucet and
payment controls remain usable; wallet requests are sequenced to avoid reusing
an L1 nonce. Both claims remain recoverable after reload. No separate faucet screen is part of setup.

The contribution slider includes **25%**, **50%**, and **75%** presets for the
EEZ-X share. They preserve the exact total, use the same balance/allowance checks
as the slider, and lock when the payment is reviewed.

Setup retains its progress bar, chain and spending-limit context, current owner
list, approval badges, Safe nonce, wallet/gas guidance and transaction history.
The final step distinguishes L2 signatures from L1 submission and reports
validation, gas estimation and Composer quoting before the wallet opens.
**Change setup** is available before the first submission. **Start new treasury**
archives the selected journal and verification requests before returning to the
chooser; pending deployments, payments, owner changes or claims prevent restart.

Source publication counts full explorer verification separately from exact
Sourcify matches and partial explorer matches. Verification-only supplemental
factory inputs live under `verification/supplemental/`, identified by their
content hashes and recompiled in integration checks. They do not change the
active deployment release or reinterpret saved setup journals.

The current testnet profile pins the public dashboard's chain checkpoints,
protocol implementations and normal bridge bytecode. A zero bridge counterpart
override means the same bridge address on the other chain, matching the normal
bridge implementation. Policies validate that effective counterpart during
construction and activation; payments do not repeat those setup checks.

Deployment and claim requests are saved before the wallet sends. Reloading keeps
unresolved requests locked and verifies their exact transaction identity before
advancing. L2 claims require canonical normal-bridge incoming-call evidence and
the exact 1,000-token mint. Mainnet and testnet setups use separate, asset-bound
paired journals. Legacy journals are neither resumed nor overwritten, legacy
manifests cannot open signing controls, and historical artifact bundles remain
verification evidence only. The old Chiado infrastructure deployer is retired.

The [contract project](contracts/README.md) documents `PairedTreasuryPolicy`,
`L1Owners`, `TreasuryBootstrap`, and the fixed `TestUSDC` faucet. The current release
also contains the standard Safe/AllowanceModule dependencies, `Bridge`, and
`WrappedToken`. Run `npm run test:contracts` after initializing the submodules.
`node tests/integration/treasury-paired-setup.mjs` exercises genuine packaged
planner batches, both Safe approval batches, activation and all four payment
routes on an isolated Anvil EVM with read-through managers. It does not prove
native EEZ relay or rollback behavior. The native `--ui` fixture remains gated
pending migration; older runbooks and audit records describe historical flows.

`npm run test:treasury:browser` drives all six setup steps through sandboxed
Chromium with real planner calldata, contracts and Safe owner signatures. It
checks wallet cancellation and reloads every pending step before confirming it.
Its final L1 alias request is verified but executed directly on logical L2 in
the single-EVM fixture; native transport and settlement need the native suite.

Transaction history uses network logos for the route, labels transaction links
“L1 tx:” and “L2 tx:”, and shows linked L1/L2 blocks in their own column.
L2 source transactions link to their canonical L1 settlement batch (labeled
“Settlement”). L1 source transactions link to matching L2 incoming call events
within canonical settled blocks. Repeated call hashes with ambiguous origins or
destinations stay unresolved; missing counterparts are retried every 15 seconds.
Settlement index queries use the L2 Composer endpoint (`l2ProxyRpc`), while
standard receipt, block, and event reads keep using the chain's read RPC.
History shows receipt and counterpart lookup errors explicitly and preserves the
source transaction link. Failures retry automatically; valid responses clear the
error, and a valid empty index still shows “not indexed yet.” Execution
inspection, live batches, and settlement progress use the same Composer routing.

The top bar shows the deployment name and horizontal network balances beside
the wallet control. Wallet controls and the provider picker use locally served
Rabby and MetaMask logos. Block counters are omitted. On narrow screens, balances
and the compact wallet button share a row below the brand and navigation menu.
Selecting a network also switches the bridge direction after the wallet confirms
the switch; ERC-20 addresses are kept unchanged. Chiado/Gnosis deployments use
xDAI for the native asset on both chains.

Set `EEZ_UI_NETWORK_NAME` in `.env` to the rollup's display name (for example,
`EEZ-X Devnet`). Runtime `networkName` supplies the bridge's L2 labels and the
network name used when adding L2 to a wallet. The bridge shows the amount sent;
gas is paid separately. Saved wallet networks may retain their
previous name and RPC; cross-chain transactions use `/composer/l1` or
`/composer/l2` for their source network.

The wallet menu checks Composer discovery through the selected wallet's
`eth_call` provider. It calls the virtual address
`0x7Ae2c80116976915a0Ee9b7994e7Bb12026087f8` using
`composerInfo(bytes32 nonce)` (`0x98da5085`) at `latest`. Every probe uses a fresh
cryptographic nonce to avoid identical-parameter wallet caches. Responses must
match the `keccak256("EEZ_COMPOSER_DISCOVERY")` marker, schema version `1`, the
nonce, the wallet chain ID, the dashboard's L1/L2 pair, and configured contract
addresses. The `info` bytes contain the existing `eez_composerInfo` JSON; optional
contract bindings are compared when advertised. Chain IDs are checked before
and after the call. Requests time out after eight seconds, and results from
previous wallet/account/network selections cannot replace the current result.

Discovery is current Composer process metadata, independent of chain state.
Updated Composers accept valid block selectors even when the wallet resolves
`latest` to a block number (as MetaMask does). Older latest-only Composers can
reject that wallet rewrite; changing the fee format does not fix discovery.

Detection runs after connection/reconnection and account/network changes,
when the page becomes visible or regains focus, and every 30 seconds while
visible. Successful detection shows only the status, network, and manual
Recheck in the wallet menu. When setup is needed, an amber notice explains
empty responses or deployment mismatches; failed verification uses error
styling. These notices provide the source Composer URL to copy and manual
wallet RPC configuration guidance. For
Rabby, it lists the Settings → Modify RPC URL steps, the current network and
chain ID, and how to save, enable, and recheck the Composer URL. Ethereum
mainnet instructions explicitly select Integrated Network → Ethereum (chain
ID 1); the URL always comes from this deployment's runtime configuration.
MetaMask instructions follow its [official RPC setup guide](https://support.metamask.io/configure/networks/how-to-add-a-custom-network-rpc#adding-or-editing-rpc-urls):
open Networks, edit the current network, add the Composer URL with a nickname,
select it as the default RPC, save, and Recheck. Mobile navigation and the
Ethereum Mainnet entry (chain ID 1) are identified explicitly.
An empty `0x` means **Composer not detected**; request errors mean **Unable to verify RPC**.
Wallets on other networks are asked to select a dashboard network.
Detection is advisory: it does not change saved wallet RPCs, block transactions,
or alter gas/fee/submission behavior. It observes only the wallet read route;
it cannot authenticate an endpoint or guarantee the wallet's simulation or
submission route. In particular, Rabby's mainnet simulation can use its own
backend independently of the configured Composer RPC.

L1 labels and logos are detected from `eth_chainId`: Ethereum, Gnosis, Chiado,
or Sepolia. Labels do not append “L1.” Override the display name or logo with
`EEZ_UI_L1_NETWORK_NAME` and `EEZ_UI_L1_NETWORK_LOGO_URL` (runtime
`l1NetworkName` / `l1NetworkLogoUrl`). Unknown chains get a neutral icon and
chain ID. These display settings do not change RPCs or transaction routing.

ERC20 bridging supports a searchable token picker alongside manual address
entry. “Known” includes a small Ethereum mainnet catalog of common contract
metadata verified against the [Uniswap default token list](https://github.com/Uniswap/default-token-list).
It is filtered by the source chain; those addresses are never offered on Chiado
or an EEZ rollup. Configure `EEZ_UI_TOKEN_LIST_URL` (runtime `tokenListUrl`) with
a CORS-enabled list in the standard `{ "tokens": [{ "chainId", "address",
"name", "symbol", "decimals" }] }` format to supply deployment-specific tokens.
Use the actual wrapped-token addresses for L2.

“Your tokens” uses the source explorer's Blockscout v2 token-balances API when
available. Set `EEZ_UI_L1_EXPLORER_API_URL` (runtime `l1ExplorerApiUrl`) for L1;
L2 reuses `EEZ_UI_L2_EXPLORER_API_URL`. Without a working indexer, it checks
balances of up to 24 known/recent tokens through the source read RPC, so it
cannot discover every token. Discovery runs only when the picker opens; failures
leave address entry available. “Recent” is stored per source chain; older records
without a chain ID are not offered. Selection still runs the bridge's on-chain
metadata, balance, approval, and gas checks. A token appearing in the list does
not guarantee that the deployed bridge supports it.

One root `.env` and Compose project configure all four services; the monitor reuses
`EEZ_UI_L1_RPC_UPSTREAM`, `EEZ_UI_L2_RPC_UPSTREAM`, registry, rollup ID, and explorer
settings. Configure `EEZ_L1_WS_URL` and `EEZ_L2_WS_URL` for immediate node-head
updates; without them, the collector uses HTTP head polling. Settlement and
finality details reconcile separately without delaying live heads. Optional
Beacon, Blobscan, and settlement-policy settings are in `.env.example`.

Feature availability depends on the contracts deployed by the target network.
Bridge requires its configured contracts. Counter Demo deploys its own counters
and uses the configured source managers for cross-chain proxies. Flash-loan and
aggregator components remain in the source but are not enabled in navigation.
Transactions require a connected browser wallet such as Rabby or MetaMask.

## Deployment architecture

The application uses four containers in one Compose project:

- `ui` serves the single React application and proxies requests through nginx.
- `monitor` runs the Python telemetry collector and API on the internal network.
  It has no published port or separate frontend.
- `trace-decoder` runs the Node.js read-only decoder API on the internal network.
  The React transaction detail view reaches it through the UI proxy.
- `verification` publishes exact treasury contract sources from retained builds.
  It shares the UI's network namespace and uses a persistent job volume; nginx
  exposes its bounded API without another public port. See the
  [source-verification runbook](docs/runbooks/treasury-shared-network.md#automatic-contract-source-verification).

Keep these services separate for production. Their dependencies, health checks,
logs, and restart lifecycles remain independent. A collector restart temporarily
interrupts monitoring while the dashboard and visualizer remain available.
The services reuse the root `.env` and runtime configuration and deploy with one `docker compose up -d --build`
command. The existing gateway provides the public HTTPS endpoint.

## Docker Compose

Copy the environment template and point the four upstream values at the network:

```bash
cp .env.example .env
docker compose up --build -d
```

The UI is served at <http://127.0.0.1:8080/dashboard/> by default. Browser RPC requests use
same-origin `/rpc/*` and `/composer/*` routes; nginx proxies those requests to the
configured upstreams, avoiding browser CORS and mixed-content problems.

The Compose defaults target the public-forwarder ports used by the local EEZ
development network. On Linux, `host.docker.internal` is mapped automatically to
the Docker host.

## Independent deployment behind a gateway

The default Compose file publishes the UI on `127.0.0.1:8080`, keeping it
reachable only through the Docker host. Configure `EEZ_UI_BIND` and
`EEZ_UI_PORT` in `.env` if needed. No shared Docker network or override file
is required. Start the UI from this repository with:

```bash
docker compose up -d --build
```

On Linux, a gateway using host networking can proxy to `127.0.0.1:8080` while
the UI retains its own Compose network. The gateway's upstream must match
EEZ_UI_PORT. Each project starts and stops independently. With the UI stopped,
the gateway stays up but UI requests receive an upstream error.

If migrating from the earlier optional shared-network setup, remove
COMPOSE_FILE and EEZ_UI_PUBLIC_NETWORK from your .env and shell environment.
To intentionally expose the UI directly on other interfaces, set
`EEZ_UI_BIND=0.0.0.0`; the default localhost binding is suitable for the gateway.

### Host-loopback RPCs

When the target node binds its RPC and Composer ports to the Docker host's
`127.0.0.1` (as in a host-network Chiado node), set
`COMPOSE_FILE=docker-compose.yml:docker-compose.host-rpc.yml` in this repository's
`.env` and use `http://127.0.0.1:<port>` for the four upstream URLs. Run the usual
`docker compose up -d --build`. This overlay places the services in the
host network: the UI listens at `127.0.0.1:8080`, the monitor at
`127.0.0.1:18080`, treasury verification at `127.0.0.1:18081`, and the trace API at
`127.0.0.1:18082`. They can then reach the node's loopback RPCs.

### Single-domain path gateway

The default image uses `EEZ_UI_BASE_PATH=/dashboard/`. For a gateway that
publishes the UI at `/dashboard/` and the monitor at `/monitor/`, use a
distinct `EEZ_UI_IMAGE` tag for a reviewed build. Set
`EEZ_UI_BASE_PATH=/` explicitly when rebuilding for an existing root-path
hostname deployment. The gateway strips `/dashboard` before proxying to the
UI and preserves `/monitor`. Its `/monitor/api/*` requests reach the Python
collector through this UI's Nginx proxy. The UI's runtime configuration is
fetched through `/dashboard/config.json`; network RPC and Composer routes stay
at `/rpc/*` and `/composer/*` on the same public hostname.

```bash
docker build -t eez-rollup-ui:dashboard-paths .
```

Set `EEZ_UI_IMAGE=eez-rollup-ui:dashboard-paths` in the private `.env` when
selecting this image for Compose. Keep the existing image tag for rollback.

Set the desired explorer and Composer URLs in the private environment before
cutover. Validate the built image at loopback, including the `/monitor/` page,
dashboard assets, runtime config, and monitor WebSocket. Changing the build
argument requires a new image; recreating a running UI is a separate operation.

## Build and run the image directly

```bash
docker build -t eez-rollup-ui:local .
docker run --rm -p 8080:8080 \
  --add-host host.docker.internal:host-gateway \
  -e EEZ_UI_L1_RPC_UPSTREAM=http://host.docker.internal:19545 \
  -e EEZ_UI_L2_RPC_UPSTREAM=http://host.docker.internal:19546 \
  -e EEZ_UI_L1_FRONT_UPSTREAM=http://host.docker.internal:19547 \
  -e EEZ_UI_L2_FRONT_UPSTREAM=http://host.docker.internal:19548 \
  eez-rollup-ui:local
```

The UI image alone provides Dashboard and the existing block inspector. Use the
root Compose project for Monitor and cross-chain transaction details; it also
starts the Python collector and Node.js trace API.

All contract addresses can be supplied as environment variables listed in
`.env.example`. The container also supports the Kurtosis artifact mounts
`/out/deployments.env` and `/demo/demo.env`.

The browser reads `config.json` for runtime addresses and optional demo contract addresses.
It does not request the legacy `/shared/rollup.env` or `/shared/faucet.key` files.

## Kurtosis integration

The rollup repository's `testing/kurtosis/start.sh` builds this checkout by
default when both repositories are siblings:

```text
Development/
├── eez-rollup0-fork/
└── eez-rollup-ui/
```

Override its location with `EEZ_UI_REPO=/path/to/eez-rollup-ui`. To consume a
prebuilt image, set `EEZ_SKIP_UI_BUILD=1` and configure `eez.ui_image` in the
Kurtosis arguments file.

## Local Vite development

Use the Node version in `.nvmrc` (also pinned in both Node Docker stages and
used by CI). With nvm installed, run `nvm install` and `nvm use` from this
repository before installing dependencies. Keep these pins aligned when applying
Node security updates; rebuilding both the UI and verification images is required
to update an existing deployment.

With a Kurtosis enclave running:

```bash
KURTOSIS_ENCLAVE=eez-engineer-dev bash scripts/configure-kurtosis.sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8080/dashboard/>. The generated `.runtime/config.json` is ignored by
Git.

To test the production build with the same runtime configuration:

```bash
npm run build
EEZ_UI_RUNTIME_CONFIG=.runtime/config.json npm run preview -- --host 127.0.0.1 --port 8083 --strictPort
```

Preview serves the browser configuration and proxies RPC/Composer requests to
the configured upstream paths, including path-based public gateways. Public
gateway URLs are suitable for a local preview; a deployment on that gateway's
own server must retain its internal upstream configuration to avoid proxy loops.

## Cross-chain fee quotes

Enable quoting separately for each source chain in the existing deployment `.env`:

```dotenv
EEZ_UI_L1_FEES_ENABLED=true
EEZ_UI_L2_FEES_ENABLED=true
EEZ_UI_L1_FEE_MAX_TOTAL_WEI=100000000000000000
EEZ_UI_L2_FEE_MAX_TOTAL_WEI=100000000000000000
```

Both flags default to `false`. They select the dashboard's payment path; fee
collection, pricing, conversion and builder refunds remain Composer policy.
Enable a direction only when its Composer supports the compact `eez_quoteFee`
API. An old dashboard does not obtain these quotes. During a fee-enforced
rollout, pause new UI submissions, install the compatible Composer and dashboard,
then enable the matching flags and reload clients. A rollback must keep the UI
and Composer API and enforcement settings compatible. This UI change has no
contract or database migration.

Bridge transfers and proxy calls use the **source** Composer: `/composer/l1`
for L1 → L2, `/composer/l2` for L2 → L1. The app calls
`eez_quoteFee([transaction, {transactionTypes}])` directly over JSON-RPC.
The app passes the quoted gas and fee fields in one ordinary wallet transaction;
there is no separate payment or authorization. Ordinary transactions, including
token approvals and proxy creation, keep their usual wallet path.

The shared SDK allows omitted gas and nonce, which Composer resolves internally.
Bridge and call forms still preview gas and support manual gas limits; their
final quote validates that submitted limit and exact calldata, sender, value,
chain and nonce. Each option binds these fields with `requestHash`, which is not
a signed Ethereum transaction hash. The wallet path uses only compact quote
fields; diagnostics are available separately from `eez_debugQuoteFee`.
There are no old quote API or response-format fallbacks.

Rabby defaults to EIP-1559 (`maxPriorityFeePerGas`, `maxFeePerGas`) on Ethereum
mainnet (chain ID 1). Other configured chains retain the EIP-155-protected legacy
fallback (`gasPrice`) for Rabby's custom-network flow. Other providers, including
MetaMask, default to EIP-1559. An explicit supported type is preserved. Only that
format is requested. The selected wallet's account, chain and pending nonce are
rechecked before sending. Failed, mismatched or expired quotes stop submission;
retry the action to obtain a new quote. Wallets may edit fees before signing;
Composer validates the signed transaction at admission. The wallet's broadcast
RPC must use the source Composer; obtaining a quote does not change a wallet's
saved RPC or guarantee its submission route.

The bridge shows **Gas Price (Gwei)** and **Max Priority Fee (Gwei)** above the
collapsed Gas settings. Values come from the current source Composer's
`eez_quoteFee`, using the selected wallet's transaction format and the same SDK
validation as submission. Gas Price maps to `maxFeePerGas` for EIP-1559 or
`gasPrice` for legacy; legacy quotes have no separate priority-fee value. The
read-only fields retain full wei-to-Gwei precision and select their contents on
focus for copying into Rabby's Custom fee fields.

Previews are requested after gas estimation and any required token approval.
Changing the bridge inputs cancels obsolete previews. Expired previews clear
their values; **Refresh fees** obtains another quote without prompting the wallet.
Bridge submission obtains a fresh quote and displays those exact values in both
the card and the wallet-confirmation dialog. They remain stable while the user
reviews the wallet; background previews cannot overwrite them. This does not
prevent the wallet from changing its own fee selection.

The bridge's **Gas settings** explain the difference between gas limit and tip,
and the need to submit through the source Composer. When the source is Ethereum
mainnet and fee quotes are enabled, they also explain MetaMask's **Site suggested**
selection and Rabby's potential fee override. These instructions do not imply
that changing transaction type forces a wallet to preserve the quote.

In confirmation-only checks with the real extensions, MetaMask 13.53.0 preserved
the SDK's supplied gas, max fee and priority fee automatically. Rabby 0.94.12
replaced the supplied fees with its own estimate; manual custom fees restored
them. Those checks used controlled quotes and did not sign or broadcast a
transaction. Browser integration tests also exercise the L1-to-L2 bridge with
native value and ERC-20 calldata through both selected providers, but mock the
wallets and RPCs; they do not establish mainnet bridge settlement.

Each cap limits `gas * maxFeePerGas` or legacy `gas * gasPrice` in **source-chain
native wei**, excluding transferred value. The default is 0.1 native units per
transaction. Caps must be positive decimal integers; flags must be `true` or
`false`. Absent or empty environment values use defaults. Compose shell values
override `.env`. The bridge notice follows its selected source chain. Native
bridge MAX reserves that source's full cap before estimating; unused reserve
stays in the wallet. A smaller amount can be entered manually when the balance
is below the cap. Disabling a direction restores its ordinary wallet path; it
does not disable backend fee enforcement.

The SDK and its tests in `src/lib/fees/l2-fees.*` are copied byte-for-byte from
RollupX `8d03af4f78cb1c2bde36a64cc1fa09d4af288950` (`sdk/l2-fees.*`);
despite the file name, they support both directions. Keep these copies aligned
with the backend contract. This revision allows up to 64 KiB of decoded calldata,
including the treasury budget deployment batch. The request hash still binds all
bytes, and the server remains authoritative for admission. Older Composers may
reject larger requests; no unquoted or truncated fallback is used. `payment.mjs`
normalizes dashboard requests and binds the SDK to the selected wallet. The Kurtosis Vite configuration helper also
accepts the same four fee environment variables:

```bash
export KURTOSIS_ENCLAVE=eez-engineer-dev
EEZ_UI_L1_FEES_ENABLED=true EEZ_UI_L2_FEES_ENABLED=true \
  bash scripts/configure-kurtosis.sh
```

## Cross-chain transaction details

**Follow this call** and transaction-history inspection open the native React
detail view at `#/visualizer?mode=trace&chain=l1|l2&tx=0x…`. The Visualizer also
offers **Trace a transaction** for pasted hashes. The page shares the dashboard's
layout, theme, and explorer links and renders call flow, logical sequence, call
arguments/returns, related transactions, and observed L1 postings. It does not
embed the standalone HTML viewer. **Blocks & settlement** opens the existing
inspector for current settlement safety/finality and block-level evidence.

The [decoder](trace-decoder/README.md) reuses the root `.env` RPC, Composer,
contract, and explorer settings. Separate trace/archive endpoints are optional:
`EEZ_UI_L1_TRACE_RPC_UPSTREAM` and `EEZ_UI_L2_TRACE_RPC_UPSTREAM` default to the
matching read RPC. Provider keys and trace URLs stay server-side. Both chains
must support call tracing; historical requests may need archive state.

The decoder prefers exact source transaction links from the corresponding Composer
frontend and verifies them against chain evidence. The default `auto` mode needs
no additional environment setup and allows legacy settlement discovery when links
are unsupported. Supported pending or invalid links remain
partial instead of expanding the search. The default diagram follows the requested
transaction without including unrelated triggers that share its settlement batch.

The browser calls `BASE_URL + "trace/api"`; nginx forwards this to the internal
service. A gateway that already strips `/dashboard/` needs no new public route.
For local development, start `node trace-decoder/service/server.mjs` separately
once its dependencies are available; Vite proxies to `127.0.0.1:18082` by default
(override with exported `EEZ_TRACE_UPSTREAM`). No service starts from `npm run dev`.

Jobs report progress, share active work across viewers, and cancel when the last
viewer releases its lease. Limits include a 120-second default deadline, two
workers, 16 jobs, bounded RPC concurrency/body sizes, and bounded result memory.
`EEZ_TRACE_TIMEOUT_MS` and `EEZ_TRACE_CONCURRENCY` configure the deadline and worker
count. Completed results are snapshots cached for 30 seconds (5 seconds for partial
results); **Refresh** bypasses completed cache entries. The observation time is
shown explicitly. A snapshot does not assert current finality.

Missing traces, unknown matches, and unavailable settlement data remain visible.
Cancelling or changing transactions never alters a wallet transaction. Calls are
read-only; the API accepts transaction hashes and chain IDs, never arbitrary RPC
URLs or private keys. The standalone CLI remains available and writes HTML/JSON
under the ignored `.runtime/trace-decoder/` directory.

## Checks

Install the pinned Playwright dependency and Chromium once with `npm ci` and
`npx playwright install chromium`. `npm test` covers the SDK/payment boundary and
existing unit regressions. Browser tests explicitly enable Chromium's sandbox.
On Ubuntu systems that restrict unprivileged user namespaces, an existing Google
Chrome installation can supply its sandbox helper:

```bash
export CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox
```

Use only an installed, root-owned sandbox helper; do not disable AppArmor or add
`--no-sandbox` to make the tests pass. See the
[Chromium sandbox guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
Without a usable sandbox the tests fail at browser launch.

To test a built preview in two terminals:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 8083
```

```bash
EEZ_UI_URL=http://127.0.0.1:8083/dashboard npm run test:fees:browser
```

The browser suite covers both directions, native/ERC-20 bridges, ABI/raw proxy
calls, legacy and EIP-1559 wallet requests, independent flags/caps, native MAX,
ordinary approvals, nonce changes and quote failures. It mocks RPC and wallet
responses and broadcasts no transactions. To check Compose interpolation and
the image's actual runtime config producer, including absent/empty/invalid inputs:

```bash
docker build -t eez-rollup-ui:local .
EEZ_UI_TEST_IMAGE=eez-rollup-ui:local npm run test:fees:config
```

`npm run test:fees:kurtosis` is a separate live test against a disposable
fee-enabled private Kurtosis network (IDs 7331/696990). It deploys small Value
fixtures, then submits four quoted proxy calls (both directions and formats) and
two native bridge transfers through the mounted dashboard. It checks canonical
source ownership, destination effects, native blob posts, L1 builder refunds,
L2 priority payments and recovery of posting costs under the private network's
1:1 cost model. It uses an injected signing adapter, not a browser extension.

Start the matching RollupX Kurtosis profile with both backend fee directions
enabled; use its deployment/demo bindings and RPCs to serve this dashboard with
both UI flags enabled. Export `KURTOSIS_ENCLAVE` in every shell that operates that
network and source RollupX's `testing/kurtosis/ports.sh`. Then set:

- `EEZ_UI_URL`: this dashboard's `/dashboard` URL.
- `EEZ_DEVNET_L1_RPC`, `EEZ_DEVNET_L2_RPC`, `EEZ_DEVNET_L1_FRONT`,
  `EEZ_DEVNET_L2_FRONT`: the selected private enclave's endpoints.
- `EEZ_TEST_FEE_KEY`: a dedicated public fixture key funded on both private chains,
  separate from the poster and proof signer. Do not use a production wallet.
- `EEZ_VALUE_ARTIFACT`: the matching RollupX `contracts/out/Value.sol/Value.json`.
- `EEZ_UI_FEE_EVIDENCE_FILE`: a writable JSON evidence path outside the checkout.

The test expects the default private cost model (parity, zero off-chain costs),
L1 refund recipient `0x5555555555555555555555555555555555555555`, and L2 fee
recipient `0x4444444444444444444444444444444444444444`. It does not qualify public
builders, browser extension simulation, Safe workloads, or load capacity.

```bash
npm ci
npm run build
npm run test:visualizer
docker compose config --quiet
# With the combined app running and the Node version from .nvmrc:
node src/monitor/tests/test_proxy.mjs
docker build -t eez-rollup-ui:local .
```

Monitor regression checks and optional telemetry settings are documented in
`src/monitor/README.md`.

With Playwright installed and a production preview running, run
`node tests/counter-demo.cjs`, `node tests/cross-chain-calls.cjs` and
`node tests/treasury-demo.cjs` for mocked
wallet/RPC coverage. They default to `http://127.0.0.1:8083/dashboard`; override
that URL with `EEZ_UI_URL`. These checks do not broadcast real transactions.
The treasury check covers hidden navigation and direct URLs, shortcut/session
behavior, simulated approvals and budget arithmetic, and responsive layout.

Transaction result pop-ups include **Follow this call** links to the native trace
detail view. Its **Blocks & settlement** link opens the existing execution
inspector, which refreshes every ten seconds and reports source execution
separately from L1 posting, safety, and finality. Canonical hashes and both node
finality tags support positive settlement stages; reorgs or unavailable evidence
clear those stages. The Monitor link opens the matching posting record directly.
Local L1 transactions show L1 confirmation without implying L2 settlement.

Use **Latest EEZ batch**, or type `latest` into Inspect, to start with a recent
posted EEZ batch. **Latest block** and saved `block=latest` links retain their
source-chain meaning. Empty Live
filters offer an inspection shortcut and a way to clear filters. Monitor keeps
operator settings collapsed and initially shows five settlement summaries on
mobile; remaining records and per-record details are expandable.

The Bridge card uses two fixed network panels. Reversing direction moves the
From/To roles, editable amount, balance, and MAX without moving the networks.
The destination shows the exact amount and recipient; one asset selection
applies to both panels. Disconnected users can connect a wallet directly from
the primary action. The ERC20 token address and existing token catalog remain
below the transfer control.

Native MAX reads the source balance and EIP-1559 fee quote, reserves the chosen
gas limit at the quoted fee cap, and re-estimates the resulting amount through
Composer. With cross-chain fees enabled, the reserve is at least the source's
configured total fee cap. A manual gas limit also contributes to that reserve.
Errors leave the amount unchanged and block submission until corrected; changing the form cancels
stale MAX results. ERC20 MAX uses the full raw token balance, including precision
omitted from the displayed balance. Wallets can independently change gas and
fees before signing.

Additional regressions:

```bash
node tests/call-settlement.test.mjs
node tests/bridge-max.test.mjs
# Against the production preview, with Playwright installed:
node tests/ux-call-follow-through.cjs
node tests/bridge-asset-swap.cjs
```

## Bridge gas and approvals

Bridge gas is estimated against the source chain's Composer (`/composer/l1`
or `/composer/l2`) using the connected wallet, bridge address, calldata, and
value. The dashboard submits the raw estimate without a buffer or automatic
fallback; an explicit manual gas override takes precedence. Ordinary estimation
errors block submission. Older Composers that report a missing estimation method
or `ExecutionNotInCurrentBlock()` require an explicit manual limit before
submission is enabled. Wrapped bridge tokens burn directly without approval;
native ERC20 tokens still require allowance for the source bridge.

Updated Composers attach structured retry hints for settlement reconciliation
and a context change during estimation. The dashboard retries that same
unsigned estimate at most four times, with 1/2/4-second backoff, and cancels
obsolete bridge-input requests. Other failures are not retried. Persistent
unavailability remains a blocking error; no gas limit is invented. Upgrade
Composer before relying on these hints: older unstructured errors still surface
immediately, and no submission or wallet signature is retried.

Wallets may apply their own gas policy. For cross-chain estimation, set Rabby's
Chiado RPC to the L1 Composer URL shown by your current dashboard deployment.

Bridge regression checks include:

```bash
node tests/bridge-gas-estimation.test.mjs
node tests/gas-estimation-unfunded.test.mjs
# Against a running UI, with Playwright installed:
node tests/bridge-gas-fees.cjs
node tests/bridge-readiness.cjs
node tests/wallet-startup.cjs
```

## Execution visualizer

Open **Visualizer** or `/dashboard/#/visualizer`. **Live** opens first by default.
**Inspect** accepts a transaction hash, block number, block hash, or `latest` in
one form. `latest` opens the newest EEZ batch; hashes are detected on either
chain. Numeric blocks and **Latest block** use L1 unless L2 is selected. Transaction History's **View execution** action opens
the source transaction in this same view. Failed transactions and contract creations are supported.

The debugger uses mined receipts, EEZ events, posting/loading calldata, and an
optional `debug_traceTransaction` call tracer. Expand execution/static entries
to inspect calls, reentrant frames, expected rolling hashes, return or revert
data, rollup commitments, and ether changes. The timeline aligns linked L1/L2 events on shared rows, with one global
step selector and Previous/Next controls. Each chain retains receipt log order.
Exact call hashes take precedence over replay candidates; ambiguous matches
and nested completions that cross that order remain links across steps. Paired
rows represent related call evidence, not clock-time simultaneity. Expected
entries do not imply successful execution. Traces include nested failures even when reverted receipt logs are
absent. Raw calldata, logs, and receipt JSON remain accessible without tracing.

Cross-chain block links come from `eez_getSettlementByL2Block` and
`eez_getSettledL2RangesByL1Block` on the L2 Composer RPC. For an L1 batch, the L2 lane
loads only the terminal sync block by its indexed hash. Settlement links retain
the complete L2 range. Chain lanes show only calls to known EEZ managers,
decoded EEZ calls, and transactions emitting EEZ events, including calls through
other contracts. Reverted calls to known managers remain visible without logs.
Transaction counts and gas totals cover the displayed EEZ transactions.
Transactions sharing call
hashes appear as candidates; a repeated hash is not a unique execution occurrence.
For work that has not settled, supply the optional counterpart transaction hash.
Missing index or trace methods show a message while preserving available data.

Inspect reads either chain by number or hash using the same EEZ transaction
filter as transaction inspection. Live retains the latest 50 posted
batches from the connected rollup, newest first. The configured registry or
a matching canonical L2 settlement identifies that deployment; unrelated L1
registries are excluded. Rows show linked L1 blocks, L2 ranges, settlement
status, transaction hashes, and the total indexed L2 block count. Selecting
a post loads its L1 receipt and terminal L2 sync block; new blocks preserve the
selected transaction and trace. It polls every
five seconds after each completed refresh, and can be paused. Export JSON saves
the loaded context and traces. Deep links support `tx`, `chain`, `mode`, `block`,
and `counterpart` parameters inside the hash fragment. **Copy inspection link**
also includes the Live `batch`, `selected` transaction and `selectedChain`,
protocol `event` index, inspector `tab`, and focused `call` hash. Live links
restore the selected batch without switching to Inspect. Existing `mode=debug`
and `mode=explorer` links continue to open the combined Inspect view.

The inspector opens **Flow** by default: entry groups containing aligned L1/L2
call requests and reverse return arrows. Nested calls sit inside their parent's
request/return span. Contract and selector labels identify each call; consumed
and completed events stay in Timeline. Entries are associated by rolling hashes
and execution evidence rather than queue indices, which can repeat.

Flow automatically loads relevant transaction traces, with two concurrent
requests and the shared trace cache. Dispatch postorder associates nested
CallResult events; source traces show the bytes returned to the original caller.
Recorded local call ordinals distinguish committed results from earlier rolled-back
attempts. Dispatch matches recompute the protocol call hash, including destination,
rollup IDs and call gas; unresolved repeated hashes stay unlinked. Request and
return arrows share the initiating chain’s color. Vertical execution arrows
connect destination to result through nested calls and resumes. Adjacent calls
by the same contract in the same transaction also connect after the caller
resumes. Waiting callers have no execution bracket; translucent row highlights
sit behind the diagram so they cannot hide connectors. A source-only cached result is
a local loop, never an arrow from an unobserved destination. Leading immediate
L2 entries also show their state commitment on L1, including pure transactions
with no cross-chain calls. Applied updates require a unique rolling-hash
completion and matching root-update receipt logs; skipped, unconfirmed, and
mismatched updates retain their status. Other empty entry groups are collapsed.
The schematic does not imply cross-chain wall-clock timing. Missing returns
are explicitly unavailable. Select a row for inline transaction links,
trace/event details, return evidence, or previous/new roots. Clicking any row
while details are open dismisses them. L1 details remain on the left.
One global step control navigates requests, returns, and immediate state updates.

**Timeline** retains the complete recorded events and transaction boundaries.
**Calls**, **Entries**, and **Raw** provide traces, plan comparisons, and source
data. Share links restore the chosen view and original receipt event index.
Replay candidates can connect differing trigger hashes through an associated
execution plan, source address, calldata, value, and a recorded call result or
unique rolling-hash completion. They do not prove destination or global timing.
Entries compares expected outcomes, rolling hashes,
and return/revert bytes with uniquely associated recorded evidence. Missing
logs or return bytes remain **Missing evidence**, rather than a mismatch.
Static execution requires more evidence than persistent receipt logs provide.
Direct incoming entrypoint traces can establish returned or reverted bytes;
a successful posting transaction alone does not prove every planned entry ran.

Calls caches traces while switching transactions and batches. Protocol ABIs
are local; verified contract names/functions/arguments/results are fetched from
the configured explorers with bounded concurrency and a short cache. Unknown
contracts keep raw calldata/results. **Jump to failure** skips reverts handled
by successful enclosing calls and directly verified expected root reverts.

Batch search covers transaction hashes, block numbers (including the settled
L2 range), registry addresses, and inspected contracts/call hashes. Settlement
and execution filters distinguish indexed/finalized/pending/noncanonical
batches, observed cross-chain calls, reverted transactions, and skipped entries.
Live automatically loads entry details for the latest 50 batches in the
background, using two concurrent inspections and retaining the selected batch
and timeline step. **Pause** stops new inspections and **Resume** continues.
Unavailable inspections retry after 30 seconds; **Retry unavailable batches**
retries immediately. Coverage is explicit; pending or unavailable batches do
not imply successful execution. Only the terminal L2 sync block is loaded for
an L1 batch, so these checks describe the
loaded evidence, not every transaction throughout its L2 settlement range.
The batch list collapses and resizes, and the chain lanes remain visible beside
the inspector on desktop.

The debugger has a separate ABI snapshot for EEZ/EEZL2, including deployed
pre-cursor L2 static tables and current cursor tables. It discovers unconfigured
registry emitters from successful batch calldata/events (including forwarding
contracts), and L2 managers from their execution events. Explicit runtime or URL
contract addresses take precedence. To regenerate the snapshot from compiled
protocol artifacts:

```bash
python3 scripts/generate-visualizer-abi.py ../eez-core-protocol
```

For local Vite development, run the Python monitor on port `18080` as described
there. Vite proxies `/monitor/` to that port; `EEZ_MONITOR_UPSTREAM` overrides the
development target. The monitor collector needs its Python dependencies installed.

When migrating an existing standalone monitor, copy optional settings from
`src/monitor/.env` into the root `.env`, use the root UI RPC/explorer
variable names, and stop the old monitor Compose project before starting the
combined project. The old monitor port is no longer published. Gateways only
need to forward the UI port, with WebSocket upgrades enabled.

### Local explorer archive for the blob decoder

When the `eez-explorers` stack is running, set
`COMPOSE_FILE=docker-compose.yml:docker-compose.explorers.yml` and
`EEZ_BLOBSCAN_API_URL=http://blobscan-api:3001` in `.env`, then run
`docker compose up -d --build ui monitor`. The optional overlay joins only the
monitor to the existing explorer network; Blobscan API access stays internal.
Standalone deployments can continue using the main Compose file and another
configured archive URL.

The decoder supports historical tags 0–2 and tag 3/profile 1 from the derivable
operations network. Tag 3 shows sparse records and retained full blocks; it does
not reconstruct omitted headers. This is structural inspection, not transaction
signature/schema validation, KZG authentication, block hash validation, or execution
replay. No database migration is needed. Deploy the monitor and UI together; an
older monitor rejects tag 3 and an older UI lacks its sparse-block explanation.
