# Safe 1.4.1

Byte-identical source subset from Safe's release `v1.4.1`, commit
[`bf943f80fec5ac647159d26161446ac5d716a294`](https://github.com/safe-global/safe-smart-account/tree/bf943f80fec5ac647159d26161446ac5d716a294).
Only `contracts/proxies/SafeProxy.sol` is needed here. The original LGPL-3.0
license and source header are retained. Do not edit the vendored contract.

The application uses SafeL2, the event-emitting Safe implementation, on L1.
Its name does not require the Safe account to live on L2. OwnedSafeFactory
creates the release's unmodified SafeProxy and initializes it atomically.
SafeL2 and CompatibilityFallbackHandler use the original artifacts from
`@safe-global/safe-contracts@1.4.1`, with npm integrity
`sha512-fP1jewywSwsIniM04NsqPyVRFKPMAuirC3ftA/TA4X3Zc5EnwQp/UCJUU2PL/37/z/jMo8UUaJ+pnFNWmMU7dQ==`.
The package's gitHead matches the release revision. Their runtime hashes match
the official deployment registry: SafeL2
`0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff`
and handler `0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9`.
The release uses Solidity 0.7.6, optimizer disabled, no via-IR. Artifacts are
retained as test runtime snapshots in `tests/falcon/fixtures/deployed-code.json`,
without an npm runtime dependency.

Only OwnedSafeFactory and its imported SafeProxy compile with the application's
Solidity 0.8.34, optimizer runs 1, via-IR, Cancun profile. The original Safe
implementation fails to compile under that via-IR profile; do not patch upstream
assembly to work around this. Tests deploy the same release bytecode as the live
singleton and handler. The mainnet profile uses their canonical addresses;
the earlier Chiado deployment uses separately deployed copies.

The official deployment registry at commit
`7b1fb6d615ab2d2999550ec9166554b180e813e5` did not list Chiado 10200 for 1.4.1;
the canonical singleton, proxy factory and handler addresses had no code on
Chiado when checked on 2026-10-13. No canonical deployment is claimed here.
