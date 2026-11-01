# Falcon existing-Safe compatibility

The existing-Safe flow now accepts a connected signing owner of a threshold-one
Safe with multiple owners, and recognizes the reviewed Falcon factory proxy.
It preserves the existing owners, threshold, modules and fallback handler.
Contract recognition does not authorize the gas wallet to administer a Safe
controlled solely by a contract.

## Source and scope

- Repository: `eez-association/eez-rollup-dashboard`.
- PR base: `feat/falcon-safe-demo` at
  `52bd0a6ef1a0627bfc8b99ad4f2c2091790a2254`.
- Candidate branch: `codex/falcon-safe-proxy-compatibility`; the PR head identifies
  the candidate source. No contracts, release artifacts or protocol pins changed.
- Protocol gitlink: `855fe0602484750861b4c31502a1a91355d33ed6`.
- Safe gitlink: `bf943f80fec5ac647159d26161446ac5d716a294`.
- Node 22.23.4, Anvil 1.7.1 (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`),
  Chromium 153.0.8010.12 with its sandbox enabled.

Public-chain activity was read-only, including `eth_call` simulations. No owner
signature was requested and no public transaction was sent. Local Anvil
transactions use disposable fixture accounts and do not change public state.

## Observations and reproduction

Captured state is in [existing-safes.json](../../../tests/falcon/fixtures/existing-safes.json).
Before/after inspection and simulation outputs are in
[read-only-checks.json](read-only-checks.json). All reads for each address used
one block number; the block hash was checked again after inspection.

| | Ethereum mainnet | Chiado |
| --- | --- | --- |
| Safe | `0x1a38210B3330aa0B41267D605f14C699A7189b60` | `0x7e044b95c8560B9347E40297E9aC5247353B63a2` |
| Block | 26319996 | 23793434 |
| Version | Safe 1.5.0 | SafeL2 1.4.1 |
| Owners / threshold | 2 / 1 | 1 contract owner / 1 |
| Enabled modules | 1 | 0 |
| Transaction / module Guard slots | both zero | both zero |

The mainnet proxy and singleton match the published 1.5.0 runtimes already
supported by Treasury. One owner has an EIP-7702 delegation; the other has no
code. Both qualify for ECDSA Safe approvals. The old Falcon flow rejected this
valid owner configuration with `Only a 1-of-1 Safe owned by the connected wallet
is supported.`

The Chiado proxy has full runtime hash
`0xb30ba1e3d8e15fff550f82025529177dabc8e791b5473a8f0e66d5f6f08bffbf`,
already pinned in Falcon's deployment. Its executable proxy body differs from
Treasury's artifact, so stripping metadata does not resolve the mismatch. The
baseline reported `This address is not a supported Safe proxy`. The candidate
recognizes this exact runtime, verifies the canonical SafeL2 singleton, then
identifies the sole contract owner
`0x71Fa743C56Eb8f389c1cbA367B9d80f86A25C922`. The gas wallet still cannot replace
that owner. Unknown proxy/implementation code and configured Guards remain rejected.

The new regression file was run against unmodified application sources first:
8 tests selected, 3 passed and 5 failed, covering the two-owner rejection,
post-addition loading/recovery, proxy recognition and duplicate-owner diagnosis.
The same 8 tests pass after the change. Detailed first-failure logs remain local
in `.runtime/safe-compatibility/`; they are not available in a fresh checkout.

To reproduce the mainnet read-only simulation with an archive-capable chain-1 RPC:

1. Pin block 26319996 and check its hash against the snapshot. Use
   `inspectExistingSafe(client, address, signal, blockNumber)` to check the Safe.
2. Build `ownerTransaction({ l1: { chainId: 1 } }, address,
   '0x00000000000000000000000000000000000faca0', 4n)`. This candidate owner is a
   simulation-only address, not a mainnet Falcon deployment.
3. Compare `safeTransactionHash(transaction)` with the Safe's
   `getTransactionHash` at that block. Both equal the recorded Safe transaction hash.
4. For each recorded owner, issue **only `eth_call`**, with that owner as `from`,
   the Safe as `to`, gas `0xf4240`, and
   `encodeSafeExecution(transaction, safeOwnerApproval(owner))` as `data`.
   Both calls returned ABI `true`. This uses Safe's caller-authenticated `v=1`
   approval, not a signature from the user's wallet.
5. Recheck the canonical block hash. Simulation has no persisted owner change.

The two-owner configuration is reproduced without external RPC dependencies by
the unit, browser and isolated EVM regressions below. The EVM test uses the exact
observed proxy builds and corresponding singleton code hashes, with fresh fixture
state. It exercises real ECDSA typed approvals, including a delegated EOA,
1-of-2 to 1-of-3 owner addition, canonical recovery and a subsequent Safe call
from the added owner. It asserts retained owners, modules, threshold and handler,
and rejects a different sender presenting the added owner's `v=1` approval.
Registry lookup is stubbed and the cross-chain caller is impersonated locally;
the test does not establish native EEZ routing. Results: [evm-checks.json](evm-checks.json).

## Validation

- `npm test`: 712 passed, zero failed/skipped. The first fresh-checkout run had
  one missing-source failure because the pinned protocol submodule was absent;
  initializing the unchanged pins resolved that prerequisite.
- `npm run build`: passed; existing Vite large-chunk advisory remains.
- `node tests/integration/falcon-existing-safe.mjs`: both runtime cases passed.
  Its initial harness observed an old head through viem's default cache; disabling
  caching for rapidly mined Anvil blocks fixed that test setup. Failed runs were
  retained locally under `.runtime/falcon-existing-safe/`.
- `node tests/falcon-existing-safe-browser.mjs`: passed with sandboxed Chromium,
  mocked RPCs and real typed signatures. Covers proxy/contract-owner errors,
  owner membership, higher thresholds, disagreement between wallet/dashboard,
  owner or nonce changes during signing, recovery and reload with three owners.
- `npm run test:falcon:browser`: all six scripts passed, including both deployed
  network profiles, Rabby/legacy and MetaMask/EIP-1559 test providers, and 26
  cross-chain-call UI scenarios. CI results are recorded on the PR.

Existing attachment/recovery storage formats are unchanged. Older clients retain
their two-owner restriction and cannot load a newly attached three-owner Safe;
rolling back the UI does not undo an on-chain owner addition. No deployment or
on-chain change is part of this PR.

The configured Falcon routes still pair EEZ-X with **Chiado 10200**. These checks
establish compatibility with the specified mainnet Safe's code and authorization
shape, not a deployed mainnet Falcon route. Native settlement, follower replay
and installed-wallet end-to-end mainnet signing were not run. Solidity builds
and broad Treasury deployment suites were not rerun locally because their code
and artifacts are unchanged; CI retains those checks.
