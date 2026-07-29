import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress, keccak256, toBytes } from "viem";
import { HUMAN_LANE_REASON, HUMAN_LANE_REASON_HASH } from "../evidence.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import { TelegramVerdictPromptStore } from "./telegram-prompt-store.js";
import { TelegramBotGateway } from "./telegram.js";
import type { Reviewer, ReviewOrder } from "./types.js";

const CLIENT = getAddress("0x1111111111111111111111111111111111111111");
const PROVIDER = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x3333333333333333333333333333333333333333");
const REVIEWER_ADDRESS = getAddress(
  "0x4444444444444444444444444444444444444444",
);
const PAYER = getAddress("0x5555555555555555555555555555555555555555");

function testConfig(): ReviewServiceConfig {
  return {
    port: 0,
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

function createClaimableOrder(database: ReviewDatabase): {
  order: ReviewOrder;
  reviewer: Reviewer;
} {
  const reviewer = database.upsertReviewer({
    telegramUserId: "503",
    telegramChatId: "503",
    alias: "Force Reply auditor",
    payoutAddress: REVIEWER_ADDRESS,
    skills: ["api"],
  });
  const content =
    "The API returns status and result fields and rejects unauthenticated requests with HTTP 401.";
  const { order } = database.createOrder({
    requestId: randomUUID(),
    deliverableContent: content,
    job: {
      jobId: "10",
      client: CLIENT,
      provider: PROVIDER,
      evaluator: ROUTER,
      description: "Verify the API contract.",
      budget: "1000000",
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
  });
  database.recordDispatch(
    order.id,
    reviewer.id,
    "50",
    new Date(Date.now() + 60_000).toISOString(),
  );
  return { order: database.getOrder(order.id)!, reviewer };
}

interface SentTelegramMessage {
  messageId: number;
  body: Record<string, unknown>;
}

function installTelegramFetch(): {
  sent: SentTelegramMessage[];
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const sent: SentTelegramMessage[] = [];
  let messageId = 100;
  globalThis.fetch = (async (input, init) => {
    const method = String(input).split("/").at(-1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (method === "answerCallbackQuery") {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(method, "sendMessage");
    messageId += 1;
    sent.push({ messageId, body });
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: messageId,
          chat: { id: Number(body.chat_id) },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return {
    sent,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("Telegram ForceReply verdict flow", () => {
  it("claims, selects a decision, and accepts a reason-only reply", async () => {
    const database = new ReviewDatabase(":memory:");
    const { order, reviewer } = createClaimableOrder(database);
    const transport = installTelegramFetch();
    let verdictWakeups = 0;
    try {
      const telegram = new TelegramBotGateway(
        "test-token",
        testConfig(),
        database,
        { onVerdict: () => void (verdictWakeups += 1) },
      );
      await telegram.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "claim-1",
          from: { id: 503 },
          data: `claim:${order.id}`,
          message: {
            message_id: 50,
            chat: { id: 503 },
          },
        },
      });
      assert.equal(database.getOrder(order.id)?.state, "claimed");
      const decisionMessage = transport.sent.at(-1);
      assert.ok(decisionMessage);

      await telegram.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "approve-1",
          from: { id: 503 },
          data: `approve:${order.id}`,
          message: {
            message_id: decisionMessage.messageId,
            chat: { id: 503 },
          },
        },
      });
      const reasonPrompt = transport.sent.at(-1);
      assert.ok(reasonPrompt);
      assert.deepEqual(reasonPrompt.body.reply_markup, {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Explain your verdict…",
      });
      const promptRow = database.sqlite
        .prepare(
          `SELECT status, decision, prompt_message_id
             FROM telegram_verdict_prompts WHERE order_id = ?`,
        )
        .get(order.id) as {
        status: string;
        decision: string;
        prompt_message_id: string;
      };
      assert.deepEqual(promptRow, {
        status: "active",
        decision: "approve",
        prompt_message_id: String(reasonPrompt.messageId),
      });

      const reasoning =
        "The deliverable satisfies every stated API contract requirement.";
      await telegram.handleUpdate({
        update_id: 3,
        message: {
          message_id: 103,
          from: { id: 503 },
          chat: { id: 503 },
          text: reasoning,
          reply_to_message: {
            message_id: reasonPrompt.messageId,
            chat: { id: 503 },
          },
        },
      });
      const reviewed = database.getOrder(order.id);
      assert.equal(reviewed?.state, "verdict_submitted");
      assert.equal(reviewed?.decision, "approve");
      assert.equal(reviewed?.reasoning, reasoning);
      assert.equal(verdictWakeups, 1);
      assert.equal(
        (
          database.sqlite
            .prepare(
              "SELECT status FROM telegram_verdict_prompts WHERE order_id = ?",
            )
            .get(order.id) as { status: string }
        ).status,
        "consumed",
      );
      assert.equal(reviewer.telegramChatId, "503");
    } finally {
      transport.restore();
      database.close();
    }
  });

  it("supersedes older prompts and binds replies to the newest decision", async () => {
    const database = new ReviewDatabase(":memory:");
    const { order, reviewer } = createClaimableOrder(database);
    database.claimOrder(order.id, reviewer.id, 1_800);
    const transport = installTelegramFetch();
    try {
      const telegram = new TelegramBotGateway(
        "test-token",
        testConfig(),
        database,
        { onVerdict() {} },
      );
      for (const decision of ["approve", "reject"] as const) {
        await telegram.handleUpdate({
          update_id: decision === "approve" ? 10 : 11,
          callback_query: {
            id: decision,
            from: { id: 503 },
            data: `${decision}:${order.id}`,
            message: { message_id: 51, chat: { id: 503 } },
          },
        });
      }
      const prompts = database.sqlite
        .prepare(
          `SELECT status, decision, prompt_message_id
             FROM telegram_verdict_prompts
            WHERE order_id = ? ORDER BY created_at, rowid`,
        )
        .all(order.id) as Array<{
        status: string;
        decision: string;
        prompt_message_id: string;
      }>;
      assert.deepEqual(
        prompts.map(({ status, decision }) => ({ status, decision })),
        [
          { status: "superseded", decision: "approve" },
          { status: "active", decision: "reject" },
        ],
      );

      await telegram.handleUpdate({
        update_id: 12,
        message: {
          message_id: 200,
          from: { id: 503 },
          chat: { id: 503 },
          text: "This reply targets the superseded approval prompt.",
          reply_to_message: {
            message_id: Number(prompts[0]!.prompt_message_id),
            chat: { id: 503 },
          },
        },
      });
      assert.equal(database.getOrder(order.id)?.state, "claimed");
      assert.match(
        String(transport.sent.at(-1)?.body.text),
        /newer verdict prompt/i,
      );

      const reasoning =
        "The response contract omits a required field, so the work must be rejected.";
      await telegram.handleUpdate({
        update_id: 13,
        message: {
          message_id: 201,
          from: { id: 503 },
          chat: { id: 503 },
          text: reasoning,
          reply_to_message: {
            message_id: Number(prompts[1]!.prompt_message_id),
            chat: { id: 503 },
          },
        },
      });
      assert.equal(database.getOrder(order.id)?.decision, "reject");
      assert.equal(database.getOrder(order.id)?.reasoning, reasoning);
    } finally {
      transport.restore();
      database.close();
    }
  });

  it("rejects wrong chats, unknown prompts, and invalid reason lengths", async () => {
    const database = new ReviewDatabase(":memory:");
    const { order, reviewer } = createClaimableOrder(database);
    database.claimOrder(order.id, reviewer.id, 1_800);
    const transport = installTelegramFetch();
    try {
      const telegram = new TelegramBotGateway(
        "test-token",
        testConfig(),
        database,
        { onVerdict() {} },
      );
      await telegram.handleUpdate({
        update_id: 20,
        callback_query: {
          id: "approve-wrong-chat",
          from: { id: 503 },
          data: `approve:${order.id}`,
          message: { message_id: 51, chat: { id: 999 } },
        },
      });
      assert.equal(transport.sent.length, 0);
      await telegram.handleUpdate({
        update_id: 21,
        callback_query: {
          id: "approve",
          from: { id: 503 },
          data: `approve:${order.id}`,
          message: { message_id: 51, chat: { id: 503 } },
        },
      });
      const promptMessageId = transport.sent.at(-1)!.messageId;

      await telegram.handleUpdate({
        update_id: 22,
        message: {
          message_id: 210,
          from: { id: 503 },
          chat: { id: 999 },
          text: "A forged reply from a different chat must not be accepted.",
          reply_to_message: {
            message_id: promptMessageId,
            chat: { id: 503 },
          },
        },
      });
      await telegram.handleUpdate({
        update_id: 23,
        message: {
          message_id: 211,
          from: { id: 9_999 },
          chat: { id: 503 },
          text: "A forged reply from another identity must not be accepted.",
          reply_to_message: {
            message_id: promptMessageId,
            chat: { id: 503 },
          },
        },
      });
      await telegram.handleUpdate({
        update_id: 24,
        message: {
          message_id: 212,
          from: { id: 503 },
          chat: { id: 503 },
          text: "A reply to an unrelated bot message must not be accepted.",
          reply_to_message: {
            message_id: 9_999,
            chat: { id: 503 },
          },
        },
      });
      await telegram.handleUpdate({
        update_id: 25,
        message: {
          message_id: 213,
          from: { id: 503 },
          chat: { id: 503 },
          text: "too short",
          reply_to_message: {
            message_id: promptMessageId,
            chat: { id: 503 },
          },
        },
      });
      assert.equal(database.getOrder(order.id)?.state, "claimed");
      assert.match(
        String(transport.sent.at(-1)?.body.text),
        /10–1000 characters/,
      );

      const reasoning =
        "The complete contract behavior is present and can be independently verified.";
      await telegram.handleUpdate({
        update_id: 26,
        message: {
          message_id: 214,
          from: { id: 503 },
          chat: { id: 503 },
          text: reasoning,
          reply_to_message: {
            message_id: promptMessageId,
            chat: { id: 503 },
          },
        },
      });
      assert.equal(database.getOrder(order.id)?.state, "verdict_submitted");
    } finally {
      transport.restore();
      database.close();
    }
  });

  it("expires durable prompt correlations and preserves legacy /verdict", async () => {
    const database = new ReviewDatabase(":memory:");
    const { order, reviewer } = createClaimableOrder(database);
    database.claimOrder(order.id, reviewer.id, 1_800);
    const store = new TelegramVerdictPromptStore(database);
    const expired = store.create({
      orderId: order.id,
      reviewerId: reviewer.id,
      telegramUserId: reviewer.telegramUserId,
      telegramChatId: reviewer.telegramChatId,
      decision: "reject",
      promptMessageId: "70",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    assert.equal(
      store.lookupReply({
        reviewerId: reviewer.id,
        telegramUserId: reviewer.telegramUserId,
        telegramChatId: reviewer.telegramChatId,
        promptMessageId: expired.promptMessageId,
      }).status,
      "expired",
    );

    const transport = installTelegramFetch();
    try {
      const expiredSlaTelegram = new TelegramBotGateway(
        "test-token",
        { ...testConfig(), reviewSlaSeconds: 0 },
        database,
        { onVerdict() {} },
      );
      await expiredSlaTelegram.handleUpdate({
        update_id: 29,
        callback_query: {
          id: "expired-sla",
          from: { id: 503 },
          data: `approve:${order.id}`,
          message: { message_id: 51, chat: { id: 503 } },
        },
      });
      assert.equal(transport.sent.length, 0);

      const telegram = new TelegramBotGateway(
        "test-token",
        testConfig(),
        database,
        { onVerdict() {} },
      );
      await telegram.handleUpdate({
        update_id: 30,
        message: {
          message_id: 300,
          from: { id: 503 },
          chat: { id: 503 },
          text: `/verdict ${order.id} approve The legacy command remains available for recovery and automation.`,
        },
      });
      assert.equal(database.getOrder(order.id)?.decision, "approve");
      assert.equal(store.get(expired.id)?.status, "expired");
    } finally {
      transport.restore();
      database.close();
    }
  });
});
