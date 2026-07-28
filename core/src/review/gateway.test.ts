import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress, keccak256, toBytes } from "viem";
import { HUMAN_LANE_REASON, HUMAN_LANE_REASON_HASH } from "../evidence.js";
import type { ReviewServiceConfig } from "./config.js";
import {
  ReviewDatabase,
  type GatewayPaymentReservationInput,
} from "./database.js";
import { ReviewValidationError } from "./chain.js";
import {
  GatewayReservationReconciler,
  gatewayAuthorizationKey,
  parseGatewayPaymentReservation,
} from "./gateway.js";
import type { ValidatedReviewJob } from "./types.js";

const CLIENT = getAddress("0x1111111111111111111111111111111111111111");
const PROVIDER = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x3333333333333333333333333333333333333333");
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const SELLER = getAddress("0x5555555555555555555555555555555555555555");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const NETWORK = "eip155:5042002";

function config(): ReviewServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "http://review.test",
    databasePath: ":memory:",
    routerAddress: ROUTER,
    sellerAddress: SELLER,
    gatewayNetwork: NETWORK,
    gatewayUrl: "https://gateway.invalid",
    reviewPrice: "250000",
    reviewPriceDisplay: "$0.25",
    reviewerReward: "200000",
    claimTtlSeconds: 600,
    reviewSlaSeconds: 1_800,
    minJobExpiryBufferSeconds: 2_220,
    maxDispatches: 2,
    internalToken: "test",
    telegramWebhookSecret: "test",
    usdcTokenAddress: USDC,
    minimumTreasuryBalance: "450000",
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 1_000,
    backgroundIntervalMs: 5_000,
    logLookbackBlocks: 10_000n,
    allowPartialConfiguration: false,
  };
}

function fixture(
  jobId: string,
  label: string,
): {
  requestId: string;
  intent: Record<string, unknown>;
  job: ValidatedReviewJob;
  payment: GatewayPaymentReservationInput;
} {
  const requestId = randomUUID();
  const content = `Deliverable ${label}`;
  const job: ValidatedReviewJob = {
    jobId,
    client: CLIENT,
    provider: PROVIDER,
    evaluator: ROUTER,
    description: "Review the committed result.",
    budget: "1000000",
    expiredAt: String(Math.floor(Date.now() / 1_000) + 10_000),
    deliverableHash: keccak256(toBytes(content)),
    escalationReasonHash: HUMAN_LANE_REASON_HASH,
    escalationReasonCode: "human_lane_requested",
    escalationCause: HUMAN_LANE_REASON,
  };
  const nonce = keccak256(toBytes(`nonce:${label}`));
  return {
    requestId,
    job,
    intent: {
      request: {
        requestId,
        jobId,
        deliverable: { contentType: "text/plain", content },
      },
      validatedJob: job,
    },
    payment: {
      signatureHash: keccak256(toBytes(`signature:${label}`)),
      authorizationKey: gatewayAuthorizationKey(PAYER, nonce),
      payer: PAYER,
      nonce,
      paymentPayload: {
        x402Version: 2,
        payload: {
          authorization: { from: PAYER, nonce },
          signature: `0x${"1".repeat(130)}`,
        },
      },
      paymentRequirements: {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount: "250000",
        payTo: SELLER,
        maxTimeoutSeconds: 604_900,
        extra: {
          name: "GatewayWalletBatched",
          version: "1",
          verifyingContract: "0x6666666666666666666666666666666666666666",
        },
      },
    },
  };
}

function acquire(
  database: ReviewDatabase,
  value: ReturnType<typeof fixture>,
): string {
  const reservation = database.acquireReviewReservation(
    value.requestId,
    value.job.jobId,
    value.intent,
    value.payment,
    { reviewPrice: "250000", reward: "200000", network: NETWORK },
  );
  if (reservation.status !== "acquired") {
    assert.fail("Gateway fixture reservation was not acquired");
  }
  return reservation.token;
}

