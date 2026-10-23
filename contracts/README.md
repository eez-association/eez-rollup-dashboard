# Treasury contracts

Unaudited demo code. This branch contains a contract-only redesign; it is not a
live deployment or an updated dashboard release. No tests, compiler, native
rehearsal or deployment were run for the paired-policy change at the user's request.

## Files to read

| Location | Purpose |
| --- | --- |
| `src/shared/PairedTreasuryPolicy.sol` | One concrete contract deployed on both L1 and L2 |
| `src/l2/L1Owners.sol` | L2 Safe owner adapter; verifies live L1 Safe signatures |
| `src/shared/TreasuryBootstrap.sol` | Optional deployment batch helper for either chain |
| `src/interfaces/` | Safe, allowance module, bridge and EEZ registry ABIs |
| `src/testnet/TestUSDC.sol` | Fixed 1,000-token faucet using the normal bridge |

There is no custom treasury bridge, separate bridge delegate or claim-helper
contract in the active sources. `legacy/` is the separate Solidity 0.7.6 build for
the upstream Safe and AllowanceModule dependencies, not an old treasury policy.
Frozen historical deployment and verification JSON is retained for saved records.

## Payment flow

Deploy the same `PairedTreasuryPolicy` contract twice. Its five constructor arguments are the local Safe, local
AllowanceModule, local token, normal local bridge and the L2 EEZ rollup ID.
L1 uses canonical USDC; L2 uses the wrapped token registered by that bridge.
The constructor reads the local rollup ID from the bridge and checks it against
that bridge's EEZ contract: `MAINNET_ROLLUP_ID()` on L1, `ROLLUP_ID()` on L2.
Missing/reverting getters reject construction; there is no failed-call fallback to
L1. These are EEZ rollup IDs, not EIP-155 chain IDs. The deployed bridge/manager
identities must still be verified during deployment.

The Safe owners call their local policy:

```solidity
paySplit(recipient, amount, onL1, expectedEpoch, fromL1)
```

`amount` and `fromL1` are exact six-decimal units. The L2 contribution is
`amount - fromL1`. `onL1` selects the recipient chain. The Safe's signatures bind
these fields, the local policy target, the Safe's own chain and its nonce.

The implementation is deliberately local-first:

1. Check the payment and that setup is active.
2. `_transferTokens` sends this policy's contribution.
3. `peer.payFromPeer` sends the other policy's contribution, without forwarding
   the payment again.
4. Emit `Paid` on the initiating policy's chain.

Inside `_transferTokens`, the branch is explicit:

- Same destination chain: the allowance module makes the Safe transfer directly
  to the recipient.
- Other destination chain: the module transfers to the policy, then the policy
  calls the normal bridge. L1 approves an exact canonical-token deposit; L2's
  bridge burns the wrapped tokens. No temporary balance or approval is retained.

Only the local Safe can start a payment. Only the registered EEZ proxy representing
the connected peer can call `payFromPeer`. An EOA, an unrelated proxy, or the peer's
original address on the wrong chain cannot take this path. Both policies reject
changed bridge counterparts during payments. Canonical asset and reciprocal peer
bindings are checked once at activation and cannot subsequently change. Payments
do not fetch the other policy's full configuration.

## Setup and budget

1. Reuse a verified normal bridge pair and its wrapped-token mapping.
2. Deploy one policy on each chain with the local bindings above.
3. Through each local Safe, call `connectPeer(originalOtherPolicyAddress)` once.
   These calls provision both peer proxies before any remote view calls are needed.
4. Enable the official AllowanceModule in each Safe, add its **local policy** as
   delegate, and grant 100 tokens per ten-minute period. Use aligned epoch-based
   reset times on both chains. The policies read the module's actual allowances.
5. Include `activate()` in the final Safe setup batch, after both connections exist.
   It validates and activates both policies using an authenticated peer call that
   does not forward again. It needs no separate Safe transaction. The peer Safe and
   local alias on the peer chain are cached for recipient checks.
6. Initiate payments through either Safe. Owner administration remains unrestricted;
   these spending limits govern the policy payment path, not every Safe action.

The shared limit remains 150 tokens per ten-minute epoch. Only the L2 policy
writes the shared counter. Every payment visits it exactly once, including an
L1-only payment with zero L2 contribution. `spent(epoch)` on either policy reports
that same counter. A stale epoch or insufficient local capacity rejects the exact
signed split; contributions are never silently rebalanced.

For L1 initiation, a shared-budget or peer-transfer failure can occur after the
local transfer. Failure must propagate through the atomic EEZ execution and the
Safe's zero-refund execution to revert the entire payment. This is a protocol
requirement; native runtime validation of the new call graph remains outstanding.

## Testnet faucet

Deploy `TestUSDC(normalL1Bridge, destinationRollupId)` on L1. It starts with zero
supply and has exactly two minting entry points:

```solidity
claim(recipient);     // Exactly 1,000 tokens on L1.
claimOnL2(recipient); // Exactly 1,000 tokens through the normal bridge to L2.
```

Both are public and repeatable. The amount, L1 bridge and destination rollup are
fixed; callers cannot supply an arbitrary amount or route. There is no owner,
registration transaction, separate dispenser, claim helper or per-wallet quota.
The constructor only stores the normal L1 bridge, not an L2 bridge address.
The bridge creates/reuses the wrapped representation on L2.

`claimOnL2` mints to the token contract itself, calls internal
`_approve(address(this), bridge, amount)`, deposits, clears approval and verifies
its previous balance was preserved. OpenZeppelin ERC20 permits the token contract
to hold its own tokens and permits self-transfers. `transferFrom` still checks
allowance even when the sender and recipient are equal. A failed bridge call
reverts the new mint and approval. Real Ethereum USDC has no faucet.

## Validation and migration status

The Solidity tests cover the fixed faucet, self-transfer behavior, local-first
ordering, both initiating Safes/destinations, exact funding splits, peer
permissions, EEZ rollup identity, one-time activation, shared-budget accounting,
signature replay and rollback. They use
real Safe/AllowanceModule/normal bridge contracts with a single-EVM EEZ transport
fixture; passing them would not establish native protocol execution. They have
**not been executed** for this change.

The dashboard deployment planner, saved-transaction signing, capability checks
and settlement tracking still target the previous source release. They need a
separate migration for two local policy addresses, peer setup, and initiating-chain
`Paid` events. Native rehearsal scripts also target the removed policies and must
be ported before use. Do not point the dashboard at these new contracts yet.
The release builder's contract list is updated, but a new compiler/source bundle
has not been generated. Historical immutable bundles must not be rewritten.

The pinned upstream dependencies are recorded in the repository submodules.
When execution is authorized and dependencies are available, contract checks are:

```sh
forge build --root contracts/legacy
forge test --root contracts
```

The separate mainnet-test profile requires an explicitly selected Ethereum fork;
ordinary contract tests do not need a live network.
