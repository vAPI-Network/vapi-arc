# vapi-arc — Agent Guide

Hackathon build for Circle's Arc "Programmable Money" hackathon via Encode Club (Agentic Economy track). **Real dates (verified from the logged-in Encode dashboard 2026-07-28):** human IS registered (participant "Mark T"); **mid-submission checkpoint is MANDATORY to stay in the hackathon — extended, open until Sun Aug 2 midnight (dashboard countdown: Aug 3 1:59 PM CEST); submit ASAP** (paste-ready copy: docs/submission/checkpoint-2.md); registration closes Sat Aug 8; **final submission Sun Aug 9 AoE** = functional MVP on Arc + public repo + 3-min video + **deck**; Demo Day Thu Aug 20 (6 PM CEST); top ~8 teams → 8-week accelerator. Platform locks at deadlines — submit early. Project page not yet created (name: "vAPI Trust Network", Agentic Economy track). Programme manager: Giles Mallinson, giles@encode.club (Discord gilesmallinson#0).

**The product:** auditable evaluator-as-a-service for ERC-8183. Our `EvaluationRouter` holds the evaluator seat on Circle's deployed AgenticCommerce contract; a guarded AI judge settles narrow low-risk jobs automatically; uncertain/hostile work routes to a human **before** funds move (settlement is terminal in ERC-8183 — no appeals). Full design + trimmed scope + schedule: `docs/specs/2026-07-27-vapi-trust-design.md` (read it first).

## State (as of Mon 2026-07-27 night — SUBMITTABLE FLOOR EXISTS ON-CHAIN)

Done, committed, verified:
- `contracts/src/EvaluationRouter.sol` — 22/22 Foundry tests green (`cd contracts && forge test`). **Deployed to Arc testnet** at `0x215766ef04b4d3af08e1cfc15863962a305af3d4` (deployer = client wallet; oracle/human/cap 100 USDC/minConf 8000bp as in `DeployRouter.s.sol`).
- `scripts/e2e-router.sh` — **ran green on-chain**: job 159631 AI-settled (AIVerdict 9400bp → Completed, provider paid 1 USDC), job 159632 escalated → human-rejected, unauthorized verdict reverted. Job IDs now parsed from the `JobCreated` receipt log (`jobCounter()-1` raced on the shared contract — both e2e scripts fixed).
- `core/` — guarded AI judge worker (watcher → hostile-input judge → deterministic gate → evidence records → oracle submitter). `pnpm -C core typecheck` green; `node --import tsx src/index.ts --once --dry-run` works without API keys.
- `app/` — React Router v7 SSR dashboard (feed, /review queue, /provider/:address, /api/reputation/:address). No DB; loaders read Arc RPC. **Verified against the live router**: all routes 200, feed shows both demo jobs, reputation API returns completed=1/rejected=1. Event fetching is one shared chunked sweep (all event names, both contracts, one `eth_getLogs` per 9k-block chunk) behind a 2-slot RPC semaphore with backoff — required by the public RPC's ~2 req/s cap; do not reintroduce per-event `Promise.all` fan-out.
- `adapters/arc/abi/` — pinned ABIs of deployed AgenticCommerce (UUPS proxy, Circle-upgradeable) + our router.

In `.env` (gitignored): all wallet keys, `ROUTER_ADDRESS`, and `CIRCLE_API_KEY` (Standard testnet key `vapi-arc-hackathon`). Wallets faucet-funded 20 USDC each (provider now ~21 after job A payout).

## Chain facts (verified on-chain 2026-07-27)

