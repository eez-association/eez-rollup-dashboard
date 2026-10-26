# Cross-chain trace decoder

Decodes one EEZ transaction (L1 or L2), finds the related transactions on the other
chain, matches every cross-chain call to its remote execution, and draws the flow.
Read-only: it only uses RPC reads/traces and explorer lookups.

This folder originated in `sync-rollups/trace-decoder`. Its JSON engine and flow
model now power the dashboard's native React transaction detail view through a
read-only Node.js API. The API runs as the internal `trace-decoder` Compose service.
The CLI and standalone HTML viewer remain available for offline inspection.
The native dashboard defaults to **Linked flow** and offers **Recorded traces**
when exact links are verified. Recorded sequence numbers are independent per
chain. The native **Call map** shows branching calls in chain bands and fits its
width automatically. **Fit width** keeps the overview responsive; **100%** restores
readable labels with scrolling. **Show local reads** reveals successful local reads
hidden by default; failed calls, missing execution, cross-chain reads and prepared
results remain visible. Searching also reveals matching local reads.
The native call flow connects visible callers to their children, numbers
calls, and highlights connections for the selected call. Dashed connectors mark
uncertain or missing execution; recorded traces never connect independent
transactions. Search and hidden protocol frames can promote descendants to the
nearest visible ancestor. **Token transfers · experimental** (off by
default) shows ERC20 Transfer events on call cards only when the same event
appears in both the trace and the committed receipt; amounts describe events,
not net balance changes. Prepared results without an expected L2 delivery are labeled separately
and do not by themselves make the API result partial. Both models use curated
public diagnostic messages; raw provider errors remain server-side.

## Dashboard API

The dashboard uses `service/server.mjs`, which imports the engine directly.
Configuration comes from the shared root `.env` and exported variables. To run
locally with the Node version in the repository root `.nvmrc`:

```sh
npm ci --prefix trace-decoder --ignore-scripts
node trace-decoder/service/server.mjs
```

It binds to `127.0.0.1:18082` by default. Compose binds internally on port 8080;
the host-network overlay uses loopback port 18082. `EEZ_TRACE_HOST` and
`EEZ_TRACE_PORT` override the listener. `EEZ_TRACE_TIMEOUT_MS` (default 120000)
and `EEZ_TRACE_CONCURRENCY` (default 2, maximum 4) bound worker jobs.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Process/configuration readiness; does not probe RPCs |
| `POST /api/jobs` | Start or share a decode; body: `{ hash, chain: "l1" \| "l2" \| "auto", chainIds: { l1: "10200", l2: "200" }, refresh?: true }` |
| `GET /api/jobs/:id` | Poll state and progress; renew the viewer lease |
| `GET /api/jobs/:id/result` | Retrieve the versioned public flow model |
| `DELETE /api/jobs/:id` | Release this viewer's lease |

Chain IDs are decimal strings checked against the configured upstreams. Selecting
a source chain restricts hash discovery without restricting related-chain decoding.
The service accepts no client-supplied endpoints or credentials. Each decode runs
in a bounded worker thread; cancelling the last viewer or reaching the deadline
terminates the worker and its outstanding requests. Viewer leases expire after
45 seconds without polling. Results are limited to 8 MiB, total cache memory to
32 MiB, jobs to 16, and clients to 64. Individual upstream bodies are limited to
16 MiB, concurrent upstream fetches to eight per worker, and RPC/explorer work to
6000 requests (JSON-RPC batch elements count separately).

Completed snapshots cache for 30 seconds, partial snapshots for 5 seconds.
Refresh bypasses completed snapshots. Results carry their observation time and
do not assert current finality. Public responses omit provider error messages,
configuration, and raw Composer responses. The public contract is
`service/types.d.ts`; the React view consumes it with no Node dependencies.

## Show a transaction

```sh
trace-decoder/show-tx.sh <TX_HASH>
```

