# vAPI Trust Network

vAPI reviews ERC-8183 freelance jobs on Arc before escrow funds are released.
AIAllowed jobs can settle after deterministic checks validate the evaluator's
response. HumanOnly and escalated jobs can purchase a Telegram review for 0.25
USDC through Circle Gateway. A Circle Developer-Controlled Wallet pays the
auditor 0.20 USDC and records the verdict on Arc.

```text
agent escrows a freelance job
        ↓
AI verdict passes policy checks ───→ provider paid / client refunded
        ↓ escalate
agent pays the x402 review endpoint
        ↓
allowlisted auditor claims in Telegram
        ↓
Circle Wallet pays auditor + submits verdict
        ↓
ERC-8183 escrow pays provider or refunds client
```

## How settlement works

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

Each human resolution records the reviewer wallet, reward, evidence hash, and
payout transaction on Arc. The dashboard shows review counts, decisions,
response times, rewards, and transaction receipts.

## Demo console

The hosted `/demo` console runs the HumanOnly path with two browser actions and
one Telegram decision:

1. Unlock live controls with the presenter passcode and confirm every Arc,
   Gateway, Telegram, Circle, wallet, and council readiness check is green.
2. Select **Create & fund $1 escrow**. The server-owned demo agent creates the
   job, selects HumanOnly before submission, funds it, commits the deliverable,
   and waits for the real judge to escalate it.
3. Select **Agent purchases human review · $0.25**. The console records the
   `402 → Gateway authorization → 202` exchange and waits for Telegram.
4. The allowlisted auditor claims, taps approve or reject, and replies with a
   written reason. The browser then follows the $0.20 payout, router settlement,
   evidence verification, and Arcscan receipts automatically.

Private keys remain in the single-replica `vapi-review` Railway service.
Completed `/proof/:runId` pages are public and read-only.

## Live contracts

- Circle AgenticCommerce:
  [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583)
- Source-verified EvaluationRouter v3:
  [`0x44A51C365eB3eC703534ebb56394E7015930533D`](https://testnet.arcscan.app/address/0x44A51C365eB3eC703534ebb56394E7015930533D)
- Circle Developer-Controlled Wallet / human resolver:
  [`0x025d2216594469E19EA70F38ef9D08E47e5dd3E7`](https://testnet.arcscan.app/address/0x025d2216594469E19EA70F38ef9D08E47e5dd3E7)

Deployed v3 jobs are `159668` (AI completed), `159669` (injection
escalation), and `159670` (HumanOnly escalation).

Those jobs exercise the router's AI and escalation paths. A UI rehearsal also
created and funded job `159917` and accepted a 0.25 USDC x402 payment. Its
Telegram review expired before a verdict. The next rehearsal must confirm the
auditor payout and escrow settlement.

## Run locally

```sh
pnpm install
cp .env.example .env

# For discovery without live Gateway, Telegram, and Circle credentials.
# /health stays degraded and paid execution remains disabled.
export REVIEW_ALLOW_PARTIAL_CONFIG=true

# Offline evaluator fixture
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

- `contracts/`: EvaluationRouter v3 and 37 Foundry tests.
- `core/`: AI judge, x402 review service, SQLite state machine, Telegram bot,
  Circle wallet orchestration, evidence, reviewer CLI, and 108 service tests.
- `app/`: demo console, public run records, Arc feed, paid-review
  operations timeline, and reviewer history.
- `adapters/arc/`: pinned Circle contract ABIs.
- `docs/`: review model, architecture, and submission material.

Railway config-as-code and persistent-volume instructions live in
[`docs/deployment/railway.md`](docs/deployment/railway.md). The hackathon
deployment uses single-replica SQLite and does not require Supabase.

The project uses Circle's ERC-8183 escrow for job settlement. Its asynchronous
wallet handling follows patterns from
[arc-escrow](https://github.com/circlefin/arc-escrow), x402 seller patterns from
[arc-nanopayments](https://github.com/circlefin/arc-nanopayments), and agent
buyer patterns from
[Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits)
without copying their alternative escrow contracts or application stacks.

Detailed design:
[Paid Human Review Exchange](docs/specs/2026-07-28-paid-human-review-exchange.md).
