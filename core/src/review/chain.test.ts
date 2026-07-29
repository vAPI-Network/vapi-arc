import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, toBytes } from "viem";
import type { ArcPublicClient } from "../chain.js";
import { computeDeliverableHash } from "../deliverables.js";
import {
  LiveReviewChain,
  ReviewValidationError,
} from "./chain.js";

const COMMERCE = getAddress(
  "0x1111111111111111111111111111111111111111",
);
const ROUTER = getAddress("0x2222222222222222222222222222222222222222");
const CLIENT = getAddress("0x3333333333333333333333333333333333333333");
const PROVIDER = getAddress(
  "0x4444444444444444444444444444444444444444",
);

describe("live Arc review validation", () => {
  it("reuses the immutable JobSubmitted commitment across content variants", async () => {
    const content = "The committed freelance deliverable.";
    const deliverableHash = computeDeliverableHash(content);
    let logScans = 0;
    const client = {
      async readContract(input: { functionName: string }) {
        if (input.functionName === "getJob") {
          return {
            id: 7n,
            client: CLIENT,
            provider: PROVIDER,
            evaluator: ROUTER,
            description: "Complete the requested work.",
            budget: 25_000_000n,
            expiredAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
            status: 2,
            hook: getAddress(
              "0x0000000000000000000000000000000000000000",
            ),
          };
        }
        if (input.functionName === "resolutions") return 3;
        if (input.functionName === "evidence") {
          return keccak256(toBytes("AI escalation"));
        }
        throw new Error(`unexpected read ${input.functionName}`);
      },
      async getBlockNumber() {
        return 100n;
      },
      async getLogs() {
        logScans += 1;
        return [{ args: { deliverable: deliverableHash } }];
      },
    } as unknown as ArcPublicClient;
    const chain = new LiveReviewChain({
      client,
      routerAddress: ROUTER,
      commerceAddress: COMMERCE,
    });

    await assert.rejects(
      chain.validateReview("7", "A malicious content variant."),
      (error: unknown) =>
        error instanceof ReviewValidationError &&
        error.code === "deliverable_hash_mismatch",
    );
    const validated = await chain.validateReview("7", content);

    assert.equal(validated.deliverableHash, deliverableHash);
    assert.equal(logScans, 1);
  });
});
