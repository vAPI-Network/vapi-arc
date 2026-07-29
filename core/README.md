# @vapi-trust/core
This worker evaluates submitted ERC-8183 jobs for vAPI Trust Network on Arc Testnet.
It watches AgenticCommerce submissions addressed to the EvaluationRouter.
Local deliverables are checked against their on-chain keccak256 commitments.
The model emits untrusted verdict data and never initiates transactions.
Deterministic code validates schema, injection flags, confidence, value, and expiry.
Only a narrow oracle wallet can sign the resulting router call.
Install from the repository root with `pnpm install`.
Run the offline API-key-free fixture with `pnpm -C core dry-run`.
Run one live pass with `pnpm -C core judge-once` or poll with `pnpm -C core watch`.

The long-running judge serves `GET /health` on Railway's injected `PORT`, or
`JUDGE_PORT` for local development when `PORT` is unset. It returns `503`
until one complete Arc polling pass succeeds and again while the last
successful pass is stale or the worker is shutting down. The default freshness
window is five minutes (`JUDGE_HEALTH_MAX_STALENESS_MS=300000`) so one pass can
include model evaluation, evidence publication, and Arc confirmation without
being mistaken for a dead worker.

## Paid Human Review Exchange

The review service turns an escalated router job into an accountless, paid
human-review order:

1. `POST /v1/review-orders` validates the Arc job and deliverable commitment
   and confirms that an independent allowlisted auditor is available before
   Circle Gateway requests an x402 payment. A durable payment intent stores the
   full signed authorization first. The pre-settle hook journals the exact
   Gateway attempt or aborts payment. Restart reconciliation retries only when
   Gateway can return authoritative settlement provenance and fresh Arc,
   evidence, council, and treasury checks still prove the review can be
   fulfilled. Once settlement may have begun, the signed intent stays
   quarantined through invalid verification, quote drift, or permanent
   preflight failure; a point-in-time verification cannot cancel an in-flight
   request. An already-used nonce without its original transfer UUID is also
   quarantined for manual reconciliation rather than treated as proof of
   payment.
2. The service offers the order to allowlisted reviewers in Telegram. The first
   valid claim wins and the claimant submits an approve/reject verdict with a
   written reason.
3. Circle Developer-Controlled Wallets normally pays the reviewer, then calls
   `EvaluationRouter.humanResolve` with the reviewer, reward, evidence hash, and
   payout transaction hash. If fresh Arc state proves settlement has become
   permanently impossible, the service preserves the earned reviewer payout,
   refunds the sponsor, and records the abort without a second router call.
4. Public order, reviewer, and canonical `HumanEvidenceV1` endpoints expose the
   resulting audit trail.

Run the service with:

```sh
pnpm -C core review-server
```

SQLite defaults to `core/data/review-exchange.sqlite`; use
`REVIEW_DATABASE_PATH` for a persistent deployment volume. The live service
fails startup unless every payment, Telegram, Circle, chain, and internal API
dependency is configured. For an intentionally incomplete local discovery
run, set `REVIEW_ALLOW_PARTIAL_CONFIG=true`; `/health` remains degraded and the
paid route fails before x402 settlement.

Payment intents, immutable price/reward quotes, Gateway provenance, and order
transitions are durable. Every outbound Circle request is journaled with its
stable idempotency key before the external call, and returned transaction
attempts are reconciled afterward. After the configured terminal retry budget
is exhausted, an authenticated operator can open a new audited attempt window
without replaying a successful transfer or resolution. Treasury admission
reserves the combined reviewer-payout and payer-refund worst case across
concurrent purchases.

Circle `STUCK` transactions remain in flight: the worker retains their
transaction ID and idempotency key and continues reconciliation through
webhooks/polling. They cannot be rotated through the operator resume endpoint;
Circle acceleration or cancellation must establish a later terminal state
first.
Consumed raw signature hashes and canonical payer+nonce authorization keys
remain attached to the paid order after its temporary reservation is removed.
This deployment model therefore requires one review service process and one
attached volume.

No Supabase database is required for the hackathon deployment. SQLite runs in
WAL mode on one persistent Railway volume and the review worker stays at one
replica. The storage boundary remains isolated so a later multi-replica release
can move to Postgres/Supabase without changing the public API or order model.

Required live configuration:

- `ROUTER_ADDRESS`, `AGENTIC_COMMERCE`, and `ARC_RPC_URL`
- `X402_SELLER_ADDRESS` and optional `X402_FACILITATOR_URL`
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`
- `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID`, and
  `CIRCLE_WALLET_ADDRESS`
- `REVIEW_INTERNAL_TOKEN` for the dashboard feed and judge evidence handoff
- `REVIEW_SERVICE_INTERNAL_URL` on `vapi-judge`, pointing at `vapi-review`

Circle webhook signatures are verified by `X-Circle-Key-Id`; the service
retrieves and bounded-caches the matching Circle public key with
`CIRCLE_API_KEY`. The webhook route is rate-limited and upstream key-service
failures return a retryable status.

`REVIEW_PRICE_USDC` defaults to `250000` and `REVIEWER_REWARD_USDC` defaults to
`200000`; both use 6-decimal USDC integer units. This hackathon service rejects
startup unless x402 is configured for Arc Testnet (`eip155:5042002`).

By default, purchases are rejected unless the escrow has enough lifetime for
the review SLA, both asynchronous Circle transactions, and a safety margin.
`REVIEW_MIN_JOB_EXPIRY_SECONDS` can make that bound more conservative, but the
service rejects a lower production value. Startup and `/health` also require a
prefunded Arc USDC treasury; configure the floor with
`REVIEW_MIN_TREASURY_USDC`.

Manage the allowlisted Reviewer Council with:

```sh
pnpm -C core reviewer:add --telegram-user-id 123 --chat-id 123 \
  --alias "Ada" --payout-address 0x... --skills security,api
pnpm -C core reviewer:list
pnpm -C core reviewer:disable --id <reviewer-id>
```

The free public API includes `/v1/review-orders/:id`,
`/v1/evidence/:evidenceHash`, and `/v1/reviewers/:address`. The dashboard uses
`GET /internal/review-orders` plus
`GET /internal/dashboard-chain-snapshot` with `Authorization: Bearer
${REVIEW_INTERNAL_TOKEN}`. The latter is a durable SQLite snapshot refreshed
by the review worker; web navigation never performs a historical Arc log scan.
The index deliberately scans at a low background cadence and retains its last
verified data through transient RPC failures. Exhausted Circle work can be
resumed with `POST /internal/review-orders/:orderId/resume` and a strict
`{"operation":"payout"|"resolution"|"refund"}` body using the same bearer
token.

Before broadcasting any AI decision, the judge sends its strict canonical
`AIEvidenceV1` to `POST /internal/ai-evidence` with that same bearer token. The
judge retries transient failures and does not submit the settlement or
escalation until the evidence service acknowledges the hash. HumanOnly jobs
continue to use the router's fixed human-lane reason hash.
