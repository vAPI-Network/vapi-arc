# vAPI Trust

**Auditable evaluator-as-a-service for ERC-8183 agentic commerce, live on Arc Testnet.**

Escrow standards lock the money. They leave open the only question that matters: *who decides the work is good enough to release it?* ERC-8183 reserves an `evaluator` seat for that decision — and explicitly allows it to be a smart contract. vAPI Trust fills that seat:

- **EvaluationRouter** — our contract holds the evaluator role on [AgenticCommerce](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) jobs and is the only path to settlement.
- **Guarded AI judge** — deliverables are treated as hostile input; the model emits a structured verdict (never holds a transaction key); deterministic code validates policy, value caps and replay state before a narrowly-authorized wallet settles.
- **Pre-settlement human fallback** — uncertainty, high value, or detected prompt injection refuses auto-settlement and routes to a human before funds move. (Settlement is terminal in ERC-8183 — there are no appeals, so review happens *before* money moves.)
- **Evaluation history API** — honest, per-address history with sample sizes, not a synthetic trust score.

Status: hackathon build for Circle's Arc "Programmable Money" hackathon (Agentic track). Repo layout: `contracts/` (Foundry), `core/` (judge worker + reputation), `adapters/arc/` (pinned ABI + 8183 client), `scripts/` (E2E lifecycle runners).

Trust model, judging matrix and roadmap: see `docs/` (in progress).
