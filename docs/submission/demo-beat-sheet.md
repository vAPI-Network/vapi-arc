# vAPI Work + Verify on Arc — three-minute demo beat sheet

## Before recording

- Use two funded party wallets (seller and buyer), three allowlisted arbiter wallets, and one
  permissionless executor wallet. Label every account in the wallet UI before recording.
- Pre-fill the happy-path form, then use that same order continuously from create at 0:30 through
  release at 1:40. Record that order end-to-end once, then remove only wallet-confirmation and
  receipt-loading dead air; keep the order address visible across every cut. Pre-stage separate
  dispute orders at each required phase. Evidence, commit, and reveal windows are real contract
  windows (at least 60 seconds each), so the 50-second dispute encore is an edited sequence of
  already-confirmed Arc transactions—not a claim that the clocks were bypassed.
- For the commit-stage order, verify off-screen that `commitStart` has passed; the current Praetors
  phase card exposes the commit deadline, not the evidence-window start.
- Open the pre-staged dispute receipts in advance; open the newly created happy-path receipts as they
  confirm. Replace every `PENDING_DEMO_*` token below after the final rehearsal.

## 0:00–0:30 — The problem

**On screen:** The Forum landing view. Start wide on the marketplace, then point to the order amount,
work deadline, review window, and connected Arc Testnet badge.

**Active wallet:** None; disconnected overview.

**Say:**

> “Arc can settle USDC in under a second. But real work cannot be verified in under a second. A
> deliverable can be late, subjective, or disputed—and neither party should have to trust a platform
> wallet. vAPI Work + Verify is the missing trust layer: one on-chain escrow per order, explicit
> timeouts, commit-reveal arbitration, and reputation built from settled results.”

**Proof point:** Every Forum order exposes its current contract state; the Order detail rail shows
the happy path plus the `DISPUTED` and `EXPIRED` branches.

## 0:30–1:10 — Create and fund on Arc

**On screen:** In The Forum, create a small order as the seller. Show buyer, USDC amount, terms hash,
work duration, and review window. Submit, open the new Order detail view, switch wallets, approve
USDC, and fund. Show the state change from `CREATED` to `LOCKED` and open the creation/funding
receipts in Arcscan. Use tight cuts for wallet-confirmation and loading dead air while keeping the
same order address visible.

**Active wallet:** Seller for `createEscrow`; then buyer for USDC approval and `depositFunds`.

**Say:**

> “The seller creates an offer. The factory gives it a deterministic EIP-1167 escrow clone with one
> buyer, one amount, and one terms hash. Now I switch to the buyer. Funding moves the exact USDC
> amount into that clone and starts the work clock. The app is preparing wallet transactions; the
> chain is the backend. Here are the successful Arc receipts and the clone's `LOCKED` state.”

**Proof points:** `PENDING_DEMO_CREATE_TX`, `PENDING_DEMO_FUND_TX`,
`PENDING_DEMO_HAPPY_ESCROW`.

## 1:10–1:40 — Deliver, release, and inspect the fee split

**On screen:** Continue with the same order funded in the previous beat. Switch to the seller and
submit a delivery hash. Switch to the buyer and release. Show `SUBMITTED` becoming
`RESOLVED / RELEASE`, then open the settlement transaction in Arcscan and point to the `Resolved`
and `FeeSplit` events/transfers.

**Active wallet:** Seller for `submitDelivery`; then buyer for `releaseFunds`.

**Say:**

> “The seller commits the delivery hash on-chain, which starts the buyer's review window. The buyer
> accepts and releases immediately. In this single Arc transaction the escrow resolves, FeeRouter
> pays 95 percent of the seller gross to the seller, and routes 5 percent—500 basis points—to the
> treasury. A full refund would be fee-free. There is no second settlement job to trust.”

**Proof point:** `PENDING_DEMO_RELEASE_TX` with the seller-net and treasury-fee transfers visible.

## 1:40–2:30 — Dispute encore: commit, reveal, execute

**On screen:** Start on the pre-staged `raiseDispute` receipt in Arcscan and point to the emitted
evidence hash. Cut to the same case in The Praetors and show its phase clock and tally. In a tight
montage, show all three arbiter commit receipts, then all three reveal receipts. Finish on
permissionless `execute`, the resulting `RESOLVED` state, and the payout events. Keep a phase label
on screen so editing cannot be mistaken for bypassing time.

**Active wallet:** Arbiter 1, Arbiter 2, Arbiter 3 for their own commits; the same three wallets for
their reveals; executor wallet for `execute` (any account may execute).

**Say:**

> “For the encore, either party can raise a dispute. During the evidence window the counterparty can
> add one evidence hash. Then our three allowlisted arbiters commit sealed votes. In the next window
> they reveal those votes, so nobody can copy an earlier choice. Two release votes release; two
> refund votes refund; every other executable tally splits. Anyone can execute after three reveals
> or after the reveal deadline. The panel calls the escrow's fixed outcome enum—it cannot invent a
> recipient. These cuts use pre-staged orders because the on-chain windows are real.”

**Proof points:** `PENDING_DEMO_DISPUTE_TX`, `PENDING_DEMO_COMMIT_TX_1..3`,
`PENDING_DEMO_REVEAL_TX_1..3`, `PENDING_DEMO_EXECUTE_TX`.

## 2:30–3:00 — Trust score, roadmap, close

**On screen:** Open The Census for the seller, trigger or show the permissionless attestation, and
highlight the raw settled/released/refunded/disputed/splits counters. End on a single roadmap card
and the Arcscan-linked deployment table.

**Active wallet:** Any wallet for `attest`; then none for the read-only close.

**Say:**

> “After settlement, anyone can attest this registered escrow once. The Census reads raw on-chain
> counters for both parties—no opaque score and no invented reputation. Next come stake-weighted
> panels, accuracy multipliers, slashing and bonds, retrievable IPFS dossiers, x402 around the
> existing EIP-3009 funding leg, and ERC-8004 identity interoperability. Arc makes money final fast.
> vAPI makes work verifiable before that money moves.”

**Proof points:** `PENDING_DEMO_ATTEST_TX`, `PENDING_DEMO_CENSUS_ADDRESS`.
