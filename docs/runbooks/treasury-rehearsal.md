# Treasury demo rehearsal

Use the dashboard’s existing **Connect Wallet** integration for every treasury
payment. Use the locally hosted official Safe application to add or remove L1
owners. The dashboard reads that L1 owner set, collects real EIP-712 signatures,
submits through Composer and verifies settlement. The Safe application and its
indexer connect to the same isolated L1, chain 1337; EEZ-X is chain 420691.

This rehearsal uses the six-decimal **Devnet USDC** fixture, 100 per Safe and 150
globally per ten-minute period. Owners retain direct spending and administrative
authority; no Guard is installed. The [proposal](../proposals/one-treasury-two-safes.md)
defines the policy and the [validation record](../audits/2026-10-20-treasury-rehearsal/README.md)
separates environment readiness, automated evidence and the remaining human
wallet-extension rehearsal.

## Start or select the isolated devnet

Run commands from the `eez-rollup-dashboard` repository root. Follow the
[existing devnet prerequisites](../../tests/integration/README.md#connected-treasury-ui)
for pinned runtime, protocol, Foundry, Node and build dependencies. The Safe
stack additionally needs Linux, Docker Compose, network access for pinned images
and artifacts, and sufficient memory/disk for the official web image and its
startup build. On AMD64 the launcher builds the exact pinned gateway source,
because the selected published gateway image is ARM64. It uses the upstream
Dockerfile and locked dependencies; no host emulation is installed.

Keep an existing interactive devnet running if its initial state is suitable.
Otherwise start a new one in a terminal:

```bash
npm run dev:treasury -- --runtime /path/to/rollupX
```

An exact previously successful native run can be supplied with `--reuse-run`,
following the [artifact verification rules](../../tests/integration/README.md).
Use the printed directory, rather than selecting whichever run was created last:

```bash
export TREASURY_RUN="$PWD/.runtime/treasury-integration/<printed-run>"
npm run treasury:safe -- start "$TREASURY_RUN/ui-session.json"
npm run treasury:safe -- check "$TREASURY_RUN/ui-session.json"
```

`start` verifies the devnet identity, deploys checksum-pinned standard Safe
auxiliary contracts with public fixture A, and starts a dedicated local Safe
Config Service, Transaction Service, indexer, Client Gateway and web application.
It does not replace either treasury Safe or grant new module permissions. It
registers the actual Safe factory/singleton with the indexer; indexed owners and
transactions come from real L1 execution. Initial downloads and web builds can
take several minutes. `start` waits for indexed state and the web build. `check` independently repeats
those checks and links the dashboard to this Safe application only on success. It is read-only with respect to both chains.

All listeners use leased loopback ports. Generated configuration, credentials,
image identity, deployment receipts, databases and logs stay under
`$TREASURY_RUN/safe-app`. The launcher does not read `.env`, edit the regular
dashboard deployment, touch other Compose projects or use public-chain funds.
`status` lists only this session’s containers. A new devnet requires its own Safe
stack and indexer data, even when it reuses the same chain IDs.

The dashboard’s **Open L1 Safe** link selects this deployment. It is an official
Safe source distribution hosted locally; the public Safe site has no backend
for this private chain. The app may label itself an unofficial distribution.
Its stock spending-limit screen does not recognize this custom chain/module
address. Present both allowance counters in the dashboard; use Safe’s **Modules**
screen to inspect the enabled module. Do not present an empty stock spending-limit
list as evidence that there is no allowance. No block explorer is configured for
this disposable L1; use the dashboard’s verified transaction details and hashes.

## Prepare the browser wallets

Use a disposable browser profile with an EIP-1193/EIP-6963 wallet supported by
the dashboard, such as MetaMask or Rabby. Import A, B and C from
`$TREASURY_RUN/public-test-wallets.json`, and name them **Owner A**, **Owner B** and
**Owner C**. These are public fixture keys with devnet gas funds. The browser
application never receives those keys or signs on the user’s behalf. Keep the
same dashboard tab open while switching accounts so collected approvals remain
available.

Open the URL in `ui-session.json`. It opens **Treasury Demo** directly;
choose **Payments**.
Enter amounts and destinations with the ordinary payment controls; there are no
scenario shortcuts.
Use its existing wallet selector. **Switch to treasury devnet** configures the
EEZ-X chain; under **Wallet network details**, verify its RPC is the generated
`/composer/l2` URL. An old saved chain 420691 may need its RPC replaced after a
fresh devnet launch. The dashboard checks genesis and Composer identity before
signing. For the Safe application, configure chain 1337 using `treasury.l1.rpc`
from the same session file. Both networks use ETH for gas.

Allow wallet access to both local browser origins. Check the chain, selected
account and Safe address in each signing dialog. A payment review has chain
420691 and the EEZ-X Safe as its verifying contract; L1 administration has chain
1337 and the L1 Safe. Signature approval and transaction broadcast are separate
wallet prompts. Approving a signature alone does not send the payment.
New payments default to the Safe on the connected network when initiation is
supported there. Choose **Start from** to change it. **Sign approval** requests
any required network change before the signature; **Submit Safe transaction**
rechecks the reviewed network before submission. Cancelling a network change
keeps the review and collected approvals. A saved submission retains its original
Safe even when the connected network differs after reload.

Before starting the timed acts, check: Safes hold **300 / 150**, spending is
**0 / 0 / 0**, the owner list is **A+B, threshold 2**, and there is no unresolved
submission. Choose a period with enough time remaining for both payment approval
rounds. A period change clears a review and requires fresh signatures; the form
never resets chain state.

## Act 1 Add C through the Safe application

1. In **Open L1 Safe**, connect A on chain 1337. Open **Settings → Setup → Manage
   signers**. Add C’s address, retain threshold **2**, and review the change.
2. Sign/propose as A. Switch the wallet to B, open the queued Safe transaction,
   provide the second confirmation and execute it. Wait for indexing to show
   **2 of 3** with A, B and C. The Safe app’s local backend retains the proposal
   and confirmations between account switches.
3. Return to the dashboard. **Shared owners** updates automatically and must
   show A, B and C with **Approval threshold: 2 of 3 owners**. Continue using B+C for payments. To demonstrate authorization
   without spending, use **Owner demo** and submit one value change
   with B+C, then return to **Payments**.

Say: “The EEZ-X Safe checks the current L1 owner quorum when it validates the
transaction.” Do not say an owner removal invalidates every earlier operation
in the same block: L1 execution order matters.

## Act 2 A shared budget and one split payment

Use a fresh treasury setup. **Payment split** shows both Safe percentages and
exact token amounts immediately. Drag it to choose a contribution, or use
**Use available funds** for the scripted destination-first allocation. No
separate activation or upgrade is required.

For each payment: enter the amount and recipient chain, choose **Use available
funds**, review its recipient and funding, sign as B, switch to C and sign, then
submit **once**. Wait for **Settled on Ethereum** and the
verified payment flow and explorer links. The form unlocks automatically for the next payment.

| Action within one period | L1 balance | EEZ-X balance | L1 spent | EEZ-X spent | Global spent |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial state | 300 | 150 | 0 | 0 | 0 |
| Pay 40 on EEZ-X | 300 | 110 | 0 | 40 | 40 |
| Split 110 to L1, funded 100 + 10 | 200 | 100 | 100 | 50 | 150 |
| Review another 1 on EEZ-X | 200 | 100 | 100 | 50 | 150 |

The last review must be rejected by the global budget before requesting any
signature. EEZ-X still has 50 of allowance, so this demonstrates an independent
shared limit. In payment history, show two settled payments and one preparation
rejection marked **not signed or submitted**. Expand the split to show the
actual contributions and settlement identity.

## Act 3 Rollback after the payment legs

The payment form no longer exposes an invoice-creation shortcut. This act is an
isolated integration-harness check, not an interactive wallet rehearsal step.
[The invoice browser test](../../tests/integration/treasury-invoice-browser.mjs)
opens and arms the fixture, obtains real signatures from its test owners, submits
the 110-USDC payment, then restores that submitted request in the browser to
verify rollback and recovery. It requires balances of at least **100 / 10** and
fresh **0 / 0 / 0** counters after a natural budget reset.

The isolated fixture deliberately closes this invoice immediately before the
proved payment in its L1 target block. Execution first attempts a 10-USDC bridge
release and a 100-USDC L1 Safe payment, then requires merchant acceptance. The
merchant rejection reverts that payment entry. Wait for **Rollback verified**;
expand the result to show the earlier successful calls in the reverted trace,
unchanged recipient/Safe/escrow balances, both allowance counters, the global
counter and Safe nonce. The separate invoice closure remains committed, and
network fees are separate. This is a controlled inclusion failure, not a USDC
transfer to a reverting fallback or a rejection during preparation.

The rollback remains in history. If the UI cannot verify the trace and canonical
state, leave it unresolved and stop this act; missing evidence is not rollback.

## Act 4 Fixed payments and the reverse route

Choose **Fixed amount**, enter **30**, select the base chain as recipient chain,
and choose **Use available funds**. Then enter **110**, select **EEZ-X** and
choose **Use available funds** again. Continue in the same second period while
sufficient time remains:

| Action | L1 balance | EEZ-X balance | L1 spent | EEZ-X spent | Global spent |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pay 30 to L1, entirely from its Safe | 170 | 100 | 30 | 0 | 30 |
| Split 110 to EEZ-X: 100 local + 10 from L1 | 160 | 0 | 40 | 100 | 140 |
| Optional: review another 16 to L1 | 160 | 0 | 40 | 100 | 140 |

The owners approve each exact amount and split. Editing either clears existing
approvals. The reverse payment locks the 10-USDC L1 contribution and mints its
backed representation on EEZ-X within the same payment entry. The optional final
payment fails because only 10 of global budget remains; the signed amount is
never reduced to fit.

History now has four settlements and the initial local preparation rejection,
plus the verified rollback when the isolated fixture act was run; the optional final review adds another rejection. Filter
by outcome, open both split payments, then reload and wait for outcomes to be
reverified. Human rehearsal counts differ from the automated suite, which also
submits a separate already-closed invoice to test Composer preparation failure.

Optionally remove C through the Safe app with an authorized L1 quorum. Refresh
the dashboard: B+C must no longer authorize an action; A+B can still use
**Owner demo** without needing another token balance or period.

## Recovery and stopping

- Cancelling a wallet signature leaves the payment unsent. Cancelling the final
  send removes that unsent attempt. Switch accounts only after each dialog ends.
- Editing terms or changing owners/nonce/period clears approvals. Review again.
- A timeout, lost wallet response or missing receipt does not authorize another
  send. Preserve the tab and saved request; reload resumes reconciliation of the
  same identity. Do not clear storage or start a duplicate payment to recover it.
- If the Safe app lags L1, wait for the indexer and rerun `check`. Do not use a
  stale owner screen as authority. The dashboard reads the chain independently.
- If a period changes between acts, recalculate expected counters from the new
  period. If balances differ, start a fresh devnet for an exact rehearsal; do not
  overwrite storage or warp time to manufacture the expected result.
- Keep browser recovery/history storage and the run directory while investigating
  an unresolved attempt. Restart can lose Composer or invoice diagnostic data;
  persistence of an identity alone cannot establish settlement or rollback.

Stop only the selected session’s Safe services, preserving its data:

```bash
npm run treasury:safe -- stop "$TREASURY_RUN/ui-session.json"
```

Then stop that devnet using its existing `stopFile` procedure in the
[integration runbook](../../tests/integration/README.md). Never run a generic
Compose down or delete shared volumes. A fresh launch has new RPC ports and
genesis identities; update wallet network URLs and use its new browser history.

Record the wallet name/version, successful A+B owner addition in the Safe UI,
B+C approvals, every settled payment hash and counter checkpoint, the rollback
trace/state table, and any retry or unresolved result. Only that completed
wallet-extension session establishes the human rehearsal milestone.
