# Falcon Safe cost comparison

The comparison is shown only for subsequent Falcon-authorized transactions
from the Safe. Controller deployment, Safe creation, funding and read-only
discovery do not produce comparison figures. Signing alone also has no paid
transaction cost.

Both cards start with the measured gas cost in the network's native token:

- **Actual cost:** verified L2 receipt `gasUsed × effectiveGasPrice`.
- **Estimated cost without EEZ:** the **same L2 gas used** multiplied by the
  verified L1 settlement receipt's `effectiveGasPrice`, including its priority fee.

The actual L2 fee appears after its receipt is verified. The L1 estimate displays
**Waiting for L1 settlement…** until canonical L1 execution and the Safe result
are verified. It never substitutes the RPC's `eth_gasPrice` suggestion, which may
be only 7 wei on an idle Chiado network even when the Composer pays a 1-gwei tip.
The verified receipt price remains fixed for that transaction through wallet
switches. Both comparisons use gas used, never gas limit or a separately
benchmarked L1 gas count. A real direct L1 execution could consume different gas;
this remains a same-gas estimate rather than an actual direct-L1 transaction.

## Currency conversion

Divide the computed wei by 10^18 to obtain native tokens, then convert to cents:

- **xDAI:** fixed **1 xDAI = $1**, with no ETH price lookup.
- **ETH:** use the public Coinbase ETH/USD spot quote.
- If token metadata is unavailable, **Gnosis 100** and **Chiado 10200** select
  xDAI; other chain IDs default to ETH. The rollup inherits the L1 native asset,
  so its configured token symbol is used first and its parent L1 ID is the fallback.
- Explicit ETH or xDAI metadata takes priority over the fallback.

For example, 0.000409435472882184 xDAI is **0.040944 cents** under the fixed
conversion. The same-gas L1 estimate of 0.005447193038130351 xDAI is **0.544719
cents**. Chiado testnet tokens have no cash value; these are nominal testnet costs.

For ETH-denominated costs, both cards use the same ETH/USD quote. The public
price endpoint receives no wallet, signature or transaction data. Quotes refresh
once per minute while visible, with stale/error handling. Without a quote, ETH
amounts remain visible rather than inventing USD values. Price/source details are
inside Details, not a banner. xDAI-only networks never request ETH/USD.

## Included fees

Cost evidence and transaction links are shown only for the sending wallet,
Falcon key, and deployment. Switching context hides the previous transaction;
returning to its context can show it again. Discovering an existing Safe does
not create cost evidence. The **Transaction costs** panel measures the entire
user-paid L2 transaction, including EEZ settlement, and compares the same L2 gas
usage at L1 prices. It does not isolate the verifier call's execution gas.

The full L2 receipt fee includes the charged base fee, priority fee and EEZ
settlement charge. Calldata and intrinsic gas are already part of gas used.
Whole L1 batch execution and blob fees remain in Details and are never added
to the user's L2 fee again. The transferred asset amount is not a gas fee.

The older [POC reference record](safe-cost-reference.json), direct-execution
benchmark and proportional blob-allocation helpers remain historical research
materials; they do not drive the current UI. Calculations live in
[`safeCosts.ts`](../../src/lib/falcon/safeCosts.ts), with price validation in
[`ethPrice.ts`](../../src/lib/falcon/ethPrice.ts).
