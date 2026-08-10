# What changed since the mid-hackathon checkpoint

The checkpoint submission ("vAPI Trust Network") and the final submission
("vAPI Work + Verify") are the same product thesis — programmable money needs a
programmable way to decide whether paid work was actually done — but the final
build replaces the single-evaluator architecture with a full marketplace loop.

## The checkpoint build (what was live before)

- One `EvaluationRouter` contract in front of Circle's `AgenticCommerce`
  escrow: an AI lane that settled or escalated, and a single paid human
  reviewer path (x402 payment → Telegram review → Circle Developer-Controlled
  Wallet payout → `humanResolve`).
- Trust came from one operator-attested resolver wallet; the dashboard was
  read-only and access-gated; state lived in a SQLite review service.
- Railway ran three services: `vapi-web` (gated dashboard), `vapi-review`
  (x402 API + Telegram + Circle payouts), `vapi-judge` (AI watcher).

## The final build (what is live now)

- **Non-custodial escrow marketplace (The Forum).** Every order is its own
  `EscrowV1` EIP-1167 clone from `EscrowFactory`, holding the buyer's USDC
  through a six-state lifecycle (Created → Locked → Submitted →
  Disputed/Resolved/Expired) with allowance and EIP-3009 funding. No platform
  wallet ever holds funds.
- **On-chain adjudication (The Praetors).** Disputes go to a three-arbiter
  commit-reveal `DisputePanel` — sealed votes, public reveals, contract-side
  tally and execution, with a time-gated council fallback. The panel can only
  pick RELEASE / REFUND / SPLIT; it can never redirect money.
- **On-chain reputation (The Census).** `ReputationRegistryV0` accrues
  settlement outcomes per address via permissionless attestation of resolved
  escrows.
- **Atomic fees.** `FeeRouter` takes 500 bp from the seller leg only,
  `net + fee == gross` enforced on-chain.
- **Chain-native app.** The dashboard has no database and no indexer — the
  chain is the database. It enumerates escrows from factory events (chunked,
  cursor-cached `eth_getLogs` within Arc's ~10k-block RPC limit) and
  multicalls live state. Public, no access gate.
- **Live proof.** A full dispute rehearsal ran on Arc Testnet on Aug 10:
  create → fund → deliver → dispute → 3× commit → 3× reveal → execute
  (2-1 RELEASE, exact 95/5 split in USDC transfer logs) → attest. Escrow
  `0x9A30090D090E3C8CA3C9A2FB37116D4f4735bD15`, RESOLVED.

## Deployment changes

- `vapi-web` now serves the new app from `main` at
  <https://vapi-web-production.up.railway.app>; its environment was reduced to
  the five contract addresses + deploy block (access-gate and review-service
  variables removed).
- `vapi-judge` and `vapi-review` remain online untouched as the legacy
  checkpoint demo; nothing in the final story depends on them and they can be
  decommissioned after judging.
- Contract addresses are new (see the README deployment table); the old
  `EvaluationRouter` deployments remain on-chain as history but are out of the
  final narrative.
