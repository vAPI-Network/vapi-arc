import { keccak256, toBytes, type Hex } from "viem";
import {
  canonicalJson,
  canonicalize,
  computeEvidenceHash,
  type JsonValue,
} from "../evidence.js";
import type {
  HumanEvidenceV1,
  ReviewOrder,
  ReviewerSnapshot,
} from "./types.js";

export interface CreateHumanEvidenceInput {
  order: ReviewOrder;
  reviewer: ReviewerSnapshot;
  payoutTransactionHash: Hex;
  payoutConfirmedAt?: string;
}

export function hashTelegramIdentity(telegramUserId: string): Hex {
  return keccak256(toBytes(`telegram:${telegramUserId}`));
}

export function createHumanEvidence(
  input: CreateHumanEvidenceInput,
): HumanEvidenceV1 {
  const { order, reviewer } = input;
  if (!order.decision || !order.reasoning || !order.verdictAt) {
    throw new Error("a complete verdict is required before creating evidence");
  }
  if (!order.escalationCause) {
    throw new Error(
      "verified escalation provenance is required before creating evidence",
    );
  }
  return {
    type: "human-v1",
    jobId: order.jobId,
    deliverableHash: order.deliverableHash,
    reviewer: reviewer.payoutAddress,
    telegramIdentityHash: reviewer.telegramIdentityHash,
    decision: order.decision,
    reasoning: order.reasoning,
    escalationCause: order.escalationCause,
    escalationReasonHash: order.escalationReasonHash,
    x402: {
      payer: order.payer,
      amount: order.reviewPrice,
      network: order.network,
      transaction: order.gatewayTransaction,
    },
    reward: order.reward,
    payoutTransactionHash: input.payoutTransactionHash,
    verdictAt: order.verdictAt,
    payoutConfirmedAt: input.payoutConfirmedAt ?? new Date().toISOString(),
  };
}

export function serializeHumanEvidence(record: HumanEvidenceV1): string {
  return JSON.stringify(
    canonicalize(record as unknown as JsonValue),
    null,
    2,
  );
}

export function humanEvidenceHash(record: HumanEvidenceV1): Hex {
  return computeEvidenceHash(record);
}

export function verifyHumanEvidence(
  record: HumanEvidenceV1,
  expected: Hex,
): boolean {
  return (
    keccak256(toBytes(canonicalJson(record))).toLowerCase() ===
    expected.toLowerCase()
  );
}
