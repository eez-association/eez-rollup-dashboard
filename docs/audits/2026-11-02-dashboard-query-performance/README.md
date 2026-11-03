# Dashboard query performance

2026-11-02: implementation and local validation complete. No deployment, live
transaction or service restart. Scope and preserved boundaries are in the
[proposal](../../proposals/dashboard-query-performance.md).

Baseline: integration branch `4381f389c98bbbb00dca09cfdede3b093daa8f0a`, identical
tree to deployed `c1c9c234bffa918b58471092b19c008e96ab7770`. Candidate implementation:
`19208b161fa6a8390c861c059c2276572adba51b`. Both pin core protocol
`855fe0602484750861b4c31502a1a91355d33ed6`; no contract, ABI, storage or SDK change.
Node 22.23.4 and sandboxed Chromium 153.0.8010.12 were used on ROG.

## Results

The same production-build browser test supplied 50 fixed batches and added
100 ms to every mocked RPC response. Both samples observed exactly 20 seconds
at 1440 × 1000, with fresh browser storage and the same fixture. One sample per
condition is retained; these timings are not a statistical latency guarantee.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| RPC requests in 20 seconds | 320 | 25 |
| History first visible | 1.378 s | 0.859 s |
| Selected batch inspection visible | 2.169 s | 1.144 s |
| Settlement-index requests | 100 | 1 |

The reduced default work is intentional: the baseline inspects all 50 batches,
while the candidate initially inspects the selected batch. The candidate test
then explicitly checks another selection, settlement filtering without receipt
hydration, full execution filtering, search, mobile layout, Load all details,
and Pause/Resume. Full inspection remains available and partial coverage is
visible. Canonicality and finality receipt checks remain active; the selected
transaction can therefore have more than one receipt read.

A separate read-only browser session substituted candidate frontend assets
locally while retaining the public dashboard's configuration and RPCs. It made
40 Visualizer data requests in 20 seconds. The earlier deployed-UI audit observed
387; these live samples had different chain heads and transaction contents, so
the fixed-fixture comparison above is the controlled evidence.

The same read-only session obtained successful automatic-gas bridge quotes in
both directions without `eth_estimateGas`. From amount entry to quote completion,
L1-to-L2 took 270 ms and L2-to-L1 261 ms; earlier deployed-UI observations were
696 and 675 ms. The implementation removes 400 ms of consecutive debounce delay
and one separate estimate from this path. These are single live samples, not a
constant service latency claim. Explicit gas and fresh final-send quotes are
covered by mocked wallet tests.

Connected views made six native balance requests over the 20-second sample,
versus eleven previously. Header and Bridge now share those reads. The balance
regression holds responses, advances timers and switches accounts to establish
bounded in-flight work and rejection of late old-account data. Two Bridge balance
requests started 3–4 ms before the live sample cutoff; they are recorded as pending
at that boundary, not as hung queries. Other live samples had no pending requests,
and all four had zero page/action errors. No wallet extension or live signing was
used in these sessions.

## Validation

- Production build passed, with the existing Vite large-chunk warning.
- Full unit suite: **733 passed, zero failed, zero skipped**. This includes three
  new debugger regressions for scoped settlement loading, disappeared/error
  observations, and fresh cache binding/expiry/noncanonical data.
- Bridge browser suites: 27 gas scenarios, 64 fee scenarios, ten lifecycle
  scenarios, 15 asset/amount scenarios, and token-picker regressions passed.
  Both directions, Rabby and MetaMask, native/ERC-20, automatic/explicit gas,
  final-send gas changes, caps, failures, nonce changes, stale/expired quotes,
  approvals, confirmation, MAX and pending-modal dismissal are covered.
- Wallet startup/balance and Visualizer navigation/performance regressions passed.
  Counter's 17 scenarios and generic cross-chain calls' 26 scenarios passed.
- The complete Falcon browser suite passed: hidden navigation, keystore,
  browser signing, both networks/wallet formats, recovery, and existing-Safe
  compatibility. Its RPCs and wallet transactions are mocked; signatures are
  generated in the real browser.
- `git diff --check`, edited JavaScript syntax and README shell-example syntax
  passed. Relevant browser scripts were added to CI.

No native protocol process tests, new on-chain deployments, contract compilation,
installed-extension signing, live settlement or independent follower replay was
run for this frontend-only change. CI retains the repository's contract/service
matrix. Safe submodules were not needed for local frontend checks; the pinned
core submodule was initialized for source-artifact unit tests without changing
its gitlink.

## Reproduction

Build both revisions with `EEZ_UI_BASE_PATH=/dashboard/ npm run build` and serve
them on separate unused ports. The comparison used baseline port 18786 and
candidate port 18796. Existing port 18787 was left untouched. From the candidate
checkout, with Node 22.23.4 and the installed Chromium sandbox helper:

```bash
export CHROME_DEVEL_SANDBOX=/usr/local/sbin/eez-chromium-sandbox
EEZ_UI_URL=http://127.0.0.1:18786/dashboard EEZ_UI_PROFILE_BASELINE=1 \
  EEZ_UI_PROFILE_DELAY_MS=100 EEZ_UI_PROFILE_SECONDS=20 \
  node tests/visualizer-query-performance.cjs
EEZ_UI_URL=http://127.0.0.1:18796/dashboard \
  EEZ_UI_PROFILE_DELAY_MS=100 EEZ_UI_PROFILE_SECONDS=20 \
  node tests/visualizer-query-performance.cjs
```

The baseline fails the new shared-balance assertion (three initial native reads
instead of two) and direct-quote assertion (one preliminary estimate instead of
zero). The candidate passes both. The fixed workload and regression inputs are
committed in the test scripts. [measurements.json](measurements.json) contains
small sanitized results and hashes of raw evidence. Raw logs and live profiles
are local-only in ignored `.runtime/` under the implementation worktree; they are
not available in another checkout. CI separately uploads its `.runtime` artifacts.

Initial failures were retained. The first build exposed optional-string typing
errors, fixed before browser validation. An existing navigation assertion expected
Inspect while both the deployed baseline and candidate route history to Trace;
the test and stale README sentence were corrected. Tests expecting a separate
post-approval estimate were updated to require a direct quote and zero estimates.
A request-count assertion was corrected to distinguish unique inspected
transactions from retained finality receipt checks. The held-balance test now
allows bounded timeout retries while checking at most two in-flight reads. These
are explained corrections, not retry-only passes.

The first full unit invocation lacked local-listener permission and initialized
protocol sources; its five failures were diagnosed as `EPERM`/`ENOENT`, then the
prepared environment passed the full suite. A preview startup on occupied port
18787 failed under `--strictPort`; that attempt and its test result were excluded.
Only task-owned preview processes were started. Operator configuration, existing
services and the deployed dashboard were preserved.