Every transaction it finds (the requested one and the related L1/L2 ones) must have a
call trace. If an endpoint cannot trace one, it exits with an error naming the
transaction and the missing setting (`EEZ_UI_L1_TRACE_RPC_UPSTREAM` / `EEZ_UI_L2_TRACE_RPC_UPSTREAM`), writes nothing
except `<hash>.partial.json`, and keeps any complete trace saved earlier.
Incomplete or invalid supported transaction links also require `--allow-partial`.
`--allow-partial` draws the incomplete flow anyway.

Otherwise it prints the transactions it found and their roles, writes
`.runtime/trace-decoder/<hash>.html` (plus the decoded `.json`) and opens the page with
the **Call flow** and **Sequence** views. Any of the flow's transactions works as
input: the trigger, the settlement batch or a delivery.

More options (same flags as `decode-trace.mjs`, plus):

```sh
node trace-decoder/flow/render-flow.mjs <TX_HASH> --env-file FILE --views all --open
node trace-decoder/flow/render-flow.mjs .runtime/trace-decoder/<hash>.json --env-file FILE --open   # re-render, no RPC calls
  --l1-rpc URL --l1-trace-rpc URL         # e.g. an archive endpoint for this run
  --l1-explorer-url URL --l2-explorer-url URL   # explorer websites for verify links
  --views flow,layers,sequence,timeline|all
```

The text/JSON CLI uses the same decoder engine: `node trace-decoder/decode-trace.mjs <TX_HASH> [--json]`.

## Configuration

The default configuration is the repository root `.env`, even when invoked from
inside `trace-decoder/`. `--env-file FILE` selects another file; `DEVNET_ENV` is
retained as a compatibility override. Explicit relative paths resolve against the
working directory. Settings are resolved in this order:

1. The selected file.
2. Nonempty exported environment variables.
3. CLI flags.

Within one source, the repository names below take precedence over legacy aliases.
Blank values are unset. Unrelated settings and wallet private keys are ignored;
the file is parsed, never sourced or executed. Only allowlisted variable references
such as `$EEZ_UI_L1_RPC_UPSTREAM` are expanded. Shell expressions are rejected.
File references also use nonempty exported values; exported values themselves are
literal. CLI flags override individual options after file expansion.

| Repository setting | Decoder use | Legacy alias |
| --- | --- | --- |
| `EEZ_UI_L1_RPC_UPSTREAM`, `EEZ_UI_L2_RPC_UPSTREAM` | Chain reads | `L1_RPC`, `L2_RPC` |
| `EEZ_UI_L1_FRONT_UPSTREAM`, `EEZ_UI_L2_FRONT_UPSTREAM` | Composer discovery, source transaction links and settlement correlation | `L1_FRONT`, `L2_FRONT` |
| `EEZ_UI_L1_TRACE_RPC_UPSTREAM`, `EEZ_UI_L2_TRACE_RPC_UPSTREAM` | Optional separate trace/archive RPCs; blank uses the corresponding read RPC | `L1_TRACE_RPC`, `L2_TRACE_RPC` |
| `EEZ_REGISTRY_ADDRESS`, `EEZL2_ADDRESS` | L1 and L2 managers, with Composer discovery when available | `ROLLUPS`, `MANAGER_L2` |
| `EEZ_UI_L1_EXPLORER_API_URL`, `EEZ_UI_L2_EXPLORER_API_URL` | ABI/name APIs; fall back to the explorer website URLs | `EXPLORER_L1`, `EXPLORER_L2` |
| `EEZ_UI_L1_EXPLORER_URL`, `EEZ_UI_L2_EXPLORER_URL` | Public explorer links, kept separate from API endpoints | `EXPLORER_L1`, `EXPLORER_L2` |
| `EEZ_TRACE_L1_EXPLORER_API_KEY`, `EEZ_TRACE_L2_EXPLORER_API_KEY` | Per-chain explorer credentials | `L1_EXPLORER_API_KEY`, `L2_EXPLORER_API_KEY` |
| `EEZ_TRACE_ETHERSCAN_API_KEY` | Shared Etherscan V2 fallback key | `ETHERSCAN_API_KEY` |

The dashboard uses `auto` by default, with no additional environment setup.
For standalone use, the decoder retains `EEZ_TX_LINKS` and CLI `--tx-links`
with the modes `auto`, `required`, and `off`.

