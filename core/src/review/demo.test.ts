import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  getAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  HUMAN_LANE_REASON,
  HUMAN_LANE_REASON_HASH,
} from "../evidence.js";
import type { CircleRail } from "./circle.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import { DemoProcessor } from "./demo.js";
import {
  createHumanEvidence,
  humanEvidenceHash,
  serializeHumanEvidence,
} from "./evidence.js";
import type {
  DemoChainRail,
  DemoChainReadiness,
  DemoPaymentHooks,
} from "./demo-chain.js";
import { DemoRepository, DemoRepositoryError } from "./demo-repository.js";
import type { DemoRun } from "./types.js";

const CLIENT = getAddress("0x1111111111111111111111111111111111111111");
const PROVIDER = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x3333333333333333333333333333333333333333");
const REVIEWER = getAddress("0x4444444444444444444444444444444444444444");
const SELLER = getAddress("0x5555555555555555555555555555555555555555");
const TX = (value: string): Hex => `0x${value.repeat(64)}` as Hex;

function config(): ReviewServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "http://review.test",
    databasePath: ":memory:",
    routerAddress: ROUTER,
    commerceAddress: getAddress(
      "0x6666666666666666666666666666666666666666",
    ),
    sellerAddress: SELLER,
    gatewayNetwork: "eip155:5042002",
    gatewayUrl: "https://gateway.invalid",
    reviewPrice: "250000",
    reviewPriceDisplay: "$0.25",
    reviewerReward: "200000",
    claimTtlSeconds: 600,
    reviewSlaSeconds: 1_800,
    minJobExpiryBufferSeconds: 2_220,
    maxDispatches: 2,
    internalToken: "internal",
    telegramBotToken: "bot",
    telegramWebhookSecret: "secret",
    circleWalletAddress: getAddress(
      "0x7777777777777777777777777777777777777777",
    ),
    usdcTokenAddress: getAddress(
      "0x3600000000000000000000000000000000000000",
    ),
    minimumTreasuryBalance: "450000",
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 1_000,
    backgroundIntervalMs: 60_000,
    logLookbackBlocks: 10_000n,
    allowPartialConfiguration: false,
    demoEnabled: true,
    demoEscrowBudget: "1000000",
    demoJobTtlSeconds: 86_400,
    demoMaxRunsPerHour: 3,
    demoJudgeHealthUrl: "data:text/plain,ok",
  };
}

class FakeDemoChain implements DemoChainRail {
  readonly clientAddress = CLIENT;
  readonly providerAddress = PROVIDER;
  readonly calls: string[] = [];
  lane = 0;
  budget = 0n;
  allowance = 0n;
  status = 0;
  resolution = 0;
  humanEvidence = TX("e");
  humanReviewer = REVIEWER;
  humanReward = "200000";
  humanPayout = TX("b");
  blockFailures = 0;
  readinessCalls = 0;
  createdRun?: DemoRun;

  async getBlockNumber(): Promise<bigint> {
    if (this.blockFailures > 0) {
      this.blockFailures -= 1;
      throw new Error("RPC request failed: timeout");
    }
    return 100n;
  }

  async getJob(jobId: string) {
    return {
      id: BigInt(jobId),
      client: CLIENT,
      provider: PROVIDER,
      evaluator: ROUTER,
      description: this.createdRun?.description ?? "",
      budget: this.budget,
      expiredAt: BigInt(this.createdRun?.expiresAt ?? "0"),
      status: this.status,
      hook: getAddress("0x0000000000000000000000000000000000000000"),
    };
  }

  async findCreatedJob(run: DemoRun) {
    return this.createdRun
      ? { jobId: "901", transactionHash: TX("1") }
      : null;
  }

  async sendCreateJob(run: DemoRun): Promise<Hex> {
    this.calls.push("createJob");
    this.createdRun = run;
    return TX("1");
  }

  async sendSetLane(): Promise<Hex> {
    this.calls.push("setLane");
    this.lane = 1;
    return TX("2");
  }

  async sendSetBudget(_jobId: string, budget: string): Promise<Hex> {
    this.calls.push("setBudget");
    this.budget = BigInt(budget);
    return TX("3");
  }

  async getAllowance(): Promise<bigint> {
    return this.allowance;
  }

  async sendApprove(amount: string): Promise<Hex> {
    this.calls.push("approve");
    this.allowance = BigInt(amount);
    return TX("4");
  }

  async hasBudget(): Promise<boolean> {
    return this.status >= 1;
  }

