# Encode platform copy: project creation + mid-submission checkpoint

Paste-ready copy for the Encode dashboard. Mid-submission is mandatory to stay
in the hackathon and closes Sun Aug 2 at midnight.

## Create a New Project form

**Project Name**

> vAPI Trust Network

**Description**

> The outcome and trust layer for agentic freelance work on Arc. A guarded AI
> evaluator settles narrow, low-risk ERC-8183 jobs, while HumanOnly, uncertain,
> or hostile work escalates before funds move. Hiring agents can sponsor an
> independent human review with a gasless x402 USDC payment; allowlisted
> auditors claim in Telegram, receive a fixed Circle Wallet payout regardless
> of approve/reject, and anchor their evidence-backed verdict on Arc.

**Project Image**: `docs/submission/project-card.png` (1200×630 PNG)

**Track**: Agentic Economy

## Mid-submission checkpoint (repo + progress summary)

**Repository**

> https://github.com/vAPI-Network/vapi-arc

**Progress summary**

> vAPI Trust Network is the outcome and trust layer for agent-to-agent
> freelance work on Arc (Agentic Economy track). Agents hire agents through
> Circle's ERC-8183 AgenticCommerce escrow. EvaluationRouter v3 holds the
> evaluator seat: a guarded AI judge evaluates committed deliverables and a
> deterministic policy gate either settles or escalates. HumanOnly and
> escalated jobs can purchase an allowlisted human review through Circle
> Gateway x402; Telegram carries the claim and verdict, and a Circle
> Developer-Controlled Wallet pays the reviewer and records the final
> evidence-backed resolution.
>
> Working today on Arc testnet, verifiable on-chain:
>
> - Source-verified EvaluationRouter v3:
>   0x44A51C365eB3eC703534ebb56394E7015930533D (37/37 Foundry tests).
>   Its only human resolver is our live Circle Developer-Controlled Wallet.
> - Full autonomous AI loop: job 159668 was judged and completed; hostile job
>   159669 was escalated without settlement; HumanOnly job 159670 skipped the
>   model and escalated. Deliverables are hash-checked against their on-chain
>   commitments, and the model never holds a transaction key.
> - Paid Human Review Exchange implemented in the same repo: Circle Gateway
>   x402 seller endpoint, durable SQLite order/payment state, allowlisted
>   Telegram claim + reasoned verdict, Circle reward/refund/contract execution
>   reconciliation, hash-verified AI-to-human escalation evidence, canonical
>   HumanEvidenceV1, factual reviewer history, and 73/73 service tests.
> - Read-only React Router v7 operations dashboard: Arc provenance, paid-review
>   states, reviewer history, evidence and Circle/Arcscan receipts. There is no
>   browser or web-server human signing key.
> - One pnpm/TypeScript repo with three Railway process configs: dashboard,
>   review API/worker, and guarded AI judge. The hackathon deployment uses a
>   single SQLite review worker on a Railway volume; no Supabase dependency.
>
> Remaining before final: configure the x402 seller + Telegram secrets and
> council, deploy the three Railway services, run the first real
> x402 → phone buzz → Circle payout → v3 escrow settlement chain, then record
> the 3-minute demo and deck. We do not present the current escalation jobs as
> completed paid-human reviews.

## Honest stack inventory (for judging-criteria questions)

| Circle product | Status |
| --- | --- |
| Arc L1 | Yes: contracts deployed, all settlement on Arc testnet |
| USDC | Yes: gas and escrow settlement currency end-to-end |
| Circle Contracts | Yes: we hold the evaluator seat on Circle's deployed AgenticCommerce (ERC-8183) |
| Circle Wallets (dev-controlled) | Partial live proof: Arc wallet is deployed and authorized; payout/refund/contract execution is implemented and mocked end-to-end, credentialed phone-buzz run remains |
| Agent Stack | No direct dependency; starter kits informed the accountless buyer story |
| Gateway Nanopayments / x402 | Yes in product: paid seller endpoint, durable replay/crash handling, default 0.25 USDC fee; first public credentialed payment remains |
| App Kits / Paymaster | No; not needed for this server-to-server flow |

Do not overclaim the "No" rows anywhere in the submission.
