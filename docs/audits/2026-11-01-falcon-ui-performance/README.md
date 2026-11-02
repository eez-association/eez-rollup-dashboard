# Falcon Safe loading and signing latency

User-reported slow loading and signing on ROG. Changes are on
`codex/falcon-safe-performance`; no deployment or live transaction was performed.
Baseline `bca8f244358e7e844c2f7cbeb19201bc01a95867` has the same tree as the
deployed `49459037fb9d7e189dfd66045673b871d6b432e6`. The dashboard protocol pin
is `855fe0602484750861b4c31502a1a91355d33ed6`; ROG runtime metadata remains
`84a5b5207880f192a6a5896cbfe0bac5249db47f`. Neither changed.

## Findings and implementation

The deployed Sign button runs Safe inspection, wallet/Composer discovery,
controller checks, digest comparison, local signing, another full Safe/session
inspection, contract authorization verification, and a fee quote. Loading also
serializes several independent groups of RPC reads. Network latency therefore
dominates the locally measured cryptography.

The initial prototype overlapped independent reads and reused one immediate
preview snapshot. At the user's request, the final change follows the accepted
[simplification scope](../../proposals/falcon-safe-request-flow.md):

- Discovery still checks deployment bytecode, routing, controller bindings and
  Safe compatibility; independent reads run concurrently.
- Sign reads the controller nonce at the current source block and the Safe
  nonce, calculates both digests locally, then creates the Falcon signature.
  It no longer calls `actionDigest`, `checkAuthorization`, full inspection or
  `eez_quoteFee`. The existing wallet session and key/input guards remain.
- Send probes the selected wallet's Composer endpoint and checks the Safe
  nonce for receipt correlation, then requests one fresh fee quote. The SDK
  validates intent binding, expiry, fee ceiling and wallet account/chain/nonce
  before sending the exact quoted fields. No unquoted fallback or automatic
  resend is introduced. The existing bounded stale-quote refresh remains.
- Composer simulation and contract execution enforce signature, replay,
  expiry, authorization and balance validity. Ownership/module information is
  labelled as last checked; the UI no longer treats it as a per-send policy.
  Exact canonical L2/L1 execution evidence remains required for confirmation.

The Safe nonce is receipt metadata, not part of the Falcon-signed calldata. Its
pre-send check cannot lock future state; an intervening Safe transaction during
wallet approval can still make the existing conservative confirmation path
refuse a mismatched receipt. This change does not weaken that evidence check or
claim to solve that existing race. No contract, SDK, RPC endpoint, key storage,
cryptographic parameter or password-protection change was made.

## Final flow measurements

Sequential baseline/candidate production previews on the same host, Node
22.23.4, sandboxed Chromium 153.0.8010.12, three trials per wallet, and 100 ms
per mocked network RPC/quote. The wallet starts on L2 with a funded Safe. The
test stops at a held wallet prompt; no broadcast takes place. Extension-local
account/chain reads are excluded from RPC counts. Both phases use the same
harness, and real browser signatures are independently verified in Node.

| Median elapsed time | Deployed baseline | Simplified flow |
| --- | ---: | ---: |
| Load Safe, Rabby | 2,307 ms | 1,311 ms |
| Load Safe, MetaMask | 2,278 ms | 1,332 ms |
| Sign, Rabby | 4,154 ms | 276 ms |
| Sign, MetaMask | 4,121 ms | 276 ms |
| Send to wallet prompt, Rabby | 2,330 ms | 463 ms |
| Send to wallet prompt, MetaMask | 2,325 ms | 462 ms |

Every trial has 41 loading requests, 82 → 3 signing requests and 43 → 5
requests from Send to the wallet prompt. The three signing reads are the
source block, controller nonce and Safe nonce. Send reads Composer identity,
Safe nonce, the quote, gas-wallet balance and pending wallet nonce.

The old Sign included a fee preview; the new Sign does not. Including both
Sign and Send still reduces requests from 125 to 8, with about 6.5 seconds
reduced to 0.74 seconds in this controlled workload. This is not a live Composer
benchmark: its real estimation latency, installed-wallet confirmation time,
user network conditions and settlement time remain unmeasured. Loading's
request count is unchanged; parallel reads reduce its latency. Confirmation
retains the existing checks and polling behavior.