The existing decoder options `EEZ_CORR_RPC`, `L1_EXPLORER_TYPE`,
`L2_EXPLORER_TYPE`, `EXPECTED_L1_CHAIN_ID`, and `EXPECTED_L2_CHAIN_ID` also remain
available. Manager addresses supplied in the file or environment pin the deployment
for the API and CLI; `--l1-manager` / `--l2-manager` override them. Composer discovery
fills only manager addresses that were not configured. The decoder reports
`pinned-manager-mismatch` if a configured address differs from Composer, while
keeping the configured address.

The API server imports `loadEnvironmentConfig()` from `src/config.mjs` and
passes its result to `decodeCrossChainTrace(config, hash)`. This loader does not
require a transaction or expose unrelated environment values. The CLI uses the
same loader and applies its flags afterward.

Use the shared upstream values from the root [.env.example](../.env.example).
For a host-run CLI, `host.docker.internal` in that template may need a CLI override
to a host-reachable URL such as `http://127.0.0.1:19545`. Endpoints are not rewritten
automatically: container and host networking can differ. Do not put trace-provider
credentials into the browser's `config.json`.

The decoder requests `debug_traceTransaction` with `callTracer` and falls back
to block tracing. Historical transactions need retained historical state. Set a
trace override for Chiado or mainnet when required; no public endpoint is assumed
to support tracing. The trace RPC is also retried for missing historical reads.

Explorer API URLs take priority over website URLs for decoding. Public links use
the website URLs, with credentials and query strings removed by the flow model.
Re-rendering saved JSON loads the same configuration and requires no RPC calls.
Without explorers, EEZ contracts decode from the bundled `src/protocol-abi.json`;
other contracts use validated 4byte.directory matches (`--no-4byte` disables that
lookup, `--no-explorer` both).

## What a decode does

1. Finds the transaction on L1 or L2 and queries `eez_getCrossChainTransaction`
   with its **transaction hash** on the source chain's frontend (`L1_FRONT` or
   `L2_FRONT`; `EEZ_CORR_RPC` can substitute when that frontend is unset and its chain ID matches the source).
   Complete links name `transactions.l1`, `postBatch`, and `l2[]` directly.
   L1 sources link to committed L2 deliveries; L2 sources link to their system
   table loader and original user transaction. Empty L2 delivery lists are valid
   for static/reverted L1 lookups.
2. Checks chain IDs, source identity, successful receipts, canonical inclusion,
   manager calldata, delivery event order/multiplicity, and L2 loader ordering.
   No intervening table replacement is allowed, including inside the source.
   `ownership.canonical` is checked against **L1** in both directions. The status
   identity and canonical headers are rechecked after fetching the linked traces.
   CLI JSON retains the RPC observation, references and validation checks in
   `transactionLinks`; link completeness alone does not prove execution success.
3. Traces only the linked transactions and matches calls inside that exact set,
   using proxy identity, calldata, value, static context, return/revert data,
   execution tables and nested call structure. Identical occurrences remain
   ambiguous unless consumed-entry and delivery order establish their identity.
   Every ordered pair must also agree on return/revert data and execution scope;
   ordering alone never overrides a mismatch.
   For L2 sources executed through `_attemptExecuteImmediateL2Txs`, the decoder
   checks each attempt's calldata against its batch entry, excludes reverted
   attempts and native entries without L1 calls, and selects the matching L1
   subtree. With multiple successful hosts it verifies the complete canonical
   settlement range, groups each loader plus source as one unit, and maps their
   order to successful L1 entries. Source links must name the same posting tx;
   loader coverage and entry/unit counts must agree. Other source units are
   verified through reads, without adding their traces to the requested flow.
   Missing evidence or mismatched counts prevents an ordinal match.
