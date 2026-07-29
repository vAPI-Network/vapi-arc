import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { applyReviewerBootstrap } from "./bootstrap.js";
import {
  parseReviewerBootstrap,
  validateOperationalConfig,
} from "./config.js";
import { ReviewDatabase } from "./database.js";

const REVIEWER_ADDRESS = getAddress(
  "0x4444444444444444444444444444444444444444",
);

function operationalConfig() {
  return {
    port: 8_787,
    claimTtlSeconds: 600,
    reviewSlaSeconds: 1_800,
    minJobExpiryBufferSeconds: 2_220,
    maxDispatches: 2,
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 180_000,
    backgroundIntervalMs: 5_000,
    logLookbackBlocks: 100_000,
  };
}

describe("review service configuration", () => {
  it("validates and normalizes a reviewer council bootstrap", () => {
    const reviewers = parseReviewerBootstrap(
      JSON.stringify([
        {
          telegramUserId: "12345",
          telegramChatId: "67890",
          alias: "  Security auditor  ",
          payoutAddress: REVIEWER_ADDRESS.toLowerCase(),
          skills: [" contracts ", "security", "security"],
        },
      ]),
    );

    assert.deepEqual(reviewers, [
      {
        telegramUserId: "12345",
        telegramChatId: "67890",
        alias: "Security auditor",
        payoutAddress: REVIEWER_ADDRESS,
        skills: ["contracts", "security"],
        active: true,
      },
    ]);
  });

  it("rejects malformed and ambiguous reviewer bootstraps", () => {
    assert.throws(
      () => parseReviewerBootstrap("{"),
      /must be valid JSON/,
    );
    assert.throws(
      () =>
        parseReviewerBootstrap(
          JSON.stringify([
            {
              telegramUserId: "123",
              telegramChatId: "456",
              alias: "First",
              payoutAddress: REVIEWER_ADDRESS,
            },
            {
              telegramUserId: "123",
              telegramChatId: "789",
              alias: "Second",
              payoutAddress: "0x5555555555555555555555555555555555555555",
            },
          ]),
        ),
      /duplicate telegramUserId/,
    );
    assert.throws(
      () =>
        parseReviewerBootstrap(
          JSON.stringify([
            {
              telegramUserId: "not-a-number",
              telegramChatId: "456",
              alias: "Invalid",
              payoutAddress: REVIEWER_ADDRESS,
            },
          ]),
        ),
      /must be a positive numeric id/,
    );
  });

  it("fails fast for unsafe operational timing and port values", () => {
    validateOperationalConfig(operationalConfig());
    assert.throws(
      () =>
        validateOperationalConfig({
          ...operationalConfig(),
          maxDispatches: 0,
        }),
      /REVIEW_MAX_DISPATCHES must be a positive safe integer/,
    );
    assert.throws(
      () =>
        validateOperationalConfig({
          ...operationalConfig(),
          port: 65_536,
        }),
      /between 1 and 65535/,
    );
    assert.throws(
      () =>
        validateOperationalConfig({
          ...operationalConfig(),
          claimTtlSeconds: 1_000,
        }),
      /must cover every claim window/,
    );
    assert.throws(
      () =>
        validateOperationalConfig({
          ...operationalConfig(),
          backgroundIntervalMs: 600_001,
        }),
      /cannot exceed REVIEW_CLAIM_TTL_SECONDS/,
    );
    assert.throws(
      () =>
        validateOperationalConfig({
          ...operationalConfig(),
          minJobExpiryBufferSeconds: 2_219,
        }),
      /must be at least 2220/,
    );
  });
});

describe("reviewer council bootstrap", () => {
  it("is idempotent and updates the same reviewer on restart", () => {
    const database = new ReviewDatabase(":memory:");
    try {
      const initial = parseReviewerBootstrap(
        JSON.stringify([
          {
            telegramUserId: "12345",
            telegramChatId: "67890",
            alias: "Initial alias",
            payoutAddress: REVIEWER_ADDRESS,
            skills: ["security"],
          },
        ]),
      );
      const [created] = applyReviewerBootstrap(database, initial);
      assert.ok(created);

      const updated = parseReviewerBootstrap(
        JSON.stringify([
          {
            telegramUserId: "12345",
            telegramChatId: "67890",
            alias: "Updated alias",
            payoutAddress: REVIEWER_ADDRESS,
            skills: ["contracts", "security"],
            active: false,
          },
        ]),
      );
      const [reapplied] = applyReviewerBootstrap(database, updated);

      assert.equal(reapplied?.id, created.id);
      assert.equal(reapplied?.alias, "Updated alias");
      assert.equal(reapplied?.active, false);
      assert.deepEqual(reapplied?.skills, ["contracts", "security"]);
      assert.equal(database.listReviewers().length, 1);
    } finally {
      database.close();
    }
  });
});
