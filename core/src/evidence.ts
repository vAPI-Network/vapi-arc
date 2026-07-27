import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { dataRoot } from "./paths.js";
import type { ReasonCode, Verdict } from "./validate.js";

export interface EvidenceRecord {
  jobId: string;
  verdict: Verdict;
  reasonCode: ReasonCode;
  model: string;
  promptVersion: "v1";
  deliverableHash: Hex;
  timestamp: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: JsonValue): JsonValue {
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

export function canonicalJson(record: EvidenceRecord): string {
  return JSON.stringify(canonicalize(record as unknown as JsonValue));
}

export function computeEvidenceHash(record: EvidenceRecord): Hex {
  return keccak256(toBytes(canonicalJson(record)));
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
