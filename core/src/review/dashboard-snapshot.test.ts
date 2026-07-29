import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type express from "express";
import type { RequestHandler } from "express";
import { getAddress, keccak256, toBytes, zeroAddress, type Hex } from "viem";
import { createReviewApp } from "./app.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import {
  DashboardSnapshotProcessor,
  type DashboardSnapshotClient,
} from "./dashboard-snapshot.js";
import { ReviewProcessor } from "./processor.js";
import type { DashboardChainSnapshot } from "./types.js";

const COMMERCE = getAddress("0x1111111111111111111111111111111111111111");
const ROUTER = getAddress("0x2222222222222222222222222222222222222222");
const CLIENT = getAddress("0x3333333333333333333333333333333333333333");
const PROVIDER = getAddress("0x4444444444444444444444444444444444444444");
const PAYER = getAddress("0x5555555555555555555555555555555555555555");
const HUMAN_REASON_HASH = keccak256(toBytes("client requested human review"));
const DELIVERABLE_HASH = keccak256(toBytes("dashboard deliverable"));

function testConfig(): ReviewServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "http://review.test",
    databasePath: ":memory:",
    routerAddress: ROUTER,
    commerceAddress: COMMERCE,
    sellerAddress: PAYER,
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
    usdcTokenAddress: getAddress("0x3600000000000000000000000000000000000000"),
    minimumTreasuryBalance: "450000",
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 1_000,
    backgroundIntervalMs: 60_000,
    logLookbackBlocks: 10_000n,
    allowPartialConfiguration: true,
  };
}

function snapshotFixture(): DashboardChainSnapshot {
  return {
    version: 1,
    configured: true,
    status: "ready",
    latestBlock: "88",
    indexedAt: "2026-07-29T10:00:00.000Z",
    lastAttemptAt: "2026-07-29T10:00:00.000Z",
    lastError: null,
    feed: [],
    reviewQueue: [],
  };
}

function tx(char: string): Hex {
  return `0x${char.repeat(64)}` as Hex;
}

function log(input: {
  address: string;
  eventName: string;
  jobId: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  args?: Record<string, unknown>;
}) {
  return {
    eventName: input.eventName,
    address: input.address,
    args: { jobId: BigInt(input.jobId), ...(input.args ?? {}) },
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: input.transactionHash,
  };
}

function rawJob(jobId: string, evaluator = ROUTER) {
  return {
    id: BigInt(jobId),
    client: CLIENT,
    provider: PROVIDER,
    evaluator,
    description: "Review this job for the dashboard.",
    budget: 1_000_000n,
    expiredAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
    status: 2,
    hook: zeroAddress,
  };
}

class FakeDashboardClient implements DashboardSnapshotClient {
  latestBlock = 120n;
  logs: unknown[] = [];
  jobs = new Map<string, ReturnType<typeof rawJob>>();
  lanes = new Map<string, number>();
  resolutions = new Map<string, number>();
  evidence = new Map<string, Hex>();
  getBlockNumberCalls = 0;
  getLogsCalls = 0;
  multicallCalls = 0;
  getBlockNumberError: Error | undefined;
  multicallError: Error | undefined;
  gate: Promise<void> | undefined;

  async getBlockNumber(): Promise<bigint> {
    this.getBlockNumberCalls += 1;
    if (this.gate) await this.gate;
    if (this.getBlockNumberError) throw this.getBlockNumberError;
    return this.latestBlock;
  }

  async getLogs(): Promise<unknown[]> {
    this.getLogsCalls += 1;
    return this.logs;
  }

  async multicall(input: {
    allowFailure: true;
    contracts: Array<{ functionName: string; args: unknown[] }>;
  }) {
    this.multicallCalls += 1;
    if (this.multicallError) {
      return input.contracts.map(() => ({
        status: "failure" as const,
        error: this.multicallError,
      }));
    }
    return input.contracts.map((contract) => {
      const jobId = BigInt(contract.args[0] as bigint).toString();
      switch (contract.functionName) {
        case "getJob":
          return { status: "success" as const, result: this.jobs.get(jobId) };
        case "lanes":
          return {
            status: "success" as const,
            result: BigInt(this.lanes.get(jobId) ?? 0),
          };
        case "resolutions":
          return {
            status: "success" as const,
            result: BigInt(this.resolutions.get(jobId) ?? 0),
          };
        case "evidence":
          return {
            status: "success" as const,
            result: this.evidence.get(jobId) ?? HUMAN_REASON_HASH,
          };
        default:
          return {
            status: "failure" as const,
            error: new Error(`unexpected multicall ${contract.functionName}`),
          };
      }
    });
  }
}

