# Dashboard query performance

Status: accepted UI scope following the user's 2026-11-02 request to address the
query audit. No protocol, contract, persisted-state or deployment change.

The deployed UI automatically inspects 50 Visualizer batches, polls Bridge
balances behind other views, and waits for a separate gas estimate before its
fee preview. Reduce that work while preserving the evidence and send boundaries.

- Live history defaults to the selected/newest batch's settlement and execution
  details. Full inspection is available on demand and for searches/execution
  filters; incomplete coverage must remain explicit. Settlement filters load
  settlement metadata. Preserve reorg invalidation, retry bounds and Pause.
- Share the wallet's account-scoped native balances with Bridge. Poll ERC-20 and
  saved counter state only while the relevant view is active. Keep transaction
  receipt observation independent of idle view polling. Bound and cancel reads
  so old account responses cannot replace the current account's balances.
- With compact fees enabled, use one debounced quote to resolve preview gas.
  Preserve explicit gas overrides, disabled-fee behavior, approval gating,
  changed-form cancellation, SDK fee/binding checks and a fresh quote on Send.
  MAX retains its amount-dependent preparation and reserve calculation.

Alternatives: only increasing concurrency still performs the same unnecessary
work; removing all background transaction observation or validation changes
transaction semantics. Global persistent RPC caches would need broader
invalidation rules and are outside this change.

Acceptance: compare the same 50-batch workload and controlled RPC delay with the
deployed baseline; verify selected/full inspection, filters, failure and reorg
cases. Exercise wallet/account changes and view changes under held reads. Verify
both bridge directions and wallet formats, automatic/explicit gas, quote errors,
stale results, caps, approvals and unchanged final-send safeguards. Run affected
browser regressions, unit tests and the production build; record limits.
