import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import {
  createGatewayMiddleware,
  type PaymentRequest,
} from "@circle-fin/x402-batching/server";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { getAddress, isAddress, isHex, type Hex } from "viem";
import { z } from "zod";
import { MAX_DELIVERABLE_BYTES } from "../deliverables.js";
import { parseAIEvidence, verifyAIEvidence } from "../evidence.js";
import type { ReviewChain } from "./chain.js";
import type { CircleRail } from "./circle.js";
import {
  CircleWebhookKeyServiceError,
  createCircleWebhookVerifier,
  type CircleWebhookVerifier,
} from "./circle-webhook.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import type { DashboardSnapshotProcessor } from "./dashboard-snapshot.js";
import type { DemoController } from "./demo.js";
import { verifiedEscalationJob } from "./eligibility.js";
import { verifyHumanEvidence } from "./evidence.js";
import { parseGatewayPaymentReservation } from "./gateway.js";
import { wakeReviewOrder, type ReviewProcessor } from "./processor.js";
import { isTelegramUpdate, type TelegramGateway } from "./telegram.js";
import type {
  CircleOperation,
  HumanEvidenceV1,
  ReviewPayment,
  ValidatedReviewJob,
} from "./types.js";

const reviewOrderInputSchema = z
  .object({
    requestId: z.uuid(),
    jobId: z.string().regex(/^(0|[1-9]\d*)$/),
    deliverable: z
      .object({
        contentType: z.literal("text/plain"),
        content: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(value.deliverable.content, "utf8") >
      MAX_DELIVERABLE_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["deliverable", "content"],
        message: `deliverable exceeds ${MAX_DELIVERABLE_BYTES} UTF-8 bytes`,
      });
    }
  });

const aiEvidenceInputSchema = z
  .object({
    evidenceHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((value) => value as Hex),
    evidence: z.unknown(),
  })
  .strict();

const circleOperationResumeInputSchema = z
  .object({
    operation: z.enum(["payout", "resolution", "refund"]),
  })
  .strict();

const createDemoRunInputSchema = z
  .object({
    requestId: z.uuid(),
    scenario: z.literal("human-only"),
  })
  .strict();

type ReviewOrderInput = z.infer<typeof reviewOrderInputSchema>;

interface ReviewRequest extends Request {
  parsedReviewOrder?: ReviewOrderInput;
  validatedReviewJob?: ValidatedReviewJob;
  rawBody?: Buffer;
  payment?: PaymentRequest["payment"];
  reviewReservationToken?: string;
  precreatedReviewOrder?: {
    orderId: string;
    created: boolean;
  };
}

export interface ReviewAppDependencies {
  config: ReviewServiceConfig;
  database: ReviewDatabase;
  chain?: ReviewChain;
  circle?: CircleRail;
  telegram?: TelegramGateway;
  processor: ReviewProcessor;
  dashboardSnapshotProcessor?: DashboardSnapshotProcessor;
  demo?: DemoController;
  paymentMiddleware?: RequestHandler;
  circleWebhookVerifier?: CircleWebhookVerifier;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorBody(code: string, message: string, details?: unknown): object {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function wrap(
  handler: (
    request: ReviewRequest,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request as ReviewRequest, response, next).catch(next);
  };
}

export function createX402PaymentMiddleware(
  config: ReviewServiceConfig,
): RequestHandler {
  if (!config.sellerAddress) {
    return (_request, response) => {
      response
        .status(503)
        .json(
          errorBody(
            "x402_not_configured",
            "X402_SELLER_ADDRESS is required to purchase a review",
          ),
        );
    };
  }
  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: [config.gatewayNetwork],
    facilitatorUrl: config.gatewayUrl,
    description: "Paid human review for an escalated vAPI escrow",
  });
  return gateway.require(
    config.reviewPriceDisplay,
  ) as unknown as RequestHandler;
}

function createDurableX402PaymentMiddleware(
  config: ReviewServiceConfig,
  database: ReviewDatabase,
): RequestHandler {
  if (!config.sellerAddress) return createX402PaymentMiddleware(config);
  const requests = new AsyncLocalStorage<ReviewRequest>();
  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: [config.gatewayNetwork],
    facilitatorUrl: config.gatewayUrl,
    description: "Paid human review for an escalated vAPI escrow",
  });
  gateway.onBeforeSettle(async ({ paymentPayload, requirements }) => {
    const request = requests.getStore();
    const reservationToken = request?.reviewReservationToken;
    if (!request || !reservationToken) {
      return {
        abort: true,
        reason: "durable_review_reservation_missing",
        message: "The review payment could not be journaled before settlement",
      };
    }
    try {
      database.markGatewaySettlementAttempt(
        reservationToken,
        paymentPayload as unknown as Record<string, unknown>,
        requirements as unknown as Record<string, unknown>,
      );
    } catch {
      return {
        abort: true,
        reason: "durable_review_reservation_failed",
        message: "The review payment could not be journaled before settlement",
      };
    }
  });
  gateway.onAfterSettle(async ({ result, requirements, paymentPayload }) => {
    const request = requests.getStore();
    const input = request?.parsedReviewOrder;
    const job = request?.validatedReviewJob;
    const reservationToken = request?.reviewReservationToken;
    const authorization = paymentPayload.payload.authorization;
    const authorizationPayer =
      typeof authorization === "object" &&
      authorization !== null &&
      "from" in authorization &&
      typeof authorization.from === "string"
        ? authorization.from
        : undefined;
    const payer = result.payer ?? authorizationPayer;
    if (
      !result.success ||
      !result.transaction?.trim() ||
      !request ||
      !input ||
      !job ||
      !reservationToken ||
      !payer ||
      !isAddress(payer)
    ) {
      return;
    }
    const payment = validatePayment(
      {
        verified: true,
        payer,
        amount: requirements.amount,
        network: result.network,
        transaction: result.transaction,
      },
      config,
    );
    database.recordReviewReservationSettlement(reservationToken, payment);
    const created = database.promoteReviewReservation(reservationToken);
    if (!created) {
      throw new Error("settled review payment could not be promoted");
    }
    request.precreatedReviewOrder = {
      orderId: created.order.id,
      created: created.created,
    };
  });
  const middleware = gateway.require(
    config.reviewPriceDisplay,
  ) as unknown as RequestHandler;
  return (request, response, next) => {
    requests.run(request as ReviewRequest, () => {
      void Promise.resolve(middleware(request, response, next)).catch(next);
    });
  };
}

