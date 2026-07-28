import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import { dataRoot } from "./paths.js";
import {
  verdictSchema,
  type ReasonCode,
  type Verdict,
} from "./validate.js";
import type { HumanEvidenceV1 } from "./review/types.js";

export const HUMAN_LANE_REASON = "client requested human review";
export const HUMAN_LANE_REASON_HASH = keccak256(toBytes(HUMAN_LANE_REASON));

export const reasonCodes = [
  "policy_passed",
  "human_lane_requested",
  "model_output_invalid",
  "injection_suspected",
  "confidence_below_threshold",
  "budget_above_cap",
  "job_expired_or_near_expiry",
  "deliverable_missing",
  "deliverable_oversized",
  "deliverable_hash_mismatch",
] as const satisfies readonly ReasonCode[];

export type AIEscalationReasonCode = Exclude<
  ReasonCode,
  "policy_passed" | "human_lane_requested"
>;

export const AI_ESCALATION_REASON_LABELS = {
  model_output_invalid: "AI output failed schema validation",
  injection_suspected: "AI evaluator detected prompt injection",
  confidence_below_threshold:
    "AI confidence fell below the automatic-settlement threshold",
  budget_above_cap: "Escrow budget exceeds the automatic-settlement cap",
  job_expired_or_near_expiry:
    "Job is too near expiry for automatic settlement",
  deliverable_missing: "Deliverable could not be loaded",
  deliverable_oversized: "Deliverable exceeds the evaluator size limit",
  deliverable_hash_mismatch:
    "Deliverable does not match its on-chain commitment",
} as const satisfies Record<AIEscalationReasonCode, string>;

const hash32Schema = z.custom<Hex>(
  (value) =>
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
  "expected a 32-byte hexadecimal value",
);

export const aiEvidenceV1Schema = z
  .object({
    type: z.literal("ai-v1"),
    jobId: z.string().regex(/^(0|[1-9]\d*)$/),
    verdict: verdictSchema,
    reasonCode: z.enum(reasonCodes),
    model: z.string().trim().min(1).max(200),
    promptVersion: z.literal("v1"),
    deliverableHash: hash32Schema,
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict();

export type AIEvidenceV1 = z.infer<typeof aiEvidenceV1Schema>;

export type EvidenceRecord = AIEvidenceV1;
export type VersionedEvidence = AIEvidenceV1 | HumanEvidenceV1;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as JsonValue)]),
    );
  }
  return value;
}

export function canonicalJson(record: VersionedEvidence): string {
  return JSON.stringify(canonicalize(record as unknown as JsonValue));
}

export function computeEvidenceHash(record: VersionedEvidence): Hex {
  return keccak256(toBytes(canonicalJson(record)));
}

export function parseAIEvidence(record: unknown): AIEvidenceV1 {
  return aiEvidenceV1Schema.parse(record);
}

export function serializeAIEvidence(record: AIEvidenceV1): string {
  return canonicalJson(parseAIEvidence(record));
}

export function verifyAIEvidence(
  record: unknown,
  expectedHash: Hex,
): record is AIEvidenceV1 {
  const parsed = aiEvidenceV1Schema.safeParse(record);
  return (
    parsed.success &&
    computeEvidenceHash(parsed.data).toLowerCase() ===
      expectedHash.toLowerCase()
  );
}

export function isAIEscalationReasonCode(
  reasonCode: ReasonCode,
): reasonCode is AIEscalationReasonCode {
  return reasonCode in AI_ESCALATION_REASON_LABELS;
}

export function escalationCauseForReasonCode(
  reasonCode: ReasonCode,
): string | undefined {
  if (reasonCode === "human_lane_requested") return HUMAN_LANE_REASON;
  if (!isAIEscalationReasonCode(reasonCode)) return undefined;
  return AI_ESCALATION_REASON_LABELS[reasonCode];
}

export interface WriteEvidenceInput {
  jobId: bigint;
  verdict: Verdict;
  reasonCode: ReasonCode;
  model: string;
  deliverableHash: Hex;
  timestamp?: string;
}

export async function writeEvidence(input: WriteEvidenceInput): Promise<{
  record: EvidenceRecord;
  evidenceHash: Hex;
  path: string;
}> {
  const record: EvidenceRecord = {
    type: "ai-v1",
    jobId: input.jobId.toString(),
    verdict: input.verdict,
    reasonCode: input.reasonCode,
    model: input.model,
    promptVersion: "v1",
    deliverableHash: input.deliverableHash,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  const canonicalRecord = canonicalize(record as unknown as JsonValue);
  const evidenceHash = computeEvidenceHash(record);
  const evidenceDirectory = path.join(dataRoot, "evidence");
  const evidencePath = path.join(
    evidenceDirectory,
    `${input.jobId.toString()}.json`,
  );
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(canonicalRecord, null, 2)}\n`,
    "utf8",
  );
  return { record, evidenceHash, path: evidencePath };
}
