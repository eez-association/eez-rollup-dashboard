# Falcon settlement links and controller verification

Dashboard baseline: `299837f6f820d9ef29434cbcb2c68afd4e011891`.
Protocol gitlink: `855fe0602484750861b4c31502a1a91355d33ed6`, unchanged.
The candidate is the application change accompanying this record.

## Reproduction and correction

The Ethereum Safe `0x1a38210B3330aa0B41267D605f14C699A7189b60` has an EEZ owner
proxy `0x839C16AaD23349330c6dCb6984579f637fB0AB9e`. The registry maps this proxy
to RollupX controller `0x80D8eC79b73645FC8ddfeFc4d6De153B6e171459`, rollup 2.
Its two observed calls are recorded in [evidence.json](evidence.json).

Both L1 settlements were successful transactions to forwarding contract
`0x07f9e14feb43a6262141bfb598c09b678fd00163`. The baseline rejected them because
the transaction recipient was not the EEZ registry. That rejection also kept
the L1 explorer link hidden indefinitely.

Read-only checks of the same existing transactions reproduced this error in
the baseline and passed in the candidate. Validation included the canonical
L2 receipt and matching Falcon event, Composer correlation, canonical L1
receipt, the configured registry's `BatchPosted` event for rollup 2, historical
Safe authority and exact Safe execution hash. Safe nonces advanced from 6 to 7
and from 7 to 8. No transaction was broadcast during this investigation.

The candidate shows the L1 link when correlation becomes available, separately
from verified execution. Safe success, consumed nonce and authority checks
remain required. Direct registry calls retain their earlier behavior; forwarded
calls without the expected registry/rollup event are rejected. No storage, SDK,
protocol or deployment migration is required.

## Controller source publication

The discovered controller was unverified. Foundry 1.7.1 and Solidity
`0.8.34+commit.80d5c536` reproduced its creation and deployed bytecode with the
recorded constructor arguments. Checks also matched the canonical creation
event, factory mapping, CREATE2 address, source hashes and immutable bindings.

The exact sources were submitted to the RollupX Blockscout API using
`forge verify-contract --root contracts/falcon --chain 696991` with the exact
compiler, constructor arguments, Blockscout verifier and `--watch`. The explorer
subsequently reported full verification, not a partial match. Its published
compiler settings, complete sources, ABI, constructor arguments and both
bytecodes were compared with the prepared input. The hashes and results are
retained in [evidence.json](evidence.json). This verified one existing contract;
it did not install a background verification worker.

## Checks and limits

- `npm test`: 771 tests passed, none skipped. The first sandboxed attempt had
  missing submodule fixtures and denied local test sockets; it was not a pass.
  The pinned submodule was initialized and the suite ran with local sockets.
- `npm run build`: TypeScript and Vite passed; existing bundle-size warning.
- `node tests/falcon-wallet.mjs`: 12 browser combinations passed across all three
  supported networks, both wallet formats and existing/missing wallet networks.
  RPCs were mocked; browser Falcon signatures were real. Tests covered forwarded
  settlement, pending links, delayed L1 receipt checks, scope changes and mobile
  layout. These are not installed-extension or live broadcast tests.
- The focused forwarded-settlement regression failed with the baseline's exact
  receipt-recipient error, then passed alongside the other 15 existing-Safe tests.
  Wrong registry/rollup, malformed or removed events, wrong receipt identity,
  absent Safe success, unconsumed nonce and invalid proxy binding remain rejected.
- Live evidence is read-only revalidation of the two existing transfers, not a
  new end-to-end broadcast or independent protocol replay. No node or signer
  suite ran because neither component nor its protocol pin changed.

Detailed local logs and prepared verification inputs remain in the ignored
`.runtime/` directory of the task checkout; they are not available in another
checkout. The public transaction identities and compact verification results
are committed here. The UI change was not deployed as part of these checks.
