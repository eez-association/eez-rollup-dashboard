# Bridge TODO fixes

Requested on 2026-10-30 for the Chiado and RollupX bridge.

- [x] Make the network name to the right of **From** a network selector. Selecting Chiado or RollupX sets that network as the source and the other network as the destination. Keep the direction swap control synchronized with this selection.
- [x] Always show **From** at the top and **To** below it. Changing direction must reorder the network panels, so the source amount and balance remain at the top and the destination amount and recipient remain below. For Chiado → RollupX, show Chiado first; for RollupX → Chiado, show RollupX first.

Implemented in `src/components/BridgeAssetSwap.tsx` on `codex/falcon-safe-followup`. The production build and 15 bridge browser scenarios pass, including network selection, source ordering at five viewport widths, keyboard focus, fee refreshes, and locking direction controls during signing. Browser scenarios use mocked wallets and broadcast no transactions.