function successfulClient(): FakeDashboardClient {
  const client = new FakeDashboardClient();
  client.jobs.set("7", rawJob("7"));
  client.lanes.set("7", 1);
  client.resolutions.set("7", 3);
  client.evidence.set("7", HUMAN_REASON_HASH);
  client.logs = [
    log({
      address: COMMERCE,
      eventName: "JobSubmitted",
      jobId: "7",
      blockNumber: 101n,
      logIndex: 1,
      transactionHash: tx("a"),
      args: { provider: PROVIDER, deliverable: DELIVERABLE_HASH },
    }),
    log({
      address: ROUTER,
      eventName: "LaneSet",
      jobId: "7",
      blockNumber: 102n,
      logIndex: 2,
      transactionHash: tx("b"),
      args: { lane: 1 },
    }),
    log({
      address: ROUTER,
      eventName: "Escalated",
      jobId: "7",
      blockNumber: 103n,
      logIndex: 3,
      transactionHash: tx("c"),
      args: { reasonHash: HUMAN_REASON_HASH },
    }),
  ];
  return client;
}

describe("dashboard chain snapshot persistence", () => {
  it("migrates the snapshot table and roundtrips a versioned snapshot", () => {
    const database = new ReviewDatabase(":memory:");
    const table = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("dashboard_chain_snapshots");
    assert.ok(table);

    const snapshot = snapshotFixture();
    database.putDashboardChainSnapshot(snapshot);
    assert.deepEqual(database.getDashboardChainSnapshot(), snapshot);
    database.close();
  });
});

describe("dashboard chain snapshot endpoint", () => {
  it("requires the internal bearer token and returns the durable snapshot", async () => {
    const config = testConfig();
    const database = new ReviewDatabase(":memory:");
    database.putDashboardChainSnapshot(snapshotFixture());
    const processor = new ReviewProcessor({ config, database });
    const app = createReviewApp({
      config,
      database,
      processor,
      paymentMiddleware: (_request, _response, next) => next(),
    });
    try {
      const unauthorized = await dispatch(
        app,
        "/internal/dashboard-chain-snapshot",
      );
      assert.equal(unauthorized.status, 401);

      const authorized = await dispatch(
        app,
        "/internal/dashboard-chain-snapshot",
        "Bearer internal-test-token",
      );
      assert.equal(authorized.status, 200);
      assert.deepEqual(JSON.parse(authorized.body), snapshotFixture());
    } finally {
      database.close();
    }
  });
});

