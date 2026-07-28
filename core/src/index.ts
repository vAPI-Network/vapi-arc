import { getAddress, keccak256, toBytes, type Hex } from "viem";
import "./env.js";
import { publicClient } from "./chain.js";
import { evaluationRouterAbi } from "./contracts.js";
import { envAddress } from "./config.js";
import {
  loadDeliverable,
  type DeliverableInspection,
} from "./deliverables.js";
import { writeEvidence } from "./evidence.js";
import { getJudgeModel, judgeDeliverable } from "./judge.js";
import { submitDecision } from "./submit.js";
import type { SubmittedJob } from "./types.js";
import { validateDecision, type Verdict } from "./validate.js";
import { pollSubmittedJobs } from "./watcher.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const runOnce = args.has("--once") || dryRun;
const fixtureMode = args.has("--fixture-job") || dryRun;
const POLL_INTERVAL_MS = 12_000;
const FIXTURE_DELIVERABLE_HASH: Hex =
  "0xb2cb7ee28ba629e7834ced57f8edf364a34c7bedb74330adb4f1bea77d1f33f2";

// Mirrors EvaluationRouter.ReviewLane and the dashboard's queue labeling.
const REVIEW_LANE_HUMAN_ONLY = 1;
const HUMAN_LANE_REASON = "client requested human review";
const HUMAN_LANE_REASON_HASH = keccak256(toBytes(HUMAN_LANE_REASON));

async function readReviewLane(jobId: bigint): Promise<number> {
  const lane = await publicClient.readContract({
    address: envAddress("ROUTER_ADDRESS"),
    abi: evaluationRouterAbi,
    functionName: "lanes",
    args: [jobId],
  });
  return Number(lane);
}

function jobLog(jobId: bigint, event: string, fields: object = {}): void {
  console.log(
    `[job:${jobId.toString()}] ${JSON.stringify(
      { event, ...fields },
      (_, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
    )}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fixtureJob(): SubmittedJob {
  return {
    id: 1n,
    client: getAddress("0x1111111111111111111111111111111111111111"),
    provider: getAddress("0x2222222222222222222222222222222222222222"),
    evaluator: getAddress("0x3333333333333333333333333333333333333333"),
    description:
      "Approve only if the deliverable states that the API returns status and result JSON fields and rejects unauthenticated requests with HTTP 401.",
    budget: 25_000_000n,
    expiredAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
    status: 2,
    hook: getAddress("0x0000000000000000000000000000000000000000"),
    deliverable: FIXTURE_DELIVERABLE_HASH,
    submittedAtBlock: 0n,
  };
}

function unavailableVerdict(deliverable: DeliverableInspection): Verdict {
  return {
    approve: false,
    confidenceBP: 0,
    reasoning: deliverable.detail ?? "deliverable unavailable",
    injectionSuspected: false,
  };
}

async function processJob(job: SubmittedJob): Promise<void> {
  jobLog(job.id, "processing_started", {
    budget: job.budget,
    submittedAtBlock: job.submittedAtBlock,
  });

  // Client-chosen review lane, enforced by the router. HumanOnly jobs never
  // reach the model: escalate straight to the human review queue.
  if (!fixtureMode && (await readReviewLane(job.id)) === REVIEW_LANE_HUMAN_ONLY) {
    jobLog(job.id, "human_lane_requested", {});
    const verdict: Verdict = {
      approve: false,
      confidenceBP: 0,
      reasoning: HUMAN_LANE_REASON,
      injectionSuspected: false,
    };
    const evidence = await writeEvidence({
      jobId: job.id,
      verdict,
      reasonCode: "human_lane_requested",
      model: "none (model not invoked)",
      deliverableHash: job.deliverable,
    });
    jobLog(job.id, "evidence_written", {
      evidenceHash: evidence.evidenceHash,
      path: evidence.path,
    });
    await submitDecision({
      jobId: job.id,
      action: "escalate",
      verdict,
      evidenceHash: HUMAN_LANE_REASON_HASH,
      dryRun,
    });
    jobLog(job.id, "processing_complete");
    return;
  }

  const deliverable = await loadDeliverable(job.id, job.deliverable);
  jobLog(job.id, "deliverable_loaded", {
    status: deliverable.status,
    byteLength: deliverable.byteLength,
    computedHash: deliverable.computedHash,
  });

  const rawVerdict =
    deliverable.status !== "ok" || deliverable.content === undefined
      ? unavailableVerdict(deliverable)
      : await judgeDeliverable({
          jobDescription: job.description,
          deliverableContent: deliverable.content,
          dryRun,
        });
  const decision = validateDecision({
    rawVerdict,
    job,
    deliverable,
  });
  jobLog(job.id, "decision_validated", {
    action: decision.action,
    reasonCode: decision.reasonCode,
    approve: decision.verdict.approve,
    confidenceBP: decision.verdict.confidenceBP,
  });

  const deliverableHash =
    deliverable.computedHash ?? deliverable.onChainHash ?? job.deliverable;
  const evidence = await writeEvidence({
    jobId: job.id,
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    model: getJudgeModel(),
    deliverableHash,
  });
  jobLog(job.id, "evidence_written", {
    evidenceHash: evidence.evidenceHash,
    path: evidence.path,
  });

  await submitDecision({
    jobId: job.id,
    action: decision.action,
    verdict: decision.verdict,
    evidenceHash: evidence.evidenceHash,
    dryRun,
  });
  jobLog(job.id, "processing_complete");
}

async function safelyProcessJob(job: SubmittedJob): Promise<boolean> {
  try {
    await processJob(job);
    return true;
  } catch (error) {
    jobLog(job.id, "processing_failed", {
      error: errorMessage(error),
    });
    return false;
  }
}

async function processAvailableJobs(): Promise<boolean> {
  if (fixtureMode) {
    jobLog(1n, "fixture_mode", { dryRun });
    return safelyProcessJob(fixtureJob());
  }

  let allSucceeded = true;
  for await (const job of pollSubmittedJobs()) {
    allSucceeded = (await safelyProcessJob(job)) && allSucceeded;
  }
  return allSucceeded;
}

async function main(): Promise<void> {
  do {
    try {
      const succeeded = await processAvailableJobs();
      if (runOnce && !succeeded) process.exitCode = 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "watcher_failed",
          error: errorMessage(error),
        }),
      );
      if (runOnce) process.exitCode = 1;
    }
    if (!runOnce) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } while (!runOnce);
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "worker_failed",
      error: errorMessage(error),
    }),
  );
  process.exitCode = 1;
});
