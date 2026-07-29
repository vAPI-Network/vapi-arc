import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  HUMAN_LANE_REASON,
  HUMAN_LANE_REASON_HASH,
  parseAIEvidence,
  serializeAIEvidence,
  verifyAIEvidence,
  type AIEvidenceV1,
} from "../evidence.js";
import type { ReasonCode } from "../validate.js";
import { verifyHumanEvidence } from "./evidence.js";
import type {
  CircleAttempt,
  CircleOperation,
  CircleTransactionResult,
  DashboardChainSnapshot,
  HumanEvidenceV1,
  InternalReviewOrder,
  PublicReviewOrder,
  ReviewAssignment,
  ReviewDecision,
  ReviewEvent,
  Reviewer,
  ReviewOrder,
  ReviewOrderState,
  ReviewPayment,
  ReviewerSnapshot,
  ValidatedReviewJob,
} from "./types.js";

interface ReviewerRow {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  alias: string;
  payout_address: string;
  skills_json: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  request_id: string;
  job_id: string;
  payment_signature_hash: string | null;
  payment_authorization_key: string | null;
  state: ReviewOrderState;
  payer: string;
  review_price: string;
  network: string;
  gateway_transaction: string | null;
  job_client: string;
  job_provider: string;
  job_description: string;
  job_budget: string;
  job_expired_at: string;
  deliverable_hash: string;
  deliverable_content: string;
  escalation_reason_hash: string;
  escalation_reason_code: string | null;
  escalation_cause: string | null;
  reviewer_id: string | null;
  reviewer_alias: string | null;
  reviewer_payout_address: string | null;
  reviewer_telegram_identity_hash: string | null;
  decision: ReviewDecision | null;
  reasoning: string | null;
  evidence_hash: string | null;
  evidence_json: string | null;
  reward: string;
  circle_payout_id: string | null;
  payout_tx_hash: string | null;
  circle_resolution_id: string | null;
  resolution_tx_hash: string | null;
  circle_refund_id: string | null;
  refund_tx_hash: string | null;
  payout_idempotency_key: string;
  resolution_idempotency_key: string;
  refund_idempotency_key: string;
  claim_expires_at: string | null;
  dispatch_count: number;
  created_at: string;
  claimed_at: string | null;
  verdict_at: string | null;
  paid_at: string | null;
  settled_at: string | null;
  settlement_abort_code: string | null;
  settlement_aborted_at: string | null;
  updated_at: string;
  last_error: string | null;
}

interface AssignmentRow {
  id: string;
  order_id: string;
  reviewer_id: string;
  status: ReviewAssignment["status"];
  telegram_message_id: string | null;
  offered_at: string;
  claimed_at: string | null;
  updated_at: string;
}

