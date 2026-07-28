import { keccak256, toBytes, type Hex } from "viem";
import type { CircleRail } from "./circle.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import {
  createHumanEvidence,
  humanEvidenceHash,
  serializeHumanEvidence,
} from "./evidence.js";
import type { ReviewChain } from "./chain.js";
import {
  isPermanentReviewValidationError,
  validateEscalatedReview,
} from "./eligibility.js";
import type { TelegramGateway } from "./telegram.js";
import type {
  CircleOperation,
  CircleTransactionResult,
  ReviewOrder,
} from "./types.js";

const PREFLIGHT_EVIDENCE_HASH = keccak256(
  toBytes("vapi-review-preflight-evidence"),
);
const PREFLIGHT_PAYOUT_HASH = keccak256(
  toBytes("vapi-review-preflight-payout"),
);
const CIRCLE_TERMINAL_FAILURES = new Set([
  "FAILED",
  "DENIED",
  "CANCELLED",
]);

export interface ReviewProcessorDependencies {
  database: ReviewDatabase;
  config: ReviewServiceConfig;
  chain?: ReviewChain;
  circle?: CircleRail;
  telegram?: TelegramGateway;
}

export class ReviewProcessor {
  private readonly processing = new Set<string>();
  private interval?: NodeJS.Timeout;
  private telegram?: TelegramGateway;
  private activeSweeps = 0;

  constructor(private readonly dependencies: ReviewProcessorDependencies) {
    this.telegram = dependencies.telegram;
  }

