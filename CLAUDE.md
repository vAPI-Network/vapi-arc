# vapi-arc — Agent Guide

Hackathon build for Circle's Arc "Programmable Money" hackathon via Encode Club (Agentic Economy track). **Real dates (verified from the logged-in Encode dashboard 2026-07-28):** human IS registered (participant "Mark T"); **mid-submission checkpoint is MANDATORY to stay in the hackathon — extended, open until Sun Aug 2 midnight (dashboard countdown: Aug 3 1:59 PM CEST); submit ASAP** (paste-ready copy: docs/submission/checkpoint-2.md); registration closes Sat Aug 8; **final submission Sun Aug 9 AoE** = functional MVP on Arc + public repo + 3-min video + **deck**; Demo Day Thu Aug 20 (6 PM CEST); top ~8 teams → 8-week accelerator. Platform locks at deadlines — submit early. Project page not yet created (name: "vAPI Trust Network", Agentic Economy track).

**The product:** one cohesive outcome and trust layer for ERC-8183 agentic work. An agent escrows USDC; the guarded AI lane either settles within policy or escalates. Escalated/HumanOnly work can purchase an allowlisted human review through x402. Telegram carries the review, Circle pays the auditor, and the same Circle Developer-Controlled Wallet records the evidence-backed verdict through `EvaluationRouter` before AgenticCommerce completes or rejects the escrow. Settlement is terminal; this is pre-settlement review, not an appeal system. Primary spec: `docs/specs/2026-07-28-paid-human-review-exchange.md`.

## State (as of Tue 2026-07-28 — v3 and paid-review stack implemented)

Done and verified:
- `contracts/src/EvaluationRouter.sol` v3 preserves AIAllowed/HumanOnly lanes and adds reviewer/reward/evidence/payout provenance to `humanResolve`. Foundry is 37/37 green. The source-verified Arc Testnet deployment is `0x44A51C365eB3eC703534ebb56394E7015930533D`.
- The router's sole `humanResolver` is the Circle Developer-Controlled Wallet `0x025d2216594469E19EA70F38ef9D08E47e5dd3E7` (verified by live RPC and the deployment broadcast). v2 `0x1a43aec02e86096b7548ff78f335e6d6271b306a` and v1 `0x215766ef04b4d3af08e1cfc15863962a305af3d4` are historical read-only deployments; never use them as the current `ROUTER_ADDRESS`.
- `core/` contains both the guarded AI judge and the paid human-review exchange: x402 seller middleware with durable signed-payment journaling, canonical payer+nonce replay protection, and fail-safe quarantined restart reconciliation, hash-verified AI-evidence handoff before every AI decision, transactional SQLite order/assignment/vote/event state, Telegram webhook/claim/verdict flow, pre-request Circle payout and contract-execution journaling, idempotent retry/reconciliation, nonterminal `STUCK` polling, authenticated exhausted-attempt recovery, refunds, canonical `HumanEvidenceV1`, reviewer CLI, health, OpenAPI, and public polling/evidence/reviewer endpoints. Core typecheck and 73/73 tests are green.
- `app/` is a read-only React Router v7 SSR dashboard. It combines Arc events with the token-authenticated review-service feed, shows the paid-review timeline and factual reviewer history, and degrades cleanly when either source is unavailable. There are no browser or web-server `HUMAN_PK` resolve controls. App typecheck and production build are green.
- `adapters/arc/abi/` pins the live AgenticCommerce and EvaluationRouter v3 ABIs. Evidence is a versioned union of `AIEvidenceV1 | HumanEvidenceV1`.

## Live Arc facts

- Arc Testnet: chainId `5042002`; RPC `https://rpc.testnet.arc.network`; explorer `https://testnet.arcscan.app`.
- AgenticCommerce proxy: `0x0747EEf0706327138c69792bF28Cd525089e4583`.
- EvaluationRouter v3: `0x44A51C365eB3eC703534ebb56394E7015930533D`.
- Circle resolver/treasury wallet: `0x025d2216594469E19EA70F38ef9D08E47e5dd3E7`.
- Arc USDC: `0x3600000000000000000000000000000000000000` (6 decimals).
- Current v3 proof set (`DEMO_JOB_IDS=159668,159669,159670`), rechecked by live RPC:
  - `159668`: AIAllowed, `AutoCompleted`, AgenticCommerce status `Completed`.
  - `159669`: AIAllowed injection case, `Escalated`, status `Submitted`.
  - `159670`: client-selected HumanOnly, model skipped, `Escalated`, status `Submitted`.
