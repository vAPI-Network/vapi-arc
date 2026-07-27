# @vapi-trust/core
This worker evaluates submitted ERC-8183 jobs for vAPI Trust on Arc Testnet.
It watches AgenticCommerce submissions addressed to the EvaluationRouter.
Local deliverables are checked against their on-chain keccak256 commitments.
The model emits untrusted verdict data and never initiates transactions.
Deterministic code validates schema, injection flags, confidence, value, and expiry.
Only a narrow oracle wallet can sign the resulting router call.
Install from the repository root with `pnpm install`.
Run the offline API-key-free fixture with `pnpm -C core dry-run`.
Run one live pass with `pnpm -C core judge-once` or poll with `pnpm -C core watch`.
