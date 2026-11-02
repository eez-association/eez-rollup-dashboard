# Pinned verifier source

Vendored unchanged from [ZKNoxHQ/ETHFALCON](https://github.com/ZKNoxHQ/ETHFALCON/tree/820da4b6f66c1ada61b6429b80da10fad0d4efc6),
commit `820da4b6f66c1ada61b6429b80da10fad0d4efc6`.

This is the minimal dependency closure for `falcon_core`, `hashToPointNIST`,
public-key decompression and the forward NTT. The demo uses SHAKE256, not the
Keccak-based ETHFALCON variant. The upstream compact-input contract, mutable key
storage helpers and permissive signature decoder are not used. See
[the wrapper contract](../../src/FalconVerifier.sol) for strict padded framing.

Retain upstream headers and [MIT license](LICENSE.txt). This is research code,
not an audited wallet authorization mechanism.