  async sendFund(): Promise<Hex> {
    this.calls.push("fund");
    this.status = 1;
    return TX("5");
  }

  async sendSubmit(): Promise<Hex> {
    this.calls.push("submit");
    this.status = 2;
    return TX("6");
  }

  async sendClaimRefund(): Promise<Hex> {
    this.calls.push("refund");
    this.status = 4;
    return TX("f");
  }

  async getLane(): Promise<number> {
    return this.lane;
  }

  async getResolution(): Promise<number> {
    return this.resolution;
  }

  async getHumanResolution() {
    return {
      resolution: this.resolution,
      evidenceHash: this.humanEvidence,
      reviewer: this.humanReviewer,
      reward: this.humanReward,
      payoutTransactionHash: this.humanPayout,
    };
  }

  async findEscalationTransaction(): Promise<Hex | null> {
    return this.resolution === 3 ? TX("7") : null;
  }

  async getReceipt(): Promise<TransactionReceipt | null> {
    return { status: "success" } as TransactionReceipt;
  }

  async readiness(): Promise<DemoChainReadiness> {
    this.readinessCalls += 1;
    return {
      chainId: 5_042_002,
      contractsReady: true,
      clientAddress: CLIENT,
      providerAddress: PROVIDER,
      resolverAddress: getAddress(
        "0x7777777777777777777777777777777777777777",
      ),
      clientTokenBalance: "10000000",
      clientNativeBalance: "1",
      providerNativeBalance: "1",
      gatewayAvailable: "1000000",
      gatewayTotal: "1000000",
    };
  }

  async purchaseReview(
    run: DemoRun,
    hooks: DemoPaymentHooks,
  ): Promise<{
    orderId: string;
    transaction: string;
    amount: string;
    status: number;
  }> {
    this.calls.push("purchase");
    hooks.onChallenge({
      amount: run.reviewPrice,
      network: "eip155:5042002",
      payTo: SELLER,
    });
    hooks.onAuthorization();
    const existing = databaseForFake?.getOrderByRequestId(run.requestId);
    const order =
      existing ??
      databaseForFake!.createOrder({
        requestId: run.requestId,
        deliverableContent: run.deliverableContent,
        job: {
          jobId: run.jobId!,
          client: CLIENT,
          provider: PROVIDER,
          evaluator: ROUTER,
          description: run.description,
          budget: run.budget,
          expiredAt: run.expiresAt,
          deliverableHash: run.deliverableHash,
          escalationReasonHash: HUMAN_LANE_REASON_HASH,
          escalationReasonCode: "human_lane_requested",
          escalationCause: HUMAN_LANE_REASON,
        },
        payment: {
          verified: true,
          payer: CLIENT,
          amount: run.reviewPrice,
          network: "eip155:5042002",
          transaction: TX("8"),
        },
        reviewPrice: run.reviewPrice,
        reward: run.reward,
      }).order;
    return {
      orderId: order.id,
      transaction: TX("8"),
      amount: run.reviewPrice,
      status: 202,
    };
  }
}

let databaseForFake: ReviewDatabase | undefined;

