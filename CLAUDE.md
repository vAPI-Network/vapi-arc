# vapi-arc — Agent Guide

Hackathon build for Circle's Arc "Programmable Money" hackathon (Agentic track). **Submit by Sun 2026-08-02** (midpoint, must submit to stay in; final deadline Aug 22; top teams → 8-week accelerator).

**The product:** auditable evaluator-as-a-service for ERC-8183. Our `EvaluationRouter` holds the evaluator seat on Circle's deployed AgenticCommerce contract; a guarded AI judge settles narrow low-risk jobs automatically; uncertain/hostile work routes to a human **before** funds move (settlement is terminal in ERC-8183 — no appeals). Full design + trimmed scope + schedule: `docs/specs/2026-07-27-vapi-trust-design.md` (read it first).

## State (as of Mon 2026-07-27 evening)

Done, committed, verified:
- `contracts/src/EvaluationRouter.sol` — 22/22 Foundry tests green (`cd contracts && forge test`). Deploy: `contracts/script/DeployRouter.s.sol`.
- `core/` — guarded AI judge worker (watcher → hostile-input judge → deterministic gate → evidence records → oracle submitter). `pnpm -C core typecheck` green; `node --import tsx src/index.ts --once --dry-run` works without API keys.
- `app/` — React Router v7 SSR dashboard (feed, /review queue, /provider/:address, /api/reputation/:address). No DB; loaders read Arc RPC. `pnpm -C app build` green; smoke-tested.
- `scripts/e2e-lifecycle.sh` + `scripts/e2e-router.sh` — full two-job demo (AI settle / escalate→human reject / unauthorized revert proof). **Blocked on faucet funds.**
- `adapters/arc/abi/` — pinned ABIs of deployed AgenticCommerce (UUPS proxy, Circle-upgradeable) + our router.

## Chain facts (verified on-chain 2026-07-27)

- Arc Testnet: chainId 5042002, RPC https://rpc.testnet.arc.network, explorer https://testnet.arcscan.app
- AgenticCommerce proxy `0x0747EEf0706327138c69792bF28Cd525089e4583` → impl `0xa316fd02827242d537f84730f8a37d0ba5fd351a`
- Job status enum: Open=0 Funded=1 Submitted=2 Completed=3 Rejected=4 Expired=5; `complete()` requires Submitted + caller==evaluator; evaluator fee paid only on complete (currently 0 bps; platform fee 0 bps)
- USDC = `0x3600000000000000000000000000000000000000` (6dp ERC-20 view of native gas)
- Demo wallets in gitignored `.env` (testnet throwaway): client `0x6581760Dcbc2a2617a8DF2f20273b9B52660DA31`, provider `0x6734b4E43e6EF164ce07eC17fC27FdD7C51078d0`, oracle `0x07CFB9b2F7a6F363Bf1804f2d511BcCf09cD59e9`, human `0x3c8bBdBE8a9A1f51df3fadB6292CBcf0cDFa141F`

## Remaining path to submission

1. **Blocked on human**: faucet USDC to the 4 wallets (faucet.circle.com; client needs most); Circle Standard testnet API key (`vapi-arc-hackathon`) + Entity Secret; ANTHROPIC_API_KEY; Encode registration.
2. Once funded: deploy router (`forge script script/DeployRouter.s.sol --rpc-url $ARC_RPC_URL --private-key $CLIENT_PK --broadcast`), set `ROUTER_ADDRESS` in `.env` + app env, run `scripts/e2e-router.sh` → submittable floor exists. Record backup footage immediately.
3. Wed: live judge runs with real Anthropic key; injection fixtures; refine judge prompt (security-critical — treat deliverables as hostile).
4. Thu: Circle dev-controlled wallets integration (client/provider/judge wallet sets — judging points); wire /review resolve button to human wallet; Railway deploy.
5. Fri: 10 unattended E2E runs; adversarial review of router; arcscan source verification; **feature freeze Friday night**.
6. Sat: README trust model (who controls oracle wallet, caps, outage behavior, "auditable evaluator operator" NOT "trustless arbitration"; note Circle's contract is admin-upgradeable) + judging-criteria matrix + roadmap section (dual-chain: Base = VAPI token/x402 home, Arc = 8183 adapter; staked DAO panels later) + 3-min video + submission draft.
7. Sun Aug 2: dry run, submit via Encode. Nothing else.

## Conventions

- Conventional Commits. Keep `core/` (judge) and `app/` (dashboard) independent packages; contracts via Foundry.
- Money logic (`contracts/`) changes require running the full test suite; the router is deliberately minimal — do not add staking/slashing/panel features before the midpoint (explicitly cut, see design doc).
- The AI judge must never hold a transaction key; all settlement goes through the deterministic gate in `core/src/validate.ts`.
- Degrade order if slipping: Circle Wallets integration → resolve-button wiring → live-judge polish. Floor = router + AI settle + one human-resolve, on-chain.