4. When the method is unsupported (`-32601`) or returns a legacy source record
   without `transactions`, `auto` uses the previous block-hash settlement lookup
   and bounded scanning path. Missing frontend configuration and fully traced local transactions without EEZ
   calls also permit this compatibility path. A system transaction (batch, loader or delivery) with no
   source record can still be opened through settlement discovery. Batch postings
   are recognized inside wrapper traces when a successful `postAndVerifyBatch`
   executes in the configured L1 manager's context and no enclosing frame reverts.
   A trace is required. Outgoing source calls from the poster’s meta hook or
   surrounding wrapper block this fallback, including caught or reverted attempts.
   Reentrant callbacks inside the manager’s immediate L2Tx execution are not sources.
   Fully decoded setup/administration calls and views without outgoing source calls
   also permit fallback; unknown manager calldata remains unresolved. A null
   source record alone does not authorize broader discovery. Supported
   incomplete/null **source** records, transport failures and invalid links are
   unresolved; they never silently trigger a broader scan. Run again after a
   pending source completes. `required` disallows compatibility fallback;
   `off` disables exact links; `--no-correlation` disables both RPC linking paths.

A correlation-only endpoint on the other chain is used for settlement discovery
in `auto` mode, not as a source frontend; `required` still needs a matching source
frontend. Legacy discovery queries the method for the source chain with the actual
receipt block hash, trying the corresponding front first after any explicit
correlation override. The two methods may live on different fronts. Unsupported
methods and transport failures try the next endpoint with the same block hash. Malformed successful responses stop discovery. If transport failures
exhaust the endpoints, the result stays unresolved; they never authorize a broad
timestamp scan.

Legacy discovery checks settlement block hashes in batches of up to 100 reads,
then scans manager calls/events in the requested block, posting block and L2 range.
Without settlement support it searches ±2,000 blocks around the nearest timestamp.
`--thorough` and explicit block ranges extend this compatibility search; they do
not expand a supported exact transaction link set. Null historical block reads,
including null batch slots, retry the configured archive trace RPC.

## Standalone linked flow and recorded traces

**Linked flow** is the default, including for verified transaction links. Confirmed
cross-chain matches connect the local request to its remote execution with arrows.
EEZ plumbing stays folded, including L2 value transfers to the manager’s
`SYSTEM_ADDRESS` verified at the receipt block. Those observed calls remain
inspectable with **EEZ plumbing** enabled. EEZ markers on cross-chain arrows also
follow this checkbox in both directions; the default view shows direct application
connections. Ambiguous matches do not become confirmed connections;
unobserved remote calls are explicitly labeled as not observed. This is a logical
call flow, not a shared timeline across chains.

With verified links, **Trace view → Recorded traces** shows each transaction's
physical call tree in its original order. **Both chains** displays the linked trees
without cross-chain arrows; call numbering starts independently on each chain.
The sequence view also gives each chain its own rows. For an L2 source, the
identified L1 entry is shown separately from other entries in its settlement batch.
If that entry cannot be isolated, a notice explains why and the full batch remains
selectable. The complete physical trace is always retained in JSON.

The gas summary shows separate **L1 flow gas** and **L2 flow gas** totals,
including EEZ plumbing, hidden reads and reverted calls. Physical parent/child
relationships prevent nested calls from being counted twice. Totals stay fixed
across view, transaction and visibility selections: they describe the requested
flow. The breakdown includes the source, linked L2 table loading and deliveries,
and the isolated L1 entry when available. Whole transactions use receipt gas;
isolated subtrees use inclusive call-trace gas. Full related transaction receipt
totals are shown separately because settlement batches can contain other flows.
Shared settlement work, transaction overhead and refunds cannot be allocated
exactly to an isolated entry. Missing gas or incomplete attribution is marked
partial; these are gas units, not fees. The native dashboard shows the same
totals in an open **Gas used by this flow** panel below the trace.

Recorded L2 proxy calls label their prepared table responses. State observations,
when supplied, are values after a block, not per-transaction storage writes.
Cross-chain reads always remain visible in both modes. **Local reads** controls
additional read-only calls, and an explicit choice persists across trace and view
changes. Optional association notes show their codes and messages.
Proxy identity failures, forwarding inconsistencies and rejected return/revert
matches remain unresolved. Selecting a remote call card opens its crossing
evidence even with plumbing off.
The text CLI also defaults to linked flow; use `--recorded` for separate physical
traces.

