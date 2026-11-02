# Falcon on Ethereum and RollupX

Status: accepted application scope. Add the mainnet route requested by the user;
the connected wallet pays for setup. No operator wallet, protocol upgrade, or
agent-initiated mainnet broadcast is required.

The existing profiles only bind Chiado to the two test rollups. Add Ethereum 1
and RollupX 696991 (rollup 2), with observed chain checkpoints and manager/registry
addresses. Reuse the canonical SafeL2 1.4.1 implementation and handler on Ethereum.
The browser offers three explicit setup transactions for missing shared contracts:
FalconVerifier and FalconL1ControllerFactory on L2, OwnedSafeFactory on L1.
Use the existing deterministic deployment proxy, reproduced compiler inputs, and
fixed salts. Anyone can pay; these contracts give the deployer no administration
or Safe ownership. Verify exact runtime code and constructor bindings before use.

Setup must not run on page load. Missing contracts show a setup action, never an
endless Safe lookup. Existing contracts are reused only after verification; a
wrong checkpoint, deployer, dependency, or occupied address blocks setup. Persist
public submission details before opening the wallet, retain late hashes, and
require reconciliation after uncertain broadcasts. Never automatically resend.
Changing account or network must not reattribute an in-flight request.

After infrastructure setup, retain the existing per-key controller, Safe choices,
Falcon signing, fresh compact fee quote, wallet session guards, and canonical
L1/L2 confirmation. The gas wallet has no Falcon authority. Testnet profiles and
encrypted key storage remain compatible; mainnet controllers and Safe attachments
use their own deployment scopes. No existing owner/threshold changes are automatic.

An alternative is operator deployment followed by hardcoded addresses. Wallet
setup avoids that dependency and uses the same verified addresses for all users.
Simply allowing new chain IDs would point users at absent or incompatible code.

Acceptance: reproduce artifacts from retained inputs; exercise real CREATE2 setup,
Falcon verification and constructor bindings on isolated Anvil; cover absent,
partial, complete and incompatible deployments, wallet rejection/changes,
uncertain submissions and reload recovery. Run the existing Falcon flows on both
testnets and the mainnet profile. These checks do not establish live native
cross-chain settlement; a wallet-authorized mainnet rehearsal remains separate.

Upgrade: ship sources/artifacts and UI together; no server migration or .env
changes for the already configured mainnet dashboard. Reverting the UI hides the
new route but does not remove contracts, keys, recovery records or Safe ownership.