## Initial prototype measurements

Same host, Node 22.23.4, sandboxed Chromium 153.0.8010.12 and built Vite preview.
The browser benchmark adapts the existing wallet fixture to an already-created,
funded Safe with 100 ms per mocked RPC and fee-quote request. Both wallet
formats use three trials; signatures are real and independently verified by
the fixture. All transaction broadcasts are mocked or blocked.

| Median elapsed time | Baseline | Initial prototype |
| --- | ---: | ---: |
| Load Safe, Rabby | 2,261 ms | 1,309 ms |
| Load Safe, MetaMask | 2,271 ms | 1,339 ms |
| Sign and preview fee, Rabby | 4,124 ms | 1,342 ms |
| Sign and preview fee, MetaMask | 4,123 ms | 1,342 ms |

The initial prototype reduced signing/preview RPC requests from 82 to 49.
Loading retains all 41 requests but overlaps independent work. These are controlled latency results,
not installed-extension timings or a promise about a particular device.

Separate fresh-context checks of the deployed public page from the ROG host
measured 173–298 ms to open the Falcon key UI, 2.9–12.7 ms for the signature
computation reported by the UI, and 121–134 ms for unlocking a disposable saved
key. Three read-only Solidity verifier calls with the public fixture succeeded
in 15–191 ms. The user's browser/device, actual fee-quote duration and network
latency remain unmeasured; backend estimation and settlement can still add time.

## Final validation and retained failures

- `npm run build` passed for the final candidate. The baseline build and source
  tree are retained from the deployed-equivalent worktree.
- `npm test`: 712 passed, zero failures/skips after initializing the pinned
  protocol and permitting the suite's local test servers.
- Wallet browser regression passed on both configured networks with
  Rabby/legacy and MetaMask/EIP-1559. Sign reads only the controller/Safe nonces,
  requests no quote and performs no Safe-owner inspection. A changed Safe nonce
  stops sending; mock Composer rejection of a consumed controller nonce,
  removed owner or insufficient balance stops before wallet submission.
  Actual browser Falcon signatures are independently verified in Node.
- The existing isolated Anvil integration passed with real Safe 1.5.0 and
  SafeL2 1.4.1 runtimes, including a nonzero transfer. The locally calculated
  hash equals each implementation's `getTransactionHash` result and matches
  its execution receipt. Registry routing is stubbed; this is not native EEZ
  settlement or proof verification.
- Existing-Safe compatibility, hidden navigation/key clearing, responsive
  layouts and recovery browser regressions passed. `git diff --check` passed.
- No Solidity/Rust changes, contract builds, live settlement canary or
  independent chain replay were performed for this frontend change.

Initial harness failures remain recorded: Chromium needed the existing
`CHROME_DEVEL_SANDBOX=/usr/local/sbin/eez-chromium-sandbox`; the first public
probe used the wrong hidden-tab storage key; the isolated checkout initially
lacked pinned protocol sources and local-server permissions. The first new
bytecode-change regression mutated a fallback mock hidden by an earlier Safe
code branch; fixing the mock reached the intended rejection. These are explicit
environment/harness corrections, not unexplained retry-only passes.

The final build first exposed Treasury's zero-value-only helper return type;
the Falcon path now reuses its EIP-712 fields with viem's generic hash function
for nonzero transfers. The first request-count assertion also counted the
dashboard's Composer probe triggered by switching back from Chiado. The
regression now isolates controller/Safe calls; the controlled benchmark starts
with the wallet already on L2 and retains every observed RPC in its counts.
Both first failures and corrected runs are retained.

[Compact measurements](measurements.json) retain all trials, source hashes and
log/harness digests. Raw logs and the diagnostic harnesses are local-only in
`.runtime/performance/` in the performance worktree and are unavailable from
another checkout. Browser regressions use `EEZ_UI_URL` pointed at its isolated
preview and the sandbox helper above. Existing operator work, services and the
deployed dashboard were preserved.
