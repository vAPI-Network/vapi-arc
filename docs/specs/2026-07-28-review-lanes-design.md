# Review lanes: client-chosen evaluation path, enforced on-chain

Approved 2026-07-28. Repositions vAPI Trust Network as the trust layer for
escrowed agentic work with a client-chosen review lane. The guarded AI judge
becomes one lane, not the product identity.

## Lanes

1. **AI review** (`ReviewLane.AIAllowed`, default): the guarded judge may
   settle within the existing cap/confidence gates; uncertainty or injection
   still escalates to a human.
2. **Human review** (`ReviewLane.HumanOnly`): the client requires a human
   verdict. The router reverts any AI settlement attempt for the job.
3. **Certified review** (roadmap only, no code): staked reviewers holding the
   "vAPI Certified" credential, organized as the Reviewer Council. Not an
   enum value; a panel with no resolver behind it would be dead code.

## Contract (EvaluationRouter, redeploy required)

- `enum ReviewLane { AIAllowed, HumanOnly }`, `mapping(uint256 => ReviewLane) public lanes`.
- `setLane(uint256 jobId, ReviewLane lane)`: caller must be the job's client
  (from `target.getJob`), job's evaluator must be this router, and the job
  must be unresolved on the router (`Resolution.None`). Flippable both ways
  until then. Emits `LaneSet(jobId indexed, lane)`.
- `submitAIVerdict`: new check, `HumanOnly` lane reverts `HumanReviewRequired`.
- `escalate` and `humanResolve` unchanged.
- New errors: `NotClient`, `LaneLocked`, `HumanReviewRequired`.
- Tests: non-client reverts; lane locked after resolution; AI verdict on
  human lane reverts; flip back re-enables AI path; human resolve works on
  both lanes; wrong evaluator reverts; lane set while Open/Funded works.

## Worker (core/)

Before judging, read `lanes(jobId)`. `HumanOnly`: skip the model call
entirely, escalate with the constant reason hash
`keccak256("client requested human review")`, and write an evidence record
with reason code `human_lane_requested`.

## Dashboard (app/)

- Add `LaneSet` to the shared event sweep (no extra RPC calls).
- Feed rows show the lane when one was set.
- Review queue labels each entry "client requested human review" (reason hash
  equals the constant) or "escalated by the gate".

## Rollout

Deploy new router → verify source on Arcscan → update `.env`
(`ROUTER_ADDRESS`), pinned ABI in `adapters/arc/`, `DEMO_JOB_IDS` → reseed a
three-job demo: AI-settled, injection-escalated-rejected, human-lane-approved
via the review UI. The previous router (`0x215766ef...af3d4`) stays on-chain
as history; checkpoint-2 links to it remain valid.

## Copy

README and submission copy lead with the trust layer and the three lanes.
"Reviewer Council" and "vAPI Certified" replace "DAO" everywhere.
