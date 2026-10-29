---
version: alpha
name: EEZ Quickstarts
description: Design language of the eez-demos site (index + 17 animated walkthroughs) — pure-black engineering aesthetic built on the eez.io brand.
omitted:
  - section: spacing
    reason: "No named spacing scale in source; layout dimensions are documented in the Layout section."
  - section: rounded
    reason: "No named radius token in source; radii are per-component, recorded in Components."
colors:
  primary: "#3BE57E"
  eez-green: "#3BE57E"
  canvas: "#0A0A0A"
  screen: "#161616"
  chrome: "#1F1F1F"
  edge: "#2E2E2E"
  muted: "#9aa3b3"
  label: "#9ba6d6"
  foreground: "#ffffff"
  ink-on-grad: "#0A0A0A"
  grad-start: "#8AE5AC"
  grad-mid: "#6283BD"
  grad-end: "#4439CB"
  logo-grad-start: "#8ce8ab"
  logo-grad-end: "#3f2acd"
  pinned: "#A8F3CE"
typography:
  sans:
    fontFamily: Geist
  mono:
    fontFamily: Geist Mono
  display:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: -0.01em
  lede:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
  eyebrow:
    fontFamily: Geist Mono
    fontSize: 12.5px
    fontWeight: 400
    letterSpacing: 0.1em
  card-title:
    fontFamily: Geist
    fontSize: 17.5px
    fontWeight: 600
    lineHeight: 1.35
  card-hook:
    fontFamily: Geist
    fontSize: 13.5px
    fontWeight: 400
    lineHeight: 1.55
  badge:
    fontFamily: Geist Mono
    fontSize: 11px
    fontWeight: 400
    letterSpacing: 0.04em
  cta:
    fontFamily: Geist Mono
    fontSize: 11.5px
    fontWeight: 500
    letterSpacing: 0.02em
components:
  card:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.foreground}"
    rounded: 16px
    padding: 28px 26px 26px
  pill:
    backgroundColor: "{colors.foreground}"
    textColor: "#000000"
    typography: "{typography.cta}"
    rounded: 100px
    padding: 5px 5px 5px 20px
  terminal:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono}"
    rounded: 10px
  search-input:
    backgroundColor: "#090909"
    textColor: "{colors.foreground}"
    rounded: 12px
    padding: 13px 44px 13px 42px
  filter-tab:
    backgroundColor: "#0d0d0d"
    textColor: "#888888"
    rounded: 100px
    padding: 6px 14px
  badge:
    textColor: "{colors.muted}"
    typography: "{typography.badge}"
    rounded: 100px
    padding: 3px 9px
  action-chip:
    backgroundColor: "#1a1a1a"
    textColor: "{colors.muted}"
    rounded: 5px
    padding: 3px 8px
  gradient-button:
    textColor: "{colors.ink-on-grad}"
    rounded: 100px
---

# EEZ Quickstarts — DESIGN.md

## Overview

EEZ Quickstarts is a static, no-build explainer site: an index of 17 cards, each linking to a short animated walkthrough of one EEZ protocol mechanic, backed by real cited source code. The design language is the eez.io brand rebuilt for a documentation surface: a pure black canvas with a faint grid texture, Geist and Geist Mono type, mixed-weight headline splits, bracket-wrapped mono eyebrows (`[ LABEL ]`), pill CTAs with a trailing circle-arrow, and flat monochrome cards where the brand's green→blue→purple gradient is reserved exclusively for hover states and thin accent rails — never used as per-category branding. The overall feel is a dark engineering terminal: quiet, dense, monospaced chrome around sans-serif content, with color earned rather than decorative.

## Colors

The palette is monochrome-first: five neutral surface steps plus one green accent (`primary`, aliased as `eez-green` after the source token), with the brand gradient as the only polychrome element.

