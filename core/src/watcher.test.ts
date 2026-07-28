import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import type { ArcPublicClient } from "./chain.js";
import { pollSubmittedJobs } from "./watcher.js";

const COMMERCE = getAddress("0x1111111111111111111111111111111111111111");
const ROUTER = getAddress("0x2222222222222222222222222222222222222222");
const CLIENT = getAddress("0x3333333333333333333333333333333333333333");
const PROVIDER = getAddress("0x4444444444444444444444444444444444444444");

describe("submitted-job watcher", () => {
  it("skips already-escalated Submitted jobs and checkpoints the range", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vapi-watcher-"));
    const statePath = path.join(directory, "state.json");
    try {
      const client = {
        async getBlockNumber() {
          return 100n;
        },
        async getLogs() {
          return [
            {
              args: {
                jobId: 42n,
                deliverable: `0x${"a".repeat(64)}`,
              },
              blockNumber: 100n,
            },
          ];
        },
        async readContract(input: { functionName: string }) {
          if (input.functionName === "getJob") {
            return {
              id: 42n,
              client: CLIENT,
              provider: PROVIDER,
              evaluator: ROUTER,
              description: "Review the submitted deliverable.",
              budget: 1_000_000n,
              expiredAt: 9_999_999_999n,
              status: 2,
              hook: getAddress("0x0000000000000000000000000000000000000000"),
            };
          }
          if (input.functionName === "resolutions") return 3;
          throw new Error(`unexpected read ${input.functionName}`);
        },
      } as unknown as ArcPublicClient;

      const jobs = [];
      for await (const job of pollSubmittedJobs({
        client,
        commerceAddress: COMMERCE,
        routerAddress: ROUTER,
        statePath,
      })) {
        jobs.push(job);
      }

      assert.deepEqual(jobs, []);
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
        nextBlock: "101",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
