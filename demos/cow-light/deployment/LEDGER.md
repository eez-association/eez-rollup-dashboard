# Ledger deployment

The deployment workstation signs deployment transactions with Ledger through Foundry `cast mktx`.
Python checks the recovered signer and every transaction field, journals its
hash before broadcast, and retains the existing recovery behavior. It never
exports a Ledger key. This path has automated signing-adapter tests, but still
requires a real Ledger rehearsal; automated tests do not prove device support.

The Ledger deployer remains the authenticator manager. `COW_SOLVER_ADDRESS`
must be a separate, explicit address. Only that address is initially allowlisted;
its private key stays on the solver machine. The route admin is also the Ledger.

## 1. Create the solver on the solver machine

Run as your normal user, outside the repository, using a Python environment
with the demo requirements installed. This creates a new file exclusively with
mode 0600 and prints only the public address. It refuses to overwrite a file.

```bash
mkdir -p "$HOME/.config/eez-cow-light"
chmod 700 "$HOME/.config/eez-cow-light"
python3 demos/cow-light/deployment/create_solver_wallet.py \
  --output "$HOME/.config/eez-cow-light/solver.key"
```

Back up the key securely. Send only the printed address to the deployment workstation. Later set
the server's `COW_SOLVER_KEY_FILE` to the absolute path of this file. Docker's
solver user (UID 1000) must be able to read it; never make it world-readable.
The generator can also run inside the built image with an explicitly mounted
private output directory and the host user's UID/GID. Do not generate a key in
an ephemeral container filesystem. Do not start the worker yet.

For a Docker-only server, after rebuilding the image from this revision, use
this instead of the Python command above (it creates the same file, once):

```bash
docker compose build cow-api
docker run --rm --network none --read-only \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$HOME/.config/eez-cow-light,dst=/keys" \
  eez-cow-light:local python deployment/create_solver_wallet.py \
  --output /keys/solver.key
```

## 2. Prepare the deployment workstation

Install Python 3, Node/npm and Foundry (`cast`, `forge`) using their official
installation instructions. Connect and unlock Ledger and open its Ethereum app.
Use a derivation path that actually resolves to your manager address; do not
assume the first Ledger account is the right account.

```bash
cd demos/cow-light
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci --prefix contracts --ignore-scripts
forge build --root contracts
```

Set these public configuration values in your shell on the deployment workstation (not the server's
localhost RPC configuration). Replace the example endpoints and all marked values before proceeding:

```bash
export COW_NETWORK=mainnet
export L1_RPC=https://deployment.example/rpc/l1
export L2_RPC=https://deployment.example/rpc/l2
export L2_FRONT=https://deployment.example/composer/l2
export L1_CHAIN_ID=1 L2_CHAIN_ID=REPLACE_WITH_L2_CHAIN_ID L2_ROLLUP_ID=REPLACE_WITH_ROLLUP_ID
export BRIDGE_L1=REPLACE_WITH_L1_BRIDGE
export BRIDGE_L2=REPLACE_WITH_L2_BRIDGE
export EEZ_MANAGER_L2=REPLACE_WITH_L2_MANAGER
export WETH_L1=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
export WETH_L2=REPLACE_WITH_OFFICIAL_BRIDGE_WRAPPER
export DEPLOYER_SIGNER=ledger
export DEPLOYER_ADDRESS=REPLACE_WITH_LEDGER_ADDRESS
export LEDGER_DERIVATION_PATH="REPLACE_WITH_YOUR_LEDGER_PATH"
export COW_SOLVER_ADDRESS=REPLACE_WITH_SERVER_SOLVER_ADDRESS
export COW_DEPLOY_MAX_FEE_WEI=5000000000000000
export COW_MANIFEST=runtime/ledger-deployment/cow-deployment.json
export ROUTE_MANIFEST=runtime/ledger-deployment/route-deployment.json
export ORDER_QUEUE=runtime/ledger-deployment/ui-orders.jsonl
export SOLVER_LOG=runtime/ledger-deployment/solver-worker.log
export COWSWAP_ARTIFACTS=contracts/node_modules/@cowprotocol/contracts/lib/contracts
unset DEPLOYER_PRIVATE_KEY DEPLOYER_KEY_FILE UNIVERSAL_ROUTE_L2
unset COW_DEPLOYMENT_ENV COW_ENV_FILE SETTLEMENT_L2
```

The scripts use `GPv2Settlement.json` and `GPv2AllowListAuthentication.json`
from `COWSWAP_ARTIFACTS`. Confirm those files exist before proceeding; use the
directory containing them if your installed artifact layout differs.
Do not use the old settlement or route manifest. Preserve any prior journals;
never delete them to force a retry. Changing solver after a journal is created
intentionally fails its identity check.

## 3. Establish WETH and funding before deployment

Using your wallet and the official bridge, bridge Ethereum **WETH ERC20** to
the target rollup, then read the wrapper on L2:

```bash
cast call "$BRIDGE_L2" 'getWrappedToken(address,uint64)(address)' \
  "$WETH_L1" 0 --rpc-url "$L2_RPC"
```

Set `WETH_L2` to that nonzero address. Native ETH wrapped locally on L2 is not
this asset. The scripts now check bridge peers, rollup IDs, manager and registered
WETH wrapper before any deployment. They stop if this prerequisite is missing.

The Ledger needs native ETH on L2 for deployments, including the Composer-quoted
cross-chain helper deployment. Bridging WETH separately requires L1 gas and WETH.
The solver needs native ETH on L2 for later settlements, but no trading inventory.
The fee budget is a maximum **per transaction**, not an estimate or total budget.

## 4. Deploy with Ledger confirmations

These commands send real transactions after device confirmation:

```bash
python deployment/deploy_cow.py
python deployment/deploy_route.py
```

Review the address, chain, transaction and fee ceiling for every confirmation.
Deployment first initializes the manager to the Ledger, authorizes the separate
solver and creates settlement. The route command then creates the L2 route and
the correctly authorized L1 helper using the official bridges.

Composer quotes currently have a short lifetime (at most 31 seconds). If a
quote expires during device review, the script rejects the signed result before
journaling/broadcast. Rerun to request a fresh quote and a new confirmation;
do not rush review or bypass the check. If a hash is already journaled, reruns
only reconcile it, never silently replace it. Stop for manual inspection on an
ambiguous submission. A rejected or disconnected device has no software-key
fallback. Device-specific blind-signing requirements must be reviewed during
the hardware rehearsal, not assumed supported by these tests.

## 5. Verify, transfer records, then simulate

Verify both new contracts on their explorers using the exact build metadata;
also verify the settlement/authenticator and their manager/solver bindings.
Back up the complete runtime deployment directory and journals on the deployment workstation.
Transfer public manifests to the server's Docker `cow-runtime` volume and set
the same `COW_MANIFEST`, `ROUTE_MANIFEST`, `WETH_L2`, chain and bridge values
there. Never copy the server solver key to the deployment workstation. Follow the runtime-volume
import instructions in the demo README with services stopped.

Restart only the API, run `check_deployment`, then complete a fresh signed-order
Composer simulation. Enable the `cow-solver` profile only after those checks.
Starting the worker executes pending signed orders; it is not simulation mode.
