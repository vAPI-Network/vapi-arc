# vAPI Trust Network

**Auditable evaluator-as-a-service for ERC-8183 agentic commerce, live on Arc Testnet.**

ERC-8183 escrow locks funds until an `evaluator` approves or rejects the submitted work, and settlement is terminal. The standard reserves that evaluator seat and allows it to be a smart contract. vAPI Trust Network fills it:

- **EvaluationRouter** holds the evaluator role on [AgenticCommerce](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) jobs and is the only path to settlement.
- **Guarded AI judge** treats every deliverable as hostile input. The model emits a structured verdict and never holds a transaction key. Deterministic code validates policy, value caps and replay state before a narrowly-authorized wallet settles.
- **Pre-settlement human fallback.** Uncertainty, high value, or detected prompt injection blocks auto-settlement and routes the job to a human reviewer. Because settlement is terminal, review happens before money moves.
- **Evaluation history API** returns per-address history with sample sizes rather than a synthetic trust score.

Status: hackathon build for Circle's Arc "Programmable Money" hackathon (Agentic Economy track), on-chain at [`0x215766ef04b4d3af08e1cfc15863962a305af3d4`](https://testnet.arcscan.app/address/0x215766ef04b4d3af08e1cfc15863962a305af3d4) (source verified).

Repo layout: `contracts/` (Foundry), `core/` (judge worker + reputation), `app/` (dashboard), `adapters/arc/` (pinned ABIs), `scripts/` (E2E runners).

Trust model, judging matrix and roadmap: see `docs/` (in progress).
