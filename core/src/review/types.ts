import type { Address, Hex } from "viem";
import type { ReasonCode } from "../validate.js";

export type DashboardSnapshotStatus =
  | "syncing"
  | "ready"
  | "stale"
  | "degraded";

export interface DashboardJobRecord {
  id: string;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: string;
  budgetUsdc: string;
  expiredAt: number;
  statusCode: number;
  status: string;
  hook: Address;
}

export interface DashboardFeedRow extends DashboardJobRecord {
  provenance: "AI auto" | "escalated" | "human" | null;
  lane: "AI" | "human" | null;
  confidenceBP: number | null;
  statusTxHash: Hex | null;
  verdictTxHash: Hex | null;
  latestBlock: string;
}

export interface DashboardReviewRecord extends DashboardJobRecord {
  deliverableHash: Hex | null;
  reasonHash: Hex;
  escalationTxHash: Hex | null;
  clientRequested: boolean;
}

export interface DashboardChainSnapshot {
  version: 1;
  configured: boolean;
  status: DashboardSnapshotStatus;
  latestBlock: string | null;
  indexedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  feed: DashboardFeedRow[];
  reviewQueue: DashboardReviewRecord[];
}

export const reviewOrderStates = [
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
] as const;

export type ReviewOrderState = (typeof reviewOrderStates)[number];
export type ReviewDecision = "approve" | "reject";

export interface ReviewPayment {
  verified: boolean;
  payer: Address;
  amount: string;
  network: string;
  transaction?: string;
}

export interface ValidatedReviewJob {
  jobId: string;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: string;
  expiredAt: string;
  deliverableHash: Hex;
  escalationReasonHash: Hex;
  escalationReasonCode?: ReasonCode;
  escalationCause?: string;
}

