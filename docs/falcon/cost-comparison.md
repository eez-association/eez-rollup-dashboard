# Falcon Safe cost comparison

The imported POC model compares direct Ethereum execution with observed EEZ-X
work repriced under editable assumptions. It is displayed after a transfer,
separately from the compact fee quote that authorizes the wallet reservation.
It does not estimate live mainnet prices or add a second settlement charge.

The [reference record](safe-cost-reference.json) retains the public benchmark
inputs, runtime/compiler identity, price sources and blob observations from
2026-10-14. A temporary controller replaced cross-chain forwarding with a
direct Safe call while preserving Falcon authorization. Three first transfers
on Anvil 1.7.1 (Osaka), using Solidity 0.8.34/runs 1/via-IR/Cancun and SafeL2
1.4.1 release bytecode, measured 5,384,699–5,650,196 execution gas excluding
transaction base gas and calldata. This is a sample range, not a worst-case
bound or a fresh simulation. The temporary adapted benchmark source/runner
was not retained; the reference's hashes do not make it reproducible here.

Ethereum adds 21,000 base gas and current calldata (4 gas per zero byte, 16 per
nonzero byte), applying the transaction-level calldata floor as a maximum.
EEZ-X uses observed L2 gas at its source block base fee, plus the entire L1
settlement's execution/calldata repriced at the chosen Ethereum gas price.
Its proportional blob share is
`ceil(encodedBytes × 131072 × blobGasPrice / 126976)` wei, assuming a full shared
blob. Encoding includes the signed source transaction, outbound Safe call,
return and framing, plus the reference batch's 38 shared carrier bytes. New
batch metadata/unused capacity can change the actual allocation. Whole L1
execution costs are not divided among other batch transactions.

The actual L2 wallet fee remains `gasUsed × effectiveGasPrice`. Its priority
fee already recovers settlement and is excluded from modeled L2 resource cost
to avoid double counting modeled L1 costs. The breakdown separately reports
observed native wallet/whole-settlement fees. Deployment, operator margins and
separately charged proving fees are excluded from the resource model.

Source observations require the exact signed calldata, receipt and canonical
block; reconstructing the signed transaction must reproduce its hash. The
EEZ-X total stays **Needs L1 check** until the Safe operation and canonical
settlement are verified. Missing gas/blob metadata remains **Unavailable**,
never zero. Positive amounts under one millionth of a dollar use scientific
notation. The UI's read-only retry reuses the selected wallet; it does not
contact an external price feed or beacon API.

The arithmetic and evidence checks live in
[`safeCosts.ts`](../../src/lib/falcon/safeCosts.ts), with public-data regression
fixtures in [`tests/falcon`](../../tests/falcon). Historical POC validations do
not establish a new live dashboard transfer or current mainnet fee levels.
