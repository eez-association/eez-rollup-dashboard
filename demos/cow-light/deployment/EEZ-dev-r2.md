# EEZ-X / eez.dev CoW deployment

Deployed on 2026-10-30 using the existing Chiado / EEZ-X network. The public
[deployment record](records/eez-dev-699169-r2.json) contains contract addresses,
receipts, source-verification results and the network identity observed during
deployment. No EEZ infrastructure was redeployed.

## Configuration

The [CoW profile](../config/deployments/eez-dev-699169-r2.json) contains only
CoW-specific token/faucet bindings, artifacts and storage paths. Infrastructure
comes from the same runtime JSON as the dashboard:

```dotenv
EEZ_UI_RUNTIME_CONFIG=.runtime/eez-dev.json
COW_DEPLOYMENT_ENV=config/deployments/eez-dev-699169-r2.json
```

Use these settings for the API, solver and deployment tools, either through the
process environment or a public `COW_ENV_FILE`. Relative dashboard-runtime paths
resolve from the repository root; CoW profile paths resolve from `demos/cow-light`.
Docker uses the existing shared environment variables instead of a host runtime
JSON. Select `COW_DEPLOYMENT_ENV` in the root `.env`; leave `COW_NETWORK` unset
to use the profile's network, or set it explicitly when overriding the profile.
In the container, restore manifests under `/app/runtime` using the same paths.
The image omits historical deployment records; restore these public manifests
from the checkout into the `cow-runtime` volume before starting the services.

RPCs, Composer endpoints, registry, manager, bridges, rollup ID and explorers
are read from the dashboard configuration. Chain identity is checked against
live RPCs and the retained deployment manifests. The identities in the public
record are verification evidence, not another source of active configuration.
Restart CoW services after changing shared configuration.

## Restore public deployment manifests

On a fresh checkout, install the documented Python/contract dependencies and
restore the two public manifests before starting the API. From `demos/cow-light`:

```python
import json
from pathlib import Path

name = 'eez-dev-699169-r2'
profile = json.loads(Path(f'config/deployments/{name}.json').read_text())
record = json.loads(Path(f'deployment/records/{name}.json').read_text())
for setting, entry in [('COW_MANIFEST', 'cowManifest'), ('ROUTE_MANIFEST', 'routeManifest')]:
    destination = Path(profile[setting])
    if destination.exists():
        existing = json.loads(destination.read_text())
        existing.pop('rpc', None)  # Older local manifests stored a transport URL.
        assert existing == record[entry], 'Review the existing manifest'
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(record[entry], indent=2) + '\n')
```

This does not recreate contracts or overwrite an order queue. Preserve the full
runtime directory when moving an existing service, including transaction journals
and pending orders. Only one solver should operate its queue.

The API runs without wallet keys. The solver needs the authorized solver's local
signing configuration and native gas; its private key is not part of the public
profile or records. Set `COW_WRAPPER_EXPLORER_API` only if adding catalog tokens
whose wrappers do not yet exist. Both tokens in this catalog already have
verified official wrappers.

## Validation and local operation

All 15 contracts used by this demo, including the reused factory proxy, are
source-verified against live code. Composer passed
a signed 0.001 ctWETH → ctUSD cross-chain simulation. The temporary allowance was
revoked afterward; no swap was submitted and no signed test order was queued.
This is simulation evidence, not a completed live swap.

The local dashboard uses the API on port 8787. The user services
`eez-cow-local-api.service` and `eez-cow-local-solver.service` manage the local API
and solver. The solver control endpoint is bound to localhost on port 8791;
the dashboard does not expose it. The faucet holds 0.5 ctWETH and 0.01 native
test tokens, sufficient for 50 claims before refill.
