export const REVIEW_ORDER_STATES = [
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

export type DashboardSnapshotStatus =
  | "syncing"
  | "ready"
  | "stale"
  | "degraded";

export type DashboardJobRecord = {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: string;
  budgetUsdc: string;
  expiredAt: number;
  statusCode: number;
  status: string;
  hook: string;
};

export type DashboardFeedRow = DashboardJobRecord & {
  provenance: "AI auto" | "escalated" | "human" | null;
  lane: "AI" | "human" | null;
  confidenceBP: number | null;
  statusTxHash: string | null;
  verdictTxHash: string | null;
  latestBlock: string;
};

export type DashboardReviewRecord = DashboardJobRecord & {
  deliverableHash: string | null;
  reasonHash: string;
  escalationTxHash: string | null;
  clientRequested: boolean;
};

export type DashboardChainSnapshot = {
  version: 1;
  configured: boolean;
  status: DashboardSnapshotStatus;
  latestBlock: string | null;
  indexedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  feed: DashboardFeedRow[];
  reviewQueue: DashboardReviewRecord[];
};

export type ReputationData = {
  address: string;
  completed: number;
  rejected: number;
  n: number;
  volumeUsdc: string;
  reliability: number | null;
  rated: boolean;
  disclaimer: string;
  history: DashboardFeedRow[];
};

export type ReviewOrderState = (typeof REVIEW_ORDER_STATES)[number];
export type ReviewDecision = "approve" | "reject";

export type ReviewOrderReviewer = {
  alias: string;
  address: string;
};

export type ReviewOrderEvent = {
  id: number;
  orderId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ReviewOrder = {
  orderId: string;
  requestId: string;
  jobId: string;
  jobDescription: string | null;
  state: ReviewOrderState;
  payer: string;
  reviewPrice: string;
  network: string;
  gatewayTransaction: string | null;
  deliverableHash: string;
  escalationReasonHash: string;
  escalationReasonCode: string | null;
  escalationCause: string | null;
  reviewer: ReviewOrderReviewer | null;
  decision: ReviewDecision | null;
  reasoning: string | null;
  evidenceHash: string | null;
  reward: string;
  payoutTransactionHash: string | null;
  resolutionTransactionHash: string | null;
  refundTransactionHash: string | null;
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
  events: ReviewOrderEvent[];
  evidenceVerified: boolean | null;
};

export type ReviewerProfile = {
  alias: string;
  address: string;
  skills: string[];
  active: boolean;
  completedReviews: number;
  paidReviews: number;
  onChainSettledReviews: number;
  approvals: number;
  rejections: number;
  totalRewards: string;
  averageResponseSeconds: number | null;
  reviews: ReviewOrder[];
};

export type ReviewServiceErrorKind =
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "timeout"
  | "unavailable"
  | "invalid_response";

export type ReviewServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ReviewServiceErrorKind; message: string };

export const REVIEW_STATE_LABELS: Record<ReviewOrderState, string> = {
  paid: "Payment accepted",
  dispatched: "Dispatched",
  claimed: "Claimed",
  verdict_submitted: "Verdict submitted",
  reviewer_paid: "Auditor paid",
  settled: "Escrow settled",
  expired: "Review expired",
  refunded: "Payer refunded",
  payout_failed: "Payout failed",
  reviewer_paid_settlement_failed: "Settlement retrying",
};

const ACTIVE_SEQUENCE: ReviewOrderState[] = [
  "paid",
  "dispatched",
  "claimed",
  "verdict_submitted",
  "reviewer_paid",
  "settled",
];

const REVIEW_TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function reviewStateProgress(state: ReviewOrderState): number {
  const index = ACTIVE_SEQUENCE.indexOf(state);
  if (index >= 0) return index;
  if (state === "payout_failed") {
    return ACTIVE_SEQUENCE.indexOf("verdict_submitted");
  }
  if (state === "reviewer_paid_settlement_failed") {
    return ACTIVE_SEQUENCE.indexOf("reviewer_paid");
  }
  if (state === "expired" || state === "refunded") {
    return ACTIVE_SEQUENCE.indexOf("dispatched");
  }
  return -1;
}

export function isTerminalReviewState(state: ReviewOrderState): boolean {
  return state === "settled" || state === "refunded";
}

export function formatUsdcBaseUnits(value: string): string {
  if (!/^\d+$/.test(value)) return "—";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatReviewTime(value: string | null): string {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return REVIEW_TIME_FORMATTER.format(date);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3_600).toFixed(1)}h`;
}
