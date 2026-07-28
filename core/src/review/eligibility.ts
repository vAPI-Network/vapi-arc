import {
  HUMAN_LANE_REASON,
  HUMAN_LANE_REASON_HASH,
  escalationCauseForReasonCode,
  isAIEscalationReasonCode,
} from "../evidence.js";
import {
  ReviewValidationError,
  type ReviewChain,
  type ReviewValidationOptions,
} from "./chain.js";
import { ReviewDatabase } from "./database.js";
import type { ValidatedReviewJob } from "./types.js";

export function verifiedEscalationJob(
  database: ReviewDatabase,
  job: ValidatedReviewJob,
): ValidatedReviewJob {
  if (
    job.escalationReasonHash.toLowerCase() ===
    HUMAN_LANE_REASON_HASH.toLowerCase()
  ) {
    return {
      ...job,
      escalationReasonCode: "human_lane_requested",
      escalationCause: HUMAN_LANE_REASON,
    };
  }
  const stored = database.getAIEvidence(job.escalationReasonHash);
  if (!stored) {
    throw new ReviewValidationError(
      "verified AI escalation evidence has not reached the review exchange",
      409,
      "ai_evidence_missing",
    );
  }
  const evidence = stored.evidence;
  if (
    evidence.jobId !== job.jobId ||
    evidence.deliverableHash.toLowerCase() !==
      job.deliverableHash.toLowerCase() ||
    !isAIEscalationReasonCode(evidence.reasonCode)
  ) {
    throw new ReviewValidationError(
      "AI escalation evidence does not match the on-chain job",
      409,
      "ai_evidence_mismatch",
      true,
    );
  }
  const cause = escalationCauseForReasonCode(evidence.reasonCode);
  if (!cause) {
    throw new ReviewValidationError(
      "AI escalation reason is not eligible for human review",
      409,
      "ai_evidence_reason_ineligible",
      true,
    );
  }
  return {
    ...job,
    escalationReasonCode: evidence.reasonCode,
    escalationCause: cause,
  };
}

export async function validateEscalatedReview(
  chain: ReviewChain,
  database: ReviewDatabase,
  jobId: string,
  deliverableContent: string,
  options?: ReviewValidationOptions,
): Promise<ValidatedReviewJob> {
  return verifiedEscalationJob(
    database,
    await chain.validateReview(jobId, deliverableContent, options),
  );
}

export function isPermanentReviewValidationError(
  error: unknown,
): error is ReviewValidationError {
  return error instanceof ReviewValidationError && error.permanent;
}
