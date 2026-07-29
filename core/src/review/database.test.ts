import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { HUMAN_LANE_REASON, HUMAN_LANE_REASON_HASH } from "../evidence.js";
import {
  ReviewDatabase,
  type GatewayPaymentReservationInput,
} from "./database.js";
import { gatewayAuthorizationKey } from "./gateway.js";
import type {
  CircleOperation,
  ReviewOrder,
  ReviewOrderState,
  ReviewPayment,
  ValidatedReviewJob,
} from "./types.js";

const CLIENT = getAddress("0x1111111111111111111111111111111111111111");
const PROVIDER = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x3333333333333333333333333333333333333333");
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const OTHER_PAYER = getAddress("0x5555555555555555555555555555555555555555");
const NETWORK = "eip155:5042002";

function validatedJob(jobId: string, content: string): ValidatedReviewJob {
  return {
    jobId,
    client: CLIENT,
    provider: PROVIDER,
    evaluator: ROUTER,
    description: "Review this committed deliverable.",
    budget: "1000000",
    expiredAt: String(Math.floor(Date.now() / 1_000) + 10_000),
    deliverableHash: keccak256(toBytes(content)),
    escalationReasonHash: HUMAN_LANE_REASON_HASH,
    escalationReasonCode: "human_lane_requested",
    escalationCause: HUMAN_LANE_REASON,
  };
}

function intent(job: ValidatedReviewJob, content: string) {
  return {
    request: {
      requestId: randomUUID(),
      jobId: job.jobId,
      deliverable: { contentType: "text/plain", content },
    },
    validatedJob: job,
  };
}

function payment(amount: string, suffix: string): ReviewPayment {
  return {
    verified: true,
    payer: PAYER,
    amount,
    network: NETWORK,
    transaction: `0x${suffix.repeat(64)}` as Hex,
  };
}

function gatewayPayment(label: string): GatewayPaymentReservationInput {
  const nonce = keccak256(toBytes(`nonce:${label}`));
  return {
    signatureHash: keccak256(toBytes(`signature:${label}`)),
    authorizationKey: gatewayAuthorizationKey(PAYER, nonce),
    paymentPayload: { fixture: label },
    paymentRequirements: { network: NETWORK },
    payer: PAYER,
    nonce,
  };
}