export interface Reviewer {
  id: string;
  telegramUserId: string;
  telegramChatId: string;
  alias: string;
  payoutAddress: Address;
  skills: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewerSnapshot {
  reviewerId: string;
  alias: string;
  payoutAddress: Address;
  telegramIdentityHash: Hex;
}

export interface ReviewOrder {
  id: string;
  requestId: string;
  jobId: string;
  state: ReviewOrderState;
  payer: Address;
  reviewPrice: string;
  network: string;
  gatewayTransaction: string | null;
  jobClient: Address;
  jobProvider: Address;
  jobDescription: string;
  jobBudget: string;
  jobExpiredAt: string;
  deliverableHash: Hex;
  deliverableContent: string;
  escalationReasonHash: Hex;
  escalationReasonCode: ReasonCode | null;
  escalationCause: string | null;
  reviewerId: string | null;
  reviewerAlias: string | null;
  reviewerPayoutAddress: Address | null;
  reviewerTelegramIdentityHash: Hex | null;
  decision: ReviewDecision | null;
  reasoning: string | null;
  evidenceHash: Hex | null;
  evidenceJson: string | null;
  reward: string;
  circlePayoutId: string | null;
  payoutTransactionHash: Hex | null;
  circleResolutionId: string | null;
  resolutionTransactionHash: Hex | null;
  circleRefundId: string | null;
  refundTransactionHash: Hex | null;
  payoutIdempotencyKey: string;
  resolutionIdempotencyKey: string;
  refundIdempotencyKey: string;
  claimExpiresAt: string | null;
  dispatchCount: number;
  createdAt: string;
  claimedAt: string | null;
  verdictAt: string | null;
  paidAt: string | null;
  settledAt: string | null;
  settlementAbortCode: string | null;
  settlementAbortedAt: string | null;
  updatedAt: string;
  lastError: string | null;
}

export interface ReviewAssignment {
  id: string;
  orderId: string;
  reviewerId: string;
  status: "offered" | "claimed" | "declined" | "expired";
  telegramMessageId: string | null;
  offeredAt: string;
  claimedAt: string | null;
  updatedAt: string;
}

export interface HumanEvidenceV1 {
  type: "human-v1";
  jobId: string;
  deliverableHash: Hex;
  reviewer: Address;
  telegramIdentityHash: Hex;
  decision: ReviewDecision;
  reasoning: string;
  escalationCause: string;
  escalationReasonHash: Hex;
  x402: {
    payer: Address;
    amount: string;
    network: string;
    transaction: string | null;
  };
  reward: string;
  payoutTransactionHash: Hex;
  verdictAt: string;
  payoutConfirmedAt: string;
}

export interface PublicReviewOrder {
  orderId: string;
  requestId: string;
  jobId: string;
  state: ReviewOrderState;
  payer: Address;
  reviewPrice: string;
  network: string;
  gatewayTransaction: string | null;
  deliverableHash: Hex;
  escalationReasonHash: Hex;
  escalationReasonCode: ReasonCode | null;
  escalationCause: string | null;
  reviewer: {
    alias: string;
    address: Address;
  } | null;
  decision: ReviewDecision | null;
  reasoning: string | null;
  evidenceHash: Hex | null;
  reward: string;
  payoutTransactionHash: Hex | null;
  resolutionTransactionHash: Hex | null;
  refundTransactionHash: Hex | null;
  createdAt: string;
  claimedAt: string | null;
  verdictAt: string | null;
  paidAt: string | null;
  settledAt: string | null;
  settlementAbortCode: string | null;
  settlementAbortedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  statusUrl: string;
  evidenceUrl: string | null;
}

export interface InternalReviewOrder extends PublicReviewOrder {
  jobDescription: string;
  deliverableContent: string;
  circlePayoutId: string | null;
  circleResolutionId: string | null;
  circleRefundId: string | null;
  claimExpiresAt: string | null;
  dispatchCount: number;
  events: ReviewEvent[];
  evidenceVerified: boolean | null;
}

export interface ReviewEvent {
  id: number;
  orderId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CircleTransactionResult {
  id: string;
  state: string;
  txHash: Hex | null;
}

export type CircleOperation = "payout" | "resolution" | "refund";

export interface CircleAttempt {
  id: string;
  orderId: string;
  operation: CircleOperation;
  attemptNumber: number;
  idempotencyKey: string;
  circleTransactionId: string;
  state: string;
  txHash: Hex | null;
  createdAt: string;
  updatedAt: string;
}

export const demoRunStates = [
  "queued",
  "preparing_escrow",
  "awaiting_escalation",
  "awaiting_purchase",
  "purchasing_review",
  "review_active",
  "finalized",
  "failed",
  "archived_refund_pending",
  "archived_refunded",
] as const;

export type DemoRunState = (typeof demoRunStates)[number];

export const demoTransactionKeys = [
  "createJob",
  "setLane",
  "setBudget",
  "approval",
  "fund",
  "submit",
  "escalation",
  "payment",
  "payout",
  "resolution",
  "reviewRefund",
  "escrowRefund",
] as const;

export type DemoTransactionKey = (typeof demoTransactionKeys)[number];

export type DemoTransactions = Record<DemoTransactionKey, string | null>;

export interface DemoRun {
  id: string;
  requestId: string;
  scenario: "human-only";
  scenarioVersion: "human-review-v1";
  state: DemoRunState;
  currentOperation: string | null;
  recoveryState: DemoRunState | null;
  jobId: string | null;
  orderId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  deliverableContent: string;
  deliverableHash: Hex;
  clientAddress: Address;
  providerAddress: Address;
  budget: string;
  reviewPrice: string;
  reward: string;
  expiresAt: string;
  chainStartBlock: string | null;
  completedSteps: string[];
  transactions: DemoTransactions;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  onChainVerified: boolean;
  lastError: string | null;
}

export interface DemoRunEvent {
  id: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DemoRunCapabilities {
  canPurchase: boolean;
  canRetry: boolean;
  canArchive: boolean;
  isTerminal: boolean;
}

export interface PublicDemoRun extends Omit<
  DemoRun,
  "recoveryState" | "chainStartBlock" | "completedSteps"
> {
  events: Array<Omit<DemoRunEvent, "runId">>;
  reviewOrder:
    | (PublicReviewOrder & {
        evidenceVerified: boolean | null;
        claimExpiresAt: string | null;
        dispatchCount: number;
      })
    | null;
  capabilities: DemoRunCapabilities;
}

export interface DemoReadinessCheck {
  key: string;
  label: string;
  status: "ready" | "warning" | "blocked";
  message: string;
}

export interface DemoReadiness {
  ready: boolean;
  enabled: boolean;
  checks: DemoReadinessCheck[];
  amounts: {
    escrowBudget: string;
    reviewPrice: string;
    reviewerReward: string;
  };
  limits: {
    maxRunsPerHour: number;
    jobTtlSeconds: number;
  };
  addresses: {
    client: Address | null;
    provider: Address | null;
    reviewer: Address | null;
    resolver: Address | null;
    seller: Address | null;
    commerce: Address | null;
    router: Address | null;
  };
  balances: {
    clientEscrow: string | null;
    clientGas: string | null;
    providerGas: string | null;
    gatewayAvailable: string | null;
    gatewayTotal: string | null;
    circleTreasury: string | null;
  };
  checkedAt: string;
}
