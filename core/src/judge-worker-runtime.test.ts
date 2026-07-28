import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import {
  closeJudgeHealthServer,
  createJudgeHealthServer,
  JudgeReadiness,
  listenJudgeHealthServer,
  loadJudgeWorkerConfig,
  validateLiveJudgeEnvironment,
} from "./judge-worker-runtime.js";

const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  PORT: "8790",
  ARC_RPC_URL: "https://rpc.testnet.arc.network",
  AGENTIC_COMMERCE: "0x1111111111111111111111111111111111111111",
  ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
  ORACLE_PK: `0x${"1".repeat(64)}`,
  ANTHROPIC_API_KEY: "anthropic-test-key",
  REVIEW_SERVICE_INTERNAL_URL: "http://vapi-review.railway.internal:8787",
  REVIEW_INTERNAL_TOKEN: "internal-test-token",
  VAPI_DATA_ROOT: "/data",
  AUTO_SETTLE_CAP: "100000000",
  MIN_CONFIDENCE_BP: "8000",
};

describe("live judge configuration", () => {
  it("loads a fully configured live worker", () => {
    assert.deepEqual(loadJudgeWorkerConfig(VALID_ENVIRONMENT), {
      port: 8790,
      readinessMaxAgeMs: 300_000,
    });
  });

  it("prefers Railway PORT and falls back to JUDGE_PORT locally", () => {
    assert.equal(
      loadJudgeWorkerConfig({
        ...VALID_ENVIRONMENT,
        PORT: "8790",
        JUDGE_PORT: "8791",
      }).port,
      8790,
    );
    assert.equal(
      loadJudgeWorkerConfig({
        ...VALID_ENVIRONMENT,
        PORT: "",
        JUDGE_PORT: "8791",
      }).port,
      8791,
    );
  });

  it("fails fast without echoing malformed secrets or URLs", () => {
    const secret = "private-value-that-must-not-be-logged";
    const environment = {
      ...VALID_ENVIRONMENT,
      ORACLE_PK: secret,
      REVIEW_SERVICE_INTERNAL_URL: `ftp://${secret}.example`,
      VAPI_DATA_ROOT: "relative/private-data",
    };

    assert.throws(
      () => validateLiveJudgeEnvironment(environment),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ORACLE_PK/);
        assert.match(error.message, /REVIEW_SERVICE_INTERNAL_URL/);
        assert.match(error.message, /VAPI_DATA_ROOT/);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes("relative/private-data"), false);
        return true;
      },
    );
  });

  it("requires a valid Railway port for the daemon", () => {
    assert.throws(
      () =>
        loadJudgeWorkerConfig({
          ...VALID_ENVIRONMENT,
          PORT: "70000",
        }),
      /PORT\/JUDGE_PORT must be an integer from 1 to 65535/,
    );
  });
});

describe("judge readiness endpoint", () => {
  const servers = new Set<ReturnType<typeof createJudgeHealthServer>>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map(async (server) => {
        await closeJudgeHealthServer(server);
        servers.delete(server);
      }),
    );
  });

  it("stays unavailable until a successful poll, then expires and drains", async () => {
    let now = Date.parse("2026-07-28T12:00:00.000Z");
    const readiness = new JudgeReadiness({
      maxAgeMs: 1_000,
      now: () => now,
    });
    const server = createJudgeHealthServer(readiness);
    servers.add(server);
    await listenJudgeHealthServer(server, 0, "127.0.0.1");
    const address = server.address() as AddressInfo;
    const healthUrl = `http://127.0.0.1:${address.port}/health`;

    const starting = await fetch(healthUrl);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), {
      status: "unavailable",
      service: "vapi-judge",
      reason: "no_successful_poll",
      lastSuccessfulPollAt: null,
      pollAgeMs: null,
    });

    readiness.markPollSucceeded();
    const ready = await fetch(healthUrl);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { reason: string }).reason, "ready");

    now += 1_001;
    const stale = await fetch(healthUrl);
    assert.equal(stale.status, 503);
    assert.equal((await stale.json() as { reason: string }).reason, "stale");

    readiness.markPollSucceeded();
    readiness.markShuttingDown();
    const draining = await fetch(healthUrl);
    assert.equal(draining.status, 503);
    assert.equal(
      (await draining.json() as { reason: string }).reason,
      "shutting_down",
    );
  });

  it("does not expose health state on other routes", async () => {
    const readiness = new JudgeReadiness({ maxAgeMs: 1_000 });
    readiness.markPollSucceeded();
    const server = createJudgeHealthServer(readiness);
    servers.add(server);
    await listenJudgeHealthServer(server, 0, "127.0.0.1");
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 404);
  });
});