- Arc Testnet: chainId 5042002, RPC https://rpc.testnet.arc.network, explorer https://testnet.arcscan.app
- AgenticCommerce proxy `0x0747EEf0706327138c69792bF28Cd525089e4583` → impl `0xa316fd02827242d537f84730f8a37d0ba5fd351a`
- Job status enum: Open=0 Funded=1 Submitted=2 Completed=3 Rejected=4 Expired=5; `complete()` requires Submitted + caller==evaluator; evaluator fee paid only on complete (currently 0 bps; platform fee 0 bps)
- USDC = `0x3600000000000000000000000000000000000000` (6dp ERC-20 view of native gas)
- Demo wallets in gitignored `.env` (testnet throwaway): client `0x6581760Dcbc2a2617a8DF2f20273b9B52660DA31`, provider `0x6734b4E43e6EF164ce07eC17fC27FdD7C51078d0`, oracle `0x07CFB9b2F7a6F363Bf1804f2d511BcCf09cD59e9`, human `0x3c8bBdBE8a9A1f51df3fadB6292CBcf0cDFa141F`
- Our EvaluationRouter v2 (review lanes): `0x1a43aec02e86096b7548ff78f335e6d6271b306a` (deployed + arcscan-verified 2026-07-28, current ROUTER_ADDRESS). v1 without lanes: `0x215766ef04b4d3af08e1cfc15863962a305af3d4` (historical, referenced by checkpoint-2 copy).
- Public RPC limits (measured): ~2 req/s per IP (HTTP 429, code -32011 "request limit reached"), `eth_getLogs` capped at a 10,000-block range; block time ~0.51s (so the app's 50k-block lookback ≈ 7h — reseed demo jobs shortly before recording/judging). Canonical multicall3 (`0xcA11...CA11`) is deployed; a WAF blocks default-python user-agents (curl/cast UAs fine).

## Review lanes (shipped Tue 2026-07-28, spec: docs/specs/2026-07-28-review-lanes-design.md)

Positioning: vAPI Trust Network = trust layer for escrowed agentic work; the guarded AI judge is one lane, not the identity. Lanes: AI review (default) / human review (`ReviewLane.HumanOnly`, client-set via `router.setLane`, AI settlement reverts `HumanReviewRequired`) / certified review (roadmap only — "Reviewer Council", credential "vAPI Certified"; never "DAO"). Worker skips the model entirely on human-lane jobs and escalates with reason hash keccak("client requested human review") — the app labels queue entries by comparing against it. 30/30 Foundry tests. **Proven on-chain (three-lane demo, current DEMO_JOB_IDS):** 159660 AI-settled @9500bp; 159661 injection → gate-escalated → human-rejected; 159662 client-set HumanOnly (lane=1 on-chain, model never invoked) → human-approved via review UI. Note: core RPC clients use a custom `patientHttp` transport (chain.ts) because Arc's 429 uses nonstandard code -32011 that viem's retry ignores — do not swap back to plain `http()`.

## Remaining path to submission

1. ~~Faucet funding~~ ✓, ~~Circle API key~~ ✓, ~~Entity Secret~~ ✓ (generated + registered via API 2026-07-27; `CIRCLE_ENTITY_SECRET` + `CIRCLE_WALLET_SET_ID` in `.env`; recovery file in gitignored `secrets/` — human must back it up; do NOT reset the Entity Secret in the console UI, it's live). Verified working: wallet set `f54e5010-6a9f-5435-8de9-d12a999e69dc` ("vapi-arc-demo") + one live `ARC-TESTNET` EOA `0x025d2216594469e19ea70f38ef9d08e47e5dd3e7` created via `@circle-fin/developer-controlled-wallets` (dep in `core/`). ~~ANTHROPIC_API_KEY~~ ✓ (funded, in `.env`). **Still blocked on human**: Encode registration.
2. ~~Deploy router + e2e-router.sh~~ ✓ (2026-07-27, see State). **Record backup footage now** (demo jobs age out of the app's 7h lookback — rerun `scripts/e2e-router.sh` to reseed, costs ~2 USDC + gas per run).
3. ~~Wed: live judge runs~~ ✓ **done early (Mon night)**: full autonomous loop proven on-chain with `claude-sonnet-5` — job 159637 (clean) live-judged approve@9500bp → gate settle → AutoCompleted, provider paid; job 159638 (injection fixture) flagged `injection_suspected` → escalated → human-rejected on-chain. Seeder: `cd core && node scripts/seed-judge-jobs.mjs` (creates funded job pair + deliverable files + rewinds watcher cursor), then `node --import tsx src/index.ts --once`. Evidence records in gitignored `core/data/evidence/`. Note: `claude-sonnet-5` rejects the `temperature` param (removed from judge). Wed now free for: more injection fixtures + judge-prompt hardening if time allows.
4. ~~Wire /review resolve button~~ ✓ (Tue: server-side action signs humanResolve with HUMAN_PK — tested live, job 159659 rejected via the UI; feature-flagged off when HUMAN_PK absent). ~~Arcscan source verification~~ ✓ (router verified via forge --verifier blockscout --verifier-url https://testnet.arcscan.app/api). Feed now pins demo jobs via DEMO_JOB_IDS env (in .env) with provenance backfilled from router.resolutions() — deployed feed stays populated after the 7h log window. Remaining Thu: Circle dev-controlled wallets integration (judging points); Railway deploy (needs human's Railway account).
5. Fri: 10 unattended E2E runs; adversarial review of router; **feature freeze Friday night**.
6. Sat: README trust model (who controls oracle wallet, caps, outage behavior, "auditable evaluator operator" NOT "trustless arbitration"; note Circle's contract is admin-upgradeable) + judging-criteria matrix + roadmap section (dual-chain: Base = VAPI token/x402 home, Arc = 8183 adapter; staked DAO panels later) + 3-min video + **deck** + submission draft.
7. Final week (Aug 3–9): buffer + polish; judging criteria mention Agent Stack / Nanopayments / Paymaster — assess cheap wins; **submit well before Sun Aug 9 AoE** (platform locks). **URGENT human item: register on Encode + create project page NOW** — checkpoints 1 (Jul 19) and 2 (Jul 26) already passed (placeholders were acceptable); email info@encode.club if the platform blocks late checkpoint entries.

## Conventions

- Conventional Commits. Keep `core/` (judge) and `app/` (dashboard) independent packages; contracts via Foundry.
- Money logic (`contracts/`) changes require running the full test suite; the router is deliberately minimal — do not add staking/slashing/panel features before the midpoint (explicitly cut, see design doc).
- The AI judge must never hold a transaction key; all settlement goes through the deterministic gate in `core/src/validate.ts`.
- Degrade order if slipping: Circle Wallets integration → resolve-button wiring → live-judge polish. Floor = router + AI settle + one human-resolve, on-chain.
