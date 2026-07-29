import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, toBytes } from "viem";
import { computeEvidenceHash, type AIEvidenceV1 } from "./evidence.js";
import { publishAIEvidence } from "./evidence-publisher.js";

function fixture(): AIEvidenceV1 {
  return {
    type: "ai-v1",
    jobId: "42",
    verdict: {
      approve: false,
      confidenceBP: 4_000,
      reasoning: "Confidence is below the deterministic settlement threshold.",
      injectionSuspected: false,
    },
    reasonCode: "confidence_below_threshold",
    model: "test-model",
    promptVersion: "v1",
    deliverableHash: keccak256(toBytes("committed deliverable")),
    timestamp: "2026-07-28T12:00:00.000Z",
  };
}

describe("AI evidence publisher", () => {
  it("retries transient failures with one stable idempotency hash", async () => {
    const evidence = fixture();
    const evidenceHash = computeEvidenceHash(evidence);
    const keys: string[] = [];
    const waits: number[] = [];
    let calls = 0;
    const fetchImpl = (async (_input, init) => {
      calls += 1;
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return calls < 3
        ? new Response("temporarily unavailable", { status: 503 })
        : new Response('{"stored":true}', { status: 201 });
    }) as typeof fetch;

    await publishAIEvidence(evidence, evidenceHash, {
      baseUrl: "https://review.internal",
      internalToken: "secret",
      fetchImpl,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    assert.equal(calls, 3);
    assert.deepEqual(keys, [
      evidenceHash.toLowerCase(),
      evidenceHash.toLowerCase(),
      evidenceHash.toLowerCase(),
    ]);
    assert.deepEqual(waits, [250, 500]);
  });

  it("fails closed after retryable transport failures", async () => {
    const evidence = fixture();
    const evidenceHash = computeEvidenceHash(evidence);
    let calls = 0;
    await assert.rejects(
      publishAIEvidence(evidence, evidenceHash, {
        baseUrl: "https://review.internal",
        internalToken: "secret",
        fetchImpl: (async () => {
          calls += 1;
          throw new Error("connection reset");
        }) as typeof fetch,
        wait: async () => {},
      }),
      /failed closed after 3 attempts/,
    );
    assert.equal(calls, 3);
  });

  it("does not retry an authenticated endpoint rejection", async () => {
    const evidence = fixture();
    const evidenceHash = computeEvidenceHash(evidence);
    let calls = 0;
    await assert.rejects(
      publishAIEvidence(evidence, evidenceHash, {
        baseUrl: "https://review.internal",
        internalToken: "wrong-secret",
        fetchImpl: (async () => {
          calls += 1;
          return new Response("unauthorized", { status: 401 });
        }) as typeof fetch,
        wait: async () => {},
      }),
      /HTTP 401/,
    );
    assert.equal(calls, 1);
  });
});