L1→L2 top-level reads, reverting calls, and calls erased by an enclosing revert
use prepared return/revert data and have no L2 delivery. These are labeled
**Prepared result · no L2 delivery expected** when no contradictory remote execution
was observed. L2→L1 reads and reverting calls do execute inside the L1 entry.
Missing traces still require an archive endpoint or explicit partial output.

A fresh complete decode replaces older JSON even if its match count decreases.
With `--allow-partial`, a run missing call traces may retain a complete saved capture
only for the same schema, chain/manager configuration and canonical transaction
inclusion. Fresh validation failures prevent this reuse. The printed summary
describes the capture actually rendered.

## How transactions are classified

The page roots relevance at the **requested transaction** and follows its matched
logical calls. Execution tables and shared batch posts are dependencies; they do
not connect every other trigger in the batch to this flow. The requested application
transaction controls the default view and title, including ordinary transfers.
The CLI JSON retains complete physical traces for inspection. Roles are determined
from evidence (`classifyTransactions` in `flow/model.mjs`):

- **Trigger**: an application transaction whose cross-chain call is top-level (not nested
  in a delivered call). If an L1 batch entry with `proxyEntryHash == 0` (an L2Tx entry)
  carries the same call, the flow started on L2.
- **Settlement batch / execution table load / L2 delivery**: by the EEZ function called.
- **Not part of this flow**: no cross-chain calls (for example proxy setup), settled in
  the same batch only.

Table loads and deliveries are shown with **EEZ plumbing** ticked; their inspector shows
the decoded execution table. Cross-chain reads remain visible; **Local reads** adds other static calls.
For a requested L2 transaction without cross-chain calls, its correlated **L1 settlement**
is available directly in the transaction selector. Selecting it reveals the batch's
protocol calls; this settlement relationship does not create a cross-chain call edge.

## Layout

```
show-tx.sh           one-command entry point
decode-trace.mjs     text/JSON CLI and public API (decodeCrossChainTrace)
src/                 decoder: config, engine, rpc, transaction-links, logical (call graph + matching),
                     prepared-result (shared result classification),
                     protocol (+ protocol-abi.json), abi-decoder, explorer
flow/                diagram: model.mjs (trace → call tree, roles), render-flow.mjs (CLI),
                     viewer/ (template.html, viewer.js)
samples/             synthetic example traces (build-samples.mjs)
service/             HTTP API, worker jobs, shared public TypeScript contract
flow/rows.mjs        pure call selection for native React flow and sequence views
tests/               node:test suites and fixtures
```

Update `src/protocol-abi.json` when the EEZ/EEZL2 ABI changes.

## Tests

Configuration checks use only Node's built-in test runner and need no installation:

```sh
node --test trace-decoder/tests/config.test.mjs
```

The default decoder suite requires its declared `ethers` dependency and uses
self-contained fixtures. API lifecycle and React row-selection tests are in
`tests/service.test.mjs` and `tests/rows.test.mjs`; `tests/source-chain.test.mjs`
covers source selection. The dashboard's `tests/trace-details.cjs` provides a
mocked Playwright flow for the React page. It starts an isolated Vite server by
default; `EEZ_UI_URL` can select an existing test server instead.

```sh
npm ci --prefix trace-decoder --ignore-scripts
npm test --prefix trace-decoder
npm audit --prefix trace-decoder --audit-level=high
node tests/trace-details.cjs
```

CI runs these checks in addition to the dashboard and treasury suites. It builds
the decoder image and runs `node tests/trace-services.mjs` to check the Compose
configuration, Vite proxy targets, and real decoder listeners in an isolated
container alongside the treasury-verification port. To run that check locally:

```sh
docker build -t eez-trace-decoder:check trace-decoder
node tests/trace-services.mjs
```

The optional `npm run test:legacy` suite still expects compiled `EEZ` / `EEZL2`
artifacts in repository-level `out/` from the original protocol repository.

`tests/flow-viewer.test.mjs` runs the page script against a stub DOM and checks that
boxes never overlap, every call arrow points right and contract tags are consistent.
Fixtures are synthetic callTracer traces of the E2E topologies, not archive captures.
