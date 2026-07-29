import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { openApiDocument } from "./app.js";
import type { ReviewServiceConfig } from "./config.js";

function testConfig(): ReviewServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "https://review.example",
    databasePath: ":memory:",
    routerAddress: getAddress(
      "0x3333333333333333333333333333333333333333",
    ),
    sellerAddress: getAddress(
      "0x5555555555555555555555555555555555555555",
    ),
    gatewayNetwork: "eip155:5042002",
    gatewayUrl: "https://gateway.invalid",
    reviewPrice: "250000",
    reviewPriceDisplay: "$0.25",
    reviewerReward: "200000",
    claimTtlSeconds: 600,
    reviewSlaSeconds: 1_800,
    minJobExpiryBufferSeconds: 2_220,
    maxDispatches: 2,
    internalToken: "internal-test-token",
    telegramWebhookSecret: "telegram-test-token",
    usdcTokenAddress: getAddress(
      "0x3600000000000000000000000000000000000000",
    ),
    minimumTreasuryBalance: "450000",
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 1_000,
    backgroundIntervalMs: 60_000,
    logLookbackBlocks: 10_000n,
    allowPartialConfiguration: false,
  };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function resolveLocalRef(document: JsonObject, reference: string): unknown {
  assert.match(reference, /^#\//);
  return reference
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      const object = asObject(current);
      assert.ok(segment in object, `unresolved OpenAPI ref: ${reference}`);
      return object[segment];
    }, document);
}

describe("review service OpenAPI", () => {
  it("documents every public, webhook, and internal operation", () => {
    const document = asObject(openApiDocument(testConfig()));
    const paths = asObject(document.paths);

    for (const path of [
      "/health",
      "/openapi.json",
      "/v1/review-orders",
      "/v1/review-orders/{orderId}",
      "/v1/evidence/{evidenceHash}",
      "/v1/reviewers/{address}",
      "/v1/telegram/webhook",
      "/v1/circle/webhook",
      "/internal/ai-evidence",
      "/internal/review-orders",
      "/internal/review-orders/{orderId}/resume",
    ]) {
      assert.ok(path in paths, `missing OpenAPI path: ${path}`);
    }

    const evidence = asObject(
      asObject(paths["/v1/evidence/{evidenceHash}"]).get,
    );
    const reviewer = asObject(
      asObject(paths["/v1/reviewers/{address}"]).get,
    );
    assert.deepEqual(evidence.parameters, [
      { $ref: "#/components/parameters/EvidenceHash" },
    ]);
    assert.deepEqual(reviewer.parameters, [
      { $ref: "#/components/parameters/ReviewerAddress" },
    ]);

    const telegram = asObject(
      asObject(paths["/v1/telegram/webhook"]).post,
    );
    const circle = asObject(asObject(paths["/v1/circle/webhook"]).post);
    const internal = asObject(asObject(paths["/internal/review-orders"]).get);
    const resume = asObject(
      asObject(paths["/internal/review-orders/{orderId}/resume"]).post,
    );
    const aiEvidence = asObject(asObject(paths["/internal/ai-evidence"]).post);
    assert.deepEqual(telegram.security, [{ TelegramWebhookSecret: [] }]);
    assert.deepEqual(circle.security, [
      { CircleSignature: [], CircleKeyId: [] },
    ]);
    assert.deepEqual(internal.security, [{ InternalBearer: [] }]);
    assert.deepEqual(resume.security, [{ InternalBearer: [] }]);
    assert.deepEqual(aiEvidence.security, [{ InternalBearer: [] }]);
  });

  it("has unique operation IDs and only resolvable local references", () => {
    const document = asObject(openApiDocument(testConfig()));
    const operationIds = new Set<string>();

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      const object = value as JsonObject;
      if (typeof object.operationId === "string") {
        assert.equal(
          operationIds.has(object.operationId),
          false,
          `duplicate operationId: ${object.operationId}`,
        );
        operationIds.add(object.operationId);
      }
      if (typeof object.$ref === "string") {
        resolveLocalRef(document, object.$ref);
      }
      for (const child of Object.values(object)) visit(child);
    };

    visit(document);
    assert.equal(operationIds.size, 11);
  });

  it("documents strict internal events and evidence verification", () => {
    const document = asObject(openApiDocument(testConfig()));
    const schemas = asObject(asObject(document.components).schemas);
    const internal = asObject(schemas.InternalReviewOrder);
    assert.equal(internal.unevaluatedProperties, false);
    const extension = asObject((internal.allOf as unknown[])[1]);
    const required = extension.required as string[];
    assert.ok(required.includes("jobDescription"));
    assert.ok(required.includes("events"));
    assert.ok(required.includes("evidenceVerified"));
    assert.ok("ReviewEvent" in schemas);
    assert.ok("AIEvidenceV1" in schemas);
    assert.ok("HumanEvidenceV1" in schemas);
  });
});