describe("durable live demo orchestration", () => {
  it("coalesces and caches the live readiness probe", async () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    database.upsertReviewer({
      telegramUserId: "123",
      telegramChatId: "123",
      alias: "Auditor",
      payoutAddress: REVIEWER,
      skills: ["contracts"],
    });
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
      circle: {
        checkTreasuryBalance: async () => ({ balance: "3000000" }),
      } as unknown as CircleRail,
    });

    try {
      const [first, second] = await Promise.all([
        processor.readiness(),
        processor.readiness(),
      ]);
      const cached = await processor.readiness();

      assert.equal(first.ready, true);
      assert.equal(second.ready, true);
      assert.equal(cached.ready, true);
      assert.equal(chain.readinessCalls, 1);
    } finally {
      database.close();
    }
  });

  it("sets HumanOnly before submission and never purchases twice", async () => {
    const database = new ReviewDatabase(":memory:");
    databaseForFake = database;
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    const reviewer = database.upsertReviewer({
      telegramUserId: "123",
      telegramChatId: "123",
      alias: "Auditor",
      payoutAddress: REVIEWER,
      skills: ["contracts"],
    });
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
      circle: {
        checkTreasuryBalance: async () => ({ balance: "3000000" }),
      } as unknown as CircleRail,
    });
    try {
      const requestId = randomUUID();
      const created = await processor.createRun(requestId);
      assert.equal(created.created, true);
      const duplicate = await processor.createRun(requestId);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.run.id, created.run.id);

      for (let index = 0; index < 20; index += 1) {
        await processor.processRun(created.run.id);
      }
      chain.resolution = 3;
      await processor.processRun(created.run.id);
      assert.equal(processor.getRun(created.run.id)?.state, "awaiting_purchase");
      assert.ok(
        chain.calls.indexOf("setLane") < chain.calls.indexOf("submit"),
        "HumanOnly must be committed before the deliverable is submitted",
      );

      processor.purchase(created.run.id);
      await processor.processRun(created.run.id);
      processor.purchase(created.run.id);
      assert.equal(
        chain.calls.filter((call) => call === "purchase").length,
        1,
      );
      const order = database.getOrderByRequestId(requestId)!;
      const claimExpiresAt = new Date(Date.now() + 60_000).toISOString();
      database.recordDispatch(order.id, reviewer.id, "1", claimExpiresAt);
      database.claimOrder(order.id, reviewer.id, 1_800);
      database.submitVerdict(
        order.id,
        reviewer.id,
        "approve",
        "The response contract and authentication behavior meet the acceptance criteria.",
        1_800,
      );
      const reviewed = database.getOrder(order.id)!;
      const evidence = createHumanEvidence({
        order: reviewed,
        reviewer: database.getReviewerSnapshot(reviewed)!,
        payoutTransactionHash: chain.humanPayout,
      });
      chain.humanEvidence = humanEvidenceHash(evidence);
      database.updateOrder(order.id, "settled", {
        evidenceHash: chain.humanEvidence,
        evidenceJson: serializeHumanEvidence(evidence),
        payoutTransactionHash: chain.humanPayout,
        resolutionTransactionHash: TX("9"),
        paidAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      });
      chain.status = 3;
      chain.resolution = 4;
      await processor.processRun(created.run.id);
      const finalized = processor.getRun(created.run.id)!;
      assert.equal(finalized.state, "finalized");
      assert.equal(finalized.onChainVerified, true);
      assert.equal(finalized.transactions.resolution, TX("9"));
      assert.equal(finalized.capabilities.isTerminal, true);
    } finally {
      databaseForFake = undefined;
      database.close();
    }
  });

  it("enforces one active run and a durable hourly start limit", () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const input = (requestId: string) => ({
      requestId,
      title: "Demo",
      description: "A uniquely tagged demo",
      acceptanceCriteria: "Do the work",
      deliverableContent: "Done",
      deliverableHash: keccak256(toBytes("Done")),
      clientAddress: CLIENT,
      providerAddress: PROVIDER,
      budget: "1000000",
      reviewPrice: "250000",
      reward: "200000",
      expiresAt: String(Math.floor(Date.now() / 1_000) + 86_400),
    });
    try {
      repository.createRun(input(randomUUID()), 3);
      assert.throws(
        () => repository.createRun(input(randomUUID()), 3),
        (error: unknown) =>
          error instanceof DemoRepositoryError &&
          error.code === "demo_run_conflict",
      );
    } finally {
      database.close();
    }
  });

  it("keeps the latest terminal proof visible behind a newer active run", () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const input = (requestId: string) => ({
      requestId,
      title: "Demo",
      description: `A uniquely tagged demo ${requestId}`,
      acceptanceCriteria: "Do the work",
      deliverableContent: "Done",
      deliverableHash: keccak256(toBytes("Done")),
      clientAddress: CLIENT,
      providerAddress: PROVIDER,
      budget: "1000000",
      reviewPrice: "250000",
      reward: "200000",
      expiresAt: String(Math.floor(Date.now() / 1_000) + 86_400),
    });
    try {
      const completed = repository.createRun(input(randomUUID()), 3).run;
      repository.transition(
        completed.id,
        "archived_refunded",
        null,
        "demo_archived",
      );
      const active = repository.createRun(input(randomUUID()), 3).run;

      assert.equal(repository.latest()?.id, active.id);
      assert.equal(repository.latestTerminal()?.id, completed.id);
    } finally {
      database.close();
    }
  });

  it("rejects archive requests while escrow preparation is still active", () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
    });
    const run = repository.createRun(
      {
        requestId: randomUUID(),
        title: "Demo",
        description: "A uniquely tagged preparing demo",
        acceptanceCriteria: "Do the work",
        deliverableContent: "Done",
        deliverableHash: keccak256(toBytes("Done")),
        clientAddress: CLIENT,
        providerAddress: PROVIDER,
        budget: "1000000",
        reviewPrice: "250000",
        reward: "200000",
        expiresAt: String(Math.floor(Date.now() / 1_000) + 86_400),
      },
      3,
    ).run;
    try {
      assert.throws(
        () => processor.archive(run.id),
        /archived only after escalation|can be archived only after escalation/,
      );
    } finally {
      database.close();
    }
  });

  it("never reports a provider-completed escrow as a client refund", async () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
    });
    const created = repository.createRun(
      {
        requestId: randomUUID(),
        title: "Demo",
        description: "A uniquely tagged terminal demo",
        acceptanceCriteria: "Do the work",
        deliverableContent: "Done",
        deliverableHash: keccak256(toBytes("Done")),
        clientAddress: CLIENT,
        providerAddress: PROVIDER,
        budget: "1000000",
        reviewPrice: "250000",
        reward: "200000",
        expiresAt: "1",
      },
      3,
    ).run;
    chain.createdRun = created;
    chain.status = 3;
    repository.patch(created.id, {
      state: "archived_refund_pending",
      currentOperation: "wait_for_refund_eligibility",
      jobId: "901",
    });
    try {
      await processor.processRun(created.id);
      const failed = processor.getRun(created.id)!;
      assert.equal(failed.state, "failed");
      assert.match(failed.lastError ?? "", /completed to the provider/);
      assert.equal(failed.capabilities.isTerminal, false);
    } finally {
      database.close();
    }
  });

  it("keeps x402 and escrow refunds separate until the escrow is reclaimed", async () => {
    const database = new ReviewDatabase(":memory:");
    databaseForFake = database;
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    database.upsertReviewer({
      telegramUserId: "123",
      telegramChatId: "123",
      alias: "Auditor",
      payoutAddress: REVIEWER,
      skills: ["contracts"],
    });
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
      circle: {
        checkTreasuryBalance: async () => ({ balance: "3000000" }),
      } as unknown as CircleRail,
    });
    try {
      const created = await processor.createRun(randomUUID());
      for (let index = 0; index < 20; index += 1) {
        await processor.processRun(created.run.id);
      }
      chain.resolution = 3;
      await processor.processRun(created.run.id);
      processor.purchase(created.run.id);
      await processor.processRun(created.run.id);
      const order = database.getOrderByRequestId(created.run.requestId)!;
      database.updateOrder(order.id, "refunded", {
        refundTransactionHash: TX("a"),
        settledAt: new Date().toISOString(),
      });

      await processor.processRun(created.run.id);
      let run = processor.getRun(created.run.id)!;
      assert.equal(run.state, "archived_refund_pending");
      assert.equal(run.transactions.reviewRefund, TX("a"));
      assert.equal(run.transactions.escrowRefund, null);
      assert.equal(run.capabilities.isTerminal, false);

      chain.createdRun!.expiresAt = "1";
      database.sqlite
        .prepare("UPDATE demo_runs SET expires_at = '1' WHERE id = ?")
        .run(created.run.id);
      await processor.processRun(created.run.id);
      await processor.processRun(created.run.id);
      run = processor.getRun(created.run.id)!;
      assert.equal(run.state, "archived_refunded");
      assert.equal(run.transactions.reviewRefund, TX("a"));
      assert.equal(run.transactions.escrowRefund, TX("f"));
    } finally {
      databaseForFake = undefined;
      database.close();
    }
  });

  it("keeps transient RPC failures processable and retries from durable state", async () => {
    const database = new ReviewDatabase(":memory:");
    const repository = new DemoRepository(database);
    const chain = new FakeDemoChain();
    database.upsertReviewer({
      telegramUserId: "123",
      telegramChatId: "123",
      alias: "Auditor",
      payoutAddress: REVIEWER,
      skills: ["contracts"],
    });
    const processor = new DemoProcessor({
      config: config(),
      database,
      repository,
      chain,
      circle: {
        checkTreasuryBalance: async () => ({ balance: "3000000" }),
      } as unknown as CircleRail,
    });
    try {
      chain.blockFailures = 1;
      const created = await processor.createRun(randomUUID());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const afterFailure = processor.getRun(created.run.id)!;
      assert.notEqual(afterFailure.state, "failed");
      assert.match(afterFailure.lastError ?? "", /RPC request failed/);

      await processor.processRun(created.run.id);
      assert.notEqual(processor.getRun(created.run.id)?.state, "failed");
    } finally {
      database.close();
    }
  });
});
