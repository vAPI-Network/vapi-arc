import "./env.js";
import { createServer } from "node:http";
import { createReviewApp, requiredTreasuryBalance } from "./review/app.js";
import { applyReviewerBootstrap } from "./review/bootstrap.js";
import { createLiveReviewChain } from "./review/chain.js";
import { createLiveCircleRail } from "./review/circle.js";
import { loadReviewServiceConfig } from "./review/config.js";
import { ReviewDatabase } from "./review/database.js";
import { DemoProcessor } from "./review/demo.js";
import { createLiveDemoChainRail } from "./review/demo-chain.js";
import { DemoRepository } from "./review/demo-repository.js";
import { validateEscalatedReview } from "./review/eligibility.js";
import {
  GatewayReservationReconciler,
  PermanentGatewayRecoveryError,
} from "./review/gateway.js";
import { ReviewProcessor, wakeReviewOrder } from "./review/processor.js";
import { createTelegramGateway } from "./review/telegram.js";
import type { ValidatedReviewJob } from "./review/types.js";

async function main(): Promise<void> {
  const config = loadReviewServiceConfig();
  const database = new ReviewDatabase(config.databasePath);
  const bootstrappedReviewers = applyReviewerBootstrap(
    database,
    config.bootstrapReviewers ?? [],
  );
  if (bootstrappedReviewers.length > 0) {
    console.log(
      JSON.stringify({
        event: "reviewer_council_bootstrapped",
        count: bootstrappedReviewers.length,
        reviewerIds: bootstrappedReviewers.map((reviewer) => reviewer.id),
      }),
    );
  }
  const chain = createLiveReviewChain(config);
  const circle = createLiveCircleRail(config);
  const processor = new ReviewProcessor({
    config,
    database,
    chain,
    circle,
  });
  const demoRepository = new DemoRepository(database);
  const demoProcessor = new DemoProcessor({
    config,
    database,
    repository: demoRepository,
    chain: createLiveDemoChainRail(config),
    circle,
    wakeReviewOrder(orderId, source) {
      wakeReviewOrder(processor, orderId, source);
    },
  });
  const telegram = createTelegramGateway(config, database, {
    onVerdict(order) {
      wakeReviewOrder(processor, order.id, "telegram_verdict");
    },
  });
  const missing = [
    !chain && "Arc/router validation",
    !config.sellerAddress && "X402_SELLER_ADDRESS",
    !telegram && "TELEGRAM_BOT_TOKEN",
    !config.telegramWebhookSecret && "TELEGRAM_WEBHOOK_SECRET",
    !circle && "Circle Developer-Controlled Wallet credentials",
    !config.internalToken && "REVIEW_INTERNAL_TOKEN",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0 && !config.allowPartialConfiguration) {
    throw new Error(
      `Paid review service is not ready: missing ${missing.join(", ")}`,
    );
  }
  const serviceReady = missing.length === 0;
  if (serviceReady) {
    await chain!.assertReady?.();
    await circle!.assertReady?.();
    await telegram!.registerWebhook();
  }
  processor.setTelegram(telegram);
  const reconciliation = serviceReady
    ? database.reconcileSettledReviewReservations()
    : { orders: [], failures: [] };
  if (reconciliation.orders.length > 0) {
    console.log(
      JSON.stringify({
        event: "settled_review_intents_recovered",
        count: reconciliation.orders.length,
        orderIds: reconciliation.orders.map((order) => order.id),
      }),
    );
  }
  if (reconciliation.failures.length > 0) {
    console.error(
      JSON.stringify({
        event: "settled_review_intents_quarantined",
        count: reconciliation.failures.length,
        failures: reconciliation.failures,
      }),
    );
  }
  const gatewayReconciler =
    serviceReady && config.sellerAddress
      ? new GatewayReservationReconciler(
          config,
          database,
          undefined,
          async ({ reservation, intent }) => {
            const freshJob = await validateEscalatedReview(
              chain!,
              database,
              intent.request.jobId,
              intent.request.deliverable.content,
            );
            assertSameRecoveryJob(intent.validatedJob, freshJob);
            if (
              database.listEligibleReviewers(
                freshJob.client,
                freshJob.provider,
                config.circleWalletAddress
                  ? [config.circleWalletAddress]
                  : [],
              )
                .length === 0
            ) {
              throw new Error(
                "no active non-conflicted reviewer is available for Gateway recovery",
              );
            }
            if (!circle!.checkTreasuryBalance) {
              throw new Error(
                "Circle treasury balance checks are unavailable for Gateway recovery",
              );
            }
            const balance = await circle!.checkTreasuryBalance();
            const required = requiredTreasuryBalance(
              database,
              config,
              reservation.token,
            );
            if (BigInt(balance.balance) < required) {
              throw new Error(
                `Circle treasury has ${balance.balance} USDC base units; ${required.toString()} required before Gateway recovery`,
              );
            }
          },
        )
      : undefined;
  const gatewayRecovery = gatewayReconciler
    ? await gatewayReconciler.reconcile()
    : { orders: [], discarded: [], failures: [] };
  logGatewayRecovery(gatewayRecovery);
  const app = createReviewApp({
    config,
    database,
    chain,
    circle,
    telegram,
    processor,
    demo: demoProcessor,
  });
  const server = createServer(app);
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        event: "review_service_listening",
        port: config.port,
        publicBaseUrl: config.publicBaseUrl,
        chainConfigured: Boolean(chain),
        x402Configured: Boolean(config.sellerAddress),
        telegramConfigured: Boolean(telegram),
        circleConfigured: Boolean(circle),
      }),
    );
  });
  processor.start();
  if (config.demoEnabled) demoProcessor.start();
  for (const order of [...reconciliation.orders, ...gatewayRecovery.orders]) {
    wakeReviewOrder(processor, order.id, "startup_recovery");
  }
  const gatewayReconciliationTimer = gatewayReconciler
    ? setInterval(
        () => {
          void gatewayReconciler
            .reconcile()
            .then((result) => {
              logGatewayRecovery(result);
              for (const order of result.orders) {
                wakeReviewOrder(processor, order.id, "gateway_reconciliation");
              }
            })
            .catch((error: unknown) => {
              console.error(
                JSON.stringify({
                  event: "gateway_reservation_reconciliation_failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            });
        },
        Math.max(config.backgroundIntervalMs, 5_000),
      )
    : undefined;

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (gatewayReconciliationTimer) {
      clearInterval(gatewayReconciliationTimer);
    }
    processor.stop();
    demoProcessor.stop();
    server.close(() => {
      void Promise.all([
        processor.drain(25_000),
        demoProcessor.drain(25_000),
      ]).then(([reviewDrained, demoDrained]) => {
        if (reviewDrained && demoDrained) database.close();
        process.exit(0);
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function assertSameRecoveryJob(
  stored: ValidatedReviewJob,
  fresh: ValidatedReviewJob,
): void {
  const same =
    stored.jobId === fresh.jobId &&
    stored.client.toLowerCase() === fresh.client.toLowerCase() &&
    stored.provider.toLowerCase() === fresh.provider.toLowerCase() &&
    stored.evaluator.toLowerCase() === fresh.evaluator.toLowerCase() &&
    stored.description === fresh.description &&
    stored.budget === fresh.budget &&
    stored.expiredAt === fresh.expiredAt &&
    stored.deliverableHash.toLowerCase() ===
      fresh.deliverableHash.toLowerCase() &&
    stored.escalationReasonHash.toLowerCase() ===
      fresh.escalationReasonHash.toLowerCase() &&
    stored.escalationReasonCode === fresh.escalationReasonCode;
  if (!same) {
    throw new PermanentGatewayRecoveryError(
      "fresh Arc validation does not match the journaled review intent",
    );
  }
}

function logGatewayRecovery(
  result: Awaited<ReturnType<GatewayReservationReconciler["reconcile"]>>,
): void {
  if (result.orders.length > 0) {
    console.log(
      JSON.stringify({
        event: "gateway_review_intents_recovered",
        count: result.orders.length,
        orderIds: result.orders.map((order) => order.id),
      }),
    );
  }
  if (result.discarded.length > 0) {
    console.warn(
      JSON.stringify({
        event: "invalid_gateway_review_intents_discarded",
        count: result.discarded.length,
        reservations: result.discarded,
      }),
    );
  }
  if (result.failures.length > 0) {
    console.error(
      JSON.stringify({
        event: "gateway_review_intents_deferred",
        count: result.failures.length,
        failures: result.failures,
      }),
    );
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "review_service_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
