# ROG rollup 4 deployment

Observed on 2026-10-29. The public dashboard is
<https://eez.asuscomm.com/dashboard/>. Press **Ctrl+Alt+Shift+T** to reveal
Treasury and CoW Light, then select **CoW Light Demo**.

The browser test sold **0.001 ctWETH** and received
**0.099699701498895209 ctUSD**, using the official existing EEZ bridges.
The controlled test wallet approved only the sell amount. It exercised the
actual dashboard iframe, API, solver, L1 pool and L2 settlement; it did not test
a wallet extension. Both settlement receipts were successful and canonical.
This observation does not assert consensus finality.

Public addresses, manifests, verification results and receipt hashes are in
[`records/rog-916969-r4.json`](records/rog-916969-r4.json). The old
`rog-916969.json` record belongs to rollup 1 and a different L2 genesis.
Some deterministic contract addresses and transaction hashes repeat across
these chains, so chain ID or address alone does not identify the deployment.

## Configuration

Set these public values in the host dashboard `.env` and select that file with
`COW_ENV_FILE`. Keep signing keys outside tracked files.

```dotenv
EEZ_ROLLUP_ID=4
EEZ_L1_BRIDGE_SENDER=0x44eAf2768f6BaEe901192a97728a42978bED4eA1
EEZ_L2_BRIDGE_RECEIVER=0x61E1aCdCEC0a4993a9C85141187602119AddEB59
EEZL2_ADDRESS=0x4B2760F84B83d6b3829E30A7573B0172B6d6402C
EEZ_UI_L1_RPC_UPSTREAM=http://127.0.0.1:18645
EEZ_UI_L2_RPC_UPSTREAM=http://127.0.0.1:18688
EEZ_UI_L2_FRONT_UPSTREAM=http://127.0.0.1:18998
COW_PUBLIC_L1_RPC=https://eez.asuscomm.com/rpc/l1
COW_PUBLIC_L2_FRONT=https://eez.asuscomm.com/composer/l2
```

Select `COW_DEPLOYMENT_ENV=config/deployments/rog-916969-r4.json` relative to
`demos/cow-light`. The profile pins the genesis and assets but obtains the
bridges, manager and RPCs from the shared environment. Runtime journals,
manifests and the order queue live under
`runtime/chiado/deployments/rog-916969-r4/`; preserve that directory when
restarting. The public record contains copies of both manifests for inspection
and recovery, but is not a replacement for transaction journals or the queue.

For another Chiado rollup, use the generic deployment workflow in the demo
README, a new profile and a fresh runtime directory. Discover and validate its
official bridges first. This deployment reused the existing Chiado test-token
pool, bridged 0.01 native tokens for gas and 1 of each test token, then deployed
GPv2 and the route/helper. The old liquidity setup contract binds the old
bridge: do not use its wrapper initializer on rollup 4. Current official
wrappers are `EEZBridgedToken`, not the older `WrappedToken` artifact.

## Host services and rollback

The API listens on `127.0.0.1:18787`, and the solver listens on
`127.0.0.1:18791`. Installed user units are `eez-cow-rog-api.service` and
`eez-cow-rog-solver.service`. Their unit files and protected-key runner are in
the deployment checkout's ignored `.runtime/` directory. The API process does
not receive a signing key. Both services restart on failure and are enabled
for the user's session. **User lingering is disabled: unattended startup
before login after a reboot is not configured.** Keep this checkout and its
virtual environment in place while these units are installed.

```bash
systemctl --user status eez-cow-rog-api.service eez-cow-rog-solver.service
journalctl --user -u eez-cow-rog-solver.service -n 50
systemctl --user restart eez-cow-rog-api.service eez-cow-rog-solver.service
```

The native dashboard UI image is `eez-rollup-ui:cow-native-r4-20261029`.
It replaces the iframe with the dashboard's shared wallet and native React
controls. Browser regression tests cover approval/signing, account changes,
quote expiry, cancelled switches, reverted approvals and lost API responses
with mocked transactions. The original real-chain swap record above was
captured before this UI replacement. The previous embedded-demo image
`eez-rollup-ui:cow-r4-20261029` is retained for UI rollback.

The deployment overlay
`.runtime/rog-r4-dashboard.override.json` sets that image and
`EEZ_UI_COW_UPSTREAM=http://127.0.0.1:18787`. Apply it together with the
operator's `data/auxiliary-916969-r4/dashboard.compose.json`, targeting only
`ui` with `up -d --no-deps ui`. Existing network settings, monitor and trace
services are preserved. The previous image is retained for rollback:
`sha256:5111385ccf77590da18360c70f5348468cf66a25bec196c6105cc13be89478be`.
To roll back, set the overlay's UI image to that digest and apply the same
compose command; stop the two demo services if the demo is being removed.

The explorer verifier was crash-looping while parsing the upstream Vyper
compiler list. `.runtime/rog-r4-verifier.override.json` sets
`SMART_CONTRACT_VERIFIER__VYPER__ENABLED=false`; it was applied with the
operator's `explorers.compose.json`, targeting only `verifier` with
`up -d --no-deps verifier`. Solidity verification works and all ten new demo
contracts/wrappers/proxies are fully verified. Vyper verification remains
disabled until the verifier supports the compiler list. Chain, bridges and
explorer database were not restarted. Retain both overlays when recreating
the operator stacks; using the base compose files alone drops the overrides.

## Test limits

The browser run used a local EIP-1193 adapter whose private key stayed in the
Node process. It allowed one bounded approval and a validated GPv2 order;
RPC reads and all submissions used the real network. The deployment directory
retains the test journal and screenshot. No second swap was submitted when
capturing the settled activity after reload.

The previously documented clearing-price/slippage limitation is unchanged.
This successful stable-pool test does not establish execution under changing
pool prices or production readiness.