- These jobs prove the v3 AI and escalation lanes. They do **not** yet prove the paid human-review chain.
- Public RPC limits are about 2 requests/second and 10,000 blocks per `eth_getLogs`. Keep the custom patient transport, shared chunked event sweeps, semaphore, and backoff; do not restore per-event `Promise.all` fan-out.

## Paid human-review workflow

1. `POST /v1/review-orders` validates the UUID/text payload, live v3 job, deliverable commitment, and eligible non-conflicted auditor before Circle Gateway requests the default `$0.25` x402 payment. SQLite reservations prevent duplicate concurrent charges; the full authorization and exact pre-settlement attempt are journaled for restart recovery.
2. The service persists the paid order, payment reference, unique Circle idempotency keys, assignments, votes, events, and asynchronous transaction attempts in `better-sqlite3`.
3. Telegram dispatches eligible allowlisted auditors. The first atomic claim wins; the reviewer chooses approve/reject and supplies a written reason. Claim timeout redispatches once; review-SLA expiry refunds the payer from the treasury.
4. A valid verdict is preflighted, then the Circle wallet pays the reviewer (default `$0.20`) regardless of decision. The created transaction ID is persisted before polling.
5. After payout confirmation, the service hashes canonical `HumanEvidenceV1` and executes v3 `humanResolve` from that same Circle wallet. A paid-reviewer/failed-settlement state retries only settlement and never pays twice. If fresh authoritative Arc state proves fulfillment became permanently impossible, an earned auditor reward is preserved and the x402 payer is refunded without calling the router.
6. The dashboard and public endpoints expose sanitized order state, evidence verification, reviewer history, payout/resolution/refund receipts, and Arcscan links. Internal operational errors remain behind `REVIEW_INTERNAL_TOKEN`.

## Railway layout

One repository, three Railway services:
- `vapi-web` → `deploy/railway-app.json`: SSR dashboard; static `/health`.
- `vapi-review` → `deploy/railway-review.json`: x402 API, Telegram webhook/worker, SQLite, Circle payout/settlement. Single replica; mount `/data` and set `REVIEW_DATABASE_PATH=/data/review-exchange.sqlite`.
- `vapi-judge` → `deploy/railway-judge.json`: guarded AI watcher. Mount its own `/data` volume and set `VAPI_DATA_ROOT=/data` for the cursor, deliverables, and AI evidence.

Both long-running core services start Node directly and have a 30-second Railway drain window. Scope oracle/Anthropic secrets only to `vapi-judge`; scope Gateway/Telegram/Circle secrets only to `vapi-review`. Share `REVIEW_INTERNAL_TOKEN` with all three services, give the judge `REVIEW_SERVICE_INTERNAL_URL`, and give the web app `REVIEW_SERVICE_URL`. Never commit secret values.

## Remaining external blockers / next proof

1. Configure a real `X402_SELLER_ADDRESS`, `TELEGRAM_BOT_TOKEN`, valid `TELEGRAM_WEBHOOK_SECRET`, and a shared `REVIEW_INTERNAL_TOKEN`; set the review service's public HTTPS URL and add 2–3 allowlisted reviewers. Values belong only in external secret stores or gitignored local env.
2. Deploy/configure the three Railway services and their two separate persistent volumes.
3. The actual live `x402 payment → Telegram claim/verdict → Circle auditor payout → v3 escrow settlement → public evidence timeline` has **not been run yet**. This is the next milestone; do not describe jobs 159669/159670 as paid-review completions.
4. After the first full run, repeat approval, rejection/refund, AI escalation, and payout-success/settlement-retry recovery; then record the phone-buzz demo and submit the marketplace endpoint.

## Conventions

- Conventional Commits. One repository and one product; `core/` contains both workers/services, `app/` is read-only presentation, and `contracts/` uses Foundry.
- Any money-path contract change requires the full Foundry suite; any review-service change requires core typecheck/tests.
- Never reintroduce `HUMAN_PK` into the app or web server. The Circle wallet is the sole v3 human resolver; the oracle key is only for the guarded AI submission path.
- Keep claims precise: operator-attested provenance and factual reviewer statistics, not trustless arbitration or reviewer "accuracy."
- No DAO, token, staking, slashing, appeals, open signup, arbitrary files/URLs, or quorum panels in the hackathon build.
