# EEZ cross-chain CoW Light demo

This directory is the complete, minimal demo stack. It is deliberately
separate from the dashboard's monitor and treasury applications:

```text
deployment/   idempotent deployment helpers and manifests
contracts/    only the two final route contracts used by this demo
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

## Network profiles

Every Python entry point uses `network_config.py`. Select `COW_NETWORK=mainnet`
(the default, preserving the original Ethereum/EEZ addresses) or
`COW_NETWORK=chiado` (Chiado 10200 / EEZ-X 906969). Public defaults live in
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

Chiado is a configuration scaffold, not a deployed demo. Copy
`.env.chiado.example` to `.env` and fill its RPCs and infrastructure addresses.
Deploy test WETH and a funded Uniswap V2 pool, then populate
`config/token-catalog.chiado.json` with its `weth` and `tokens` (the same token
entry format as the mainnet catalog). Deploy GPv2 first, then the route. To
derive wrappers before their first bridge, supply `WRAPPER_REFERENCE_TX` and
`WRAPPER_PREFIX_LEN` for that network's bridge creation code. An existing
wrapper can be resolved without those fields. Chiado never inherits mainnet
addresses, token liquidity or wrapper traces.

To run both demos, launch each API and worker with its own environment and
distinct `PORT` values (for example API 8787/8788 and worker 8791/8792).
`PORT` applies to the process being started, so don't set one shared port for
the API and worker. Both use the same code and separate profile state.

## Deployment

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
The GPv2 script refuses to overwrite an existing manifest. Recovery from an
interrupted deployment before manifest persistence still requires inspecting
the submitted transactions; these scripts do not yet journal every stage.

For systemd, copy `solver/eez-cow-solver.service`, replace `/opt/eez-cow-light`
with this directory, and provide `SOLVER_KEY_FILE` through a protected
EnvironmentFile. Do not put a secret in this repository.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --test tests/ui-network.test.cjs
python3 -m py_compile network_config.py backend/server.py solver/*.py deployment/*.py
forge build --root contracts
```

The deployment scripts are network tools and are not run as part of the web
build. Use canonical Composer and RPC endpoints when validating a settlement;
an execution-RPC receipt alone is not L1-finality.