  setTelegram(telegram: TelegramGateway | undefined): void {
    this.telegram = telegram;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.processAllWithLogging();
    }, this.dependencies.config.backgroundIntervalMs);
    this.interval.unref();
    this.processAllWithLogging();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async processAll(): Promise<void> {
    this.activeSweeps += 1;
    try {
      const orders = this.dependencies.database.listOrdersInStates([
        "paid",
        "dispatched",
        "claimed",
        "verdict_submitted",
        "payout_failed",
        "reviewer_paid",
        "reviewer_paid_settlement_failed",
        "expired",
      ]);
      for (const order of orders) await this.processOrder(order.id);
    } finally {
      this.activeSweeps -= 1;
    }
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.activeSweeps > 0 || this.processing.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return this.activeSweeps === 0 && this.processing.size === 0;
  }

  private processAllWithLogging(): void {
    void this.processAll().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "review_processor_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  async processOrder(orderId: string): Promise<void> {
    if (this.processing.has(orderId)) return;
    this.processing.add(orderId);
    try {
      const timeout = this.dependencies.database.applyReviewTimeouts(
        orderId,
        this.dependencies.config.reviewSlaSeconds,
        this.dependencies.config.maxDispatches,
      );
      const order = timeout.order;
      if (!order) return;
      if (timeout.action === "expired") {
        await this.refund(order.id);
        return;
      }
      if (timeout.action === "redispatched") return;
      if (this.circleRetriesExhausted(order)) return;
      switch (order.state) {
        case "paid":
          await this.dispatch(order);
          break;
        case "dispatched":
          break;
        case "claimed":
          break;
        case "verdict_submitted":
        case "payout_failed":
          await this.payReviewer(order);
          break;
        case "reviewer_paid":
        case "reviewer_paid_settlement_failed":
          await this.settle(order);
          break;
        case "expired":
          await this.refund(order.id);
          break;
      }
    } finally {
      this.processing.delete(orderId);
    }
  }

  wakeOrder(orderId: string, source: string): void {
    wakeReviewOrder(this, orderId, source);
  }

  private circleRetriesExhausted(order: ReviewOrder): boolean {
    const operation: CircleOperation | undefined =
      order.state === "payout_failed"
        ? "payout"
        : order.state === "reviewer_paid_settlement_failed"
          ? "resolution"
          : order.state === "expired"
            ? "refund"
            : undefined;
    if (!operation) return false;
    const attempts = this.dependencies.database.listCircleAttempts(
      order.id,
      operation,
    );
    const latest = attempts.at(-1);
    const currentIdempotencyKey =
      operation === "payout"
        ? order.payoutIdempotencyKey
        : operation === "resolution"
          ? order.resolutionIdempotencyKey
          : order.refundIdempotencyKey;
    return Boolean(
      latest &&
      attempts.length >= this.dependencies.config.circleMaxAttempts &&
      CIRCLE_TERMINAL_FAILURES.has(latest.state) &&
      latest.idempotencyKey === currentIdempotencyKey,
    );
  }

  private async dispatch(order: ReviewOrder): Promise<void> {
    if (!(await this.reviewableBeforeDispatch(order))) return;
    if (!this.telegram) {
      this.dependencies.database.updateOrder(order.id, "paid", {
        lastError: "Telegram is not configured",
      });
      return;
    }
    const reviewers = this.dependencies.database.listEligibleReviewers(
      order.jobClient,
      order.jobProvider,
    );
    if (reviewers.length === 0) {
      this.dependencies.database.updateOrder(order.id, "paid", {
        lastError: "No eligible reviewers are active",
      });
      return;
    }
    try {
      const sent = await this.telegram.dispatch(order, reviewers);
      if (sent === 0) throw new Error("No Telegram review offers were sent");
    } catch (error) {
      this.dependencies.database.updateOrder(order.id, "paid", {
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async payReviewer(order: ReviewOrder): Promise<void> {
    const { database, chain, circle } = this.dependencies;
    const reviewer = database.getReviewerSnapshot(order);
    if (!reviewer || !order.decision || !order.reasoning) {
      database.updateOrder(order.id, "payout_failed", {
        lastError: "Review verdict or assigned reviewer is missing",
      });
      return;
    }
    if (!chain || !circle) {
      database.updateOrder(order.id, "payout_failed", {
        lastError: "Circle Wallets or Arc validation is not configured",
      });
      return;
    }
    let currentOrder = order;
    try {
      if (!currentOrder.circlePayoutId) {
        const settlementBufferSeconds = this.payoutExpiryBufferSeconds();
        if (!currentOrder.settlementAbortCode) {
          try {
            await validateEscalatedReview(
              chain,
              database,
              currentOrder.jobId,
              currentOrder.deliverableContent,
              { minJobExpiryBufferSeconds: settlementBufferSeconds },
            );
          } catch (error) {
            if (!isPermanentReviewValidationError(error)) throw error;
            currentOrder = this.markSettlementAborted(
              currentOrder,
              error.code,
              error.message,
            );
          }
        }
        if (
          !currentOrder.settlementAbortCode &&
          BigInt(currentOrder.jobExpiredAt) <
            BigInt(Math.floor(Date.now() / 1_000) + settlementBufferSeconds)
        ) {
          throw new Error(
            `Escrow expiry is inside the ${settlementBufferSeconds}s Circle payout and settlement safety window`,
          );
        }
        if (!currentOrder.settlementAbortCode) {
          await chain.preflightHumanResolve({
            order: currentOrder,
            reviewer,
            evidenceHash: PREFLIGHT_EVIDENCE_HASH,
            payoutTransactionHash: PREFLIGHT_PAYOUT_HASH,
          });
        }
      }
      let payout: CircleTransactionResult;
      if (currentOrder.circlePayoutId) {
        payout = await circle.getTransaction(currentOrder.circlePayoutId);
      } else {
        database.markCircleRequestStarted(currentOrder.id, "payout");
        payout = await circle.transfer({
          destination: reviewer.payoutAddress,
          amount: currentOrder.reward,
          idempotencyKey: currentOrder.payoutIdempotencyKey,
          reference: `vapi-review-payout:${currentOrder.id}`,
          onCreated: (transaction) => {
            database.recordCircleTransaction(
              currentOrder.id,
              "payout",
              transaction,
            );
          },
        });
      }
      database.recordCircleTransaction(currentOrder.id, "payout", payout);
      this.requireCompletedCircleTransaction(currentOrder, "payout", payout);
      const paidAt = new Date().toISOString();
      database.updateOrder(
        currentOrder.id,
        "reviewer_paid",
        {
          circlePayoutId: payout.id,
          payoutTransactionHash: payout.txHash,
          paidAt,
          lastError: null,
        },
        "reviewer_paid",
        {
          reviewer: reviewer.payoutAddress,
          amount: currentOrder.reward,
          circleTransactionId: payout.id,
          transactionHash: payout.txHash,
        },
      );
      await this.settle(database.getOrder(currentOrder.id)!);
    } catch (error) {
      database.updateOrder(
        currentOrder.id,
        "payout_failed",
        { lastError: error instanceof Error ? error.message : String(error) },
        "payout_failed",
      );
    }
  }

  private async settle(order: ReviewOrder): Promise<void> {
    const { database, chain, circle } = this.dependencies;
    const reviewer = database.getReviewerSnapshot(order);
    if (!circle || !reviewer || !order.payoutTransactionHash) {
      database.updateOrder(order.id, "reviewer_paid_settlement_failed", {
        lastError: "Circle settlement or payout provenance is not configured",
      });
      return;
    }
    try {
      const evidence = createHumanEvidence({
        order,
        reviewer,
        payoutTransactionHash: order.payoutTransactionHash,
        payoutConfirmedAt: order.paidAt ?? undefined,
      });
      const evidenceHash = humanEvidenceHash(evidence);
      const evidenceJson = serializeHumanEvidence(evidence);
      database.updateOrder(order.id, "reviewer_paid", {
        evidenceHash,
        evidenceJson,
        lastError: null,
      });
      let currentOrder = database.getOrder(order.id)!;
      const unresolvedRequestStarted =
        !currentOrder.circleResolutionId &&
        database.hasCurrentCircleRequestStarted(currentOrder.id, "resolution");
      if (
        !currentOrder.settlementAbortCode &&
        !currentOrder.circleResolutionId &&
        !unresolvedRequestStarted
      ) {
        if (!chain) {
          throw new Error(
            "Arc validation is not configured for final settlement",
          );
        }
        try {
          await validateEscalatedReview(
            chain,
            database,
            currentOrder.jobId,
            currentOrder.deliverableContent,
            {
              minJobExpiryBufferSeconds: this.resolutionExpiryBufferSeconds(),
            },
          );
        } catch (error) {
          if (!isPermanentReviewValidationError(error)) throw error;
          currentOrder = this.markSettlementAborted(
            currentOrder,
            error.code,
            error.message,
          );
        }
      }
      if (currentOrder.settlementAbortCode && !unresolvedRequestStarted) {
        await this.refund(currentOrder.id);
        return;
      }
      if (!currentOrder.circleResolutionId && !unresolvedRequestStarted) {
        await chain!.preflightHumanResolve({
          order: currentOrder,
          reviewer,
          evidenceHash,
          payoutTransactionHash: currentOrder.payoutTransactionHash!,
        });
      }
      let resolution: CircleTransactionResult;
      if (currentOrder.circleResolutionId) {
        resolution = await circle.getTransaction(
          currentOrder.circleResolutionId,
        );
      } else {
        database.markCircleRequestStarted(currentOrder.id, "resolution");
        resolution = await circle.resolve({
          order: currentOrder,
          reviewer,
          evidenceHash,
          payoutTransactionHash: currentOrder.payoutTransactionHash!,
          onCreated: (transaction) => {
            database.recordCircleTransaction(
              currentOrder.id,
              "resolution",
              transaction,
            );
          },
        });
      }
      database.recordCircleTransaction(
        currentOrder.id,
        "resolution",
        resolution,
      );
      this.requireCompletedCircleTransaction(
        currentOrder,
        "resolution",
        resolution,
      );
      database.updateOrder(
        order.id,
        "settled",
        {
          evidenceHash,
          evidenceJson,
          circleResolutionId: resolution.id,
          resolutionTransactionHash: resolution.txHash,
          settledAt: new Date().toISOString(),
          settlementAbortCode: null,
          settlementAbortedAt: null,
          lastError: null,
        },
        "escrow_settled",
        {
          decision: order.decision,
          evidenceHash,
          circleTransactionId: resolution.id,
          transactionHash: resolution.txHash,
        },
      );
    } catch (error) {
      database.updateOrder(
        order.id,
        "reviewer_paid_settlement_failed",
        { lastError: error instanceof Error ? error.message : String(error) },
        "settlement_failed",
      );
    }
  }

  private async reviewableBeforeDispatch(order: ReviewOrder): Promise<boolean> {
    const { chain, database } = this.dependencies;
    if (!chain) {
      database.updateOrder(order.id, "paid", {
        lastError: "Arc validation is not configured before dispatch",
      });
      return false;
    }
    try {
      await validateEscalatedReview(
        chain,
        database,
        order.jobId,
        order.deliverableContent,
        {
          minJobExpiryBufferSeconds: this.dispatchExpiryBufferSeconds(order),
        },
      );
      return true;
    } catch (error) {
      if (!isPermanentReviewValidationError(error)) {
        database.updateOrder(order.id, "paid", {
          lastError: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      database.expireAssignments(order.id);
      database.updateOrder(
        order.id,
        "expired",
        {
          settlementAbortCode: error.code,
          settlementAbortedAt: new Date().toISOString(),
          claimExpiresAt: null,
          lastError: null,
        },
        "fulfillment_permanently_failed",
        {
          phase: "before_dispatch",
          code: error.code,
          message: error.message,
        },
      );
      await this.refund(order.id);
      return false;
    }
  }

  private markSettlementAborted(
    order: ReviewOrder,
    code: string,
    message: string,
  ): ReviewOrder {
    if (order.settlementAbortCode) return order;
    return this.dependencies.database.updateOrder(
      order.id,
      order.state,
      {
        settlementAbortCode: code,
        settlementAbortedAt: new Date().toISOString(),
        lastError: null,
      },
      "fulfillment_permanently_failed",
      { phase: "after_verdict", code, message },
    );
  }

  private payoutExpiryBufferSeconds(): number {
    return (
      Math.ceil(
        (2 * this.dependencies.config.transactionPollTimeoutMs) / 1_000,
      ) + 60
    );
  }

  private dispatchExpiryBufferSeconds(order: ReviewOrder): number {
    const createdAtMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new Error("review order has an invalid creation timestamp");
    }
    const remainingReviewMs =
      createdAtMs +
      this.dependencies.config.reviewSlaSeconds * 1_000 -
      Date.now();
    const remainingReviewSeconds = Math.max(
      0,
      Math.ceil(remainingReviewMs / 1_000),
    );
    return remainingReviewSeconds + this.payoutExpiryBufferSeconds();
  }

  private resolutionExpiryBufferSeconds(): number {
    return (
      Math.ceil(this.dependencies.config.transactionPollTimeoutMs / 1_000) + 60
    );
  }

  private async refund(orderId: string): Promise<void> {
    const { database, circle } = this.dependencies;
    const order = database.getOrder(orderId);
    if (!order || order.state === "refunded") return;
    if (!circle) {
      database.updateOrder(orderId, "expired", {
        lastError: "Circle Wallets is not configured for refund",
      });
      return;
    }
    try {
      let refund: CircleTransactionResult;
      if (order.circleRefundId) {
        refund = await circle.getTransaction(order.circleRefundId);
      } else {
        database.markCircleRequestStarted(order.id, "refund");
        refund = await circle.transfer({
          destination: order.payer,
          amount: order.reviewPrice,
          idempotencyKey: order.refundIdempotencyKey,
          reference: `vapi-review-refund:${order.id}`,
          onCreated: (transaction) => {
            database.recordCircleTransaction(order.id, "refund", transaction);
          },
        });
      }
      database.recordCircleTransaction(order.id, "refund", refund);
      this.requireCompletedCircleTransaction(order, "refund", refund);
      database.updateOrder(
        order.id,
        "refunded",
        {
          circleRefundId: refund.id,
          refundTransactionHash: refund.txHash,
          lastError: null,
        },
        "review_refunded",
        {
          payer: order.payer,
          amount: order.reviewPrice,
          circleTransactionId: refund.id,
          transactionHash: refund.txHash,
        },
      );
    } catch (error) {
      database.updateOrder(order.id, "expired", {
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  reconcileCircleNotification(payload: unknown): void {
    const id = extractString(payload, ["id", "transactionId"]);
    if (!id) return;
    const order = this.dependencies.database
      .listOrders()
      .find(
        (candidate) =>
          candidate.circlePayoutId === id ||
          candidate.circleResolutionId === id ||
          candidate.circleRefundId === id,
      );
    if (order) {
      this.dependencies.database.addEvent(order.id, "circle_webhook_received", {
        transactionId: id,
      });
      this.wakeOrder(order.id, "circle_webhook");
    }
  }

  private requireCompletedCircleTransaction(
    order: ReviewOrder,
    operation: CircleOperation,
    transaction: CircleTransactionResult,
  ): asserts transaction is CircleTransactionResult & { txHash: Hex } {
    if (transaction.state === "COMPLETE" && transaction.txHash) return;
    if (CIRCLE_TERMINAL_FAILURES.has(transaction.state)) {
      const retry = this.dependencies.database.rotateCircleAttempt(
        order.id,
        operation,
        transaction,
        this.dependencies.config.circleMaxAttempts,
      );
      if (!retry.rotated) {
        this.dependencies.database.addEvent(
          order.id,
          "circle_attempts_exhausted",
          {
            operation,
            terminalState: transaction.state,
            attempts: retry.attempts,
          },
        );
      }
      throw new Error(
        retry.rotated
          ? `Circle ${operation} ${transaction.id} ended ${transaction.state}; retry ${retry.attempts + 1}/${this.dependencies.config.circleMaxAttempts} scheduled`
          : `Circle ${operation} ${transaction.id} ended ${transaction.state}; maximum ${retry.attempts} attempts reached`,
      );
    }
    throw new Error(
      `Circle ${operation} ${transaction.id} is ${transaction.state}; awaiting confirmation`,
    );
  }
}

export function wakeReviewOrder(
  processor: Pick<ReviewProcessor, "processOrder">,
  orderId: string,
  source: string,
): void {
  void processor.processOrder(orderId).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "review_order_wake_failed",
        orderId,
        source,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

function extractString(
  value: unknown,
  keys: string[],
  depth = 0,
): string | undefined {
  if (depth > 4 || typeof value !== "object" || value === null)
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const found = extractString(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export const preflightHashes: { evidence: Hex; payout: Hex } = {
  evidence: PREFLIGHT_EVIDENCE_HASH,
  payout: PREFLIGHT_PAYOUT_HASH,
};
