import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequestPacer } from "./chain.js";

describe("Arc RPC request pacing", () => {
  it("serializes concurrent callers at the configured interval", async () => {
    let now = 0;
    const waits: number[] = [];
    const completions: number[] = [];
    const pace = createRequestPacer(
      650,
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    );

    await Promise.all(
      [1, 2, 3, 4].map(async (value) => {
        await pace();
        completions.push(value);
      }),
    );

    assert.deepEqual(completions, [1, 2, 3, 4]);
    assert.deepEqual(waits, [650, 650, 650]);
    assert.equal(now, 1_950);
  });

  it("does not delay the first request or calls after an idle interval", async () => {
    let now = 10_000;
    const waits: number[] = [];
    const pace = createRequestPacer(
      650,
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    );

    await pace();
    now += 1_000;
    await pace();

    assert.deepEqual(waits, []);
  });
});
