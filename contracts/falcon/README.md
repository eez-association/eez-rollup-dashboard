# Falcon wallet deployment sources

These are the exact compiler sources of the existing Falcon demo. Retrieved
from the verified [ROG verifier](https://eez.asuscomm.com/explorer/address/0x1F7B6E9BfC86F2d72C44E3cEF9b133C59c57C6E9),
[ROG controller factory](https://eez.asuscomm.com/explorer/address/0x935808C804FC35a3C38BAf6Dd1cf4b408352a3CB)
and [Chiado Safe factory](https://gnosis-chiado.blockscout.com/address/0xB90b9d8305E5E6Dc87B9173B7c0dC3b4AE7ec04B).
All three creation bytecodes were reproduced exactly with Solidity
0.8.34+commit.80d5c536, optimizer 1, via IR, Cancun. The separate Foundry root
retains their source paths and metadata without changing Treasury artifacts.

Run `node scripts/build-falcon-artifacts.mjs` from the repository root to rebuild
the browser artifact; `--check` verifies it. The artifact retains an input hash,
initcode, runtime and named immutable offsets. Constructor arguments are bound
by the mainnet deployment plan, including destination chain 1. No deployer gets
an administrative role. Sources under `vendor/` are unchanged; retain licenses.

These are research/demo contracts, not audited wallet security. Mainnet support
does not change the existing proof/signing trust model. See the
[Falcon runbook](../../docs/runbooks/falcon-safe-demo.md) for the wallet flow and
the distinction between local validation and live settlement.
