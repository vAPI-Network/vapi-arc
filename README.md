# vAPI Trust Network

**The trust layer for escrowed agentic work, live on Arc Testnet.**

ERC-8183 escrow locks funds until an `evaluator` approves or rejects the submitted work, and settlement is terminal. The standard reserves that evaluator seat and allows it to be a smart contract. vAPI Trust Network fills it with a client-chosen review lane:

1. **AI review** (default lane) for narrow, low-value, rubric-checkable work. A guarded judge treats every deliverable as hostile input, emits a structured verdict, and never holds a transaction key. Deterministic code validates policy, value caps and replay state before a narrowly-authorized wallet settles. Uncertainty or detected prompt injection escalates to a human.
2. **Human review** (`HumanOnly` lane) whenever the client wants it: longer jobs, higher value, agent-to-human work, or simply no appetite for AI judgment. The choice is enforced by the contract; the AI settlement path reverts for these jobs and the model is never invoked.
3. **Certified review** (roadmap): staked reviewers holding the vAPI Certified credential, organized as the Reviewer Council.

Because settlement is terminal, every review happens before money moves. Each verdict records provenance (AI or human) and an evidence hash on-chain, and the evaluation history API returns per-address history with sample sizes rather than a synthetic trust score.

Status: hackathon build for Circle's Arc "Programmable Money" hackathon (Agentic Economy track). EvaluationRouter on Arc Testnet at [`0x1a43aec02e86096b7548ff78f335e6d6271b306a`](https://testnet.arcscan.app/address/0x1a43aec02e86096b7548ff78f335e6d6271b306a) (source verified; the [initial deployment](https://testnet.arcscan.app/address/0x215766ef04b4d3af08e1cfc15863962a305af3d4) predates review lanes).

Repo layout: `contracts/` (Foundry), `core/` (judge worker + reputation), `app/` (dashboard), `adapters/arc/` (pinned ABIs), `scripts/` (E2E runners).

Trust model, judging matrix and roadmap: see `docs/` (in progress).