interface EventRow {
  id: number;
  order_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface TelegramUpdateRow {
  update_id: number;
  status: "processing" | "processed" | "failed";
  processing_token: string | null;
  attempts: number;
  received_at: string;
  updated_at: string;
  processed_at: string | null;
  last_error: string | null;
}

interface CircleAttemptRow {
  id: string;
  order_id: string;
  operation: CircleOperation;
  attempt_number: number;
  idempotency_key: string;
  circle_transaction_id: string;
  state: string;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewReservationRow {
  token: string;
  request_id: string;
  job_id: string;
  intent_json: string | null;
  payment_signature_hash: string | null;
  payment_authorization_key: string | null;
  payment_payload_json: string | null;
  payment_requirements_json: string | null;
  payment_payer: string | null;
  payment_nonce: string | null;
  settlement_recovery_at: string | null;
  quoted_review_price: string | null;
  quoted_reward: string | null;
  quoted_network: string | null;
  phase: "payment_pending" | "settled";
  settlement_payer: string | null;
  settlement_amount: string | null;
  settlement_network: string | null;
  settlement_transaction: string | null;
  reconcile_error: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface AIEvidenceRow {
  evidence_hash: string;
  evidence_json: string;
  job_id: string;
  deliverable_hash: string;
  reason_code: string;
  received_at: string;
}

interface DashboardSnapshotRow {
  id: string;
  version: number;
  snapshot_json: string;
  updated_at: string;
}

export interface StoredAIEvidence {
  evidenceHash: Hex;
  evidenceJson: string;
  evidence: AIEvidenceV1;
  receivedAt: string;
}

export interface DashboardPinnedReviewMetadata {
  jobId: string;
  deliverableHash: Hex | null;
  reasonHash: Hex | null;
  escalationTxHash: Hex | null;
}

export type TelegramUpdateReservation =
  | { status: "acquired"; token: string }
  | { status: "processing" }
  | { status: "processed" };

export interface CreateReviewOrderInput {
  requestId: string;
  deliverableContent: string;
  job: ValidatedReviewJob;
  payment: ReviewPayment;
  reviewPrice: string;
  reward: string;
  reservationToken?: string;
}

export interface GatewayPaymentReservationInput {
  signatureHash: Hex;
  authorizationKey: Hex;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>;
  payer: Address;
  nonce: Hex;
}

export interface RecoverableGatewayReservation {
  token: string;
  requestId: string;
  jobId: string;
  intentJson: string;
  paymentPayloadJson: string;
  paymentRequirementsJson: string;
  payer: string;
  nonce: string;
  reviewPrice: string | null;
  reward: string | null;
  network: string | null;
}

export interface UpsertReviewerInput {
  telegramUserId: string;
  telegramChatId: string;
  alias: string;
  payoutAddress: Address;
  skills: string[];
  active?: boolean;
}

const TELEGRAM_UPDATE_LEASE_MS = 5 * 60_000;
const REVIEW_RESERVATION_LEASE_MS = 15 * 60_000;
const GATEWAY_SETTLEMENT_RECOVERY_DELAY_MS = 60_000;
const CIRCLE_TERMINAL_FAILURES = new Set([
  "FAILED",
  "DENIED",
  "CANCELLED",
]);
const DASHBOARD_CHAIN_SNAPSHOT_ID = "dashboard-chain-snapshot";
const DASHBOARD_CHAIN_SNAPSHOT_VERSION = 1;

const circleOperationColumns = {
  payout: {
    id: "circle_payout_id",
    hash: "payout_tx_hash",
    key: "payout_idempotency_key",
  },
  resolution: {
    id: "circle_resolution_id",
    hash: "resolution_tx_hash",
    key: "resolution_idempotency_key",
  },
  refund: {
    id: "circle_refund_id",
    hash: "refund_tx_hash",
    key: "refund_idempotency_key",
  },
} as const satisfies Record<
  CircleOperation,
  { id: string; hash: string; key: string }
>;

const circleOperationRecoveryStates = {
  payout: "payout_failed",
  resolution: "reviewer_paid_settlement_failed",
  refund: "expired",
} as const satisfies Record<CircleOperation, ReviewOrderState>;

export class CircleOperationResumeError extends Error {
  readonly name = "CircleOperationResumeError";

  constructor(
    readonly code:
      | "review_order_not_found"
      | "invalid_circle_resume_state"
      | "circle_operation_not_exhausted",
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function reviewSlaElapsed(
  order: ReviewOrder,
  reviewSlaSeconds: number,
  nowMs: number,
): boolean {
  if (
    !Number.isSafeInteger(reviewSlaSeconds) ||
    reviewSlaSeconds < 0 ||
    reviewSlaSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    throw new Error("review SLA must be a safe non-negative number of seconds");
  }
  const createdAt = Date.parse(order.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error("review order has an invalid creation timestamp");
  }
  return createdAt + reviewSlaSeconds * 1_000 <= nowMs;
}

function reviewerFromRow(row: ReviewerRow): Reviewer {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    alias: row.alias,
    payoutAddress: getAddress(row.payout_address),
    skills: JSON.parse(row.skills_json) as string[],
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderFromRow(row: OrderRow): ReviewOrder {
  return {
    id: row.id,
    requestId: row.request_id,
    jobId: row.job_id,
    state: row.state,
    payer: getAddress(row.payer),
    reviewPrice: row.review_price,
    network: row.network,
    gatewayTransaction: row.gateway_transaction,
    jobClient: getAddress(row.job_client),
    jobProvider: getAddress(row.job_provider),
    jobDescription: row.job_description,
    jobBudget: row.job_budget,
    jobExpiredAt: row.job_expired_at,
    deliverableHash: row.deliverable_hash as Hex,
    deliverableContent: row.deliverable_content,
    escalationReasonHash: row.escalation_reason_hash as Hex,
    escalationReasonCode: row.escalation_reason_code as ReasonCode | null,
    escalationCause: row.escalation_cause,
    reviewerId: row.reviewer_id,
    reviewerAlias: row.reviewer_alias,
    reviewerPayoutAddress: row.reviewer_payout_address
      ? getAddress(row.reviewer_payout_address)
      : null,
    reviewerTelegramIdentityHash:
      row.reviewer_telegram_identity_hash as Hex | null,
    decision: row.decision,
    reasoning: row.reasoning,
    evidenceHash: row.evidence_hash as Hex | null,
    evidenceJson: row.evidence_json,
    reward: row.reward,
    circlePayoutId: row.circle_payout_id,
    payoutTransactionHash: row.payout_tx_hash as Hex | null,
    circleResolutionId: row.circle_resolution_id,
    resolutionTransactionHash: row.resolution_tx_hash as Hex | null,
    circleRefundId: row.circle_refund_id,
    refundTransactionHash: row.refund_tx_hash as Hex | null,
    payoutIdempotencyKey: row.payout_idempotency_key,
    resolutionIdempotencyKey: row.resolution_idempotency_key,
    refundIdempotencyKey: row.refund_idempotency_key,
    claimExpiresAt: row.claim_expires_at,
    dispatchCount: row.dispatch_count,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    verdictAt: row.verdict_at,
    paidAt: row.paid_at,
    settledAt: row.settled_at,
    settlementAbortCode: row.settlement_abort_code,
    settlementAbortedAt: row.settlement_aborted_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

function assignmentFromRow(row: AssignmentRow): ReviewAssignment {
  return {
    id: row.id,
    orderId: row.order_id,
    reviewerId: row.reviewer_id,
    status: row.status,
    telegramMessageId: row.telegram_message_id,
    offeredAt: row.offered_at,
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

function circleAttemptFromRow(row: CircleAttemptRow): CircleAttempt {
  return {
    id: row.id,
    orderId: row.order_id,
    operation: row.operation,
    attemptNumber: row.attempt_number,
    idempotencyKey: row.idempotency_key,
    circleTransactionId: row.circle_transaction_id,
    state: row.state,
    txHash: row.tx_hash as Hex | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function circleIdempotencyKey(
  order: ReviewOrder,
  operation: CircleOperation,
): string {
  switch (operation) {
    case "payout":
      return order.payoutIdempotencyKey;
    case "resolution":
      return order.resolutionIdempotencyKey;
    case "refund":
      return order.refundIdempotencyKey;
  }
}

function publicOrderError(order: ReviewOrder): string | null {
  if (!order.lastError) return null;
  switch (order.state) {
    case "payout_failed":
      return "Reviewer payout is being retried.";
    case "reviewer_paid_settlement_failed":
      return "Escrow settlement is being retried.";
    case "expired":
      return "Review refund is pending.";
    default:
      return "The review order requires operator attention.";
  }
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isDashboardChainSnapshot(
  value: unknown,
): value is DashboardChainSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Partial<DashboardChainSnapshot>;
  return (
    snapshot.version === DASHBOARD_CHAIN_SNAPSHOT_VERSION &&
    typeof snapshot.configured === "boolean" &&
    (snapshot.status === "syncing" ||
      snapshot.status === "ready" ||
      snapshot.status === "stale" ||
      snapshot.status === "degraded") &&
    (snapshot.latestBlock === null ||
      (typeof snapshot.latestBlock === "string" &&
        /^(0|[1-9]\d*)$/.test(snapshot.latestBlock))) &&
    (snapshot.indexedAt === null || typeof snapshot.indexedAt === "string") &&
    (snapshot.lastAttemptAt === null ||
      typeof snapshot.lastAttemptAt === "string") &&
    (snapshot.lastError === null || typeof snapshot.lastError === "string") &&
    Array.isArray(snapshot.feed) &&
    Array.isArray(snapshot.reviewQueue)
  );
}

export class ReviewDatabase {
  readonly sqlite: InstanceType<typeof Database>;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.sqlite = new Database(databasePath);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reviewers (
        id TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        telegram_chat_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        payout_address TEXT NOT NULL UNIQUE,
        skills_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_orders (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN (
          'paid', 'dispatched', 'claimed', 'verdict_submitted',
          'reviewer_paid', 'settled', 'expired', 'refunded',
          'payout_failed', 'reviewer_paid_settlement_failed'
        )),
        payer TEXT NOT NULL,
        review_price TEXT NOT NULL,
        network TEXT NOT NULL,
        gateway_transaction TEXT UNIQUE,
        job_client TEXT NOT NULL,
        job_provider TEXT NOT NULL,
        job_description TEXT NOT NULL,
        job_budget TEXT NOT NULL,
        job_expired_at TEXT NOT NULL,
        deliverable_hash TEXT NOT NULL,
        deliverable_content TEXT NOT NULL,
        escalation_reason_hash TEXT NOT NULL,
        escalation_reason_code TEXT,
        escalation_cause TEXT,
        reviewer_id TEXT REFERENCES reviewers(id),
        reviewer_alias TEXT,
        reviewer_payout_address TEXT,
        reviewer_telegram_identity_hash TEXT,
        decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
        reasoning TEXT,
        evidence_hash TEXT UNIQUE,
        evidence_json TEXT,
        reward TEXT NOT NULL,
        circle_payout_id TEXT UNIQUE,
        payout_tx_hash TEXT,
        circle_resolution_id TEXT UNIQUE,
        resolution_tx_hash TEXT,
        circle_refund_id TEXT UNIQUE,
        refund_tx_hash TEXT,
        payout_idempotency_key TEXT NOT NULL UNIQUE,
        resolution_idempotency_key TEXT NOT NULL UNIQUE,
        refund_idempotency_key TEXT NOT NULL UNIQUE,
        claim_expires_at TEXT,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        verdict_at TEXT,
        paid_at TEXT,
        settled_at TEXT,
        settlement_abort_code TEXT,
        settlement_aborted_at TEXT,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS review_assignments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
        status TEXT NOT NULL CHECK (status IN ('offered', 'claimed', 'declined', 'expired')),
        telegram_message_id TEXT,
        offered_at TEXT NOT NULL,
        claimed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(order_id, reviewer_id)
      );

      CREATE TABLE IF NOT EXISTS review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_votes (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        reasoning TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(order_id, reviewer_id)
      );

      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
        processing_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        processed_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS circle_attempts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('payout', 'resolution', 'refund')),
        attempt_number INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        circle_transaction_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        tx_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(order_id, operation, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS circle_request_journal (
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('payout', 'resolution', 'refund')),
        idempotency_key TEXT NOT NULL UNIQUE,
        requested_at TEXT NOT NULL,
        PRIMARY KEY(order_id, operation, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS review_reservations (
        token TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL UNIQUE,
        intent_json TEXT,
        payment_signature_hash TEXT,
        payment_authorization_key TEXT,
        payment_payload_json TEXT,
        payment_requirements_json TEXT,
        payment_payer TEXT,
        payment_nonce TEXT,
        settlement_recovery_at TEXT,
        quoted_review_price TEXT,
        quoted_reward TEXT,
        quoted_network TEXT,
        phase TEXT NOT NULL DEFAULT 'payment_pending'
          CHECK (phase IN ('payment_pending', 'settled')),
        settlement_payer TEXT,
        settlement_amount TEXT,
        settlement_network TEXT,
        settlement_transaction TEXT,
        reconcile_error TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_evidence_records (
        evidence_hash TEXT PRIMARY KEY,
        evidence_json TEXT NOT NULL,
        job_id TEXT NOT NULL,
        deliverable_hash TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dashboard_chain_snapshots (
        id TEXT PRIMARY KEY CHECK (id = 'dashboard-chain-snapshot'),
        version INTEGER NOT NULL CHECK (version = 1),
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS review_orders_state_idx
        ON review_orders(state, updated_at);
      CREATE INDEX IF NOT EXISTS review_assignments_order_idx
        ON review_assignments(order_id, status);
      CREATE INDEX IF NOT EXISTS review_events_order_idx
        ON review_events(order_id, id);
      CREATE INDEX IF NOT EXISTS review_votes_order_idx
        ON review_votes(order_id, created_at);
      CREATE INDEX IF NOT EXISTS circle_attempts_order_idx
        ON circle_attempts(order_id, operation, attempt_number);
      CREATE INDEX IF NOT EXISTS circle_request_journal_order_idx
        ON circle_request_journal(order_id, operation);
      CREATE INDEX IF NOT EXISTS review_reservations_expiry_idx
        ON review_reservations(expires_at);
      CREATE INDEX IF NOT EXISTS ai_evidence_records_job_idx
        ON ai_evidence_records(job_id, received_at);
    `);
    this.ensureOrderColumn("reviewer_alias", "TEXT");
    this.ensureOrderColumn("reviewer_payout_address", "TEXT");
    this.ensureOrderColumn("reviewer_telegram_identity_hash", "TEXT");
    this.ensureOrderColumn("payment_signature_hash", "TEXT");
    this.ensureOrderColumn("payment_authorization_key", "TEXT");
    this.ensureOrderColumn("escalation_reason_code", "TEXT");
    this.ensureOrderColumn("escalation_cause", "TEXT");
    this.ensureOrderColumn("settlement_abort_code", "TEXT");
    this.ensureOrderColumn("settlement_aborted_at", "TEXT");
    this.ensureTableColumn("review_reservations", "intent_json", "TEXT");
    this.ensureTableColumn(
      "review_reservations",
      "payment_signature_hash",
      "TEXT",
    );
    this.ensureTableColumn(
      "review_reservations",
      "payment_authorization_key",
      "TEXT",
    );
    this.ensureTableColumn(
      "review_reservations",
      "payment_payload_json",
      "TEXT",
    );
    this.ensureTableColumn(
      "review_reservations",
      "payment_requirements_json",
      "TEXT",
    );
    this.ensureTableColumn("review_reservations", "payment_payer", "TEXT");
    this.ensureTableColumn("review_reservations", "payment_nonce", "TEXT");
    this.ensureTableColumn(
      "review_reservations",
      "settlement_recovery_at",
      "TEXT",
    );
    this.ensureTableColumn(
      "review_reservations",
      "quoted_review_price",
      "TEXT",
    );
    this.ensureTableColumn("review_reservations", "quoted_reward", "TEXT");
    this.ensureTableColumn("review_reservations", "quoted_network", "TEXT");
    this.ensureTableColumn("review_reservations", "phase", "TEXT");
    this.ensureTableColumn("review_reservations", "settlement_payer", "TEXT");
    this.ensureTableColumn("review_reservations", "settlement_amount", "TEXT");
    this.ensureTableColumn("review_reservations", "settlement_network", "TEXT");
    this.ensureTableColumn(
      "review_reservations",
      "settlement_transaction",
      "TEXT",
    );
    this.ensureTableColumn("review_reservations", "reconcile_error", "TEXT");
    this.ensureTableColumn("review_reservations", "updated_at", "TEXT");
    this.sqlite
      .prepare(
        `UPDATE review_reservations
            SET phase = COALESCE(phase, 'payment_pending'),
                updated_at = COALESCE(updated_at, created_at)`,
      )
      .run();
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS review_reservations_signature_unique_idx
        ON review_reservations(payment_signature_hash)
        WHERE payment_signature_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS review_reservations_authorization_unique_idx
        ON review_reservations(payment_authorization_key)
        WHERE payment_authorization_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS review_reservations_settlement_unique_idx
        ON review_reservations(settlement_transaction)
        WHERE settlement_transaction IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS review_orders_signature_unique_idx
        ON review_orders(payment_signature_hash)
        WHERE payment_signature_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS review_orders_authorization_unique_idx
        ON review_orders(payment_authorization_key)
        WHERE payment_authorization_key IS NOT NULL;
    `);
    this.sqlite
      .prepare(
        `UPDATE review_orders
            SET escalation_reason_code = 'human_lane_requested',
                escalation_cause = ?
          WHERE lower(escalation_reason_hash) = lower(?)
            AND (escalation_reason_code IS NULL OR escalation_cause IS NULL)`,
      )
      .run(HUMAN_LANE_REASON, HUMAN_LANE_REASON_HASH);
    this.backfillReviewerSnapshots();
  }

  private ensureOrderColumn(name: string, type: "TEXT"): void {
    this.ensureTableColumn("review_orders", name, type);
  }

  private ensureTableColumn(
    table: "review_orders" | "review_reservations",
    name: string,
    type: "TEXT",
  ): void {
    const columns = this.sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  private backfillReviewerSnapshots(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT o.id, r.id AS reviewer_id, r.alias, r.payout_address,
                r.telegram_user_id
           FROM review_orders o
           JOIN reviewers r ON r.id = o.reviewer_id
          WHERE o.reviewer_alias IS NULL
             OR o.reviewer_payout_address IS NULL
             OR o.reviewer_telegram_identity_hash IS NULL`,
      )
      .all() as Array<{
      id: string;
      reviewer_id: string;
      alias: string;
      payout_address: string;
      telegram_user_id: string;
    }>;
    const update = this.sqlite.prepare(
      `UPDATE review_orders
          SET reviewer_alias = ?, reviewer_payout_address = ?,
              reviewer_telegram_identity_hash = ?
        WHERE id = ?`,
    );
    for (const row of rows) {
      update.run(
        row.alias,
        getAddress(row.payout_address),
        keccak256(toBytes(`telegram:${row.telegram_user_id}`)),
        row.id,
      );
    }
  }

  close(): void {
    this.sqlite.close();
  }

  getDashboardChainSnapshot(): DashboardChainSnapshot | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM dashboard_chain_snapshots
          WHERE id = ? AND version = ?`,
      )
      .get(
        DASHBOARD_CHAIN_SNAPSHOT_ID,
        DASHBOARD_CHAIN_SNAPSHOT_VERSION,
      ) as DashboardSnapshotRow | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.snapshot_json) as unknown;
    if (!isDashboardChainSnapshot(parsed)) {
      throw new Error("stored dashboard chain snapshot has an invalid shape");
    }
    return parsed;
  }

  putDashboardChainSnapshot(snapshot: DashboardChainSnapshot): void {
    if (!isDashboardChainSnapshot(snapshot)) {
      throw new Error("dashboard chain snapshot has an invalid shape");
    }
    this.sqlite
      .prepare(
        `INSERT INTO dashboard_chain_snapshots (
           id, version, snapshot_json, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        DASHBOARD_CHAIN_SNAPSHOT_ID,
        DASHBOARD_CHAIN_SNAPSHOT_VERSION,
        JSON.stringify(snapshot),
        nowIso(),
      );
  }

  listDashboardPinnedJobIds(extraJobIds: string[] = []): string[] {
    const ids = new Set<string>();
    for (const jobId of extraJobIds) {
      if (/^(0|[1-9]\d*)$/.test(jobId)) ids.add(BigInt(jobId).toString());
    }
    const orderRows = this.sqlite
      .prepare("SELECT job_id FROM review_orders ORDER BY created_at DESC")
      .all() as Array<{ job_id: string }>;
    for (const row of orderRows) ids.add(row.job_id);
    if (this.tableExists("demo_runs")) {
      const demoRows = this.sqlite
        .prepare(
          `SELECT job_id FROM demo_runs
            WHERE job_id IS NOT NULL
            ORDER BY created_at DESC`,
        )
        .all() as Array<{ job_id: string | null }>;
      for (const row of demoRows) {
        if (row.job_id && /^(0|[1-9]\d*)$/.test(row.job_id)) {
          ids.add(BigInt(row.job_id).toString());
        }
      }
    }
    return [...ids];
  }

  listDashboardPinnedReviewMetadata(): DashboardPinnedReviewMetadata[] {
    const byJob = new Map<string, DashboardPinnedReviewMetadata>();
    const orders = this.sqlite
      .prepare(
        `SELECT job_id, deliverable_hash, escalation_reason_hash
           FROM review_orders
          ORDER BY created_at DESC`,
      )
      .all() as Array<{
      job_id: string;
      deliverable_hash: string;
      escalation_reason_hash: string;
    }>;
    for (const row of orders) {
      byJob.set(row.job_id, {
        jobId: row.job_id,
        deliverableHash: isHex32(row.deliverable_hash)
          ? row.deliverable_hash
          : null,
        reasonHash: isHex32(row.escalation_reason_hash)
          ? row.escalation_reason_hash
          : null,
        escalationTxHash: null,
      });
    }
    if (this.tableExists("demo_runs")) {
      const rows = this.sqlite
        .prepare(
          `SELECT job_id, deliverable_hash, escalation_tx
             FROM demo_runs
            WHERE job_id IS NOT NULL
            ORDER BY created_at DESC`,
        )
        .all() as Array<{
        job_id: string | null;
        deliverable_hash: string;
        escalation_tx: string | null;
      }>;
      for (const row of rows) {
        if (!row.job_id || !/^(0|[1-9]\d*)$/.test(row.job_id)) continue;
        const existing = byJob.get(row.job_id);
        byJob.set(row.job_id, {
          jobId: row.job_id,
          deliverableHash: isHex32(row.deliverable_hash)
            ? row.deliverable_hash
            : (existing?.deliverableHash ?? null),
          reasonHash: existing?.reasonHash ?? null,
          escalationTxHash: isHex32(row.escalation_tx)
            ? row.escalation_tx
            : (existing?.escalationTxHash ?? null),
        });
      }
    }
    return [...byJob.values()];
  }

  private tableExists(table: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = ?`,
      )
      .get(table);
    return Boolean(row);
  }

  storeAIEvidence(
    evidenceHash: Hex,
    evidenceInput: unknown,
  ): { evidence: StoredAIEvidence; created: boolean } {
    const evidence = parseAIEvidence(evidenceInput);
    if (!verifyAIEvidence(evidence, evidenceHash)) {
      throw new Error("AI evidence does not match its canonical hash");
    }
    if (evidence.reasonCode === "human_lane_requested") {
      throw new Error(
        "human-only lane provenance is not an AI evidence record",
      );
    }
    const normalizedHash = evidenceHash.toLowerCase() as Hex;
    const evidenceJson = serializeAIEvidence(evidence);
    return this.transaction(() => {
      const existing = this.getAIEvidence(normalizedHash);
      if (existing) {
        if (existing.evidenceJson !== evidenceJson) {
          throw new Error(
            "AI evidence hash is already bound to another record",
          );
        }
        return { evidence: existing, created: false };
      }
      const receivedAt = nowIso();
      this.sqlite
        .prepare(
          `INSERT INTO ai_evidence_records (
             evidence_hash, evidence_json, job_id, deliverable_hash,
             reason_code, received_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalizedHash,
          evidenceJson,
          evidence.jobId,
          evidence.deliverableHash,
          evidence.reasonCode,
          receivedAt,
        );
      return {
        evidence: {
          evidenceHash: normalizedHash,
          evidenceJson,
          evidence,
          receivedAt,
        },
        created: true,
      };
    });
  }

  getAIEvidence(hash: Hex): StoredAIEvidence | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM ai_evidence_records
          WHERE lower(evidence_hash) = lower(?)`,
      )
      .get(hash) as AIEvidenceRow | undefined;
    if (!row) return undefined;
    const evidence = parseAIEvidence(JSON.parse(row.evidence_json));
    const evidenceHash = row.evidence_hash as Hex;
    if (
      !verifyAIEvidence(evidence, evidenceHash) ||
      evidence.jobId !== row.job_id ||
      evidence.deliverableHash.toLowerCase() !==
        row.deliverable_hash.toLowerCase() ||
      evidence.reasonCode !== row.reason_code
    ) {
      throw new Error("stored AI evidence failed integrity verification");
    }
    return {
      evidenceHash,
      evidenceJson: row.evidence_json,
      evidence,
      receivedAt: row.received_at,
    };
  }

  upsertReviewer(input: UpsertReviewerInput): Reviewer {
    const telegramUserId = input.telegramUserId.trim();
    const telegramChatId = input.telegramChatId.trim();
    const alias = input.alias.trim();
    if (telegramUserId.length > 32 || !/^[1-9]\d*$/.test(telegramUserId)) {
      throw new Error(
        "reviewer Telegram user id must be a positive numeric id",
      );
    }
    if (telegramChatId.length > 32 || !/^-?[1-9]\d*$/.test(telegramChatId)) {
      throw new Error("reviewer Telegram chat id must be a numeric chat id");
    }
    if (!alias || alias.length > 80) {
      throw new Error("reviewer alias must contain 1 to 80 characters");
    }
    if (
      !Array.isArray(input.skills) ||
      input.skills.length > 20 ||
      input.skills.some(
        (skill) =>
          typeof skill !== "string" ||
          !skill.trim() ||
          skill.trim().length > 64,
      )
    ) {
      throw new Error(
        "reviewer skills must contain at most 20 non-empty values up to 64 characters",
      );
    }
    if (input.active !== undefined && typeof input.active !== "boolean") {
      throw new Error("reviewer active status must be a boolean");
    }
    const payoutAddress = getAddress(input.payoutAddress);
    if (payoutAddress === zeroAddress) {
      throw new Error("reviewer payout address cannot be the zero address");
    }
    const existing = this.sqlite
      .prepare("SELECT * FROM reviewers WHERE telegram_user_id = ?")
      .get(telegramUserId) as ReviewerRow | undefined;
    const chatOwner = this.sqlite
      .prepare(
        `SELECT id FROM reviewers
          WHERE telegram_chat_id = ? AND telegram_user_id != ?`,
      )
      .get(telegramChatId, telegramUserId) as { id: string } | undefined;
    if (chatOwner) {
      throw new Error(
        "reviewer Telegram chat id is already assigned to another reviewer",
      );
    }
    const timestamp = nowIso();
    const skillsJson = JSON.stringify(
      [
        ...new Set(input.skills.map((skill) => skill.trim()).filter(Boolean)),
      ].sort(),
    );
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE reviewers
             SET telegram_chat_id = ?, alias = ?, payout_address = ?,
                 skills_json = ?, active = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          telegramChatId,
          alias,
          payoutAddress,
          skillsJson,
          input.active === false ? 0 : 1,
          timestamp,
          existing.id,
        );
      return this.getReviewer(existing.id)!;
    }
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO reviewers (
           id, telegram_user_id, telegram_chat_id, alias, payout_address,
           skills_json, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        telegramUserId,
        telegramChatId,
        alias,
        payoutAddress,
        skillsJson,
        input.active === false ? 0 : 1,
        timestamp,
        timestamp,
      );
    return this.getReviewer(id)!;
  }

  setReviewerActive(id: string, active: boolean): Reviewer | undefined {
    this.sqlite
      .prepare("UPDATE reviewers SET active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, nowIso(), id);
    return this.getReviewer(id);
  }

  getReviewer(id: string): Reviewer | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM reviewers WHERE id = ?")
      .get(id) as ReviewerRow | undefined;
    return row ? reviewerFromRow(row) : undefined;
  }

  getReviewerByTelegramUserId(telegramUserId: string): Reviewer | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM reviewers WHERE telegram_user_id = ?")
      .get(telegramUserId) as ReviewerRow | undefined;
    return row ? reviewerFromRow(row) : undefined;
  }

  getReviewerByAddress(address: Address): Reviewer | undefined {
    const current = this.sqlite
      .prepare("SELECT * FROM reviewers WHERE lower(payout_address) = lower(?)")
      .get(address) as ReviewerRow | undefined;
    if (current) return reviewerFromRow(current);
    const historical = this.sqlite
      .prepare(
        `SELECT r.* FROM reviewers r
           JOIN review_orders o ON o.reviewer_id = r.id
          WHERE lower(o.reviewer_payout_address) = lower(?)
          ORDER BY o.claimed_at DESC
          LIMIT 1`,
      )
      .get(address) as ReviewerRow | undefined;
    return historical ? reviewerFromRow(historical) : undefined;
  }

  listReviewers(activeOnly = false): Reviewer[] {
    const rows = this.sqlite
      .prepare(
        activeOnly
          ? "SELECT * FROM reviewers WHERE active = 1 ORDER BY alias"
          : "SELECT * FROM reviewers ORDER BY alias",
      )
      .all() as unknown as ReviewerRow[];
    return rows.map(reviewerFromRow);
  }

  listEligibleReviewers(
    client: Address,
    provider: Address,
    additionalConflicts: Address[] = [],
  ): Reviewer[] {
    const conflicts = [client, provider, ...additionalConflicts];
    const clauses = conflicts
      .map(() => "lower(payout_address) != lower(?)")
      .join(" AND ");
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM reviewers
          WHERE active = 1
            AND ${clauses}
          ORDER BY created_at`,
      )
      .all(...conflicts) as unknown as ReviewerRow[];
    return rows.map(reviewerFromRow);
  }

  acquireReviewReservation(
    requestId: string,
    jobId: string,
    intent: Record<string, unknown> | undefined,
    gatewayPayment: GatewayPaymentReservationInput | undefined,
    quote: { reviewPrice: string; reward: string; network: string },
  ):
    | { status: "acquired"; token: string }
    | { status: "existing"; order: ReviewOrder }
    | { status: "busy" } {
    if (
      !/^\d+$/.test(quote.reviewPrice) ||
      !/^\d+$/.test(quote.reward) ||
      !quote.network.trim()
    ) {
      throw new Error("review reservation quote is invalid");
    }
    const paymentSignatureHash = gatewayPayment?.signatureHash;
    const paymentAuthorizationKey = gatewayPayment?.authorizationKey;
    return this.transaction(() => {
      this.sqlite
        .prepare(
          `DELETE FROM review_reservations
            WHERE phase = 'payment_pending'
              AND settlement_recovery_at IS NULL
              AND expires_at <= ?`,
        )
        .run(nowIso());
      const existing = this.findOrderByRequestOrJob(requestId, jobId);
      if (existing) return { status: "existing", order: existing };

      const timestamp = nowIso();
      if (paymentSignatureHash && paymentAuthorizationKey) {
        const signatureReservation = this.sqlite
          .prepare(
            `SELECT token FROM review_reservations
              WHERE lower(payment_signature_hash) = lower(?)
                 OR lower(payment_authorization_key) = lower(?)
             UNION ALL
             SELECT id AS token FROM review_orders
              WHERE lower(payment_signature_hash) = lower(?)
                 OR lower(payment_authorization_key) = lower(?)
             LIMIT 1`,
          )
          .get(
            paymentSignatureHash,
            paymentAuthorizationKey,
            paymentSignatureHash,
            paymentAuthorizationKey,
          ) as { token: string } | undefined;
        if (signatureReservation) {
          const intendedReservation = this.sqlite
            .prepare(
              `SELECT token FROM review_reservations
                WHERE request_id = ? AND job_id = ?`,
            )
            .get(requestId, jobId) as { token: string } | undefined;
          if (signatureReservation.token !== intendedReservation?.token) {
            return { status: "busy" };
          }
        }
      }
      const existingReservation = this.sqlite
        .prepare(
          `SELECT * FROM review_reservations
            WHERE request_id = ? OR job_id = ?
            ORDER BY created_at
            LIMIT 1`,
        )
        .get(requestId, jobId) as ReviewReservationRow | undefined;
      if (existingReservation) {
        const exactIntent =
          existingReservation.request_id === requestId &&
          existingReservation.job_id === jobId;
        const active = Date.parse(existingReservation.expires_at) > Date.now();
        const sameQuote =
          existingReservation.quoted_review_price === quote?.reviewPrice &&
          existingReservation.quoted_reward === quote?.reward &&
          existingReservation.quoted_network === quote?.network;
        if (
          !exactIntent ||
          existingReservation.phase === "settled" ||
          active ||
          existingReservation.settlement_recovery_at !== null ||
          !sameQuote
        ) {
          return { status: "busy" };
        }
        const token = randomUUID();
        const expiresAt = new Date(
          Date.now() + REVIEW_RESERVATION_LEASE_MS,
        ).toISOString();
        const renewed = this.sqlite
          .prepare(
            `UPDATE review_reservations
                SET token = ?, intent_json = ?,
                    payment_signature_hash = ?,
                    payment_authorization_key = ?,
                    payment_payload_json = ?,
                    payment_requirements_json = ?,
                    payment_payer = ?,
                    payment_nonce = ?,
                    settlement_recovery_at = NULL,
                    reconcile_error = NULL,
                    phase = 'payment_pending', expires_at = ?, updated_at = ?
              WHERE token = ? AND phase = 'payment_pending'`,
          )
          .run(
            token,
            intent ? JSON.stringify(intent) : existingReservation.intent_json,
            paymentSignatureHash ?? null,
            paymentAuthorizationKey ?? null,
            gatewayPayment
              ? JSON.stringify(gatewayPayment.paymentPayload)
              : null,
            gatewayPayment
              ? JSON.stringify(gatewayPayment.paymentRequirements)
              : null,
            gatewayPayment?.payer ?? null,
            gatewayPayment?.nonce ?? null,
            expiresAt,
            timestamp,
            existingReservation.token,
          );
        return Number(renewed.changes) === 1
          ? { status: "acquired", token }
          : { status: "busy" };
      }
      const token = randomUUID();
      const expiresAt = new Date(
        Date.now() + REVIEW_RESERVATION_LEASE_MS,
      ).toISOString();
      const inserted = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO review_reservations (
             token, request_id, job_id, intent_json, payment_signature_hash,
             payment_authorization_key,
             payment_payload_json, payment_requirements_json, payment_payer,
             payment_nonce, settlement_recovery_at,
             quoted_review_price, quoted_reward, quoted_network, phase,
             expires_at, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'payment_pending', ?, ?, ?
           )`,
        )
        .run(
          token,
          requestId,
          jobId,
          intent ? JSON.stringify(intent) : null,
          paymentSignatureHash ?? null,
          paymentAuthorizationKey ?? null,
          gatewayPayment ? JSON.stringify(gatewayPayment.paymentPayload) : null,
          gatewayPayment
            ? JSON.stringify(gatewayPayment.paymentRequirements)
            : null,
          gatewayPayment?.payer ?? null,
          gatewayPayment?.nonce ?? null,
          null,
          quote?.reviewPrice ?? null,
          quote?.reward ?? null,
          quote?.network ?? null,
          expiresAt,
          timestamp,
          timestamp,
        );
      return Number(inserted.changes) === 1
        ? { status: "acquired", token }
        : { status: "busy" };
    });
  }

  releaseReviewReservation(token: string): void {
    this.sqlite
      .prepare(
        `DELETE FROM review_reservations
          WHERE token = ? AND phase = 'payment_pending'
            AND settlement_recovery_at IS NULL`,
      )
      .run(token);
  }

  markGatewaySettlementAttempt(
    token: string,
    paymentPayload: Record<string, unknown>,
    paymentRequirements: Record<string, unknown>,
  ): void {
    const timestamp = nowIso();
    const marked = this.sqlite
      .prepare(
        `UPDATE review_reservations
            SET payment_payload_json = ?, payment_requirements_json = ?,
                settlement_recovery_at = ?, reconcile_error = NULL,
                updated_at = ?
          WHERE token = ? AND phase = 'payment_pending'
            AND payment_signature_hash IS NOT NULL`,
      )
      .run(
        JSON.stringify(paymentPayload),
        JSON.stringify(paymentRequirements),
        new Date(
          Date.now() + GATEWAY_SETTLEMENT_RECOVERY_DELAY_MS,
        ).toISOString(),
        timestamp,
        token,
      );
    if (Number(marked.changes) !== 1) {
      throw new Error("review reservation was lost before Gateway settlement");
    }
  }

  discardExpiredUnattemptedReviewReservations(now = new Date()): string[] {
    return this.transaction(() => {
      const tokens = this.sqlite
        .prepare(
          `SELECT token FROM review_reservations
            WHERE phase = 'payment_pending'
              AND settlement_recovery_at IS NULL
              AND expires_at <= ?
            ORDER BY created_at`,
        )
        .all(now.toISOString()) as Array<{ token: string }>;
      if (tokens.length > 0) {
        const remove = this.sqlite.prepare(
          `DELETE FROM review_reservations
            WHERE token = ? AND phase = 'payment_pending'
              AND settlement_recovery_at IS NULL`,
        );
        for (const row of tokens) remove.run(row.token);
      }
      return tokens.map((row) => row.token);
    });
  }

  listRecoverableGatewayReservations(
    now = new Date(),
  ): RecoverableGatewayReservation[] {
    const rows = this.sqlite
      .prepare(
        `SELECT token, request_id, job_id, intent_json, payment_payload_json,
                payment_requirements_json,
                payment_payer, payment_nonce, quoted_review_price,
                quoted_reward, quoted_network
           FROM review_reservations
          WHERE phase = 'payment_pending'
            AND payment_signature_hash IS NOT NULL
            AND intent_json IS NOT NULL
            AND payment_payload_json IS NOT NULL
            AND payment_requirements_json IS NOT NULL
            AND payment_payer IS NOT NULL
            AND payment_nonce IS NOT NULL
            AND settlement_recovery_at IS NOT NULL
            AND settlement_recovery_at <= ?
          ORDER BY settlement_recovery_at, created_at`,
      )
      .all(now.toISOString()) as Array<{
      token: string;
      request_id: string;
      job_id: string;
      intent_json: string;
      payment_payload_json: string;
      payment_requirements_json: string;
      payment_payer: string;
      payment_nonce: string;
      quoted_review_price: string | null;
      quoted_reward: string | null;
      quoted_network: string | null;
    }>;
    return rows.map((row) => {
      return {
        token: row.token,
        requestId: row.request_id,
        jobId: row.job_id,
        intentJson: row.intent_json,
        paymentPayloadJson: row.payment_payload_json,
        paymentRequirementsJson: row.payment_requirements_json,
        payer: row.payment_payer,
        nonce: row.payment_nonce,
        reviewPrice: row.quoted_review_price,
        reward: row.quoted_reward,
        network: row.quoted_network,
      };
    });
  }

  deferGatewayReservationRecovery(
    token: string,
    error: string,
    delayMs = GATEWAY_SETTLEMENT_RECOVERY_DELAY_MS,
  ): void {
    this.sqlite
      .prepare(
        `UPDATE review_reservations
            SET reconcile_error = ?, settlement_recovery_at = ?, updated_at = ?
          WHERE token = ? AND phase = 'payment_pending'`,
      )
      .run(
        error,
        new Date(Date.now() + delayMs).toISOString(),
        nowIso(),
        token,
      );
  }

  reviewReservationLiabilityThrough(token?: string): bigint {
    let priority: { created_at: string; token: string } | undefined;
    if (token) {
      priority = this.sqlite
        .prepare(
          "SELECT created_at, token FROM review_reservations WHERE token = ?",
        )
        .get(token) as { created_at: string; token: string } | undefined;
      if (!priority) {
        throw new Error(
          "review reservation was lost before treasury admission",
        );
      }
    }
    const priorityClause = priority
      ? `AND (
           created_at < ?
           OR (created_at = ? AND token <= ?)
         )`
      : "";
    const rows = this.sqlite
      .prepare(
        `SELECT quoted_review_price, quoted_reward
           FROM review_reservations
          WHERE (
            phase = 'settled'
            OR payment_signature_hash IS NOT NULL
            OR expires_at > ?
          )
          ${priorityClause}`,
      )
      .all(
        nowIso(),
        ...(priority
          ? [priority.created_at, priority.created_at, priority.token]
          : []),
      ) as Array<{
      quoted_review_price: string | null;
      quoted_reward: string | null;
    }>;
    return rows.reduce((sum, row) => {
      if (
        !row.quoted_review_price ||
        !/^\d+$/.test(row.quoted_review_price) ||
        !row.quoted_reward ||
        !/^\d+$/.test(row.quoted_reward)
      ) {
        throw new Error("active review reservation has an invalid quote");
      }
      const reviewPrice = BigInt(row.quoted_review_price);
      const reward = BigInt(row.quoted_reward);
      return sum + reviewPrice + reward;
    }, 0n);
  }

  recordReviewReservationSettlement(
    token: string,
    payment: ReviewPayment,
  ): void {
    if (!payment.transaction?.trim()) {
      throw new Error(
        "settled review payment requires a transaction reference",
      );
    }
    this.transaction(() => {
      const reservation = this.sqlite
        .prepare("SELECT * FROM review_reservations WHERE token = ?")
        .get(token) as ReviewReservationRow | undefined;
      if (!reservation) {
        throw new Error("review payment reservation was lost");
      }
      if (
        !reservation.quoted_review_price ||
        !reservation.quoted_reward ||
        !reservation.quoted_network
      ) {
        throw new Error("review payment reservation is missing its quote");
      }
      if (
        payment.amount !== reservation.quoted_review_price ||
        payment.network !== reservation.quoted_network
      ) {
        throw new Error(
          "review settlement does not match its immutable payment quote",
        );
      }
      if (
        reservation.payment_payer &&
        getAddress(reservation.payment_payer) !== getAddress(payment.payer)
      ) {
        throw new Error(
          "review settlement payer does not match its signed payment authorization",
        );
      }
      if (reservation.phase === "settled") {
        if (
          reservation.settlement_transaction !== payment.transaction ||
          reservation.settlement_payer?.toLowerCase() !==
            payment.payer.toLowerCase() ||
          reservation.settlement_amount !== payment.amount ||
          reservation.settlement_network !== payment.network
        ) {
          throw new Error(
            "review reservation was settled with different payment provenance",
          );
        }
        return;
      }
      const reusedPayment = this.sqlite
        .prepare(
          `SELECT token FROM review_reservations
            WHERE settlement_transaction = ? AND token != ?
          UNION ALL
          SELECT id AS token FROM review_orders
            WHERE gateway_transaction = ?
          LIMIT 1`,
        )
        .get(payment.transaction, token, payment.transaction) as
        { token: string } | undefined;
      if (reusedPayment) {
        throw new Error(
          "Gateway payment is already associated with another review",
        );
      }
      this.sqlite
        .prepare(
          `UPDATE review_reservations
              SET phase = 'settled', settlement_payer = ?,
                  settlement_amount = ?, settlement_network = ?,
                  settlement_transaction = ?,
                  reconcile_error = NULL,
                  settlement_recovery_at = NULL,
                  expires_at = '9999-12-31T23:59:59.999Z', updated_at = ?
            WHERE token = ? AND phase = 'payment_pending'`,
        )
        .run(
          getAddress(payment.payer),
          payment.amount,
          payment.network,
          payment.transaction,
          nowIso(),
          token,
        );
    });
  }

  promoteReviewReservation(
    token: string,
  ): { order: ReviewOrder; created: boolean } | undefined {
    const reservation = this.sqlite
      .prepare("SELECT * FROM review_reservations WHERE token = ?")
      .get(token) as ReviewReservationRow | undefined;
    if (!reservation || reservation.phase !== "settled") return undefined;
    if (
      !reservation.intent_json ||
      !reservation.settlement_payer ||
      !reservation.settlement_amount ||
      !reservation.settlement_network ||
      !reservation.settlement_transaction ||
      !reservation.quoted_review_price ||
      !reservation.quoted_reward ||
      !reservation.quoted_network
    ) {
      throw new Error("settled review reservation is missing provenance");
    }
    const intent = JSON.parse(reservation.intent_json) as {
      request?: {
        requestId?: unknown;
        jobId?: unknown;
        deliverable?: { content?: unknown };
      };
      validatedJob?: ValidatedReviewJob;
    };
    if (
      intent.request?.requestId !== reservation.request_id ||
      intent.request.jobId !== reservation.job_id ||
      typeof intent.request.deliverable?.content !== "string" ||
      intent.validatedJob?.jobId !== reservation.job_id
    ) {
      throw new Error("settled review reservation contains an invalid intent");
    }
    return this.createOrder({
      requestId: reservation.request_id,
      deliverableContent: intent.request.deliverable.content,
      job: intent.validatedJob,
      payment: {
        verified: true,
        payer: getAddress(reservation.settlement_payer),
        amount: reservation.settlement_amount,
        network: reservation.settlement_network,
        transaction: reservation.settlement_transaction,
      },
      reviewPrice: reservation.quoted_review_price,
      reward: reservation.quoted_reward,
      reservationToken: token,
    });
  }

  reconcileSettledReviewReservations(): {
    orders: ReviewOrder[];
    failures: Array<{ token: string; error: string }>;
  } {
    const rows = this.sqlite
      .prepare(
        `SELECT token FROM review_reservations
          WHERE phase = 'settled' AND reconcile_error IS NULL
          ORDER BY created_at`,
      )
      .all() as Array<{ token: string }>;
    const orders: ReviewOrder[] = [];
    const failures: Array<{ token: string; error: string }> = [];
    for (const row of rows) {
      try {
        const promoted = this.promoteReviewReservation(row.token);
        if (!promoted) {
          throw new Error("settled review reservation disappeared");
        }
        orders.push(promoted.order);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sqlite
          .prepare(
            `UPDATE review_reservations
                SET reconcile_error = ?, updated_at = ?
              WHERE token = ? AND phase = 'settled'`,
          )
          .run(message, nowIso(), row.token);
        failures.push({ token: row.token, error: message });
      }
    }
    return { orders, failures };
  }

  createOrder(input: CreateReviewOrderInput): {
    order: ReviewOrder;
    created: boolean;
  } {
    return this.transaction(() => {
      const duplicate = this.findOrderByRequestOrJob(
        input.requestId,
        input.job.jobId,
      );
      if (duplicate) return { order: duplicate, created: false };
      let reservation: ReviewReservationRow | undefined;
      if (input.reservationToken) {
        reservation = this.sqlite
          .prepare(
            `SELECT * FROM review_reservations
              WHERE token = ? AND request_id = ? AND job_id = ?`,
          )
          .get(input.reservationToken, input.requestId, input.job.jobId) as
          ReviewReservationRow | undefined;
        if (!reservation) {
          throw new Error("review order reservation was lost");
        }
        if (reservation.phase !== "settled") {
          throw new Error(
            "review order reservation must be durably settled before promotion",
          );
        }
        if (
          reservation.quoted_review_price !== input.reviewPrice ||
          reservation.quoted_reward !== input.reward ||
          reservation.quoted_network !== input.payment.network ||
          input.payment.amount !== reservation.quoted_review_price ||
          (reservation.payment_payer !== null &&
            reservation.payment_payer.toLowerCase() !==
              input.payment.payer.toLowerCase()) ||
          reservation.settlement_transaction !== input.payment.transaction ||
          reservation.settlement_payer?.toLowerCase() !==
            input.payment.payer.toLowerCase() ||
          reservation.settlement_amount !== input.payment.amount ||
          reservation.settlement_network !== input.payment.network
        ) {
          throw new Error(
            "review order payment does not match its immutable reservation",
          );
        }
      }
      if (!input.job.escalationReasonCode || !input.job.escalationCause) {
        throw new Error("review order requires verified escalation provenance");
      }
      const timestamp = nowIso();
      const id = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO review_orders (
             id, request_id, job_id, payment_signature_hash,
             payment_authorization_key, state, payer, review_price, network,
             gateway_transaction, job_client, job_provider, job_description,
             job_budget, job_expired_at, deliverable_hash, deliverable_content,
             escalation_reason_hash, escalation_reason_code, escalation_cause,
             reward, payout_idempotency_key, resolution_idempotency_key,
             refund_idempotency_key, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          id,
          input.requestId,
          input.job.jobId,
          reservation?.payment_signature_hash ?? null,
          reservation?.payment_authorization_key ?? null,
          getAddress(input.payment.payer),
          input.reviewPrice,
          input.payment.network,
          input.payment.transaction ?? null,
          input.job.client,
          input.job.provider,
          input.job.description,
          input.job.budget,
          input.job.expiredAt,
          input.job.deliverableHash,
          input.deliverableContent,
          input.job.escalationReasonHash,
          input.job.escalationReasonCode,
          input.job.escalationCause,
          input.reward,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          timestamp,
          timestamp,
        );
      this.insertEvent(id, "payment_accepted", {
        payer: input.payment.payer,
        amount: input.payment.amount,
        network: input.payment.network,
        transaction: input.payment.transaction ?? null,
      });
      if (input.reservationToken) {
        this.sqlite
          .prepare("DELETE FROM review_reservations WHERE token = ?")
          .run(input.reservationToken);
      }
      return { order: this.getOrder(id)!, created: true };
    });
  }

  getOrder(id: string): ReviewOrder | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM review_orders WHERE id = ?")
      .get(id) as OrderRow | undefined;
    return row ? orderFromRow(row) : undefined;
  }

  getOrderByRequestId(requestId: string): ReviewOrder | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM review_orders WHERE request_id = ?")
      .get(requestId) as OrderRow | undefined;
    return row ? orderFromRow(row) : undefined;
  }

  getOrderByJobId(jobId: string): ReviewOrder | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM review_orders WHERE job_id = ?")
      .get(jobId) as OrderRow | undefined;
    return row ? orderFromRow(row) : undefined;
  }

  findOrderByRequestOrJob(
    requestId: string,
    jobId: string,
  ): ReviewOrder | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM review_orders
          WHERE request_id = ? OR job_id = ?
          ORDER BY created_at LIMIT 1`,
      )
      .get(requestId, jobId) as OrderRow | undefined;
    return row ? orderFromRow(row) : undefined;
  }

  listOrders(jobIds?: string[]): ReviewOrder[] {
    let rows: OrderRow[];
    if (jobIds && jobIds.length > 0) {
      const placeholders = jobIds.map(() => "?").join(",");
      rows = this.sqlite
        .prepare(
          `SELECT * FROM review_orders
            WHERE job_id IN (${placeholders})
            ORDER BY created_at DESC`,
        )
        .all(...jobIds) as unknown as OrderRow[];
    } else {
      rows = this.sqlite
        .prepare("SELECT * FROM review_orders ORDER BY created_at DESC")
        .all() as unknown as OrderRow[];
    }
    return rows.map(orderFromRow);
  }

  listOrdersInStates(states: ReviewOrderState[]): ReviewOrder[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM review_orders
          WHERE state IN (${placeholders})
          ORDER BY updated_at`,
      )
      .all(...states) as unknown as OrderRow[];
    return rows.map(orderFromRow);
  }

  recordCircleTransaction(
    orderId: string,
    operation: CircleOperation,
    transaction: CircleTransactionResult,
  ): CircleAttempt {
    return this.transaction(() =>
      this.recordCircleTransactionUnsafe(orderId, operation, transaction),
    );
  }

  markCircleRequestStarted(
    orderId: string,
    operation: CircleOperation,
  ): boolean {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) throw new Error("review order not found");
      const idempotencyKey = circleIdempotencyKey(order, operation);
      const timestamp = nowIso();
      const inserted = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO circle_request_journal (
             order_id, operation, idempotency_key, requested_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(orderId, operation, idempotencyKey, timestamp);
      if (Number(inserted.changes) === 1) {
        this.insertEvent(orderId, "circle_request_started", { operation });
        return true;
      }
      const existing = this.sqlite
        .prepare(
          `SELECT order_id, operation FROM circle_request_journal
            WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        { order_id: string; operation: CircleOperation } | undefined;
      if (existing?.order_id !== orderId || existing.operation !== operation) {
        throw new Error(
          "Circle idempotency key is journaled for another operation",
        );
      }
      return false;
    });
  }

  hasCurrentCircleRequestStarted(
    orderId: string,
    operation: CircleOperation,
  ): boolean {
    const order = this.getOrder(orderId);
    if (!order) throw new Error("review order not found");
    const row = this.sqlite
      .prepare(
        `SELECT 1 FROM circle_request_journal
          WHERE order_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(orderId, operation, circleIdempotencyKey(order, operation));
    return Boolean(row);
  }

  listCircleAttempts(
    orderId: string,
    operation?: CircleOperation,
  ): CircleAttempt[] {
    const rows = (operation
      ? this.sqlite
          .prepare(
            `SELECT * FROM circle_attempts
                WHERE order_id = ? AND operation = ?
                ORDER BY attempt_number`,
          )
          .all(orderId, operation)
      : this.sqlite
          .prepare(
            `SELECT * FROM circle_attempts
                WHERE order_id = ? ORDER BY operation, attempt_number`,
          )
          .all(orderId)) as unknown as CircleAttemptRow[];
    return rows.map(circleAttemptFromRow);
  }

  rotateCircleAttempt(
    orderId: string,
    operation: CircleOperation,
    terminalTransaction: CircleTransactionResult,
    maxAttempts: number,
  ): { rotated: boolean; attempts: number } {
    return this.transaction(() => {
      this.recordCircleTransactionUnsafe(
        orderId,
        operation,
        terminalTransaction,
      );
      const row = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS attempts FROM circle_attempts
            WHERE order_id = ? AND operation = ?`,
        )
        .get(orderId, operation) as { attempts: number };
      const attempts = Number(row.attempts);
      if (attempts >= maxAttempts) return { rotated: false, attempts };

      const columns = circleOperationColumns[operation];
      const nextKey = randomUUID();
      const timestamp = nowIso();
      const updated = this.sqlite
        .prepare(
          `UPDATE review_orders
             SET ${columns.id} = NULL, ${columns.hash} = NULL,
                 ${columns.key} = ?, updated_at = ?
           WHERE id = ? AND ${columns.id} = ?`,
        )
        .run(nextKey, timestamp, orderId, terminalTransaction.id);
      if (Number(updated.changes) !== 1) {
        throw new Error(
          `Circle ${operation} attempt is no longer current for this order`,
        );
      }
      this.insertEvent(orderId, "circle_retry_scheduled", {
        operation,
        terminalState: terminalTransaction.state,
        completedAttempts: attempts,
        maximumAttempts: maxAttempts,
      });
      return { rotated: true, attempts };
    });
  }

  resumeCircleOperation(
    orderId: string,
    operation: CircleOperation,
    maxAttempts: number,
  ): ReviewOrder {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("Circle maximum attempts must be a positive integer");
    }
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) {
        throw new CircleOperationResumeError(
          "review_order_not_found",
          "Review order was not found",
          404,
        );
      }
      const expectedState = circleOperationRecoveryStates[operation];
      if (order.state !== expectedState) {
        throw new CircleOperationResumeError(
          "invalid_circle_resume_state",
          `Circle ${operation} can only be resumed from ${expectedState}`,
          409,
        );
      }
      const attempts = this.listCircleAttempts(orderId, operation);
      const latest = attempts.at(-1);
      const currentIdempotencyKey = circleIdempotencyKey(order, operation);
      if (
        !latest ||
        attempts.length < maxAttempts ||
        !CIRCLE_TERMINAL_FAILURES.has(latest.state) ||
        latest.idempotencyKey !== currentIdempotencyKey
      ) {
        throw new CircleOperationResumeError(
          "circle_operation_not_exhausted",
          `Circle ${operation} has not exhausted its current retry budget`,
          409,
        );
      }

      const columns = circleOperationColumns[operation];
      const nextKey = randomUUID();
      const timestamp = nowIso();
      const updated = this.sqlite
        .prepare(
          `UPDATE review_orders
             SET ${columns.id} = NULL, ${columns.hash} = NULL,
                 ${columns.key} = ?, last_error = NULL, updated_at = ?
           WHERE id = ? AND state = ? AND ${columns.key} = ?`,
        )
        .run(
          nextKey,
          timestamp,
          orderId,
          expectedState,
          currentIdempotencyKey,
        );
      if (Number(updated.changes) !== 1) {
        throw new CircleOperationResumeError(
          "invalid_circle_resume_state",
          `Circle ${operation} recovery state changed before it could be resumed`,
          409,
        );
      }
      this.insertEvent(orderId, "circle_operator_resume", {
        operation,
        completedAttempts: attempts.length,
        terminalState: latest.state,
        previousCircleTransactionId: latest.circleTransactionId,
      });
      return this.getOrder(orderId)!;
    });
  }

  private recordCircleTransactionUnsafe(
    orderId: string,
    operation: CircleOperation,
    transaction: CircleTransactionResult,
  ): CircleAttempt {
    if (!transaction.id) throw new Error("Circle transaction id is required");
    const order = this.getOrder(orderId);
    if (!order) throw new Error("review order not found");
    const idempotencyKey = circleIdempotencyKey(order, operation);
    const existing = this.sqlite
      .prepare("SELECT * FROM circle_attempts WHERE idempotency_key = ?")
      .get(idempotencyKey) as CircleAttemptRow | undefined;
    const timestamp = nowIso();
    if (existing) {
      if (existing.circle_transaction_id !== transaction.id) {
        throw new Error(
          "Circle returned a different transaction for the same idempotency key",
        );
      }
      this.sqlite
        .prepare(
          `UPDATE circle_attempts
             SET state = ?, tx_hash = COALESCE(?, tx_hash), updated_at = ?
           WHERE id = ?`,
        )
        .run(transaction.state, transaction.txHash, timestamp, existing.id);
    } else {
      const attempt = this.sqlite
        .prepare(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
             FROM circle_attempts WHERE order_id = ? AND operation = ?`,
        )
        .get(orderId, operation) as { attempt_number: number };
      this.sqlite
        .prepare(
          `INSERT INTO circle_attempts (
             id, order_id, operation, attempt_number, idempotency_key,
             circle_transaction_id, state, tx_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          orderId,
          operation,
          Number(attempt.attempt_number),
          idempotencyKey,
          transaction.id,
          transaction.state,
          transaction.txHash,
          timestamp,
          timestamp,
        );
    }

    const columns = circleOperationColumns[operation];
    this.sqlite
      .prepare(
        `UPDATE review_orders
           SET ${columns.id} = ?, ${columns.hash} = COALESCE(?, ${columns.hash}),
               updated_at = ?
         WHERE id = ?`,
      )
      .run(transaction.id, transaction.txHash, timestamp, orderId);
    const row = this.sqlite
      .prepare("SELECT * FROM circle_attempts WHERE idempotency_key = ?")
      .get(idempotencyKey) as CircleAttemptRow;
    return circleAttemptFromRow(row);
  }

  reserveTelegramUpdate(updateId: number): TelegramUpdateReservation {
    if (!Number.isSafeInteger(updateId)) {
      throw new Error("Telegram update id must be a safe integer");
    }
    return this.transaction(() => {
      const timestamp = nowIso();
      const token = randomUUID();
      const inserted = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO telegram_updates (
             update_id, status, processing_token, attempts, received_at,
             updated_at
           ) VALUES (?, 'processing', ?, 1, ?, ?)`,
        )
        .run(updateId, token, timestamp, timestamp);
      if (Number(inserted.changes) === 1) {
        return { status: "acquired", token };
      }

      const existing = this.sqlite
        .prepare("SELECT * FROM telegram_updates WHERE update_id = ?")
        .get(updateId) as TelegramUpdateRow | undefined;
      if (!existing) {
        throw new Error("Telegram update reservation was not persisted");
      }
      if (existing.status === "processed") return { status: "processed" };

      const leaseExpired =
        existing.status === "processing" &&
        Date.parse(existing.updated_at) <=
          Date.now() - TELEGRAM_UPDATE_LEASE_MS;
      if (existing.status === "failed" || leaseExpired) {
        const reacquired = this.sqlite
          .prepare(
            `UPDATE telegram_updates
               SET status = 'processing', processing_token = ?,
                   attempts = attempts + 1, updated_at = ?,
                   processed_at = NULL, last_error = NULL
             WHERE update_id = ? AND status = ? AND updated_at = ?`,
          )
          .run(
            token,
            timestamp,
            updateId,
            existing.status,
            existing.updated_at,
          );
        if (Number(reacquired.changes) === 1) {
          return { status: "acquired", token };
        }
      }
      return { status: "processing" };
    });
  }

  completeTelegramUpdate(updateId: number, token: string): void {
    const timestamp = nowIso();
    const result = this.sqlite
      .prepare(
        `UPDATE telegram_updates
           SET status = 'processed', processing_token = NULL,
               processed_at = ?, updated_at = ?, last_error = NULL
         WHERE update_id = ? AND status = 'processing'
           AND processing_token = ?`,
      )
      .run(timestamp, timestamp, updateId, token);
    if (Number(result.changes) !== 1) {
      throw new Error("Telegram update reservation is no longer active");
    }
  }

  failTelegramUpdate(updateId: number, token: string, error: string): void {
    this.sqlite
      .prepare(
        `UPDATE telegram_updates
           SET status = 'failed', processing_token = NULL,
               updated_at = ?, last_error = ?
         WHERE update_id = ? AND status = 'processing'
           AND processing_token = ?`,
      )
      .run(nowIso(), error, updateId, token);
  }

  recordDispatch(
    orderId: string,
    reviewerId: string,
    telegramMessageId: string | null,
    claimExpiresAt: string,
  ): ReviewAssignment {
    return this.transaction(() => {
      const timestamp = nowIso();
      const id = randomUUID();
      const orderUpdate = this.sqlite
        .prepare(
          `UPDATE review_orders
             SET state = 'dispatched', claim_expires_at = ?,
                 dispatch_count = CASE
                   WHEN state = 'paid' THEN dispatch_count + 1
                   ELSE dispatch_count
                 END,
                 updated_at = ?,
                 last_error = NULL
           WHERE id = ? AND state IN ('paid', 'dispatched')`,
        )
        .run(claimExpiresAt, timestamp, orderId);
      if (Number(orderUpdate.changes) !== 1) {
        throw new Error("review order is no longer dispatchable");
      }
      this.sqlite
        .prepare(
          `INSERT INTO review_assignments (
             id, order_id, reviewer_id, status, telegram_message_id,
             offered_at, updated_at
           ) VALUES (?, ?, ?, 'offered', ?, ?, ?)
           ON CONFLICT(order_id, reviewer_id) DO UPDATE SET
             status = 'offered',
             telegram_message_id = excluded.telegram_message_id,
             offered_at = excluded.offered_at,
             claimed_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(id, orderId, reviewerId, telegramMessageId, timestamp, timestamp);
      this.insertEvent(orderId, "review_dispatched", {
        reviewerId,
        telegramMessageId,
        claimExpiresAt,
      });
      return this.getAssignment(orderId, reviewerId)!;
    });
  }

  getAssignment(
    orderId: string,
    reviewerId: string,
  ): ReviewAssignment | undefined {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM review_assignments WHERE order_id = ? AND reviewer_id = ?",
      )
      .get(orderId, reviewerId) as AssignmentRow | undefined;
    return row ? assignmentFromRow(row) : undefined;
  }

  claimOrder(
    orderId: string,
    reviewerId: string,
    reviewSlaSeconds: number,
    additionalConflicts: Address[] = [],
  ): ReviewOrder {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) throw new Error("review order not found");
      if (order.state === "claimed" && order.reviewerId === reviewerId) {
        return order;
      }
      if (order.state !== "dispatched") {
        throw new Error("review order is no longer available");
      }
      const nowMs = Date.now();
      const timestamp = new Date(nowMs).toISOString();
      if (reviewSlaElapsed(order, reviewSlaSeconds, nowMs)) {
        throw new Error("review SLA has elapsed");
      }
      if (order.claimExpiresAt && Date.parse(order.claimExpiresAt) <= nowMs) {
        throw new Error("review offer has expired");
      }
      const assignment = this.getAssignment(orderId, reviewerId);
      if (!assignment || assignment.status !== "offered") {
        throw new Error("reviewer was not offered this order");
      }
      const reviewer = this.getReviewer(reviewerId);
      if (!reviewer?.active) {
        throw new Error("reviewer is no longer active");
      }
      if (
        reviewer.payoutAddress.toLowerCase() ===
          order.jobClient.toLowerCase() ||
        reviewer.payoutAddress.toLowerCase() ===
          order.jobProvider.toLowerCase() ||
        additionalConflicts.some(
          (address) =>
            reviewer.payoutAddress.toLowerCase() === address.toLowerCase(),
        )
      ) {
        throw new Error(
          "client/provider/resolver conflicts cannot claim this review",
        );
      }
      const result = this.sqlite
        .prepare(
          `UPDATE review_orders
             SET state = 'claimed', reviewer_id = ?, reviewer_alias = ?,
                 reviewer_payout_address = ?,
                 reviewer_telegram_identity_hash = ?, claimed_at = ?,
                 claim_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'dispatched'`,
        )
        .run(
          reviewerId,
          reviewer.alias,
          reviewer.payoutAddress,
          keccak256(toBytes(`telegram:${reviewer.telegramUserId}`)),
          timestamp,
          timestamp,
          orderId,
        );
      if (Number(result.changes) !== 1) {
        throw new Error("another reviewer already claimed this order");
      }
      this.sqlite
        .prepare(
          `UPDATE review_assignments
             SET status = CASE WHEN reviewer_id = ? THEN 'claimed' ELSE 'expired' END,
                 claimed_at = CASE WHEN reviewer_id = ? THEN ? ELSE claimed_at END,
                 updated_at = ?
           WHERE order_id = ? AND status = 'offered'`,
        )
        .run(reviewerId, reviewerId, timestamp, timestamp, orderId);
      this.insertEvent(orderId, "review_claimed", {
        reviewerId,
        reviewerAlias: reviewer.alias,
        reviewerAddress: reviewer.payoutAddress,
      });
      return this.getOrder(orderId)!;
    });
  }

  getReviewerSnapshot(order: ReviewOrder): ReviewerSnapshot | undefined {
    if (
      !order.reviewerId ||
      !order.reviewerAlias ||
      !order.reviewerPayoutAddress ||
      !order.reviewerTelegramIdentityHash
    ) {
      return undefined;
    }
    return {
      reviewerId: order.reviewerId,
      alias: order.reviewerAlias,
      payoutAddress: order.reviewerPayoutAddress,
      telegramIdentityHash: order.reviewerTelegramIdentityHash,
    };
  }

  submitVerdict(
    orderId: string,
    reviewerId: string,
    decision: ReviewDecision,
    reasoning: string,
    reviewSlaSeconds: number,
  ): ReviewOrder {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) throw new Error("review order not found");
      if (
        order.state === "verdict_submitted" &&
        order.reviewerId === reviewerId
      ) {
        return order;
      }
      if (order.state !== "claimed" || order.reviewerId !== reviewerId) {
        throw new Error("only the assigned reviewer can submit this verdict");
      }
      const nowMs = Date.now();
      const timestamp = new Date(nowMs).toISOString();
      if (reviewSlaElapsed(order, reviewSlaSeconds, nowMs)) {
        throw new Error("review SLA has elapsed");
      }
      this.sqlite
        .prepare(
          `INSERT INTO review_votes (
             id, order_id, reviewer_id, decision, reasoning, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), orderId, reviewerId, decision, reasoning, timestamp);
      this.sqlite
        .prepare(
          `UPDATE review_orders
             SET state = 'verdict_submitted', decision = ?, reasoning = ?,
                 verdict_at = ?, updated_at = ?, last_error = NULL
           WHERE id = ?`,
        )
        .run(decision, reasoning, timestamp, timestamp, orderId);
      this.insertEvent(orderId, "verdict_submitted", {
        reviewerId,
        decision,
        reasoning,
      });
      return this.getOrder(orderId)!;
    });
  }

  applyReviewTimeouts(
    orderId: string,
    reviewSlaSeconds: number,
    maxDispatches: number,
  ): {
    action: "none" | "redispatched" | "expired";
    order?: ReviewOrder;
  } {
    if (!Number.isSafeInteger(maxDispatches) || maxDispatches < 1) {
      throw new Error("max dispatches must be a positive safe integer");
    }
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) return { action: "none" };

      const nowMs = Date.now();
      const timestamp = new Date(nowMs).toISOString();
      if (
        (order.state === "paid" ||
          order.state === "dispatched" ||
          order.state === "claimed") &&
        reviewSlaElapsed(order, reviewSlaSeconds, nowMs)
      ) {
        const result = this.sqlite
          .prepare(
            `UPDATE review_orders
               SET state = 'expired', claim_expires_at = NULL,
                   last_error = NULL, updated_at = ?
             WHERE id = ? AND state = ?`,
          )
          .run(timestamp, orderId, order.state);
        if (Number(result.changes) !== 1) {
          throw new Error("review order changed while applying its SLA");
        }
        this.expireOfferedAssignments(orderId, timestamp);
        this.insertEvent(
          orderId,
          "review_expired",
          { reason: "review SLA elapsed" },
          timestamp,
        );
        return {
          action: "expired",
          order: this.getOrder(orderId)!,
        };
      }

      if (
        order.state !== "dispatched" ||
        !order.claimExpiresAt ||
        Date.parse(order.claimExpiresAt) > nowMs
      ) {
        return { action: "none", order };
      }

      this.expireOfferedAssignments(orderId, timestamp);
      if (order.dispatchCount < maxDispatches) {
        const result = this.sqlite
          .prepare(
            `UPDATE review_orders
               SET state = 'paid', claim_expires_at = NULL,
                   last_error = NULL, updated_at = ?
             WHERE id = ? AND state = 'dispatched'
               AND claim_expires_at = ?`,
          )
          .run(timestamp, orderId, order.claimExpiresAt);
        if (Number(result.changes) !== 1) {
          throw new Error("review order changed while applying its claim TTL");
        }
        this.insertEvent(
          orderId,
          "review_redispatched",
          { previousDispatchCount: order.dispatchCount },
          timestamp,
        );
        return {
          action: "redispatched",
          order: this.getOrder(orderId)!,
        };
      }

      const result = this.sqlite
        .prepare(
          `UPDATE review_orders
             SET state = 'expired', claim_expires_at = NULL,
                 last_error = NULL, updated_at = ?
           WHERE id = ? AND state = 'dispatched'
             AND claim_expires_at = ?`,
        )
        .run(timestamp, orderId, order.claimExpiresAt);
      if (Number(result.changes) !== 1) {
        throw new Error("review order changed while applying its claim TTL");
      }
      this.insertEvent(
        orderId,
        "review_expired",
        { reason: "no reviewer claimed the final dispatch" },
        timestamp,
      );
      return {
        action: "expired",
        order: this.getOrder(orderId)!,
      };
    });
  }

