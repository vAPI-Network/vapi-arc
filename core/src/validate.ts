import { z } from "zod";
import { envBasisPoints, envUnsignedBigInt } from "./config.js";
import type { DeliverableInspection } from "./deliverables.js";
import type { AgenticJob } from "./types.js";

export const verdictSchema = z
  .object({
    approve: z.boolean(),
    confidenceBP: z.number().int().min(0).max(10_000),
    reasoning: z.string().max(1_200),
    injectionSuspected: z.boolean(),
  })
  .strict();

export type Verdict = z.infer<typeof verdictSchema>;
export type GateAction = "settle" | "escalate";
export type ReasonCode =
  | "policy_passed"
  | "model_output_invalid"
  | "injection_suspected"
  | "confidence_below_threshold"
  | "budget_above_cap"
  | "job_expired_or_near_expiry"
  | "deliverable_missing"
  | "deliverable_oversized"
  | "deliverable_hash_mismatch";

export interface GateResult {
  action: GateAction;
  reasonCode: ReasonCode;
  verdict: Verdict;
}

export interface ValidateInput {
  rawVerdict: unknown;
  job: AgenticJob;
  deliverable: DeliverableInspection;
  nowSeconds?: bigint;
  minConfidenceBP?: number;
  autoSettleCap?: bigint;
}

const invalidVerdict: Verdict = {
  approve: false,
  confidenceBP: 0,
  reasoning: "model output failed deterministic schema validation",
  injectionSuspected: false,
};

export function validateDecision(input: ValidateInput): GateResult {
  const parsed = verdictSchema.safeParse(input.rawVerdict);
  if (!parsed.success) {
    return {
      action: "escalate",
      reasonCode: "model_output_invalid",
      verdict: invalidVerdict,
    };
  }
  const verdict = parsed.data;

  if (input.deliverable.status === "missing") {
    return { action: "escalate", reasonCode: "deliverable_missing", verdict };
  }
  if (input.deliverable.status === "oversized") {
    return { action: "escalate", reasonCode: "deliverable_oversized", verdict };
  }
  if (input.deliverable.status === "hash-mismatch") {
    return {
      action: "escalate",
      reasonCode: "deliverable_hash_mismatch",
      verdict,
    };
  }
  if (verdict.injectionSuspected) {
    return { action: "escalate", reasonCode: "injection_suspected", verdict };
  }

  const minConfidenceBP =
    input.minConfidenceBP ?? envBasisPoints("MIN_CONFIDENCE_BP", 8_000);
  if (verdict.confidenceBP < minConfidenceBP) {
    return {
      action: "escalate",
      reasonCode: "confidence_below_threshold",
      verdict,
    };
  }

  const autoSettleCap =
    input.autoSettleCap ??
    envUnsignedBigInt("AUTO_SETTLE_CAP", 100_000_000n);
  if (input.job.budget > autoSettleCap) {
    return { action: "escalate", reasonCode: "budget_above_cap", verdict };
  }

  const nowSeconds =
    input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1_000));
  if (input.job.expiredAt <= nowSeconds + 60n) {
    return {
      action: "escalate",
      reasonCode: "job_expired_or_near_expiry",
      verdict,
    };
  }

  return { action: "settle", reasonCode: "policy_passed", verdict };
}
