import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  getAddress,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import {
  HUMAN_LANE_REASON,
  HUMAN_LANE_REASON_HASH,
} from "../evidence.js";
import { createReviewApp } from "./app.js";
import type { CircleRail } from "./circle.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import {
  ReviewProcessor,
  wakeReviewOrder,
} from "./processor.js";
import type { TelegramGateway } from "./telegram.js";

const ROUTER = getAddress("0x1111111111111111111111111111111111111111");
const CLIENT = getAddress("0x2222222222222222222222222222222222222222");
const PROVIDER = getAddress(
  "0x3333333333333333333333333333333333333333",
);
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const REFUND_TX = `0x${"d".repeat(64)}` as Hex;

function config(): ReviewServiceConfig {
  return {
    port: 8787,
    publicBaseUrl: "http://review.test",
    databasePath: ":memory:",
    routerAddress: ROUTER,
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

function createPaidOrder(database: ReviewDatabase, jobId = "91") {
  const content = "A paid review that will expire.";
  return database.createOrder({
    requestId: randomUUID(),
    deliverableContent: content,
    job: {
      jobId,
      client: CLIENT,
      provider: PROVIDER,
      evaluator: ROUTER,
      description: "Review the submitted work.",
      budget: "25000000",
      expiredAt: String(Math.floor(Date.now() / 1_000) + 3_600),
      deliverableHash: keccak256(toBytes(content)),
      escalationReasonHash: HUMAN_LANE_REASON_HASH,
      escalationReasonCode: "human_lane_requested",
      escalationCause: HUMAN_LANE_REASON,
    },
    payment: {
      verified: true,
      payer: PAYER,
      amount: "250000",
      network: "eip155:5042002",
      transaction: `0x${"c".repeat(64)}`,
    },
    reviewPrice: "250000",
    reward: "200000",
  }).order;
}

describe("review financial recovery", () => {
  it("refunds an expired payer exactly once", async () => {
    const database = new ReviewDatabase(":memory:");
    const order = createPaidOrder(database);
    database.updateOrder(order.id, "expired");
    let transfers = 0;
    const circle: CircleRail = {
      async transfer(input) {
        transfers += 1;
        assert.equal(input.destination, PAYER);
        assert.equal(input.amount, "250000");
        return { id: "refund-1", state: "COMPLETE", txHash: REFUND_TX };
      },
      async resolve() {
        assert.fail("refunds do not resolve escrow");
      },
      async getTransaction(id) {
        return { id, state: "COMPLETE", txHash: REFUND_TX };
      },
    };
    const processor = new ReviewProcessor({
      database,
      config: config(),
      circle,
    });

    await processor.processOrder(order.id);
    await processor.processOrder(order.id);

    const refunded = database.getOrder(order.id)!;
    assert.equal(refunded.state, "refunded");
    assert.equal(refunded.refundTransactionHash, REFUND_TX);
    assert.equal(transfers, 1);
    assert.equal(
      database
        .listEvents(order.id)
        .filter((event) => event.type === "review_refunded").length,
      1,
    );
    database.close();
  });

  it("keeps polling a STUCK refund without rotating or permitting operator resume", async () => {
    const database = new ReviewDatabase(":memory:");
    const order = createPaidOrder(database, "93");
    database.updateOrder(order.id, "expired");
    const originalKey = order.refundIdempotencyKey;
    let transfers = 0;
    let polls = 0;
    const circle: CircleRail = {
      async transfer(input) {
        transfers += 1;
        assert.equal(input.idempotencyKey, originalKey);
        return { id: "refund-stuck", state: "STUCK", txHash: null };
      },
      async resolve() {
        assert.fail("refunds do not resolve escrow");
      },
      async getTransaction(id) {
        polls += 1;
        assert.equal(id, "refund-stuck");
        return { id, state: "COMPLETE", txHash: REFUND_TX };
      },
    };
    const currentConfig = { ...config(), circleMaxAttempts: 1 };
    const processor = new ReviewProcessor({
      database,
      config: currentConfig,
      circle,
    });

    await processor.processOrder(order.id);
    const stuck = database.getOrder(order.id)!;
    assert.equal(stuck.state, "expired");
    assert.equal(stuck.circleRefundId, "refund-stuck");
    assert.equal(stuck.refundIdempotencyKey, originalKey);
    assert.equal(
      database.listCircleAttempts(order.id, "refund")[0]?.state,
      "STUCK",
    );
    assert.throws(
      () =>
        database.resumeCircleOperation(
          order.id,
          "refund",
          currentConfig.circleMaxAttempts,
        ),
      /has not exhausted its current retry budget/,
    );

    await processor.processOrder(order.id);
    const refunded = database.getOrder(order.id)!;
    assert.equal(refunded.state, "refunded");
    assert.equal(refunded.refundIdempotencyKey, originalKey);
    assert.equal(refunded.refundTransactionHash, REFUND_TX);
    assert.equal(transfers, 1);
    assert.equal(polls, 1);
    database.close();
  });

  it("wakes the matching order on a Circle notification", async () => {
    const database = new ReviewDatabase(":memory:");
    const order = createPaidOrder(database, "92");
    database.recordCircleTransaction(order.id, "payout", {
      id: "payout-pending",
      state: "INITIATED",
      txHash: null,
    });
    const processor = new ReviewProcessor({
      database,
      config: config(),
    });
    let wakes = 0;
    processor.processOrder = async (orderId) => {
      assert.equal(orderId, order.id);
      wakes += 1;
    };

    processor.reconcileCircleNotification({ transactionId: "payout-pending" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(wakes, 1);
    assert.ok(
      database
        .listEvents(order.id)
        .some((event) => event.type === "circle_webhook_received"),
    );
    database.close();
  });

  it("contains a rejected immediate worker wake", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };
    try {
      wakeReviewOrder(
        {
          async processOrder() {
            throw new Error("wake failed safely");
          },
        },
        "order-1",
        "unit-test",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? "", /review_order_wake_failed/);
      assert.match(errors[0] ?? "", /wake failed safely/);
    } finally {
      console.error = originalError;
    }
  });
});

describe("review webhook authentication", () => {
  it("rejects forged Telegram and Circle callbacks before processing", async () => {
    const database = new ReviewDatabase(":memory:");
    let telegramCalls = 0;
    let circleCalls = 0;
    const telegram: TelegramGateway = {
      async registerWebhook() {},
      async dispatch() {
        return 0;
      },
      async handleUpdate() {
        telegramCalls += 1;
      },
    };
    const processor = {
      async processOrder() {},
      reconcileCircleNotification() {
        circleCalls += 1;
      },
    } as unknown as ReviewProcessor;
    const app = createReviewApp({
      config: config(),
      database,
      telegram,
      processor,
      circleWebhookVerifier: {
        async verify() {
          return false;
        },
      },
    });
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      assert.fail("test server did not bind");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const telegramResponse = await fetch(
        `${baseUrl}/v1/telegram/webhook`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "forged",
          },
          body: JSON.stringify({ update_id: 101 }),
        },
      );
      assert.equal(telegramResponse.status, 401);

      const circleResponse = await fetch(`${baseUrl}/v1/circle/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-circle-signature": "forged",
          "x-circle-key-id": "key-1",
        },
        body: JSON.stringify({ transactionId: "payout-forged" }),
      });
      assert.equal(circleResponse.status, 401);
      assert.equal(telegramCalls, 0);
      assert.equal(circleCalls, 0);
    } finally {
      server.close();
      await once(server, "close");
      database.close();
    }
  });
});