  updateOrder(
    orderId: string,
    state: ReviewOrderState,
    fields: Partial<{
      evidenceHash: Hex;
      evidenceJson: string;
      circlePayoutId: string;
      payoutTransactionHash: Hex;
      circleResolutionId: string;
      resolutionTransactionHash: Hex;
      circleRefundId: string;
      refundTransactionHash: Hex;
      paidAt: string;
      settledAt: string;
      settlementAbortCode: string | null;
      settlementAbortedAt: string | null;
      claimExpiresAt: string | null;
      lastError: string | null;
    }> = {},
    eventType?: string,
    eventPayload: Record<string, unknown> = {},
  ): ReviewOrder {
    return this.transaction(() => {
      const existing = this.getOrder(orderId);
      if (!existing) throw new Error("review order not found");
      const timestamp = nowIso();
      this.sqlite
        .prepare(
          `UPDATE review_orders SET
             state = ?,
             evidence_hash = COALESCE(?, evidence_hash),
             evidence_json = COALESCE(?, evidence_json),
             circle_payout_id = COALESCE(?, circle_payout_id),
             payout_tx_hash = COALESCE(?, payout_tx_hash),
             circle_resolution_id = COALESCE(?, circle_resolution_id),
             resolution_tx_hash = COALESCE(?, resolution_tx_hash),
             circle_refund_id = COALESCE(?, circle_refund_id),
             refund_tx_hash = COALESCE(?, refund_tx_hash),
             paid_at = COALESCE(?, paid_at),
             settled_at = COALESCE(?, settled_at),
             settlement_abort_code = ?,
             settlement_aborted_at = ?,
             claim_expires_at = ?,
             last_error = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          state,
          fields.evidenceHash ?? null,
          fields.evidenceJson ?? null,
          fields.circlePayoutId ?? null,
          fields.payoutTransactionHash ?? null,
          fields.circleResolutionId ?? null,
          fields.resolutionTransactionHash ?? null,
          fields.circleRefundId ?? null,
          fields.refundTransactionHash ?? null,
          fields.paidAt ?? null,
          fields.settledAt ?? null,
          Object.prototype.hasOwnProperty.call(fields, "settlementAbortCode")
            ? (fields.settlementAbortCode ?? null)
            : existing.settlementAbortCode,
          Object.prototype.hasOwnProperty.call(fields, "settlementAbortedAt")
            ? (fields.settlementAbortedAt ?? null)
            : existing.settlementAbortedAt,
          Object.prototype.hasOwnProperty.call(fields, "claimExpiresAt")
            ? (fields.claimExpiresAt ?? null)
            : existing.claimExpiresAt,
          fields.lastError === undefined
            ? existing.lastError
            : fields.lastError,
          timestamp,
          orderId,
        );
      if (eventType) this.insertEvent(orderId, eventType, eventPayload);
      return this.getOrder(orderId)!;
    });
  }

  expireAssignments(orderId: string): void {
    this.expireOfferedAssignments(orderId, nowIso());
  }

  private expireOfferedAssignments(orderId: string, timestamp: string): void {
    this.sqlite
      .prepare(
        `UPDATE review_assignments
           SET status = 'expired', updated_at = ?
         WHERE order_id = ? AND status = 'offered'`,
      )
      .run(timestamp, orderId);
  }

  private insertEvent(
    orderId: string,
    type: string,
    payload: Record<string, unknown>,
    createdAt = nowIso(),
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO review_events (order_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(orderId, type, JSON.stringify(payload), createdAt);
  }

  addEvent(
    orderId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.insertEvent(orderId, type, payload);
  }

  listEvents(orderId: string): ReviewEvent[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM review_events WHERE order_id = ? ORDER BY id")
      .all(orderId) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  getEvidence(hash: Hex):
    | {
        evidenceHash: Hex;
        evidenceJson: string;
        type: "ai-v1" | "human-v1";
      }
    | undefined {
    const human = this.sqlite
      .prepare(
        `SELECT evidence_hash, evidence_json FROM review_orders
          WHERE lower(evidence_hash) = lower(?) AND evidence_json IS NOT NULL`,
      )
      .get(hash) as
      { evidence_hash: string; evidence_json: string } | undefined;
    if (human) {
      return {
        evidenceHash: human.evidence_hash as Hex,
        evidenceJson: human.evidence_json,
        type: "human-v1",
      };
    }
    const ai = this.getAIEvidence(hash);
    return ai
      ? {
          evidenceHash: ai.evidenceHash,
          evidenceJson: ai.evidenceJson,
          type: "ai-v1",
        }
      : undefined;
  }

  publicOrder(order: ReviewOrder, publicBaseUrl: string): PublicReviewOrder {
    const reviewer = this.getReviewerSnapshot(order);
    return {
      orderId: order.id,
      requestId: order.requestId,
      jobId: order.jobId,
      state: order.state,
      payer: order.payer,
      reviewPrice: order.reviewPrice,
      network: order.network,
      gatewayTransaction: order.gatewayTransaction,
      deliverableHash: order.deliverableHash,
      escalationReasonHash: order.escalationReasonHash,
      escalationReasonCode: order.escalationReasonCode,
      escalationCause: order.escalationCause,
      reviewer: reviewer
        ? { alias: reviewer.alias, address: reviewer.payoutAddress }
        : null,
      decision: order.decision,
      reasoning: order.reasoning,
      evidenceHash: order.evidenceHash,
      reward: order.reward,
      payoutTransactionHash: order.payoutTransactionHash,
      resolutionTransactionHash: order.resolutionTransactionHash,
      refundTransactionHash: order.refundTransactionHash,
      createdAt: order.createdAt,
      claimedAt: order.claimedAt,
      verdictAt: order.verdictAt,
      paidAt: order.paidAt,
      settledAt: order.settledAt,
      settlementAbortCode: order.settlementAbortCode,
      settlementAbortedAt: order.settlementAbortedAt,
      updatedAt: order.updatedAt,
      lastError: publicOrderError(order),
      statusUrl: `${publicBaseUrl}/v1/review-orders/${order.id}`,
      evidenceUrl: order.evidenceHash
        ? `${publicBaseUrl}/v1/evidence/${order.evidenceHash}`
        : null,
    };
  }

  internalOrder(
    order: ReviewOrder,
    publicBaseUrl: string,
  ): InternalReviewOrder {
    let evidenceVerified: boolean | null = null;
    if (order.evidenceHash && order.evidenceJson) {
      try {
        evidenceVerified = verifyHumanEvidence(
          JSON.parse(order.evidenceJson) as HumanEvidenceV1,
          order.evidenceHash,
        );
      } catch {
        evidenceVerified = false;
      }
    }
    return {
      ...this.publicOrder(order, publicBaseUrl),
      jobDescription: order.jobDescription,
      deliverableContent: order.deliverableContent,
      circlePayoutId: order.circlePayoutId,
      circleResolutionId: order.circleResolutionId,
      circleRefundId: order.circleRefundId,
      claimExpiresAt: order.claimExpiresAt,
      dispatchCount: order.dispatchCount,
      events: this.listEvents(order.id),
      evidenceVerified,
      lastError: order.lastError,
    };
  }
}
