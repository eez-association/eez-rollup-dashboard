# Falcon mainnet wallet setup

Implementation baseline: dashboard main `497cdddb753d2a3d95dcc90efc15706f48818f70`.
Target: `eez-association/eez-rollup-dashboard`. Core gitlink remains
`855fe0602484750861b4c31502a1a91355d33ed6`; no protocol or existing deployment changes.
See the accepted [application proposal](../../proposals/falcon-mainnet.md).

The baseline rejects Ethereum 1 / RollupX 696991, registry/manager
`0x4B2760F84B83d6b3829E30A7573B0172B6d6402C`, rollup 2. Reproduced by passing
that discovered route to the baseline `falconDashboardConfig`; it returns a null
deployment and the Chiado-only message. The mainnet configuration regression
repeats that input against the candidate and requires the new profile, while
mixed chain/registry/rollup combinations remain rejected.

## Read-only mainnet observations

[read-only.json](read-only.json) retains chain checkpoints, dependency code hashes
and the expected CREATE2 addresses. Both networks have the canonical deterministic
deployer; Ethereum has the expected SafeL2 1.4.1 singleton and handler. All three
planned Falcon addresses had no code at the recorded observation time. No funding,
deployment, Safe change, or other transaction was broadcast on a public network.
These observations are not a deployment certificate; the UI checks again before use.

## Reproducibility and local checks

Foundry 1.7.1, Solidity 0.8.34+commit.80d5c536, Node 22.23.4. The compiler profile
is optimizer 1 / via IR / Cancun. Sources were recovered from the existing verified
contracts linked in [the source README](../../../contracts/falcon/README.md).
All three creation bytecodes reproduced exactly; [artifacts.json](artifacts.json)
records that comparison. The generated browser artifact is checked by
`node scripts/build-falcon-artifacts.mjs --check` in CI.

[local-evm.json](local-evm.json) records real CREATE2 transactions on two disposable
Anvil nodes with chain IDs 1 and 696991, independent ports and test wallets. The
test checks constructor-bound runtime hashes, duplicate-deployment rejection,
a frozen browser signature, a fresh Falcon authorization, rejection of a Chiado
destination domain and wrong nonce, and atomic Safe initialization for its caller.
The EEZ manager/registry routing is stubbed. This is EVM contract execution, not
native EEZ cross-chain settlement or follower replay. Local gas usage is not a
mainnet fee quote.

Checks:

- `npm test`: 750 tests passed, no skips.
- `npm run build`: passed (existing large-chunk warnings).
- `node scripts/build-falcon-artifacts.mjs --check`: passed.
- `forge fmt --check --root contracts/falcon` and `git diff --check`: passed.
- `node tests/integration/falcon-shared-setup.mjs`: passed.
- `node tests/falcon-setup-browser.mjs`: passed with sandboxed Chromium and mocked
  RPC. Covers both wallets, no-prompt initial load, no Falcon key requirement,
  rejection, partial/complete setup, incompatible code, reload, uncertain broadcast,
  replacement-hash recovery and a late reply after an account switch. No automatic
  deployment or resend. A focused unit test holds receipt propagation to check that
  an early wallet reply does not trigger a premature transaction lookup.
- Hidden-navigation browser regression: passed, including lazy loading and mobile.
- `node tests/falcon-wallet.mjs`: passed across all three profiles, both wallet
  formats and known/missing wallet networks. Mainnet cases also fund on L1 and
  sign/quote/confirm a transfer, including ETH/USD costs (mock RPC/receipts and real
  browser Falcon signatures).
- Existing recovery and existing-Safe browser regressions: passed. They include
  cancelled/replaced requests, cross-tab recovery, Safe 1.5.0, EIP-7702 owners,
  owner/nonce changes, reload and retained modules.

The first local unit invocation lacked socket permission for RPC-server tests;
the permitted run completed the full suite. Initial validation also exposed a
case-only bytecode assertion and incomplete browser fixtures (currency name,
cancelled-wallet object errors and the deliberately locked/replaced test key).
Those were corrected before the final checks; original local diagnostic logs
remain under the worktree's ignored `.runtime/` and are not portable evidence.

The full CI Treasury/CoW/dependency matrix is not replaced by these focused checks.
No installed-extension or live mainnet settlement rehearsal has run. Source
verification of future mainnet controllers requires the deployment's worker to
follow the new factory; browser code checks do not publish explorer source.

## Upgrade and rollback

Ship the frontend and generated artifact together. Existing configured mainnet
endpoints and fee settings are reused; no new `.env` fields or backend changes.
Testnet bindings, encrypted backups and existing recovery records remain valid.
The new public infrastructure journal uses a distinct kind, scoped to the route
and paying account. Older UI builds ignore that journal and cannot expose the
new mainnet route. Reverting the UI does not delete contracts, keys, recovery
records or Safe ownership. User-specific controllers and Safes remain separate
wallet-authorized actions after shared setup.