function makeRecoverable(database: ReviewDatabase, token: string): void {
  const stored = database.sqlite
    .prepare(
      `SELECT payment_payload_json, payment_requirements_json
         FROM review_reservations WHERE token = ?`,
    )
    .get(token) as {
    payment_payload_json: string;
    payment_requirements_json: string;
  };
  database.markGatewaySettlementAttempt(
    token,
    JSON.parse(stored.payment_payload_json) as Record<string, unknown>,
    JSON.parse(stored.payment_requirements_json) as Record<string, unknown>,
  );
  database.sqlite
    .prepare(
      "UPDATE review_reservations SET settlement_recovery_at = ? WHERE token = ?",
    )
    .run(new Date(Date.now() - 1_000).toISOString(), token);
}

describe("Gateway reservation restart reconciliation", () => {
  it("uses payer and nonce as the canonical replay key across encodings", () => {
    const currentConfig = config();
    const nonce = `0x${"a".repeat(64)}`;
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount: "250000",
        payTo: SELLER,
        maxTimeoutSeconds: 604_900,
        extra: {
          name: "GatewayWalletBatched",
          version: "1",
          verifyingContract: "0x6666666666666666666666666666666666666666",
        },
      },
      payload: {
        authorization: {
          from: PAYER,
          to: SELLER,
          value: "250000",
          validAfter: "1",
          validBefore: "9999999999",
          nonce,
        },
        signature: `0x${"b".repeat(130)}`,
      },
    };
    const compact = Buffer.from(JSON.stringify(payload)).toString("base64");
    const pretty = Buffer.from(JSON.stringify(payload, null, 2)).toString(
      "base64",
    );
    const firstPayment = parseGatewayPaymentReservation(compact, currentConfig);
    const secondPayment = parseGatewayPaymentReservation(pretty, currentConfig);
    assert.ok(firstPayment);
    assert.ok(secondPayment);
    assert.notEqual(firstPayment.signatureHash, secondPayment.signatureHash);
    assert.equal(firstPayment.authorizationKey, secondPayment.authorizationKey);

    const database = new ReviewDatabase(":memory:");
    const first = fixture("200", "first-encoding");
    const second = fixture("206", "second-encoding");
    assert.equal(
      database.acquireReviewReservation(
        first.requestId,
        first.job.jobId,
        first.intent,
        firstPayment,
        { reviewPrice: "250000", reward: "200000", network: NETWORK },
      ).status,
      "acquired",
    );
    assert.equal(
      database.acquireReviewReservation(
        second.requestId,
        second.job.jobId,
        second.intent,
        secondPayment,
        { reviewPrice: "250000", reward: "200000", network: NETWORK },
      ).status,
      "busy",
    );
    database.close();
  });

  it("retries a journaled settlement and durably consumes its signature", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("201", "successful-retry");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    let verifyCalls = 0;
    let settleCalls = 0;
    let preflightCalls = 0;
    const reconciler = new GatewayReservationReconciler(
      config(),
      database,
      {
        async verify() {
          verifyCalls += 1;
          return { isValid: true, payer: PAYER };
        },
        async settle() {
          settleCalls += 1;
          return {
            success: true,
            payer: PAYER,
            transaction: "gateway-transfer-201",
            network: NETWORK,
          };
        },
      },
      async ({ intent }) => {
        preflightCalls += 1;
        assert.equal(intent.request.jobId, "201");
        assert.equal(intent.validatedJob.jobId, "201");
      },
    );

    const result = await reconciler.reconcile();
    assert.equal(verifyCalls, 1);
    assert.equal(preflightCalls, 1);
    assert.equal(settleCalls, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0]?.gatewayTransaction, "gateway-transfer-201");

    const second = fixture("202", "different-job");
    assert.equal(
      database.acquireReviewReservation(
        second.requestId,
        second.job.jobId,
        second.intent,
        value.payment,
        { reviewPrice: "250000", reward: "200000", network: NETWORK },
      ).status,
      "busy",
    );
    database.close();
  });

  it("quarantines an already-used nonce without inventing payment provenance", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("203", "nonce-recovery");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    const reconciler = new GatewayReservationReconciler(config(), database, {
      async verify() {
        return {
          isValid: false,
          invalidReason: "nonce_already_used",
          payer: PAYER,
        };
      },
      async settle() {
        assert.fail("an already-used nonce must not be settled twice");
      },
    });

    const result = await reconciler.reconcile();
    assert.equal(result.orders.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? "", /original transfer UUID/);
    assert.equal(database.listOrders().length, 0);
    database.close();
  });

  it("retains any attempted authorization when verification cannot prove non-settlement", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("212", "verification-race");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    const reconciler = new GatewayReservationReconciler(config(), database, {
      async verify() {
        return {
          isValid: false,
          invalidReason: "authorization_expired",
          payer: PAYER,
        };
      },
      async settle() {
        assert.fail("an invalid verification result must not trigger settlement");
      },
    });

    const result = await reconciler.reconcile();
    assert.equal(result.orders.length, 0);
    assert.equal(result.discarded.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(
      result.failures[0]?.error ?? "",
      /cannot prove the earlier settlement attempt was not accepted/,
    );
    assert.equal(database.reviewReservationLiabilityThrough(), 450000n);
    assert.ok(
      database.sqlite
        .prepare("SELECT token FROM review_reservations WHERE token = ?")
        .get(token),
    );
    database.close();
  });

  it("releases expired signatures when settlement never began", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("204", "never-attempted");
    const token = acquire(database, value);
    database.sqlite
      .prepare("UPDATE review_reservations SET expires_at = ? WHERE token = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), token);
    let gatewayCalls = 0;
    const reconciler = new GatewayReservationReconciler(
      config(),
      database,
      {
        async verify() {
          gatewayCalls += 1;
          return { isValid: true };
        },
        async settle() {
          gatewayCalls += 1;
          return {
            success: true,
            transaction: "unexpected",
            network: NETWORK,
          };
        },
      },
      async () => {},
    );

    const result = await reconciler.reconcile();
    assert.equal(gatewayCalls, 0);
    assert.deepEqual(
      result.discarded.map((entry) => entry.token),
      [token],
    );
    assert.equal(
      (
        database.sqlite
          .prepare("SELECT count(*) AS count FROM review_reservations")
          .get() as { count: number }
      ).count,
      0,
    );
    database.close();
  });

  it("keeps an indeterminate Gateway failure for a later safe retry", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("205", "transient");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    const reconciler = new GatewayReservationReconciler(config(), database, {
      async verify() {
        throw new Error("Gateway temporarily unavailable");
      },
      async settle() {
        assert.fail("settlement cannot run after a failed verification call");
      },
    });

    const result = await reconciler.reconcile();
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? "", /temporarily unavailable/);
    const stored = database.sqlite
      .prepare(
        "SELECT reconcile_error FROM review_reservations WHERE token = ?",
      )
      .get(token) as { reconcile_error: string };
    assert.match(stored.reconcile_error, /temporarily unavailable/);
    database.close();
  });

  it("isolates one malformed pending row without blocking valid recovery", async () => {
    const database = new ReviewDatabase(":memory:");
    const malformed = fixture("207", "malformed-pending");
    const valid = fixture("208", "valid-pending");
    const malformedToken = acquire(database, malformed);
    const validToken = acquire(database, valid);
    makeRecoverable(database, malformedToken);
    makeRecoverable(database, validToken);
    database.sqlite
      .prepare(
        "UPDATE review_reservations SET quoted_review_price = NULL WHERE token = ?",
      )
      .run(malformedToken);
    const reconciler = new GatewayReservationReconciler(
      config(),
      database,
      {
        async verify() {
          return { isValid: true, payer: PAYER };
        },
        async settle() {
          return {
            success: true,
            payer: PAYER,
            transaction: "gateway-transfer-208",
            network: NETWORK,
          };
        },
      },
      async () => {},
    );

    const result = await reconciler.reconcile();
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0]?.jobId, "208");
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.token, malformedToken);
    assert.match(result.failures[0]?.error ?? "", /immutable quote/);
    database.close();
  });

  it("defers a valid authorization when fresh fulfillment is unavailable", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("209", "fresh-preflight");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    let settleCalls = 0;
    const reconciler = new GatewayReservationReconciler(
      config(),
      database,
      {
        async verify() {
          return { isValid: true, payer: PAYER };
        },
        async settle() {
          settleCalls += 1;
          return {
            success: true,
            payer: PAYER,
            transaction: "must-not-settle",
            network: NETWORK,
          };
        },
      },
      async () => {
        throw new Error("Arc RPC is temporarily unavailable");
      },
    );

    const result = await reconciler.reconcile();
    assert.equal(settleCalls, 0);
    assert.equal(result.orders.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? "", /temporarily unavailable/);
    const retained = database.sqlite
      .prepare(
        `SELECT phase, reconcile_error
           FROM review_reservations WHERE token = ?`,
      )
      .get(token) as { phase: string; reconcile_error: string };
    assert.equal(retained.phase, "payment_pending");
    assert.match(retained.reconcile_error, /temporarily unavailable/);
    database.close();
  });

  it("quarantines permanent preflight failure until an in-flight settlement is known", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("211", "permanent-preflight");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    let settleCalls = 0;
    const reconciler = new GatewayReservationReconciler(
      config(),
      database,
      {
        async verify() {
          return { isValid: true, payer: PAYER };
        },
        async settle() {
          settleCalls += 1;
          return {
            success: true,
            payer: PAYER,
            transaction: "must-not-settle",
            network: NETWORK,
          };
        },
      },
      async () => {
        throw new ReviewValidationError(
          "job has already settled",
          409,
          "wrong_job_status",
          true,
        );
      },
    );

    const result = await reconciler.reconcile();
    assert.equal(settleCalls, 0);
    assert.equal(result.orders.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.discarded.length, 0);
    assert.match(result.failures[0]?.error ?? "", /already settled/);
    assert.equal(database.reviewReservationLiabilityThrough(), 450000n);

    // The SDK settlement that caused this journal can still finish after the
    // recovery read. Keeping the reservation makes that late callback safe.
    database.recordReviewReservationSettlement(token, {
      verified: true,
      payer: PAYER,
      amount: "250000",
      network: NETWORK,
      transaction: "gateway-original-in-flight-211",
    });
    const promoted = database.promoteReviewReservation(token);
    assert.equal(promoted?.order.jobId, "211");
    assert.equal(
      promoted?.order.gatewayTransaction,
      "gateway-original-in-flight-211",
    );
    database.close();
  });

  it("never recovers an authorization after the configured quote changes", async () => {
    const database = new ReviewDatabase(":memory:");
    const value = fixture("210", "quote-drift");
    const token = acquire(database, value);
    makeRecoverable(database, token);
    let gatewayCalls = 0;
    const reconciler = new GatewayReservationReconciler(
      { ...config(), reviewPrice: "260000", reviewPriceDisplay: "$0.26" },
      database,
      {
        async verify() {
          gatewayCalls += 1;
          return { isValid: true, payer: PAYER };
        },
        async settle() {
          gatewayCalls += 1;
          return {
            success: true,
            payer: PAYER,
            transaction: "must-not-settle",
            network: NETWORK,
          };
        },
      },
      async () => {},
    );

    const result = await reconciler.reconcile();
    assert.equal(gatewayCalls, 1);
    assert.equal(result.orders.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.discarded.length, 0);
    assert.match(result.failures[0]?.error ?? "", /configured review quote/);
    assert.equal(database.reviewReservationLiabilityThrough(), 450000n);
    database.close();
  });
});