- **Canvas (`canvas`, #0A0A0A):** the page ground, always overlaid with a faint 42px grid texture drawn from two 1px `rgba(255,255,255,.045)` line layers. The raw `html/body` behind it is #000.
- **Screen (`screen`, #161616):** raised content surfaces — card bodies and terminal code panes.
- **Chrome (`chrome`, #1F1F1F):** window furniture — terminal headers and toolbars.
- **Edge (`edge`, #2E2E2E):** the single hairline border color for cards, terminals, chips, and dividers. Even quieter hairlines (#1a1a1a) separate page-level regions like the footer and stage header.
- **Muted (`muted`, #9aa3b3):** secondary text — eyebrows, CTAs, badges, citations, step labels.
- **EEZ green (`eez-green`, #3BE57E):** the functional accent — focus rings, search focus, active diagram strokes, and intro-slide eyebrows. Never a fill for large areas.
- **Brand gradient (`grad-start` → `grad-mid` → `grad-end`):** #8AE5AC → #6283BD → #4439CB at 90deg (stops 0% / 55% / 100%) for accent rails and progress bars; the two-stop variant (#8AE5AC → #6283BD) fills primary gradient buttons with near-black (`ink-on-grad`) text. The logo's vertical gradient (`logo-grad-start` → `logo-grad-end`) paints card hover rails.
- **Pinned (`pinned`, #A8F3CE):** a paler green reserved for the "PINNED" commit marker in terminal headers.
- **Label (`label`, #9ba6d6):** a cool periwinkle for diagram labels inside walkthroughs.

Text hierarchy runs #fff (headings, hover states) → #dcdcdc (the light half of headline splits) → #c9cfda (ledes) → muted → #8f8f8f (card hooks) → #4d4d4d (quiet card numbers).

## Typography

Geist carries all reading content; Geist Mono carries all chrome. Both load from Google Fonts (Geist 400–800, Geist Mono 400–600), with `system-ui` and `ui-monospace`/`SF Mono`/`Menlo` fallback stacks.

- **Display:** the h1 is a mixed-weight split — alternating spans of weight 800 white and weight 300 #dcdcdc — at 48px / 1.08 / -0.01em, dropping to 32px under 640px. Use `text-wrap: balance`.
- **Eyebrows:** every section label is mono, 12.5px, letter-spaced 0.1em, muted, and wrapped in literal brackets: `[ DAPP DEVELOPERS ]`. Eyebrows double as h2s with UA heading defaults neutralized.
- **Ledes:** 18px / 1.55 in #c9cfda, max-width 640px, `text-wrap: pretty`.
- **Mono-as-chrome:** nav links, CTAs, badges, filter tabs, keyboard-shortcut hints, footer labels, and citations are all mono at 11–13px with slight positive tracking (0.02–0.08em), usually uppercase.
- Card titles and hooks follow the `card-title` and `card-hook` scales; hooks may embed inline `code`.

## Layout

- The index wraps content at max-width 1200px with 48px top / 32px side padding (32px / 18px under 640px) and a 100px bottom reserve.
- Card grids use `repeat(auto-fit, minmax(300px, 1fr))` with 16px gaps; sections with exactly four cards use a fixed 2-column variant that collapses to one column under 700px (an even 4 never divides into 3 columns without a phantom cell).
- Section rhythm: 56px above each section head, 18px between eyebrow and grid.
- Walkthrough pages are authored as a fixed 1920×1080 stage, scaled to fit the viewport and never scrolled; below 1120px the stage reflows into a normal stacked document (`!important` overrides on the stage children, flex rows forced to wrap, code panes capped at 60vh).
- The stage header is a 96px bar with a 3px gradient progress bar along its bottom edge, holding the back link, title, PRE-MAINNET tag, step label, and NEXT link.

## Elevation & Depth

Surfaces are flat by default — depth is stated by the surface-step colors and hairline borders, not shadows. Only two effects exist:

- **Card hover:** lift `translateY(-4px)`, shadow `0 20px 44px -20px rgba(0,0,0,.75)`, background deepens to #0d0d0d, border to #333, and a 2px gradient rail fades in along the top edge.
- **Search focus:** green border plus a soft `0 0 0 3px rgba(63,185,80,0.15)` ring.

The 2px gradient top rail is the site's signature accent: cards show it on hover, terminal windows show it permanently.

## Shapes

- Cards: 16px radius. Search input: 12px. Terminal windows: 10px. Small action chips and shortcut hints: 4–5px.
- Anything pill-shaped — CTAs, badges, filter tabs, gradient buttons — uses 100px (fully rounded).
- Arrow affordances are perfect circles (26–30px) containing a `→` glyph; on hover the circle nudges `translateX(2–3px)` and, inside cards, fills with the gradient.
- The pinned-commit marker is an 8px square rotated 45° (a diamond).
- Focus visibility is a 2px solid green outline offset 2px, applied to links, cards, and buttons alike.

## Components

- **Card:** the whole card is one anchor. Contents: a head row (quiet mono number + title, optional pill badge right-aligned), a hook paragraph, and a bottom-pinned mono CTA row ("WATCH THE 3-STEP WALKTHROUGH" + circle-arrow). Visited cards dim their title to #b8b8b8. Cards carry no code snippets.
- **Pill CTA:** white pill, black mono text, trailing 30px dark circle-arrow; the outline variant is transparent with an edge border. Exactly one solid pill per row — the primary action; all siblings are outline.
- **Terminal window:** chrome header (pinned diamond + commit-pinned `file:line` citation link in muted mono with a dotted underline + uppercase action chips: FULL / TEST / COPY) over a screen-colored code pane with line numbers and a blinking cursor, set in mono at 19px / 34px at the 1920px authoring scale. Permanent gradient top rail; body and header divided by edge-colored hairlines.
- **Search + filters:** full-width dark input with leading search icon and a trailing `/` shortcut hint; mono uppercase filter pills below, where the active tab inverts to white-on-black-text. An empty state uses a dashed edge border.
- **Nav / footer:** mono 12px links in #9a9a9a brightening to white on hover; footer separated by a #1a1a1a hairline with an uppercase letter-spaced label.
- **Motion:** transitions are 0.2s ease across the board (0.15s for text color). Walkthroughs add `riseIn` (12px rise + fade, 0.4s), `dashMove` (marching-ants SVG connectors), and a blinking cursor; `prefers-reduced-motion: reduce` neutralizes all animation and transitions globally.

## Dashboard data and accessibility

CoW Light is a native dashboard tab and reuses the selected dashboard wallet;
do not embed the standalone demo page or add an independent wallet session.
Use the shared neutral surfaces, Geist amount typography and pill actions.
Group sell and receive assets with their network and balance, and keep one
primary action for connection, quote, exact-amount approval or order signing.
Show recipient, minimum received and quote expiry before signing. Keep pool
and contract identifiers in a disclosure. Order history belongs to the
connected wallet, distinguishes the signed minimum from received amounts,
and links to the dashboard execution inspector and configured explorers.
Preserve pending orders across reloads and show uncertain submissions without
automatically signing or submitting a replacement.

The dashboard, monitor, and execution visualizer use a 12px minimum for control
text, data labels, badges, and secondary values. Hashes and table cells use
13–14px. Long decoder explanations are limited to approximately 75 characters
per line. These rules take precedence over the smaller quickstart chrome sizes
above on application data surfaces.

L1 uses a periwinkle semantic accent (`#9ba6d6`); L2 uses a violet semantic accent
(`#b5a3ee`). Use these colors on chain labels, thin row markers, and diagram
lanes, always with a network name or logo. Keep card surfaces neutral. Links
use neutral text with an underline; green communicates positive state and also
retains its existing focus and interaction role. Chain color alone never
conveys success, canonicality, safety, or finality.

Transaction results link directly to execution inspection. Settlement progress
is derived from canonical block hashes and node safety/finality evidence.
Confirmation of source execution does not imply L1 settlement or finality.
Disconnected wallets are an ordinary empty state, not an error. Mobile
settlement summaries expose result and inspection actions without horizontal
scrolling; supporting operator detail is expandable.

The bridge groups each network, amount, and asset in a single From/To control.
Network positions remain fixed when direction reverses; the editable amount,
balance, and MAX belong to From, while the exact destination amount and
recipient belong to To. Use 10px inset corners, a circular direction control,
transparent asset pills, 32px Geist amounts, and 12px mono labels. Asset choices
expand inline with visible focus and return focus when dismissed. The primary
action connects a wallet when disconnected. Balance and recipient validation
use amber; transaction and RPC failures retain error styling.

The treasury reuses the dashboard's connected wallet. Setup requires an existing Chiado Safe address and offers a new or
existing EEZ-X Safe. Label the new option **Deploy a mirror Safe**: it verifies
owners and the approval threshold against the L1 Safe dynamically. The imported
L1 Safe keeps its owners and threshold. **Start new treasury** is a secondary action that
returns to these choices without disconnecting the wallet; there is no archived
treasury collection. Before any deployment is confirmed, **Change setup** serves
that purpose. Pending requests must remain visible and be resolved before
restarting. Keep every setup action list visible under a
heading that explains its purpose. Explain contract deployment, owner verification
and spending authorization as distinct steps. Reserve disclosures for
supporting contract information; owner changes and the next wallet approval
remain visible before signing. Use one
primary action for the current approval stage; collected approvals and submitted
transactions are distinct states. Environment badges remain neutral; a green
approval or connection badge requires the corresponding observed state.

Show ownership beside Safe selection and creation, and limits at spending
configuration. Setup does not fund Safes: show no funding form, token balance
requirement, faucet entry or skip control. Keep the required owner-verification
connection visible without suggesting tokens will move. Preserve any historical
funding transactions and unresolved wallet requests in transaction history.
Do not add separate deployment-wallet, gas-balance or reused-infrastructure panels. Keep
setup progress compact and lead with the current action. After the final transaction,
verify the treasury automatically and open its connected view. Show only a compact
verification status while checking; on failure retain setup and offer **Retry verification**.
A configured treasury must not show a completed setup panel or another open button.
In the connected view,
show the shared budget and both Safe balances, then payment and **Shared owners**.
Each Safe balance card shows an abbreviated address linking to its chain’s configured
explorer and an adjacent icon button that copies the full address. Keep the address
and copy icon on one line, with the full address in the link’s accessible name and tooltip. Keep these visible while balances load; the Chiado
card also links to the Safe app when configured.
The shared-owners card shows wallet addresses and the **Approval threshold** as
“2 of 3 owners”, separate from approvals collected for the current transaction.
Explain that EEZ-X reads the current owners and threshold from Chiado through EEZ,
so **both Safes stay in sync automatically**. Refresh after verified owner changes
and poll for changes made elsewhere. Keep the last observed list visible with a
stale-state message if reads fail; never present entered addresses as confirmed
owners before inclusion. Label current signers **Owner**, and mark the active
account separately as **Connected wallet**. Historical deployment labels must
not imply another role or extra authority in this list.
For fixed payments, replace the funding selector with a percentage slider between
the two Safes. Show both percentages and exact USDC amounts; the left endpoint
uses Chiado and the right endpoint EEZ-X. Default from available funds, retain a
chosen split through polling, and lock it during review. Sign exact contributions,
never silently rebalance them. Invalid capacity stays visible. New setups include
custom splits directly; there is no separate activation or policy-upgrade flow.
Percentage rules keep automatic allocation of their dynamic amount.
Keep initiating Safe, recipient, amount, destination and funding visible before signing; put
contract identifiers, token movement and observed block details in disclosures.
The payment form has no **Demo scenarios** shortcuts or repeated test-token tagline;
use the ordinary amount, destination, percentage and split controls. After settlement, show a continuous connected flow from
owner verification through the shared budget, branching into the two Safe
contributions and rejoining at the recipient. Keep connectors joined as the layout
reflows. Put explorer links inside the relevant nodes: initiating Safe transaction,
EEZ-X policy execution and block, each funding transaction, and the settlement
transaction and block. Show each contribution's verified amount, share, and direct
or bridged route; mark unused Safes explicitly. Use network names (Chiado or
Ethereum, and EEZ-X) in treasury labels, not L1/L2. Never invent a separate EEZ-X
settlement transaction or treat the Safe signing hash as an explorer transaction.
Payment-history rows show the verified amount from each Safe, transactions and
blocks on both chains, and expand to this same flow. Keep a distinct initiating
Chiado/Ethereum transaction visible when it differs from settlement. Missing
optional settlement data withholds its links without changing verified payment
status; refresh it sequentially and share evidence between rows and diagrams.
Omit the generic explanatory footer under the diagram. Remove the generic Treasury details
panel. Verified completed payments release the form and restart control automatically,
retaining their identity in history; a changed or unresolved observation restores
the pending lock while that request is being tracked. Pending requests and errors remain visible. Treasury transaction
links open the configured block explorer for their L1 or L2 chain. Use the same
visible and accessible names for navigation. For a new payment, default **Start
from** to the connected network when that Safe supports initiation; retain any
explicit choice, review or pending request. Do not show a standalone network
switch in payment approvals. **Sign approval** and **Submit Safe transaction**
request a switch only when the wallet differs from the reviewed Safe. Explain
that prompt beside the action, and stop if the user cancels, the network does not
change, or the selected account/review changes while the prompt is open.

Keep **Add an owner** within **Shared owners**, with a **New owner address** input and
**Required approvals** defaulting to the current L1 threshold. Enter the candidate
address directly; the connected wallet is used by current owners to approve the
change. Keep reviewed fields fixed until the user chooses to edit them. Owner
changes advance on verified L1 inclusion and show **Owner change included**;
keep checking until dismissed, without waiting for the `safe` checkpoint. Show
reverts as failures rather than successful owner additions.

Keep **Get Test USDC** as a separate, secondary action on the connected treasury.
Show amount (up to six decimals), destination network (Chiado / EEZ-X), and
recipient address, defaulting to the connected wallet with an optional reset.
The connected wallet signs and pays Chiado gas; any wallet or Safe can receive
tokens without having gas. Preserve the draft amount, recipient and destination
when changing the paying wallet. Returning to an unresolved request restores that
wallet’s exact locked selection.
Existing balances never restrict a request. Explain the first request's two
confirmations (prepare the dispenser, then deliver); subsequent requests reuse it.
Keep pending selections locked and restore them on reload. Confirm exact delivery
only after verification; preparing the dispenser is not receipt of tokens.
Preserve the independent faucet journal and the treasury's setup/payment state.

New treasury setups deploy a policy that supports both initiation chains and
custom splits. Do not show activation links or a policy-upgrade card. Retained
handover transaction records remain saved; their presence
does not offer another migration.

Use the Bridge & Calls history layout for treasury setup transactions, oldest
first. Keep the action, network, transaction, block, observed status and time
visible during setup. Once the treasury is open, show **Payment history** in this
same row layout and hide the setup transaction panel; retain its saved records.
Advance setup on verified successful inclusion;
show finality separately without delaying the next step. RPC uncertainty must
replace a stale success state. A pending row makes the disabled restart action
clear without repeating a second instruction below it.

## Do's and Don'ts

- **Do** reserve the gradient for hover states, thin accent rails, progress bars, and the primary button — never as per-category branding or large fills.
- **Do** cite a real, pinned-commit `file:line` on every code panel; nothing paraphrased or invented.
- **Do** keep every interactive element reachable with the shared green focus ring.
- **Don't** color-code sections or cards by category (the rejected "colored rail per category" pattern).
- **Don't** put code snippets on index cards; the card sells the walkthrough with a title, hook, and CTA only.
- **Don't** use IBM Plex — it was explicitly replaced by Geist in the brand redesign.
- **Don't** let the quiet card number be the sole conveyor of order; it is intentionally redundant with card position.
