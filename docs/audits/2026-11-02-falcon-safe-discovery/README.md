# Falcon Safe discovery latency

The user reports that “Finding your Safe” succeeds but takes several seconds.
This change overlaps independent reads and avoids rediscovering the same Safe
when the gas-paying wallet changes. See the accepted
[discovery scope](../../proposals/falcon-safe-request-flow.md#safe-discovery).

## Source identity

- PR base and dashboard target fork: `eez-association/eez-rollup-dashboard`,
  `feat/falcon-safe-demo`, `7690c09cbc9ffa10b89cd77874de7bc82e456b3a` (PR #44).
- Baseline preview: `b807275adc3a6a1792148d6e7710a511732d0dee`, the deployed PR #44
  source. Its tree equals the merge base above.
- Tested implementation: `b3b154ccb1237fc6dcd7e1d6e5be8fde9346f27e`, on
  `codex/falcon-safe-discovery`. The following audit commit changes documentation
  and evidence only.
- Protocol gitlink and initialized checkout:
  `855fe0602484750861b4c31502a1a91355d33ed6`, unchanged. No contracts, deployment
  configuration, dependencies, fee SDK or backend code changed.

## Behavior

Previously, initial discovery awaited the Composer/deployment inspection, then
controller inspection, then L1 discovery. It also repeated the complete lookup
when the gas wallet changed, although the Safe belongs to the Falcon key.

The new read-only path checks the source chain and deployment in parallel with
the factory mapping. It shares one source block between deployment, mapping and
controller reads. The mapping supplies an address for L1 lookup while controller
authority is checked independently. No address, balance or action is exposed
until all required checks pass. A missing controller still requires successful
L2 deployment checks, and skips the unnecessary L1 lookup.

The dashboard read endpoint no longer receives a Composer broadcast-route probe
during discovery. Wallet setup and submission retain that check. All existing
chain checkpoints, code hashes, controller bindings and factory/attached-Safe
compatibility checks remain. Changing the gas wallet retains the loaded account;
key, deployment and attachment changes still restart lookup and cancel old work.
There is no ownership cache, speculative funding address or new RPC API.

## Controlled comparison

Both production previews ran sequentially on the same host using Node 22.23.4
and sandboxed Chromium 153.0.8010.12. Each mock RPC/quote waits 100 ms. There are
three fresh browser contexts per wallet per revision, with an already-open
Falcon tab, a connected wallet on L2 and a funded factory Safe in the fixture.
Load timing starts at Generate Key and ends at the fully checked Safe; it
includes local key generation, but excludes opening the tab and connecting the
wallet. Both revisions use the identical retained harness. Real browser Falcon
signatures are independently verified in Node. Send stops at a held mock wallet
prompt; no transaction is broadcast.

| Median | Baseline | Candidate |
| --- | ---: | ---: |
| Load, Rabby | 1,313 ms | 809 ms |
| Load, MetaMask | 1,329 ms | 813 ms |
| Sign, Rabby | 279 ms | 275 ms |
| Sign, MetaMask | 276 ms | 276 ms |
| Send to wallet prompt, Rabby | 462 ms | 463 ms |
| Send to wallet prompt, MetaMask | 463 ms | 462 ms |

Loading is about 38–39% faster in this workload. All trials use 41 → 37 discovery
reads, with Sign and Send unchanged at 3 and 5. Four reads disappear: the three
read-endpoint Composer probe requests and the separate L2 block-number request.
The larger latency improvement comes from overlapping the remaining inspections.
Small signing/send differences are noise, not claimed improvements. The wallet
regression confirms that switching gas wallets does not repeat factory lookup.

The committed [measurements](measurements.json) retain every trial's timings and
request counts, source identity and the harness digest. The original harness and
raw logs are local-only, ignored artifacts under
`artifacts/dashboard-falcon-performance-20261101/.runtime/performance/`
(`wallet-simplified-profile.mjs`, `discovery-{baseline,candidate}-20261102.*`).
Candidate validation logs are local-only under
`artifacts/dashboard-falcon-discovery-20261102/.runtime/performance/`.
These paths are relative to the operator's rollupX workspace; they are not
included in a dashboard clone.

## Validation and limits

- `npm run build`: passed (release artifact check, TypeScript and Vite).
- `npm test`: 730 tests passed, including 18 new discovery regressions. Held
  deployment/authority reads prove L1 lookup overlaps them without bypassing
  validation. Tests also cover both networks, consistent block tags, absent
  accounts, invalid bindings/owners, cancellation and fresh authority on reload.
- Browser navigation and keystore tests passed. Wallet tests passed all eight
  network/wallet/network-setup combinations, including real browser signatures,
  account changes, quote rejection and transaction recovery paths. The dedicated
  recovery, existing-Safe compatibility and cross-chain call browser tests passed.
- `git diff --check`: passed. No Solidity or backend source changed, so their
  build/process suites were not rerun locally. No live settlement or independent
  chain replay was exercised. This is not a measurement of the user's connection
  or of live Composer/settlement latency, and is not deployment evidence.

Retained first failures: the restricted unit invocation could not run loopback
RPC fixtures and reported file-level results rather than all individual tests.
With local socket access, one source-consistency test then failed because the new
worktree lacked the pinned OpenZeppelin files. Initializing the exact protocol
gitlink resolved that prerequisite; the full suite passed with no skips. The
first browser run stopped at a test waiting for the old wallet-change discovery
notice. It now waits for the relevant wallet-scoped control and asserts no repeat
lookup; the complete wallet matrix passed. These are documented environment and
expectation corrections, not unexplained retry-only passes.