export function createReviewApp(dependencies: ReviewAppDependencies) {
  const { config, database, chain, telegram, processor } = dependencies;
  const circleWebhookVerifier =
    dependencies.circleWebhookVerifier ??
    createCircleWebhookVerifier(config.circleApiKey);
  const app = express();
  app.disable("x-powered-by");
  // Railway terminates HTTP at one trusted proxy hop. This keeps per-client
  // purchase/webhook limits from collapsing into one shared proxy address.
  app.set("trust proxy", 1);
  app.use(
    express.json({
      // JSON escaping can make a valid 32 KiB text deliverable materially
      // larger on the wire, so keep the transport ceiling above the decoded
      // UTF-8 limit enforced by reviewOrderInputSchema.
      limit: "128kb",
      verify(request, _response, buffer) {
        (request as ReviewRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get(
    "/health",
    wrap(async (_request, response) => {
      const configured = {
        chain: Boolean(chain),
        x402: Boolean(config.sellerAddress),
        telegram: Boolean(telegram && config.telegramWebhookSecret),
        circle: Boolean(
          dependencies.circle &&
          config.circleApiKey &&
          config.circleEntitySecret &&
          config.circleWalletId &&
          config.circleWalletAddress,
        ),
        internalApi: Boolean(config.internalToken),
        council: database.listReviewers(true).length > 0,
      };
      let treasury:
        | { ready: true; balance: string; minimum: string }
        | { ready: false; error: string } = {
        ready: false,
        error: "Circle treasury is not configured",
      };
      if (dependencies.circle?.checkTreasuryBalance) {
        try {
          const balance = await dependencies.circle.checkTreasuryBalance();
          const required = requiredTreasuryBalance(database, config);
          treasury =
            BigInt(balance.balance) >= required
              ? {
                  ready: true,
                  balance: balance.balance,
                  minimum: required.toString(),
                }
              : {
                  ready: false,
                  error: `Circle treasury has ${balance.balance} USDC base units; ${required.toString()} required for current obligations and one new review`,
                };
        } catch (error) {
          treasury = {
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const ready = Object.values(configured).every(Boolean) && treasury.ready;
      response.status(ready ? 200 : 503).json({
        status: ready ? "ok" : "degraded",
        service: "vapi-human-review-exchange",
        network: config.gatewayNetwork,
        configured,
        treasury,
      });
    }),
  );

  app.get("/openapi.json", (_request, response) => {
    response.json(openApiDocument(config));
  });

  app.post(
    "/internal/ai-evidence",
    requireInternalToken(config),
    wrap(async (request, response) => {
      const input = aiEvidenceInputSchema.safeParse(request.body);
      if (!input.success) {
        response
          .status(400)
          .json(
            errorBody(
              "invalid_ai_evidence",
              "Invalid AI evidence handoff",
              input.error.issues,
            ),
          );
        return;
      }
      const idempotencyKey = request.header("idempotency-key");
      if (
        idempotencyKey &&
        idempotencyKey.toLowerCase() !== input.data.evidenceHash.toLowerCase()
      ) {
        response
          .status(400)
          .json(
            errorBody(
              "invalid_ai_evidence_idempotency_key",
              "Idempotency-Key must equal the canonical evidence hash",
            ),
          );
        return;
      }
      try {
        const stored = database.storeAIEvidence(
          input.data.evidenceHash,
          input.data.evidence,
        );
        response.status(stored.created ? 201 : 200).json({
          evidenceHash: stored.evidence.evidenceHash,
          stored: true,
          duplicate: !stored.created,
        });
      } catch (error) {
        response
          .status(400)
          .json(
            errorBody(
              "invalid_ai_evidence",
              error instanceof Error
                ? error.message
                : "AI evidence validation failed",
            ),
          );
      }
    }),
  );

  app.get(
    "/internal/dashboard-chain-snapshot",
    requireInternalToken(config),
    wrap(async (_request, response) => {
      response
        .set("cache-control", "no-store")
        .json(
          dependencies.dashboardSnapshotProcessor?.getSnapshot() ??
            fallbackDashboardSnapshot(config, database),
        );
    }),
  );

  app.get(
    "/v1/review-orders/:orderId",
    wrap(async (request, response) => {
      const rawOrderId = request.params.orderId;
      const orderId = Array.isArray(rawOrderId)
        ? (rawOrderId[0] ?? "")
        : (rawOrderId ?? "");
      const order = database.getOrder(orderId);
      if (!order) {
        response
          .status(404)
          .json(errorBody("order_not_found", "Review order was not found"));
        return;
      }
      response.json(database.publicOrder(order, config.publicBaseUrl));
    }),
  );

  app.get(
    "/v1/evidence/:evidenceHash",
    wrap(async (request, response) => {
      const hash = request.params.evidenceHash ?? "";
      if (!isHex(hash) || hash.length !== 66) {
        response
          .status(400)
          .json(errorBody("invalid_evidence_hash", "Invalid evidence hash"));
        return;
      }
      const stored = database.getEvidence(hash as Hex);
      if (!stored) {
        response
          .status(404)
          .json(errorBody("evidence_not_found", "Evidence was not found"));
        return;
      }
      const rawEvidence = JSON.parse(stored.evidenceJson) as unknown;
      const evidence =
        stored.type === "ai-v1"
          ? parseAIEvidence(rawEvidence)
          : (rawEvidence as HumanEvidenceV1);
      const verified =
        stored.type === "ai-v1"
          ? verifyAIEvidence(evidence, stored.evidenceHash)
          : verifyHumanEvidence(
              evidence as HumanEvidenceV1,
              stored.evidenceHash,
            );
      response.status(verified ? 200 : 500).json({
        evidenceHash: stored.evidenceHash,
        verified,
        evidence,
      });
    }),
  );

  app.get(
    "/v1/reviewers/:address",
    wrap(async (request, response) => {
      const rawAddress = request.params.address;
      const address = Array.isArray(rawAddress)
        ? (rawAddress[0] ?? "")
        : (rawAddress ?? "");
      if (!isAddress(address)) {
        response
          .status(400)
          .json(errorBody("invalid_address", "Invalid reviewer address"));
        return;
      }
      const requestedAddress = getAddress(address);
      const reviewer = database.getReviewerByAddress(requestedAddress);
      if (!reviewer) {
        response
          .status(404)
          .json(errorBody("reviewer_not_found", "Reviewer was not found"));
        return;
      }
      const completed = database
        .listOrders()
        .filter(
          (order) =>
            order.reviewerPayoutAddress?.toLowerCase() ===
              requestedAddress.toLowerCase() && order.verdictAt !== null,
        );
      const latestSnapshot = completed.at(0);
      const isCurrentAddress =
        reviewer.payoutAddress.toLowerCase() === requestedAddress.toLowerCase();
      const paid = completed.filter((order) => order.paidAt !== null);
      const responseTimes = completed
        .filter((order) => order.claimedAt !== null && order.verdictAt !== null)
        .map(
          (order) =>
            (Date.parse(order.verdictAt!) - Date.parse(order.claimedAt!)) /
            1_000,
        );
      response.json({
        reviewer: {
          alias: latestSnapshot?.reviewerAlias ?? reviewer.alias,
          address: requestedAddress,
          skills: isCurrentAddress ? reviewer.skills : [],
          active: isCurrentAddress && reviewer.active,
          completedReviews: completed.length,
          approvals: completed.filter((order) => order.decision === "approve")
            .length,
          rejections: completed.filter((order) => order.decision === "reject")
            .length,
          totalRewards: completed
            .filter((order) => order.paidAt !== null)
            .reduce((sum, order) => sum + BigInt(order.reward), 0n)
            .toString(),
          paidReviews: paid.length,
          onChainSettledReviews: completed.filter(
            (order) => order.state === "settled",
          ).length,
          averageResponseSeconds:
            responseTimes.length === 0
              ? null
              : Math.round(
                  responseTimes.reduce((sum, seconds) => sum + seconds, 0) /
                    responseTimes.length,
                ),
          reviews: completed.map((order) =>
            database.publicOrder(order, config.publicBaseUrl),
          ),
        },
      });
    }),
  );

  app.get(
    "/internal/review-orders",
    requireInternalToken(config),
    wrap(async (request, response) => {
      const rawJobIds =
        typeof request.query.jobIds === "string"
          ? request.query.jobIds.split(",").filter(Boolean)
          : undefined;
      if (rawJobIds?.some((jobId) => !/^(0|[1-9]\d*)$/.test(jobId))) {
        response
          .status(400)
          .json(errorBody("invalid_job_ids", "jobIds must be decimal IDs"));
        return;
      }
      const orders = database
        .listOrders(rawJobIds)
        .map((order) => database.internalOrder(order, config.publicBaseUrl));
      response.json({ orders });
    }),
  );

  app.get(
    "/internal/demo/readiness",
    requireInternalToken(config),
    wrap(async (request, response) => {
      if (!dependencies.demo) {
        response.status(503).json(
          errorBody(
            "demo_not_configured",
            "The live demo orchestrator is not configured",
          ),
        );
        return;
      }
      response.set("cache-control", "no-store").json({
        readiness: await dependencies.demo.readiness(),
      });
    }),
  );

  app.post(
    "/internal/demo-runs",
    requireInternalToken(config),
    wrap(async (request, response) => {
      if (!dependencies.demo) {
        response.status(503).json(
          errorBody(
            "demo_not_configured",
            "The live demo orchestrator is not configured",
          ),
        );
        return;
      }
      const parsed = createDemoRunInputSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json(
          errorBody(
            "invalid_demo_run_request",
            "requestId must be a UUID and scenario must be human-only",
            parsed.error.issues,
          ),
        );
        return;
      }
      const { run } = await dependencies.demo.createRun(parsed.data.requestId);
      response.status(202).set("cache-control", "no-store").json({
        runId: run.id,
        state: run.state,
        statusUrl: `${config.publicBaseUrl}/internal/demo-runs/${run.id}`,
      });
    }),
  );

  app.get(
    "/internal/demo-runs/latest",
    requireInternalToken(config),
    wrap(async (request, response) => {
      if (!dependencies.demo) {
        response.status(503).json(
          errorBody(
            "demo_not_configured",
            "The live demo orchestrator is not configured",
          ),
        );
        return;
      }
      response
        .set("cache-control", "no-store")
        .json({
          run: dependencies.demo.latest(
            request.query.terminal === "true",
          ),
        });
    }),
  );

  app.get(
    "/internal/demo-runs/:runId",
    requireInternalToken(config),
    wrap(async (request, response) => {
      if (!dependencies.demo) {
        response.status(503).json(
          errorBody(
            "demo_not_configured",
            "The live demo orchestrator is not configured",
          ),
        );
        return;
      }
      const runId = demoRunId(request, response);
      if (!runId) return;
      const run = dependencies.demo.getRun(runId);
      if (!run) {
        response
          .status(404)
          .json(errorBody("demo_run_not_found", "Demo run was not found"));
        return;
      }
      response.set("cache-control", "no-store").json({ run });
    }),
  );

  for (const action of ["purchase", "retry", "archive"] as const) {
    app.post(
      `/internal/demo-runs/:runId/${action}`,
      requireInternalToken(config),
      wrap(async (request, response) => {
        if (!dependencies.demo) {
          response.status(503).json(
            errorBody(
              "demo_not_configured",
              "The live demo orchestrator is not configured",
            ),
          );
          return;
        }
        const runId = demoRunId(request, response);
        if (!runId) return;
        const run =
          action === "purchase"
            ? dependencies.demo.purchase(runId)
            : action === "retry"
              ? dependencies.demo.retry(runId)
              : dependencies.demo.archive(runId);
        response.status(202).set("cache-control", "no-store").json({ run });
      }),
    );
  }

  app.post(
    "/internal/review-orders/:orderId/resume",
    requireInternalToken(config),
    wrap(async (request, response) => {
      const rawOrderId = request.params.orderId;
      const orderId = Array.isArray(rawOrderId)
        ? (rawOrderId[0] ?? "")
        : (rawOrderId ?? "");
      if (!z.uuid().safeParse(orderId).success) {
        response
          .status(400)
          .json(errorBody("invalid_order_id", "orderId must be a UUID"));
        return;
      }
      const parsed = circleOperationResumeInputSchema.safeParse(request.body);
      if (!parsed.success) {
        response
          .status(400)
          .json(
            errorBody(
              "invalid_circle_resume_request",
              "operation must be payout, resolution, or refund",
              parsed.error.flatten(),
            ),
          );
        return;
      }
      const operation: CircleOperation = parsed.data.operation;
      const order = database.resumeCircleOperation(
        orderId,
        operation,
        config.circleMaxAttempts,
      );
      response.status(202).json({
        orderId: order.id,
        operation,
        state: order.state,
      });
      wakeReviewOrder(processor, order.id, "circle_operator_resume");
    }),
  );

  app.post(
    "/v1/telegram/webhook",
    requireTelegramSecret(config),
    wrap(async (request, response) => {
      if (!telegram) {
        response
          .status(503)
          .json(
            errorBody("telegram_not_configured", "Telegram is not configured"),
          );
        return;
      }
      if (!isTelegramUpdate(request.body)) {
        response
          .status(400)
          .json(
            errorBody("invalid_telegram_update", "Invalid Telegram update"),
          );
        return;
      }
      const reservation = database.reserveTelegramUpdate(
        request.body.update_id,
      );
      if (reservation.status === "processed") {
        response.status(200).json({ accepted: true, duplicate: true });
        return;
      }
      if (reservation.status === "processing") {
        response
          .status(503)
          .json(
            errorBody(
              "telegram_update_processing",
              "Telegram update is already being processed",
            ),
          );
        return;
      }
      try {
        await telegram.handleUpdate(request.body);
        database.completeTelegramUpdate(
          request.body.update_id,
          reservation.token,
        );
      } catch (error) {
        database.failTelegramUpdate(
          request.body.update_id,
          reservation.token,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      response.status(202).json({ accepted: true });
    }),
  );

  app.post(
    "/v1/circle/webhook",
    fixedWindowRateLimit(60, 60_000),
    requireCircleSignature(circleWebhookVerifier),
    wrap(async (request, response) => {
      processor.reconcileCircleNotification(request.body);
      response.status(202).json({ accepted: true });
    }),
  );

  const paymentMiddleware =
    dependencies.paymentMiddleware ??
    createDurableX402PaymentMiddleware(config, database);
  app.post(
    "/v1/review-orders",
    parseReviewInput,
    returnExistingOrder(database, config),
    fixedWindowRateLimit(10, 60_000, {
      code: "review_purchase_rate_limited",
      message: "Too many review purchase attempts",
    }),
    requirePaidPathConfigured(dependencies),
    prevalidateReview(chain, database),
    requireEligibleReviewer(dependencies),
    reserveReviewOrder(database, config),
    requireTreasuryReady(dependencies),
    paymentMiddleware,
    wrap(async (request, response) => {
      const input = request.parsedReviewOrder;
      const job = request.validatedReviewJob;
      if (!input || !job) throw new Error("review prevalidation was skipped");
      const precreated = request.precreatedReviewOrder
        ? database.getOrder(request.precreatedReviewOrder.orderId)
        : undefined;
      const result = precreated
        ? {
            order: precreated,
            created: request.precreatedReviewOrder?.created ?? false,
          }
        : (() => {
            const recovered = request.reviewReservationToken
              ? database.promoteReviewReservation(
                  request.reviewReservationToken,
                )
              : undefined;
            if (recovered) return recovered;
            if (!dependencies.paymentMiddleware) {
              const error = new Error(
                "Gateway settlement is awaiting durable reconciliation",
              ) as Error & { statusCode: number; code: string };
              error.statusCode = 503;
              error.code = "payment_reconciliation_pending";
              throw error;
            }
            const payment = validatePayment(request.payment, config);
            return database.createOrder({
              requestId: input.requestId,
              deliverableContent: input.deliverable.content,
              job,
              payment,
              reviewPrice: config.reviewPrice,
              reward: config.reviewerReward,
            });
          })();
      const publicOrder = database.publicOrder(
        result.order,
        config.publicBaseUrl,
      );
      response.status(result.created ? 202 : 200).json({
        orderId: result.order.id,
        state: result.order.state,
        statusUrl: publicOrder.statusUrl,
      });
      if (result.created) {
        wakeReviewOrder(processor, result.order.id, "paid_order_created");
      }
    }),
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "internal_error";
    const details =
      typeof error === "object" && error !== null && "details" in error
        ? error.details
        : undefined;
    response
      .status(statusCode)
      .json(
        errorBody(
          code,
          statusCode === 500
            ? "Internal review service error"
            : error instanceof Error
              ? error.message
              : String(error),
          details,
        ),
      );
  };
  app.use(errorHandler);
  return app;
}

function demoRunId(request: Request, response: Response): string | undefined {
  const raw = request.params.runId;
  const runId = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (!z.uuid().safeParse(runId).success) {
    response
      .status(400)
      .json(errorBody("invalid_demo_run_id", "runId must be a UUID"));
    return undefined;
  }
  return runId;
}

function fallbackDashboardSnapshot(
  config: ReviewServiceConfig,
  database: ReviewDatabase,
) {
  const stored = database.getDashboardChainSnapshot();
  if (stored) return stored;
  const configured = Boolean(config.routerAddress);
  return {
    version: 1,
    configured,
    status: configured ? "syncing" : "degraded",
    latestBlock: null,
    indexedAt: null,
    lastAttemptAt: null,
    lastError: configured ? null : "ROUTER_ADDRESS is not configured",
    feed: [],
    reviewQueue: [],
  };
}

const parseReviewInput: RequestHandler = (request, response, next) => {
  const parsed = reviewOrderInputSchema.safeParse(request.body);
  if (!parsed.success) {
    response
      .status(400)
      .json(
        errorBody(
          "invalid_review_request",
          "Invalid review order request",
          parsed.error.issues,
        ),
      );
    return;
  }
  (request as ReviewRequest).parsedReviewOrder = parsed.data;
  next();
};

function returnExistingOrder(
  database: ReviewDatabase,
  config: ReviewServiceConfig,
): RequestHandler {
  return (request, response, next) => {
    const input = (request as ReviewRequest).parsedReviewOrder!;
    const existing = database.findOrderByRequestOrJob(
      input.requestId,
      input.jobId,
    );
    if (!existing) {
      next();
      return;
    }
    const order = database.publicOrder(existing, config.publicBaseUrl);
    response.status(200).json({
      orderId: existing.id,
      state: existing.state,
      statusUrl: order.statusUrl,
    });
  };
}

function prevalidateReview(
  chain: ReviewChain | undefined,
  database: ReviewDatabase,
): RequestHandler {
  const inFlight = new Map<string, Promise<ValidatedReviewJob>>();
  return wrap(async (request, response, next) => {
    if (!chain) {
      response
        .status(503)
        .json(
          errorBody(
            "chain_not_configured",
            "ROUTER_ADDRESS is required to validate review jobs",
          ),
        );
      return;
    }
    const input = request.parsedReviewOrder!;
    const key = `${input.jobId}:${Buffer.from(
      input.deliverable.content,
      "utf8",
    ).toString("base64url")}`;
    let validation = inFlight.get(key);
    if (!validation) {
      validation = chain.validateReview(input.jobId, input.deliverable.content);
      inFlight.set(key, validation);
    }
    try {
      request.validatedReviewJob = verifiedEscalationJob(
        database,
        await validation,
      );
    } finally {
      if (inFlight.get(key) === validation) inFlight.delete(key);
    }
    next();
  });
}

function requireEligibleReviewer(
  dependencies: ReviewAppDependencies,
): RequestHandler {
  return (request, response, next) => {
    if (dependencies.paymentMiddleware) {
      next();
      return;
    }
    const job = (request as ReviewRequest).validatedReviewJob;
    if (!job) {
      response
        .status(503)
        .json(
          errorBody(
            "review_prevalidation_missing",
            "Review prevalidation did not complete",
          ),
        );
      return;
    }
    if (
      dependencies.database.listEligibleReviewers(
        job.client,
        job.provider,
        dependencies.config.circleWalletAddress
          ? [dependencies.config.circleWalletAddress]
          : [],
      )
        .length === 0
    ) {
      response
        .status(503)
        .json(
          errorBody(
            "no_eligible_reviewer",
            "No active non-conflicted auditor is currently available",
          ),
        );
      return;
    }
    next();
  };
}

function requirePaidPathConfigured(
  dependencies: ReviewAppDependencies,
): RequestHandler {
  return (_request, response, next) => {
    // Unit/integration tests can inject a deterministic payment adapter. The
    // live x402 route must fail before payment unless every fulfillment rail is
    // configured.
    if (dependencies.paymentMiddleware) {
      next();
      return;
    }
    const { config, chain, circle, telegram } = dependencies;
    const ready = Boolean(
      chain &&
      circle &&
      telegram &&
      config.sellerAddress &&
      config.circleApiKey &&
      config.circleEntitySecret &&
      config.circleWalletId &&
      config.circleWalletAddress &&
      config.routerAddress &&
      circle.checkTreasuryBalance,
    );
    if (!ready) {
      response
        .status(503)
        .json(
          errorBody(
            "review_fulfillment_not_ready",
            "Human review fulfillment is not fully configured",
          ),
        );
      return;
    }
    next();
  };
}

function requireTreasuryReady(
  dependencies: ReviewAppDependencies,
): RequestHandler {
  return wrap(async (request, response, next) => {
    if (dependencies.paymentMiddleware) {
      next();
      return;
    }
    const { circle, config, database } = dependencies;
    try {
      const balance = await circle!.checkTreasuryBalance!();
      if (
        BigInt(balance.balance) <
        requiredTreasuryBalance(
          database,
          config,
          request.reviewReservationToken,
        )
      ) {
        throw new Error("treasury balance is below outstanding obligations");
      }
    } catch {
      response
        .status(503)
        .json(
          errorBody(
            "review_treasury_not_ready",
            "Human review treasury liquidity is temporarily unavailable",
          ),
        );
      return;
    }
    next();
  });
}

export function requiredTreasuryBalance(
  database: ReviewDatabase,
  config: ReviewServiceConfig,
  reservationToken?: string,
): bigint {
  const activeLiability = database.listOrders().reduce((sum, order) => {
    switch (order.state) {
      case "paid":
      case "dispatched":
      case "claimed":
      case "verdict_submitted":
      case "payout_failed":
        return sum + BigInt(order.reviewPrice) + BigInt(order.reward);
      case "reviewer_paid":
      case "reviewer_paid_settlement_failed":
      case "expired":
        return sum + BigInt(order.reviewPrice);
      default:
        return sum;
    }
  }, 0n);
  const reservationLiability =
    database.reviewReservationLiabilityThrough(reservationToken);
  const nextReviewLiability =
    BigInt(config.reviewPrice) + BigInt(config.reviewerReward);
  const obligations =
    activeLiability +
    reservationLiability +
    (reservationToken ? 0n : nextReviewLiability);
  const configuredFloor = BigInt(config.minimumTreasuryBalance);
  return obligations > configuredFloor ? obligations : configuredFloor;
}

function reserveReviewOrder(
  database: ReviewDatabase,
  config: ReviewServiceConfig,
): RequestHandler {
  return (request, response, next) => {
    const reviewRequest = request as ReviewRequest;
    const input = reviewRequest.parsedReviewOrder!;
    let gatewayPayment;
    try {
      gatewayPayment = parseGatewayPaymentReservation(
        request.header("payment-signature"),
        config,
      );
    } catch (error) {
      response
        .status(400)
        .json(
          errorBody(
            "invalid_payment_signature",
            error instanceof Error
              ? error.message
              : "Invalid Payment-Signature header",
          ),
        );
      return;
    }
    const reservation = database.acquireReviewReservation(
      input.requestId,
      input.jobId,
      {
        request: input,
        validatedJob: reviewRequest.validatedReviewJob,
      },
      gatewayPayment,
      {
        reviewPrice: config.reviewPrice,
        reward: config.reviewerReward,
        network: config.gatewayNetwork,
      },
    );
    if (reservation.status === "existing") {
      const order = database.publicOrder(
        reservation.order,
        config.publicBaseUrl,
      );
      response.status(200).json({
        orderId: reservation.order.id,
        state: reservation.order.state,
        statusUrl: order.statusUrl,
      });
      return;
    }
    if (reservation.status === "busy") {
      response
        .status(409)
        .set("retry-after", "2")
        .json(
          errorBody(
            "review_order_in_progress",
            "An identical review purchase is already in progress",
          ),
        );
      return;
    }

    reviewRequest.reviewReservationToken = reservation.token;
    let released = false;
    const release = (): void => {
      if (released) return;
      if (
        reviewRequest.payment?.verified &&
        !database.findOrderByRequestOrJob(input.requestId, input.jobId)
      ) {
        // Gateway settled but order persistence failed. Leave the durable
        // intent locked for operator reconciliation instead of admitting a
        // second payment.
        return;
      }
      released = true;
      database.releaseReviewReservation(reservation.token);
    };
    response.once("finish", release);
    next();
  };
}

function validatePayment(
  payment: PaymentRequest["payment"],
  config: ReviewServiceConfig,
): ReviewPayment {
  if (!payment?.verified || !isAddress(payment.payer)) {
    const error = new Error("A verified x402 payment is required") as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 402;
    error.code = "payment_required";
    throw error;
  }
  if (
    !/^\d+$/.test(payment.amount) ||
    BigInt(payment.amount) !== BigInt(config.reviewPrice) ||
    payment.network !== config.gatewayNetwork ||
    !payment.transaction?.trim()
  ) {
    const error = new Error(
      "x402 payment amount or network does not match this review",
    ) as Error & { statusCode: number; code: string };
    error.statusCode = 402;
    error.code = "invalid_payment";
    throw error;
  }
  return {
    verified: true,
    payer: getAddress(payment.payer),
    amount: payment.amount,
    network: payment.network,
    transaction: payment.transaction,
  };
}

function requireInternalToken(config: ReviewServiceConfig): RequestHandler {
  return (request, response, next) => {
    if (!config.internalToken) {
      response
        .status(503)
        .json(
          errorBody(
            "internal_api_not_configured",
            "REVIEW_INTERNAL_TOKEN is not configured",
          ),
        );
      return;
    }
    const expected = `Bearer ${config.internalToken}`;
    const actual = request.header("authorization") ?? "";
    if (!safeEqual(actual, expected)) {
      response
        .status(401)
        .json(errorBody("unauthorized", "Invalid internal API token"));
      return;
    }
    next();
  };
}

function requireTelegramSecret(config: ReviewServiceConfig): RequestHandler {
  return (request, response, next) => {
    if (!config.telegramWebhookSecret) {
      response
        .status(503)
        .json(
          errorBody(
            "telegram_webhook_not_configured",
            "TELEGRAM_WEBHOOK_SECRET is not configured",
          ),
        );
      return;
    }
    const actual = request.header("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(actual, config.telegramWebhookSecret)) {
      response
        .status(401)
        .json(errorBody("invalid_telegram_secret", "Invalid Telegram secret"));
      return;
    }
    next();
  };
}

function requireCircleSignature(
  verifier: CircleWebhookVerifier | undefined,
): RequestHandler {
  return wrap(async (request, response, next) => {
    if (!verifier) {
      response
        .status(503)
        .json(
          errorBody(
            "circle_webhook_not_configured",
            "CIRCLE_API_KEY is required to verify Circle webhooks",
          ),
        );
      return;
    }
    const signature = request.header("x-circle-signature");
    const keyId = request.header("x-circle-key-id");
    const rawBody = (request as ReviewRequest).rawBody;
    if (!signature || !keyId || !rawBody) {
      response
        .status(401)
        .json(
          errorBody("invalid_circle_signature", "Missing Circle signature"),
        );
      return;
    }
    try {
      if (
        !(await verifier.verify({
          keyId,
          signature,
          body: rawBody,
        }))
      ) {
        throw new Error("signature mismatch");
      }
    } catch (error) {
      if (error instanceof CircleWebhookKeyServiceError) {
        response
          .status(503)
          .json(
            errorBody(
              "circle_key_service_unavailable",
              "Circle webhook verification is temporarily unavailable",
            ),
          );
        return;
      }
      response
        .status(401)
        .json(
          errorBody("invalid_circle_signature", "Invalid Circle signature"),
        );
      return;
    }
    next();
  });
}

function fixedWindowRateLimit(
  limit: number,
  windowMs: number,
  responseDetails: {
    code: string;
    message: string;
  } = {
    code: "rate_limited",
    message: "Too many Circle webhook verification attempts",
  },
): RequestHandler {
  const clients = new Map<string, { count: number; resetsAt: number }>();
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const current = clients.get(key);
    if (!current || current.resetsAt <= now) {
      if (clients.size >= 1_000) {
        for (const [candidate, state] of clients) {
          if (state.resetsAt <= now) clients.delete(candidate);
        }
        if (clients.size >= 1_000) {
          const oldest = clients.keys().next().value as string | undefined;
          if (oldest) clients.delete(oldest);
        }
      }
      clients.set(key, { count: 1, resetsAt: now + windowMs });
      next();
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      response
        .status(429)
        .set("retry-after", String(Math.ceil((current.resetsAt - now) / 1_000)))
        .json(errorBody(responseDetails.code, responseDetails.message));
      return;
    }
    next();
  };
}

export function openApiDocument(config: ReviewServiceConfig): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "vAPI Human Review Exchange",
      version: "1.0.0",
      description:
        "Accountless paid human review and Arc settlement for escalated agentic work.",
    },
    servers: [{ url: config.publicBaseUrl }],
    tags: [
      {
        name: "Reviews",
        description: "Purchase and poll human reviews.",
      },
      {
        name: "Evidence",
        description: "Public, hash-verifiable review provenance.",
      },
      {
        name: "Reviewers",
        description: "Objective reviewer history and payout statistics.",
      },
      {
        name: "Webhooks",
        description: "Authenticated Telegram and Circle callbacks.",
      },
      {
        name: "Operations",
        description: "Service readiness and authenticated dashboard data.",
      },
    ],
    paths: {
      "/health": {
        get: {
          operationId: "getReviewServiceHealth",
          tags: ["Operations"],
          summary: "Check review-service and treasury readiness",
          responses: {
            "200": {
              description: "All paid-review rails are ready",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
            "503": {
              description: "One or more paid-review rails are degraded",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          tags: ["Operations"],
          summary: "Retrieve this OpenAPI document",
          responses: {
            "200": {
              description: "OpenAPI 3.1 service description",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/v1/review-orders": {
        post: {
          operationId: "createReviewOrder",
          tags: ["Reviews"],
          summary: "Purchase a human review",
          description: `Prevalidates the Arc job before charging. A new order requires an x402 payment of ${config.reviewPriceDisplay} USDC on Arc Testnet; replaying an existing request ID or job ID returns the existing order without another charge.`,
          security: [{ X402Payment: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateReviewOrder" },
              },
            },
          },
          responses: {
            "200": {
              description:
                "An existing order matched the request ID or job ID; no new payment was taken",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReviewOrderReceipt" },
                },
              },
            },
            "202": {
              description: "Paid review accepted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReviewOrderReceipt" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "402": {
              description:
                "A valid x402 payment is required or the supplied payment does not match this quote",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
            "409": {
              description:
                "The job is ineligible, already has a purchase in progress, or cannot be reviewed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "422": {
              description:
                "The submitted content does not match the on-chain deliverable commitment",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/v1/review-orders/{orderId}": {
        get: {
          operationId: "getReviewOrder",
          tags: ["Reviews"],
          summary: "Poll review status",
          parameters: [{ $ref: "#/components/parameters/OrderId" }],
          responses: {
            "200": {
              description: "Public review status",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicReviewOrder" },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/evidence/{evidenceHash}": {
        get: {
          operationId: "getVersionedEvidence",
          tags: ["Evidence"],
          summary: "Retrieve and verify AI or human evidence",
          parameters: [{ $ref: "#/components/parameters/EvidenceHash" }],
          responses: {
            "200": {
              description:
                "Canonical versioned evidence and a successful local hash verification",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EvidenceResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/NotFound" },
            "500": {
              description: "Stored evidence failed canonical hash verification",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EvidenceResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/reviewers/{address}": {
        get: {
          operationId: "getReviewerProfile",
          tags: ["Reviewers"],
          summary: "Get objective reviewer history",
          parameters: [{ $ref: "#/components/parameters/ReviewerAddress" }],
          responses: {
            "200": {
              description: "Reviewer history and factual statistics",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReviewerResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/telegram/webhook": {
        post: {
          operationId: "receiveTelegramUpdate",
          tags: ["Webhooks"],
          summary: "Receive an auditor interaction from Telegram",
          description:
            "Accepts Telegram Bot API updates after validating Telegram's webhook secret. Update IDs are reserved durably to prevent callback replay.",
          security: [{ TelegramWebhookSecret: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelegramUpdate" },
              },
            },
          },
          responses: {
            "200": {
              description: "A previously completed update was acknowledged",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WebhookAccepted" },
                },
              },
            },
            "202": {
              description: "Update accepted and processed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WebhookAccepted" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/v1/circle/webhook": {
        post: {
          operationId: "receiveCircleNotification",
          tags: ["Webhooks"],
          summary: "Reconcile an asynchronous Circle transaction",
          description:
            "Validates both Circle webhook headers against the exact raw request body before passing the notification to the transaction reconciler.",
          security: [{ CircleSignature: [], CircleKeyId: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CircleNotification" },
              },
            },
          },
          responses: {
            "202": {
              description: "Notification accepted for reconciliation",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WebhookAccepted" },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "429": { $ref: "#/components/responses/RateLimited" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/internal/review-orders": {
        get: {
          operationId: "listInternalReviewOrders",
          tags: ["Operations"],
          summary: "List review orders for the operations dashboard",
          description:
            "Returns the internal dashboard feed. This route includes deliverable content and Circle transaction IDs and must not be exposed without its bearer token.",
          security: [{ InternalBearer: [] }],
          parameters: [
            {
              in: "query",
              name: "jobIds",
              required: false,
              description: "Comma-separated decimal Arc job IDs.",
              schema: {
                type: "string",
                pattern: "^(0|[1-9][0-9]*)(,(0|[1-9][0-9]*))*$",
              },
            },
          ],
          responses: {
            "200": {
              description: "Internal review orders",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["orders"],
                    properties: {
                      orders: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/InternalReviewOrder",
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/internal/review-orders/{orderId}/resume": {
        post: {
          operationId: "resumeExhaustedCircleOperation",
          tags: ["Operations"],
          summary: "Resume an exhausted Circle payout, resolution, or refund",
          description:
            "Rotates the current Circle idempotency key only after the configured terminal-attempt budget is exhausted, records an operator audit event, and wakes the background processor. The operation remains in its explicit recovery state until Circle confirms the retried transaction.",
          security: [{ InternalBearer: [] }],
          parameters: [{ $ref: "#/components/parameters/OrderId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["operation"],
                  properties: {
                    operation: {
                      type: "string",
                      enum: ["payout", "resolution", "refund"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description:
                "A new audited attempt window was opened and processing was woken",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["orderId", "operation", "state"],
                    properties: {
                      orderId: { type: "string", format: "uuid" },
                      operation: {
                        type: "string",
                        enum: ["payout", "resolution", "refund"],
                      },
                      state: {
                        $ref: "#/components/schemas/ReviewOrderState",
                      },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { $ref: "#/components/responses/Conflict" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/internal/ai-evidence": {
        post: {
          operationId: "storeAiDecisionEvidence",
          tags: ["Operations", "Evidence"],
          summary: "Store a judge's canonical AI decision evidence",
          description:
            "Internal idempotent handoff used by the judge before it submits an Arc settlement or escalation. The service strictly validates AIEvidenceV1 and its canonical hash; paid-review admission separately requires an eligible escalation reason.",
          security: [{ InternalBearer: [] }],
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              required: false,
              description:
                "When supplied, must equal the canonical evidence hash.",
              schema: { $ref: "#/components/schemas/Hash32" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StoreAIEvidence" },
              },
            },
          },
          responses: {
            "200": {
              description: "The exact evidence record was already stored",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/StoreAIEvidenceResponse",
                  },
                },
              },
            },
            "201": {
              description: "AI decision evidence stored",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/StoreAIEvidenceResponse",
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "503": { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        X402Payment: {
          type: "apiKey",
          in: "header",
          name: "Payment-Signature",
          description:
            "Circle Gateway x402 payment payload. An initial request without this header receives the payment requirements.",
        },
        TelegramWebhookSecret: {
          type: "apiKey",
          in: "header",
          name: "X-Telegram-Bot-Api-Secret-Token",
          description:
            "Secret configured when registering the Telegram webhook.",
        },
        CircleSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Circle-Signature",
          description: "Circle signature over the exact raw request body.",
        },
        CircleKeyId: {
          type: "apiKey",
          in: "header",
          name: "X-Circle-Key-Id",
          description: "Circle public-key identifier used for verification.",
        },
        InternalBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "The REVIEW_INTERNAL_TOKEN value.",
        },
      },
      parameters: {
        OrderId: {
          in: "path",
          name: "orderId",
          required: true,
          description: "Review order UUID.",
          schema: { type: "string", format: "uuid" },
        },
        EvidenceHash: {
          in: "path",
          name: "evidenceHash",
          required: true,
          description:
            "Keccak-256 hash of canonical AIEvidenceV1 or HumanEvidenceV1 JSON.",
          schema: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{64}$",
          },
        },
        ReviewerAddress: {
          in: "path",
          name: "address",
          required: true,
          description: "Auditor Arc payout address.",
          schema: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
          },
        },
      },
      responses: {
        BadRequest: {
          description: "Request validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        Unauthorized: {
          description: "Authentication or webhook signature validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        NotFound: {
          description: "The requested resource was not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        Conflict: {
          description:
            "The requested recovery action conflicts with current order state",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        RateLimited: {
          description: "Too many requests",
          headers: {
            "Retry-After": {
              description: "Seconds until another request may be attempted.",
              schema: { type: "integer", minimum: 1 },
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        ServiceUnavailable: {
          description:
            "The requested service rail is not configured or is temporarily unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
      schemas: {
        Address: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{40}$",
          description: "EVM address.",
        },
        Hash32: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{64}$",
          description: "32-byte hexadecimal value.",
        },
        BaseUnitAmount: {
          type: "string",
          pattern: "^(0|[1-9][0-9]*)$",
          description: "USDC amount in base units.",
        },
        Timestamp: {
          type: "string",
          format: "date-time",
        },
        NullableTimestamp: {
          anyOf: [{ $ref: "#/components/schemas/Timestamp" }, { type: "null" }],
        },
        NullableHash32: {
          anyOf: [{ $ref: "#/components/schemas/Hash32" }, { type: "null" }],
        },
        ReviewOrderState: {
          type: "string",
          enum: [
            "paid",
            "dispatched",
            "claimed",
            "verdict_submitted",
            "reviewer_paid",
            "settled",
            "expired",
            "refunded",
            "payout_failed",
            "reviewer_paid_settlement_failed",
          ],
        },
        ReviewDecision: {
          type: "string",
          enum: ["approve", "reject"],
        },
        ReasonCode: {
          type: "string",
          enum: [
            "policy_passed",
            "human_lane_requested",
            "model_output_invalid",
            "injection_suspected",
            "confidence_below_threshold",
            "budget_above_cap",
            "job_expired_or_near_expiry",
            "deliverable_missing",
            "deliverable_oversized",
            "deliverable_hash_mismatch",
          ],
        },
        ErrorResponse: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
        HealthResponse: {
          type: "object",
          additionalProperties: false,
          required: ["status", "service", "network", "configured", "treasury"],
          properties: {
            status: { type: "string", enum: ["ok", "degraded"] },
            service: { const: "vapi-human-review-exchange" },
            network: { type: "string" },
            configured: {
              type: "object",
              additionalProperties: false,
              required: [
                "chain",
                "x402",
                "telegram",
                "circle",
                "internalApi",
                "council",
              ],
              properties: {
                chain: { type: "boolean" },
                x402: { type: "boolean" },
                telegram: { type: "boolean" },
                circle: { type: "boolean" },
                internalApi: { type: "boolean" },
                council: { type: "boolean" },
              },
            },
            treasury: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["ready", "balance", "minimum"],
                  properties: {
                    ready: { const: true },
                    balance: { $ref: "#/components/schemas/BaseUnitAmount" },
                    minimum: { $ref: "#/components/schemas/BaseUnitAmount" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["ready", "error"],
                  properties: {
                    ready: { const: false },
                    error: { type: "string" },
                  },
                },
              ],
            },
          },
        },
        CreateReviewOrder: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "jobId", "deliverable"],
          properties: {
            requestId: { type: "string", format: "uuid" },
            jobId: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            deliverable: {
              type: "object",
              additionalProperties: false,
              required: ["contentType", "content"],
              properties: {
                contentType: { const: "text/plain" },
                content: {
                  type: "string",
                  description: `Maximum ${MAX_DELIVERABLE_BYTES} bytes after UTF-8 decoding.`,
                },
              },
            },
          },
        },
        ReviewOrderReceipt: {
          type: "object",
          additionalProperties: false,
          required: ["orderId", "state", "statusUrl"],
          properties: {
            orderId: { type: "string", format: "uuid" },
            state: { $ref: "#/components/schemas/ReviewOrderState" },
            statusUrl: { type: "string", format: "uri" },
          },
        },
        ReviewOrderBase: {
          type: "object",
          required: [
            "orderId",
            "requestId",
            "jobId",
            "state",
            "payer",
            "reviewPrice",
            "network",
            "gatewayTransaction",
            "deliverableHash",
            "escalationReasonHash",
            "escalationReasonCode",
            "escalationCause",
            "reviewer",
            "decision",
            "reasoning",
            "evidenceHash",
            "reward",
            "payoutTransactionHash",
            "resolutionTransactionHash",
            "refundTransactionHash",
            "createdAt",
            "claimedAt",
            "verdictAt",
            "paidAt",
            "settledAt",
            "settlementAbortCode",
            "settlementAbortedAt",
            "updatedAt",
            "lastError",
            "statusUrl",
            "evidenceUrl",
          ],
          properties: {
            orderId: { type: "string", format: "uuid" },
            requestId: { type: "string", format: "uuid" },
            jobId: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            state: { $ref: "#/components/schemas/ReviewOrderState" },
            payer: { $ref: "#/components/schemas/Address" },
            reviewPrice: { $ref: "#/components/schemas/BaseUnitAmount" },
            network: { type: "string" },
            gatewayTransaction: {
              anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
            },
            deliverableHash: { $ref: "#/components/schemas/Hash32" },
            escalationReasonHash: { $ref: "#/components/schemas/Hash32" },
            escalationReasonCode: {
              anyOf: [
                { $ref: "#/components/schemas/ReasonCode" },
                { type: "null" },
              ],
            },
            escalationCause: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            reviewer: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["alias", "address"],
                  properties: {
                    alias: { type: "string" },
                    address: { $ref: "#/components/schemas/Address" },
                  },
                },
                { type: "null" },
              ],
            },
            decision: {
              anyOf: [
                { $ref: "#/components/schemas/ReviewDecision" },
                { type: "null" },
              ],
            },
            reasoning: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            evidenceHash: {
              $ref: "#/components/schemas/NullableHash32",
            },
            reward: { $ref: "#/components/schemas/BaseUnitAmount" },
            payoutTransactionHash: {
              $ref: "#/components/schemas/NullableHash32",
            },
            resolutionTransactionHash: {
              $ref: "#/components/schemas/NullableHash32",
            },
            refundTransactionHash: {
              $ref: "#/components/schemas/NullableHash32",
            },
            createdAt: { $ref: "#/components/schemas/Timestamp" },
            claimedAt: { $ref: "#/components/schemas/NullableTimestamp" },
            verdictAt: { $ref: "#/components/schemas/NullableTimestamp" },
            paidAt: { $ref: "#/components/schemas/NullableTimestamp" },
            settledAt: { $ref: "#/components/schemas/NullableTimestamp" },
            settlementAbortCode: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            settlementAbortedAt: {
              $ref: "#/components/schemas/NullableTimestamp",
            },
            updatedAt: { $ref: "#/components/schemas/Timestamp" },
            lastError: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            statusUrl: { type: "string", format: "uri" },
            evidenceUrl: {
              anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
            },
          },
        },
        PublicReviewOrder: {
          allOf: [{ $ref: "#/components/schemas/ReviewOrderBase" }],
          unevaluatedProperties: false,
        },
        InternalReviewOrder: {
          allOf: [
            { $ref: "#/components/schemas/ReviewOrderBase" },
            {
              type: "object",
              required: [
                "jobDescription",
                "deliverableContent",
                "circlePayoutId",
                "circleResolutionId",
                "circleRefundId",
                "claimExpiresAt",
                "dispatchCount",
                "events",
                "evidenceVerified",
              ],
              properties: {
                jobDescription: { type: "string" },
                deliverableContent: { type: "string" },
                circlePayoutId: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
                circleResolutionId: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
                circleRefundId: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
                claimExpiresAt: {
                  $ref: "#/components/schemas/NullableTimestamp",
                },
                dispatchCount: { type: "integer", minimum: 0 },
                events: {
                  type: "array",
                  items: { $ref: "#/components/schemas/ReviewEvent" },
                },
                evidenceVerified: {
                  anyOf: [{ type: "boolean" }, { type: "null" }],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        ReviewEvent: {
          type: "object",
          additionalProperties: false,
          required: ["id", "orderId", "type", "payload", "createdAt"],
          properties: {
            id: { type: "integer", minimum: 1 },
            orderId: { type: "string", format: "uuid" },
            type: { type: "string" },
            payload: { type: "object", additionalProperties: true },
            createdAt: { $ref: "#/components/schemas/Timestamp" },
          },
        },
        AIVerdict: {
          type: "object",
          additionalProperties: false,
          required: [
            "approve",
            "confidenceBP",
            "reasoning",
            "injectionSuspected",
          ],
          properties: {
            approve: { type: "boolean" },
            confidenceBP: {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
            },
            reasoning: { type: "string", maxLength: 1_200 },
            injectionSuspected: { type: "boolean" },
          },
        },
        AIEvidenceV1: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "jobId",
            "verdict",
            "reasonCode",
            "model",
            "promptVersion",
            "deliverableHash",
            "timestamp",
          ],
          properties: {
            type: { const: "ai-v1" },
            jobId: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            verdict: { $ref: "#/components/schemas/AIVerdict" },
            reasonCode: { $ref: "#/components/schemas/ReasonCode" },
            model: { type: "string", minLength: 1, maxLength: 200 },
            promptVersion: { const: "v1" },
            deliverableHash: { $ref: "#/components/schemas/Hash32" },
            timestamp: { $ref: "#/components/schemas/Timestamp" },
          },
        },
        StoreAIEvidence: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceHash", "evidence"],
          properties: {
            evidenceHash: { $ref: "#/components/schemas/Hash32" },
            evidence: { $ref: "#/components/schemas/AIEvidenceV1" },
          },
        },
        StoreAIEvidenceResponse: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceHash", "stored", "duplicate"],
          properties: {
            evidenceHash: { $ref: "#/components/schemas/Hash32" },
            stored: { const: true },
            duplicate: { type: "boolean" },
          },
        },
        HumanEvidenceV1: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "jobId",
            "deliverableHash",
            "reviewer",
            "telegramIdentityHash",
            "decision",
            "reasoning",
            "escalationCause",
            "escalationReasonHash",
            "x402",
            "reward",
            "payoutTransactionHash",
            "verdictAt",
            "payoutConfirmedAt",
          ],
          properties: {
            type: { const: "human-v1" },
            jobId: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            deliverableHash: { $ref: "#/components/schemas/Hash32" },
            reviewer: { $ref: "#/components/schemas/Address" },
            telegramIdentityHash: { $ref: "#/components/schemas/Hash32" },
            decision: { $ref: "#/components/schemas/ReviewDecision" },
            reasoning: { type: "string" },
            escalationCause: { type: "string" },
            escalationReasonHash: { $ref: "#/components/schemas/Hash32" },
            x402: {
              type: "object",
              additionalProperties: false,
              required: ["payer", "amount", "network", "transaction"],
              properties: {
                payer: { $ref: "#/components/schemas/Address" },
                amount: { $ref: "#/components/schemas/BaseUnitAmount" },
                network: { type: "string" },
                transaction: {
                  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
                },
              },
            },
            reward: { $ref: "#/components/schemas/BaseUnitAmount" },
            payoutTransactionHash: { $ref: "#/components/schemas/Hash32" },
            verdictAt: { $ref: "#/components/schemas/Timestamp" },
            payoutConfirmedAt: { $ref: "#/components/schemas/Timestamp" },
          },
        },
        EvidenceResponse: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceHash", "verified", "evidence"],
          properties: {
            evidenceHash: { $ref: "#/components/schemas/Hash32" },
            verified: { type: "boolean" },
            evidence: {
              oneOf: [
                { $ref: "#/components/schemas/AIEvidenceV1" },
                { $ref: "#/components/schemas/HumanEvidenceV1" },
              ],
              discriminator: { propertyName: "type" },
            },
          },
        },
        ReviewerResponse: {
          type: "object",
          additionalProperties: false,
          required: ["reviewer"],
          properties: {
            reviewer: {
              type: "object",
              additionalProperties: false,
              required: [
                "alias",
                "address",
                "skills",
                "active",
                "completedReviews",
                "approvals",
                "rejections",
                "totalRewards",
                "paidReviews",
                "onChainSettledReviews",
                "averageResponseSeconds",
                "reviews",
              ],
              properties: {
                alias: { type: "string" },
                address: { $ref: "#/components/schemas/Address" },
                skills: {
                  type: "array",
                  items: { type: "string" },
                },
                active: { type: "boolean" },
                completedReviews: { type: "integer", minimum: 0 },
                approvals: { type: "integer", minimum: 0 },
                rejections: { type: "integer", minimum: 0 },
                totalRewards: {
                  $ref: "#/components/schemas/BaseUnitAmount",
                },
                paidReviews: { type: "integer", minimum: 0 },
                onChainSettledReviews: { type: "integer", minimum: 0 },
                averageResponseSeconds: {
                  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
                },
                reviews: {
                  type: "array",
                  items: {
                    $ref: "#/components/schemas/PublicReviewOrder",
                  },
                },
              },
            },
          },
        },
        TelegramUpdate: {
          type: "object",
          required: ["update_id"],
          properties: {
            update_id: { type: "integer", minimum: 0 },
          },
          additionalProperties: true,
          description:
            "Telegram Bot API Update. Message and callback-query fields vary by interaction type.",
        },
        CircleNotification: {
          type: "object",
          additionalProperties: true,
          description:
            "Signed Circle webhook notification. Unknown fields are retained for forward compatibility.",
        },
        WebhookAccepted: {
          type: "object",
          additionalProperties: false,
          required: ["accepted"],
          properties: {
            accepted: { const: true },
            duplicate: { type: "boolean" },
          },
        },
      },
    },
  };
}
