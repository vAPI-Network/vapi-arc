# vAPI Work + Verify on Arc: three-minute demo beat sheet

**Live app:** <https://vapi-web-production.up.railway.app> · **Arc explorer:** <https://testnet.arcscan.app> · **Public repo:** <https://github.com/vAPI-Network/vapi-arc>

## Before recording

- Use one funded vendor wallet, one funded client wallet, three registered reviewer wallets, and one executor wallet. Label each account in the wallet UI.
- Pre-fill the happy-path form. Use the same order from creation at 0:30 through release at 1:40. Record the order once from start to finish, then cut only wallet confirmation and receipt-loading pauses. Keep the order address visible across cuts.
- Pre-stage separate disputed orders for the evidence, commit, and reveal phases. Each on-chain window lasts at least 60 seconds. The 50-second dispute sequence therefore uses already-confirmed Arc transactions and does not imply that anyone bypassed the clocks.
- For the commit-stage order, confirm off-screen that `commitStart` has passed. The Disputes phase card shows the commit deadline, not the start of the evidence window.
- Open the pre-staged dispute receipts before recording. Open the happy-path receipts as they confirm.

## 0:00–0:30: The problem

**On screen:** Open Marketplace (The Forum). Start with the job briefs, then point to an offer's USDC amount, work deadline, review window, and connected Arc Testnet badge.

**Active wallet:** None. Show the public, disconnected view.

**Say:**

> “Arc can settle USDC in under a second. Real work still takes time to deliver and review. vAPI Work + Verify gives each order its own on-chain escrow, clear deadlines, commit-reveal disputes, and reputation based on settled results. A platform wallet never holds the client's money.”

**Proof:** Each Marketplace card shows a readable brief and contract state. Order detail shows the happy path and the `DISPUTED` and `EXPIRED` branches.

## 0:30–1:10: Create and fund on Arc

**On screen:** In Marketplace, create a small offer as the vendor. Show the client address, USDC amount, terms hash, readable job brief, work duration, and review window. Submit it and open Order detail. Switch to the client wallet, approve USDC, and fund the order. Show `CREATED` changing to `LOCKED`, then open the creation and funding receipts in Arcscan. Keep the same order address visible through the cuts.

**Active wallet:** Vendor for `createEscrow`; client for USDC approval and `depositFunds`.

**Say:**

> “The vendor creates an offer for this client. The factory gives the order a deterministic EIP-1167 escrow clone with one client, one amount, and one terms hash. Funding moves the exact USDC amount from the client into that clone and starts the work clock. The app prepares wallet transactions, and Arc stores the state. These receipts show the clone in `LOCKED`.”

**Proof:** Open the successful `createEscrow` and `depositFunds` receipts, then match their order address to Order detail.

## 1:10–1:40: Deliver, release, and inspect the fee split

**On screen:** Continue with the funded order. Switch to the vendor and submit a delivery hash. Switch to the client and release. Show `SUBMITTED` changing to `RESOLVED / RELEASE`, then open the settlement transaction in Arcscan and point to the `Resolved` and `FeeSplit` events or transfers.

**Active wallet:** Vendor for `submitDelivery`; client for `releaseFunds`.

**Say:**

> “The vendor stores the delivery hash on-chain, which starts the client's review window. The client accepts and releases immediately. In one Arc transaction, the escrow resolves, `FeeRouter` pays 95 percent of the vendor's gross payout to the vendor, and sends 5 percent, or 500 basis points, to the treasury. A full refund has no fee.”

**Proof:** Show the vendor net and treasury fee in the same settlement receipt.

## 1:40–2:30: Commit, reveal, and execute a dispute

**On screen:** Start on a pre-staged `raiseDispute` receipt in Arcscan and point to its evidence hash. Open the same case in Disputes (The Praetors) and show the phase clock and tally. Show all three reviewer commit receipts, then all three reveal receipts. Finish with permissionless `execute`, the resulting `RESOLVED` state, and the payout events. Keep the phase label visible so the edit cannot look like a clock bypass.

**Active wallet:** Reviewer 1, Reviewer 2, and Reviewer 3 for their own commits and reveals; any wallet for `execute`.

**Say:**

> “The client or vendor can open a dispute. During the evidence window, the other party can add one evidence hash. Three registered reviewers then commit sealed votes. They reveal those votes in the next window, so a reviewer cannot copy an earlier choice. Two release votes release. Two refund votes refund. Every other executable tally splits. Anyone can execute after three reveals or after the reveal deadline. The panel sends a fixed outcome enum to the escrow and cannot invent a recipient. We pre-staged these orders because the on-chain windows are real.”

**Proof:** Show the dispute evidence, three commits, three reveals, execution, and selected `RELEASE`, `REFUND`, or `SPLIT` outcome for one order.

## 2:30–3:00: Reputation, roadmap, and close

**On screen:** Open Reputation (The Census) for the vendor. Trigger or show the permissionless attestation and point to the settled, released, refunded, disputed, and split counters. End on the live deployment table with Arcscan links.

**Active wallet:** Any wallet for `attest`; no wallet action for the final read-only screen.

**Say:**

> “After settlement, anyone can attest this registered escrow once. Reputation reads raw on-chain counters for both parties. Next we can add stake-weighted panels, reviewer accuracy, slashing and bonds, retrievable IPFS dossiers, x402 around the existing EIP-3009 funding path, and ERC-8004 identity support. The deployed app and every contract address are public now.”

**Proof:** Show the updated reputation counters, then open the [`EscrowFactory`](https://testnet.arcscan.app/address/0xb6546d4A7FC5B75FF04828165d17e6a4ad397Da3) from the deployment table.
