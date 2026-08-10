# What changed since the mid-hackathon checkpoint

The checkpoint tested one part of the idea: how a paid evaluator could help settle an escrow. The final submission, vAPI Work + Verify, turns that experiment into a public USDC work marketplace with per-order contracts, reviewer voting, and on-chain reputation.

**Final live app:** <https://vapi-web-production.up.railway.app> · **Arc explorer:** <https://testnet.arcscan.app> · **Public repo:** <https://github.com/vAPI-Network/vapi-arc>

## Checkpoint history

The checkpoint submission was called “vAPI Trust Network.” It used one `EvaluationRouter` in front of Circle's `AgenticCommerce` escrow. An AI lane could settle or escalate, while one paid human evaluator handled an x402 payment, Telegram review, Circle Developer-Controlled Wallet payout, and `humanResolve` call.

That version depended on one operator-attested resolver wallet, a read-only gated dashboard, and a SQLite review service. Railway ran `vapi-web`, `vapi-review`, and `vapi-judge` for the checkpoint demo.

This evaluator flow remains in `core/` only as checkpoint history. The final product does not use it.

## Final product

- **Non-custodial marketplace.** Each order is an `EscrowV1` EIP-1167 clone created by `EscrowFactory`. The clone holds the client's USDC through six states: `CREATED`, `LOCKED`, `SUBMITTED`, `DISPUTED`, `RESOLVED`, and `EXPIRED`. Clients can fund by allowance or EIP-3009 authorization. A platform wallet never holds order funds.
- **Fixed dispute outcomes.** Three registered reviewers commit sealed votes and reveal them in the next phase. Two matching release votes choose `RELEASE`; two matching refund votes choose `REFUND`; every other executable tally chooses `SPLIT`. A time-gated council can choose from the same three outcomes. Neither path can redirect funds to another address.
- **Permissionless settlement.** Anyone can call an available work timeout, review timeout, dispute execution, or one-time reputation attestation.
- **Atomic 500 bp fee.** `FeeRouter` takes 500 bp from the vendor payout only. The vendor net and treasury fee must add up to the gross payout in the same transaction. Full client refunds have no fee.
- **On-chain reputation.** `ReputationRegistryV0` records raw settled, released, refunded, disputed, and split counters for the client and vendor.
- **Tested contracts.** The final Foundry suite contains 50 tests.

## Final app and presentation

- **English-first navigation.** The primary page names are Marketplace, Order detail, Disputes, and Reputation. The Forum, The Praetors, and The Census appear only as Roman-flavored subtitles.
- **Plain-language UX.** Role banners identify the client, vendor, and reviewer. Action cards explain what a transaction will do, and receipts describe the result in direct language.
- **Readable job briefs.** Marketplace cards and Order detail show a human-readable brief alongside the on-chain terms hash.
- **Final-day restyle.** The 2026-08-10 update added orange-led accents, a clearer brand strip, roomier address pills, and more breathing room without changing contract behavior.
- **Public live deployment.** Railway serves the final chain-native app at <https://vapi-web-production.up.railway.app>. The app reads factory events and live contract state without the checkpoint database, review service, indexer, or access gate.
- **Submission assets ready.** The final white presentation deck exists, and its matching copy is in [`deck-copy.md`](deck-copy.md). The [GitHub repository](https://github.com/vAPI-Network/vapi-arc) is public.

## Final on-chain proof

The contracts were deployed on Arc Testnet chain `5042002`; the [README deployment table](../../README.md#arc-deployment) links every address to Arcscan.

On 2026-08-10, the team ran a full dispute rehearsal: create → fund → deliver → dispute → 3× commit → 3× reveal → execute → attest. The reviewers reached a 2-1 `RELEASE`, and the USDC logs showed the exact 95/5 payout split. The order finished `RESOLVED` at [`0x9A30090D090E3C8CA3C9A2FB37116D4f4735bD15`](https://testnet.arcscan.app/address/0x9A30090D090E3C8CA3C9A2FB37116D4f4735bD15).

The legacy `EvaluationRouter`, `vapi-review`, and `vapi-judge` artifacts remain only as checkpoint records. The final judging path uses the public app, `packages/escrow-contracts/`, and the deployments listed in the README.