describe("durable review payment reservations", () => {
  it("preserves a journaled Gateway attempt during request cleanup", () => {
    const database = new ReviewDatabase(":memory:");
    const content = "Preserve this ambiguous settlement.";
    const job = validatedJob("110", content);
    const value = intent(job, content);
    const gateway = gatewayPayment("ambiguous-settlement");
    const reservation = database.acquireReviewReservation(
      value.request.requestId,
      job.jobId,
      value,
      gateway,
      {
        reviewPrice: "250000",
        reward: "200000",
        network: NETWORK,
      },
    );
    if (reservation.status !== "acquired") {
      assert.fail("Gateway fixture reservation was not acquired");
    }

    database.markGatewaySettlementAttempt(
      reservation.token,
      gateway.paymentPayload,
      gateway.paymentRequirements,
    );
    database.releaseReviewReservation(reservation.token);

    const journal = database.sqlite
      .prepare(
        `SELECT phase, settlement_recovery_at
           FROM review_reservations
          WHERE token = ?`,
      )
      .get(reservation.token) as
      { phase: string; settlement_recovery_at: string | null } | undefined;
    assert.equal(journal?.phase, "payment_pending");
    assert.ok(journal?.settlement_recovery_at);
    assert.equal(
      database.listRecoverableGatewayReservations(
        new Date(Date.now() + 120_000),
      )[0]?.token,
      reservation.token,
    );
    database.close();
  });

  it("rejects a mismatched settlement payer without mutating its journal", () => {
    const database = new ReviewDatabase(":memory:");
    const content = "Bind this settlement to its signed payer.";
    const job = validatedJob("111", content);
    const value = intent(job, content);
    const gateway = gatewayPayment("payer-binding");
    const reservation = database.acquireReviewReservation(
      value.request.requestId,
      job.jobId,
      value,
      gateway,
      {
        reviewPrice: "250000",
        reward: "200000",
        network: NETWORK,
      },
    );
    if (reservation.status !== "acquired") {
      assert.fail("Gateway fixture reservation was not acquired");
    }
    database.markGatewaySettlementAttempt(
      reservation.token,
      gateway.paymentPayload,
      gateway.paymentRequirements,
    );

    assert.throws(
      () =>
        database.recordReviewReservationSettlement(reservation.token, {
          ...payment("250000", "d"),
          payer: OTHER_PAYER,
        }),
      /payer does not match its signed payment authorization/,
    );
    const journal = database.sqlite
      .prepare(
        `SELECT phase, settlement_recovery_at, settlement_transaction
           FROM review_reservations
          WHERE token = ?`,
      )
      .get(reservation.token) as {
      phase: string;
      settlement_recovery_at: string | null;
      settlement_transaction: string | null;
    };
    assert.equal(journal.phase, "payment_pending");
    assert.ok(journal.settlement_recovery_at);
    assert.equal(journal.settlement_transaction, null);
    database.close();
  });

  it("rejects direct promotion of a journaled but unsettled payment", () => {
    const database = new ReviewDatabase(":memory:");
    const content = "Keep the fallback path bound to the signed payer.";
    const job = validatedJob("112", content);
    const value = intent(job, content);
    const gateway = gatewayPayment("fallback-payer-binding");
    const reservation = database.acquireReviewReservation(
      value.request.requestId,
      job.jobId,
      value,
      gateway,
      {
        reviewPrice: "250000",
        reward: "200000",
        network: NETWORK,
      },
    );
    if (reservation.status !== "acquired") {
      assert.fail("Gateway fixture reservation was not acquired");
    }
    database.markGatewaySettlementAttempt(
      reservation.token,
      gateway.paymentPayload,
      gateway.paymentRequirements,
    );

    assert.throws(
      () =>
        database.createOrder({
          requestId: value.request.requestId,
          deliverableContent: content,
          job,
          payment: payment("250000", "e"),
          reviewPrice: "250000",
          reward: "200000",
          reservationToken: reservation.token,
        }),
      /must be durably settled before promotion/,
    );
    assert.equal(
      database.findOrderByRequestOrJob(value.request.requestId, job.jobId),
      undefined,
    );
    const journal = database.sqlite
      .prepare(
        `SELECT phase, payment_payer, settlement_recovery_at
           FROM review_reservations
          WHERE token = ?`,
      )
      .get(reservation.token) as {
      phase: string;
      payment_payer: string;
      settlement_recovery_at: string | null;
    };
    assert.equal(journal.phase, "payment_pending");
    assert.equal(journal.payment_payer, PAYER);
    assert.ok(journal.settlement_recovery_at);
    assert.equal(
      database.listRecoverableGatewayReservations(
        new Date(Date.now() + 120_000),
      )[0]?.token,
      reservation.token,
    );
    database.close();
  });

  it("recovers the immutable quote and rejects one Gateway payment across jobs", () => {
    const database = new ReviewDatabase(":memory:");
    const contentA = "First committed deliverable.";
    const jobA = validatedJob("101", contentA);
    const intentA = intent(jobA, contentA);
    const quote = {
      reviewPrice: "300000",
      reward: "210000",
      network: NETWORK,
    };
    const first = database.acquireReviewReservation(
      intentA.request.requestId,
      jobA.jobId,
      intentA,
      gatewayPayment("payment-signature-a"),
      quote,
    );
    if (first.status !== "acquired") assert.fail("first intent not acquired");
    const settledPayment = payment("300000", "a");
    database.recordReviewReservationSettlement(first.token, settledPayment);

    const contentB = "Second committed deliverable.";
    const jobB = validatedJob("102", contentB);
    const intentB = intent(jobB, contentB);
    const second = database.acquireReviewReservation(
      intentB.request.requestId,
      jobB.jobId,
      intentB,
      gatewayPayment("payment-signature-b"),
      quote,
    );
    if (second.status !== "acquired") assert.fail("second intent not acquired");
    assert.throws(
      () =>
        database.recordReviewReservationSettlement(
          second.token,
          settledPayment,
        ),
      /already associated/,
    );

    const reconciliation = database.reconcileSettledReviewReservations();
    assert.deepEqual(reconciliation.failures, []);
    assert.equal(reconciliation.orders.length, 1);
    assert.equal(reconciliation.orders[0]?.reviewPrice, "300000");
    assert.equal(reconciliation.orders[0]?.reward, "210000");
    assert.equal(
      reconciliation.orders[0]?.gatewayTransaction,
      settledPayment.transaction,
    );
    const pending = database.sqlite
      .prepare(
        "SELECT phase, settlement_transaction FROM review_reservations WHERE token = ?",
      )
      .get(second.token) as {
      phase: string;
      settlement_transaction: string | null;
    };
    assert.deepEqual(pending, {
      phase: "payment_pending",
      settlement_transaction: null,
    });
    const contentC = "Third committed deliverable.";
    const jobC = validatedJob("107", contentC);
    const intentC = intent(jobC, contentC);
    assert.equal(
      database.acquireReviewReservation(
        intentC.request.requestId,
        jobC.jobId,
        intentC,
        gatewayPayment("payment-signature-a"),
        quote,
      ).status,
      "busy",
    );
    database.close();
  });

  it("isolates a malformed settled intent instead of blocking valid recovery", () => {
    const database = new ReviewDatabase(":memory:");
    const quote = {
      reviewPrice: "250000",
      reward: "200000",
      network: NETWORK,
    };
    const validContent = "Recover this valid order.";
    const validJob = validatedJob("103", validContent);
    const validIntent = intent(validJob, validContent);
    const valid = database.acquireReviewReservation(
      validIntent.request.requestId,
      validJob.jobId,
      validIntent,
      undefined,
      quote,
    );
    if (valid.status !== "acquired") assert.fail("valid intent not acquired");
    database.recordReviewReservationSettlement(
      valid.token,
      payment("250000", "b"),
    );

    const malformed = database.acquireReviewReservation(
      randomUUID(),
      "104",
      undefined,
      undefined,
      quote,
    );
    if (malformed.status !== "acquired") {
      assert.fail("malformed fixture not acquired");
    }
    database.recordReviewReservationSettlement(
      malformed.token,
      payment("250000", "c"),
    );

    const reconciliation = database.reconcileSettledReviewReservations();
    assert.equal(reconciliation.orders.length, 1);
    assert.equal(reconciliation.orders[0]?.jobId, "103");
    assert.equal(reconciliation.failures.length, 1);
    assert.equal(reconciliation.failures[0]?.token, malformed.token);
    assert.match(reconciliation.failures[0]?.error ?? "", /missing provenance/);
    assert.deepEqual(database.reconcileSettledReviewReservations(), {
      orders: [],
      failures: [],
    });
    database.close();
  });

  it("accounts for concurrent reservations in deterministic admission order", () => {
    const database = new ReviewDatabase(":memory:");
    const quote = {
      reviewPrice: "250000",
      reward: "200000",
      network: NETWORK,
    };
    for (const jobId of ["105", "106"]) {
      const content = `Deliverable ${jobId}`;
      const job = validatedJob(jobId, content);
      const value = intent(job, content);
      const reservation = database.acquireReviewReservation(
        value.request.requestId,
        jobId,
        value,
        undefined,
        quote,
      );
      assert.equal(reservation.status, "acquired");
    }
    const reservations = database.sqlite
      .prepare(
        "SELECT token FROM review_reservations ORDER BY created_at, token",
      )
      .all() as Array<{ token: string }>;
    assert.equal(reservations.length, 2);
    assert.equal(
      database.reviewReservationLiabilityThrough(reservations[0]!.token),
      450000n,
    );
    assert.equal(
      database.reviewReservationLiabilityThrough(reservations[1]!.token),
      900000n,
    );
    assert.equal(database.reviewReservationLiabilityThrough(), 900000n);
    database.close();
  });

  it("reaps an expired unsigned intent before admitting a new request", () => {
    const database = new ReviewDatabase(":memory:");
    const quote = {
      reviewPrice: "250000",
      reward: "200000",
      network: NETWORK,
    };
    const content = "Retry this abandoned unpaid purchase.";
    const job = validatedJob("109", content);
    const firstIntent = intent(job, content);
    const first = database.acquireReviewReservation(
      firstIntent.request.requestId,
      job.jobId,
      firstIntent,
      undefined,
      quote,
    );
    if (first.status !== "acquired") assert.fail("first intent not acquired");
    database.sqlite
      .prepare("UPDATE review_reservations SET expires_at = ? WHERE token = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), first.token);

    const secondIntent = intent(job, content);
    assert.equal(
      database.acquireReviewReservation(
        secondIntent.request.requestId,
        job.jobId,
        secondIntent,
        undefined,
        quote,
      ).status,
      "acquired",
    );
    database.close();
  });
});

describe("reviewer database invariants", () => {
  it("rejects identities and payout details that cannot be dispatched safely", () => {
    const database = new ReviewDatabase(":memory:");
    const valid = {
      telegramUserId: "123",
      telegramChatId: "-456",
      alias: "Ada",
      payoutAddress: PAYER,
      skills: ["security"],
    };

    assert.throws(
      () =>
        database.upsertReviewer({
          ...valid,
          telegramUserId: "not-numeric",
        }),
      /positive numeric id/,
    );
    assert.throws(
      () => database.upsertReviewer({ ...valid, telegramChatId: "0" }),
      /numeric chat id/,
    );
    assert.throws(
      () => database.upsertReviewer({ ...valid, alias: " " }),
      /alias/,
    );
    assert.throws(
      () =>
        database.upsertReviewer({
          ...valid,
          payoutAddress: getAddress(
            "0x0000000000000000000000000000000000000000",
          ),
        }),
      /zero address/,
    );
    assert.throws(
      () =>
        database.upsertReviewer({
          ...valid,
          skills: Array.from({ length: 21 }, (_, index) => `skill-${index}`),
        }),
      /at most 20/,
    );
    database.upsertReviewer(valid);
    assert.throws(
      () =>
        database.upsertReviewer({
          ...valid,
          telegramUserId: "124",
        }),
      /chat id is already assigned/,
    );
    assert.equal(database.listReviewers().length, 1);
    database.close();
  });
});

describe("Circle operator recovery invariants", () => {
  it("rotates exhausted payout, resolution, and refund keys without changing recovery state", () => {
    const database = new ReviewDatabase(":memory:");
    const cases: Array<{
      operation: CircleOperation;
      state: ReviewOrderState;
      jobId: string;
      suffix: string;
    }> = [
      {
        operation: "payout",
        state: "payout_failed",
        jobId: "120",
        suffix: "1",
      },
      {
        operation: "resolution",
        state: "reviewer_paid_settlement_failed",
        jobId: "121",
        suffix: "2",
      },
      {
        operation: "refund",
        state: "expired",
        jobId: "122",
        suffix: "3",
      },
    ];
    const keyFor = (
      order: ReviewOrder,
      operation: CircleOperation,
    ): string =>
      operation === "payout"
        ? order.payoutIdempotencyKey
        : operation === "resolution"
          ? order.resolutionIdempotencyKey
          : order.refundIdempotencyKey;
    const circleIdFor = (
      order: ReviewOrder,
      operation: CircleOperation,
    ): string | null =>
      operation === "payout"
        ? order.circlePayoutId
        : operation === "resolution"
          ? order.circleResolutionId
          : order.circleRefundId;

    for (const entry of cases) {
      const content = `Exhausted ${entry.operation} recovery`;
      const { order } = database.createOrder({
        requestId: randomUUID(),
        deliverableContent: content,
        job: validatedJob(entry.jobId, content),
        payment: payment("250000", entry.suffix),
        reviewPrice: "250000",
        reward: "200000",
      });
      database.updateOrder(order.id, entry.state, {
        lastError: `${entry.operation} exhausted`,
      });
      const beforeKey = keyFor(database.getOrder(order.id)!, entry.operation);
      assert.deepEqual(
        database.rotateCircleAttempt(
          order.id,
          entry.operation,
          {
            id: `${entry.operation}-terminal`,
            state: "FAILED",
            txHash: null,
          },
          1,
        ),
        { rotated: false, attempts: 1 },
      );
      assert.equal(
        circleIdFor(database.getOrder(order.id)!, entry.operation),
        `${entry.operation}-terminal`,
      );

      const resumed = database.resumeCircleOperation(
        order.id,
        entry.operation,
        1,
      );
      assert.equal(resumed.state, entry.state);
      assert.equal(circleIdFor(resumed, entry.operation), null);
      assert.equal(resumed.lastError, null);
      assert.notEqual(keyFor(resumed, entry.operation), beforeKey);
      assert.throws(
        () => database.resumeCircleOperation(order.id, entry.operation, 1),
        /has not exhausted its current retry budget/,
      );
    }
    assert.equal(
      database
        .listOrders()
        .flatMap((order) => database.listEvents(order.id))
        .filter((event) => event.type === "circle_operator_resume").length,
      3,
    );
    database.close();
  });
});
