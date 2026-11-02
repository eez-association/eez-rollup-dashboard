# Falcon Safe request flow

Status: accepted UI scope, following the user's request on 2026-11-01 to simplify
the existing performance change. No protocol, contract or deployment change.

The current UI repeats deployment inspection, Safe inspection and Falcon
verification before a Composer quote that already simulates the transaction.
It also quotes immediately after signing and again on Send.

Keep full deployment and Safe compatibility checks during discovery, attachment
and confirmation. Signing needs current controller and Safe nonces, the source
block timestamp, and local signature generation. Compute the Safe transaction
hash locally using the existing Treasury EIP-712 implementation. Send checks the
selected wallet's Composer route, keeps the small Safe nonce consistency check
for exact receipt correlation, obtains a fresh quote, and uses the existing SDK
wallet/fee guards. Remove separate digest/authorization RPCs and the automatic
signing-time fee preview. Composer and the contracts enforce execution validity.

The UI's owners/modules description is a last-checked observation, not a
per-transfer on-chain policy. A nonce read cannot lock future Safe state; the
existing conservative confirmation checks must still refuse mismatched evidence.
Do not cache mutable authorization or silently treat a quote as settlement.
Retain key/input/session invalidation, ambiguous-send recovery and exact L1/L2
receipt checks. No automatic resend or unquoted fallback.

Alternatives: only overlapping all checks leaves unnecessary work; removing all
nonce and receipt checks breaks the existing exact-operation confirmation path.
Changing contracts to enforce extra Safe policy is outside this UI task.

Acceptance: exercise both wallets and networks, quote/simulation rejection,
nonce/key/input/wallet changes and settlement evidence; no quote, contract
authorization call or full Safe inspection on Sign. Compare the same controlled
browser workload against the retained deployed baseline. Document that signing
no longer includes a fee preview, and measure the separate send path as well.

## Safe discovery

Accepted UI scope on 2026-11-02: reduce the remaining startup delay. The deployed
PR #44 still performs 41 reads for a factory Safe, with deployment inspection,
controller inspection and L1 discovery waiting on each other.

Run independent deployment checks and account discovery concurrently, sharing one
L2 block for the factory mapping and controller inspection. Start L1 discovery
as soon as the controller address is known, while its authority is checked.
Publish the result only after all chain, deployment and authority checks pass.
Read-only discovery does not need the wallet's Composer probe; setup and Send
retain that broadcast-route check. Switching the gas wallet must not restart a
key-scoped lookup. Keep key, deployment and attachment invalidation and aborts.

Do not cache mutable ownership or display an unchecked funding address. Retain
the complete factory and attached-Safe checks, fresh signing nonces, fee-quote
guards and settlement confirmation. Persistent discovery caches and new RPC or
contract APIs are outside this change.

Acceptance: compare cold browser loading against PR #44 with the same controlled
RPC latency; verify both supported networks and wallets, absent controllers/Safes,
invalid chains/bindings/authority, cancellation, attachment changes and wallet
switches. Hold independent reads to prove that overlap never bypasses validation.