describe("DashboardSnapshotProcessor", () => {
  it("refreshes chain data into feed and pending review queue rows", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });

    const snapshot = await processor.refresh();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.latestBlock, "120");
    assert.equal(snapshot.feed.length, 1);
    const feedRow = snapshot.feed[0];
    assert.ok(feedRow);
    assert.equal(feedRow.id, "7");
    assert.equal(feedRow.provenance, "escalated");
    assert.equal(feedRow.lane, "human");
    assert.equal(feedRow.statusTxHash, tx("a"));
    assert.equal(feedRow.verdictTxHash, tx("c"));
    assert.equal(snapshot.reviewQueue.length, 1);
    const queueRow = snapshot.reviewQueue[0];
    assert.ok(queueRow);
    assert.equal(queueRow.deliverableHash, DELIVERABLE_HASH);
    assert.equal(queueRow.reasonHash, HUMAN_REASON_HASH);
    assert.equal(queueRow.escalationTxHash, tx("c"));
    assert.equal(queueRow.clientRequested, true);
    assert.deepEqual(database.getDashboardChainSnapshot(), snapshot);
    database.close();
  });

  it("indexes a recent escalation even when submission is outside lookback", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = new FakeDashboardClient();
    client.jobs.set("9", rawJob("9"));
    client.resolutions.set("9", 3);
    client.evidence.set("9", HUMAN_REASON_HASH);
    client.logs = [
      log({
        address: ROUTER,
        eventName: "Escalated",
        jobId: "9",
        blockNumber: 119n,
        logIndex: 1,
        transactionHash: tx("d"),
        args: { reasonHash: HUMAN_REASON_HASH },
      }),
    ];
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
    });

    const snapshot = await processor.refresh();
    assert.equal(snapshot.feed[0]?.id, "9");
    assert.equal(snapshot.reviewQueue[0]?.id, "9");
    assert.equal(snapshot.reviewQueue[0]?.deliverableHash, null);
    database.close();
  });

  it("uses null instead of fabricating a receipt outside the indexed range", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = new FakeDashboardClient();
    client.jobs.set("10", rawJob("10"));
    client.resolutions.set("10", 3);
    client.evidence.set("10", HUMAN_REASON_HASH);
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: ["10"],
    });

    const snapshot = await processor.refresh();
    assert.equal(snapshot.reviewQueue[0]?.id, "10");
    assert.equal(snapshot.reviewQueue[0]?.escalationTxHash, null);
    database.close();
  });

  it("does not advertise expired escalations as reviewable", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const expired = rawJob("7");
    expired.expiredAt = 1n;
    client.jobs.set("7", expired);
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
    });

    const snapshot = await processor.refresh();
    assert.equal(snapshot.feed[0]?.status, "Expired");
    assert.deepEqual(snapshot.reviewQueue, []);
    database.close();
  });

  it("keeps the last successful snapshot when a refresh fails", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });
    const ready = await processor.refresh();
    client.getBlockNumberError = new Error("Arc RPC unavailable");

    const degraded = await processor.refresh();
    assert.equal(degraded.status, "degraded");
    assert.equal(
      degraded.lastError,
      "Arc RPC is temporarily unavailable; the background indexer will retry.",
    );
    assert.deepEqual(degraded.feed, ready.feed);
    assert.deepEqual(degraded.reviewQueue, ready.reviewQueue);
    assert.equal(processor.getSnapshot().status, "degraded");
    database.close();
  });

  it("does not replace last-good rows with a rate-limited multicall", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });
    const ready = await processor.refresh();
    client.multicallError = new Error(
      "RPC request failed: -32011 request limit reached",
    );

    const degraded = await processor.refresh();
    assert.equal(degraded.status, "degraded");
    assert.deepEqual(degraded.feed, ready.feed);
    assert.deepEqual(degraded.reviewQueue, ready.reviewQueue);
    database.close();
  });

  it("does not replace last-good rows after an HTTP 503 multicall", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
    });
    const ready = await processor.refresh();
    client.multicallError = new Error("HTTP request failed. Status: 503");

    const degraded = await processor.refresh();
    assert.equal(
      degraded.lastError,
      "Arc RPC is temporarily unavailable; the background indexer will retry.",
    );
    assert.deepEqual(degraded.feed, ready.feed);
    assert.deepEqual(degraded.reviewQueue, ready.reviewQueue);
    database.close();
  });

  it("never persists credentials from an RPC error", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
    });
    await processor.refresh();
    client.getBlockNumberError = new Error(
      "HTTP 429 from https://rpc.example/private-token",
    );

    const degraded = await processor.refresh();
    assert.equal(
      degraded.lastError,
      "Arc RPC rate limit reached; the background indexer will retry.",
    );
    assert.equal(degraded.lastError?.includes("private-token"), false);
    assert.equal(
      database
        .getDashboardChainSnapshot()
        ?.lastError?.includes("private-token"),
      false,
    );
    database.close();
  });

  it("prevents overlapping refreshes", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    let release!: () => void;
    client.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
    });

    const first = processor.refresh();
    const second = processor.refresh();
    assert.strictEqual(first, second);
    assert.equal(client.getBlockNumberCalls, 1);
    release();
    await first;
    assert.equal(client.getBlockNumberCalls, 1);
    database.close();
  });

  it("stops and drains an in-flight refresh", async () => {
    const database = new ReviewDatabase(":memory:");
    const client = successfulClient();
    let release!: () => void;
    client.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = new DashboardSnapshotProcessor({
      config: testConfig(),
      database,
      client,
      pinnedJobIds: [],
      intervalMs: 10_000,
    });

    const refresh = processor.refresh();
    processor.stop();
    const drained = processor.drain(1_000);
    release();
    assert.equal(await drained, true);
    assert.equal((await refresh).status, "ready");
    database.close();
  });
});

async function dispatch(
  app: express.Express,
  url: string,
  authorization?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const handlers = routeHandlers(app, url);
    let index = 0;
    const request = {
      header(name: string): string | undefined {
        return name.toLowerCase() === "authorization"
          ? authorization
          : undefined;
      },
    };
    const response = {
      statusCode: 200,
      body: "",
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(value: unknown) {
        this.body = JSON.stringify(value);
        resolve({ status: this.statusCode, body: this.body });
        return this;
      },
    };
    const next = (error?: unknown): void => {
      if (error) {
        reject(error);
        return;
      }
      const handler = handlers[index];
      index += 1;
      if (!handler) {
        resolve({ status: response.statusCode, body: response.body });
        return;
      }
      handler(request as never, response as never, next);
    };
    next();
  });
}

function routeHandlers(app: express.Express, path: string): RequestHandler[] {
  const router = (app as unknown as { router?: { stack?: unknown[] } }).router;
  assert.ok(router?.stack, "Express router stack is unavailable");
  const layer = router.stack.find((entry) => {
    const route = (entry as { route?: { path?: unknown } }).route;
    return route?.path === path;
  }) as
    | {
        route: {
          stack: Array<{ handle: RequestHandler }>;
        };
      }
    | undefined;
  assert.ok(layer, `missing route ${path}`);
  return layer.route.stack.map((entry) => entry.handle);
}
