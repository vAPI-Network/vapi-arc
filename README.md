# vAPI Trust Network

**The outcome and trust layer for agentic freelance work. Its contracts are
live on Arc Testnet; the paid human-review service is ready for a credentialed
end-to-end run.**

vAPI combines ERC-8183 escrow, guarded AI evaluation, accountless x402 review
payments, paid human auditors in Telegram, and Circle wallet settlement in one
product.

```text
agent escrows a freelance job
        ↓
AI settles safe work ───────────────→ provider paid / client refunded
        ↓ escalate
agent pays the x402 review endpoint
        ↓
allowlisted auditor claims in Telegram
        ↓
Circle Wallet pays auditor + submits verdict
        ↓
ERC-8183 escrow pays provider or refunds client
```

## Why it exists

ERC-8183 locks funds until an evaluator approves or rejects submitted work, and
settlement is terminal. vAPI holds that evaluator seat with a client-selected
review lane:

1. **AIAllowed** handles narrow, low-value, rubric-checkable work. The model
   never holds a key; deterministic policy checks its structured response
   before a restricted oracle can settle.
2. **HumanOnly** skips the model. It and every uncertain, over-cap, or hostile
   AI result are escalated before funds move.
3. **Paid human review** lets an agent sponsor an escalated decision for 0.25
   USDC through Circle Gateway. The first eligible council member claims the
   review in Telegram and receives 0.20 USDC regardless of approve/reject.

Every human resolution anchors the reviewer wallet, reward, evidence hash, and
reviewer payout transaction on Arc. The dashboard exposes objective history and
receipts without inventing an unverifiable “trust score.”

## Live demo console

The hosted `/demo` console turns the complete HumanOnly path into two browser
actions and one Telegram decision:

1. Unlock live controls with the presenter passcode and confirm every Arc,
   Gateway, Telegram, Circle, wallet, and council readiness check is green.
2. Select **Create & fund $1 escrow**. The server-owned demo agent creates the
   job, selects HumanOnly before submission, funds it, commits the deliverable,
   and waits for the real judge to escalate it.
3. Select **Agent purchases human review · $0.25**. The console records the
   genuine `402 → Gateway authorization → 202` exchange and waits for Telegram.
4. The allowlisted auditor claims, taps approve or reject, and replies with a
   written reason. The browser then follows the $0.20 payout, router settlement,
   evidence verification, and Arcscan receipts automatically.

Routine demo runs require no terminal, copied job IDs, browser wallet, or manual
refresh. Private keys remain only in the single-replica `vapi-review` Railway
service; completed `/proof/:runId` pages are public and read-only.

## Live contracts

- Circle AgenticCommerce:
  [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583)
- Source-verified EvaluationRouter v3:
  [`0x44A51C365eB3eC703534ebb56394E7015930533D`](https://testnet.arcscan.app/address/0x44A51C365eB3eC703534ebb56394E7015930533D)
- Circle Developer-Controlled Wallet / human resolver:
  [`0x025d2216594469E19EA70F38ef9D08E47e5dd3E7`](https://testnet.arcscan.app/address/0x025d2216594469E19EA70F38ef9D08E47e5dd3E7)

Fresh v3 proof jobs are `159668` (AI completed), `159669` (injection
escalation), and `159670` (HumanOnly escalation).

Those jobs prove the deployed router’s AI and escalation lanes. The complete
`x402 payment → Telegram review → auditor payout → escrow settlement` chain has
not yet been run with the live Gateway and Telegram credentials.

## Run locally

```sh
pnpm install
cp .env.example .env

# For discovery without live Gateway, Telegram, and Circle credentials.
# /health stays degraded and paid execution remains disabled.
export REVIEW_ALLOW_PARTIAL_CONFIG=true

# Offline guarded-judge fixture
pnpm -C core dry-run

# Paid review API, Telegram dispatcher, and Circle transaction reconciler
pnpm -C core review-server

# Read-only operations dashboard
pnpm -C app dev
```

Add allowlisted reviewers with:

```sh
pnpm -C core reviewer:add \
  --telegram-user-id 123456 \
  --chat-id 123456 \
  --alias "Ada" \
  --payout-address 0x... \
  --skills security,api
```

The paid public endpoint is `POST /v1/review-orders`. Free polling, evidence,
reviewer history, health, and OpenAPI endpoints are described by
`GET /openapi.json`. See [core/README.md](core/README.md) for configuration.

## Repository

This stays on the same pnpm/TypeScript + React Router v7 (RRV7) stack used by
the other vAPI repos. It is one repository and one product; Railway is
configured to run the RRV7 dashboard, review API/worker, and AI judge as three
services from the same source.

- `contracts/` — EvaluationRouter v3 and 37 Foundry tests.
- `core/` — AI judge, x402 review service, SQLite state machine, Telegram bot,
  Circle wallet orchestration, evidence, reviewer CLI, and 91 service tests.
- `app/` — live demo console, public proof pages, Arc feed, paid-review
  operations timeline, and reviewer history.
- `adapters/arc/` — pinned Circle contract ABIs.
- `docs/` — trust model, architecture, and submission material.

Railway config-as-code and persistent-volume instructions live in
[`docs/deployment/railway.md`](docs/deployment/railway.md). The hackathon
deployment uses single-replica SQLite and does not require Supabase.

The project keeps Circle’s ERC-8183 escrow as its single settlement truth. It
borrows asynchronous wallet patterns from
[arc-escrow](https://github.com/circlefin/arc-escrow), x402 seller patterns from
[arc-nanopayments](https://github.com/circlefin/arc-nanopayments), and agent
buyer patterns from
[Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits)
without copying their alternative escrow contracts or application stacks.

Detailed design:
[Paid Human Review Exchange](docs/specs/2026-07-28-paid-human-review-exchange.md).
