import type { ReviewDecision, ReviewOrderState } from "./review-service";

export const DEMO_RUN_STATES = [
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

export type DemoRunState = (typeof DEMO_RUN_STATES)[number];
export type DemoCheckStatus = "ready" | "warning" | "blocked";

export type DemoReadinessCheck = {
  key: string;
  label: string;
  status: DemoCheckStatus;
  message: string;
};

export type DemoReadiness = {
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
    client: string | null;
    provider: string | null;
    reviewer: string | null;
    resolver: string | null;
    seller: string | null;
    commerce: string | null;
    router: string | null;
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
};

export type DemoRunEvent = {
  id: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type DemoTransactions = {
  createJob: string | null;
  setLane: string | null;
  setBudget: string | null;
  approval: string | null;
  fund: string | null;
  submit: string | null;
  escalation: string | null;
  payment: string | null;
  payout: string | null;
  resolution: string | null;
  reviewRefund: string | null;
  escrowRefund: string | null;
};

export type DemoReviewOrder = {
  orderId: string | null;
  state: ReviewOrderState | string;
  payer: string | null;
  reviewPrice: string;
  network: string | null;
  gatewayTransaction: string | null;
  reviewer: {
    alias: string;
    address: string;
  } | null;
  decision: ReviewDecision | null;
  reasoning: string | null;
  evidenceHash: string | null;
  evidenceUrl: string | null;
  evidenceVerified: boolean | null;
  payoutTransactionHash: string | null;
  resolutionTransactionHash: string | null;
  refundTransactionHash: string | null;
  claimExpiresAt: string | null;
  dispatchCount: number;
  createdAt: string | null;
  claimedAt: string | null;
  verdictAt: string | null;
  paidAt: string | null;
  settledAt: string | null;
  lastError: string | null;
};

export type DemoCapabilities = {
  canPurchase: boolean;
  canRetry: boolean;
  canArchive: boolean;
  isTerminal: boolean;
};

export type DemoRun = {
  id: string;
  requestId: string;
  scenario: string;
  state: DemoRunState;
  currentOperation: string | null;
  jobId: string | null;
  orderId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  deliverableContent: string;
  deliverableHash: string | null;
  budget: string;
  reviewPrice: string;
  reward: string;
  expiresAt: string | null;
  clientAddress: string | null;
  providerAddress: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  onChainVerified: boolean;
  lastError: string | null;
  transactions: DemoTransactions;
  events: DemoRunEvent[];
  reviewOrder: DemoReviewOrder | null;
  capabilities: DemoCapabilities;
};

export const DEMO_STATE_LABELS: Record<DemoRunState, string> = {
  queued: "Queued",
  preparing_escrow: "Preparing escrow",
  awaiting_escalation: "Awaiting escalation",
  awaiting_purchase: "Human judgment required",
  purchasing_review: "Agent purchasing review",
  review_active: "Human review active",
  finalized: "Proof finalized",
  failed: "Needs attention",
  archived_refund_pending: "Refund pending",
  archived_refunded: "Escrow refunded",
};

export const EMPTY_TRANSACTIONS: DemoTransactions = {
  createJob: null,
  setLane: null,
  setBudget: null,
  approval: null,
  fund: null,
  submit: null,
  escalation: null,
  payment: null,
  payout: null,
  resolution: null,
  reviewRefund: null,
  escrowRefund: null,
};

export function isDemoRunTerminal(run: DemoRun): boolean {
  return (
    run.capabilities.isTerminal ||
    run.state === "finalized" ||
    run.state === "archived_refunded"
  );
}

const PUBLIC_PROOF_EVENT_TYPES = new Set([
  "demo_run_created",
  "escrow_job_created",
  "human_lane_selected",
  "escrow_budget_set",
  "escrow_allowance_ready",
  "escrow_funded",
  "deliverable_committed",
  "judge_escalation_confirmed",
  "human_judgment_required",
  "x402_challenge_received",
  "x402_authorization_signed",
  "x402_payment_accepted",
  "review_order_attached",
  "payout_confirmed",
  "resolution_confirmed",
  "reviewRefund_confirmed",
  "review_payment_refunded_escrow_pending",
  "escrow_refund_confirmed",
  "on_chain_provenance_verified",
  "demo_run_finalized",
]);

export function toPublicProofRun(run: DemoRun): DemoRun {
  const safeEvents = run.events
    .filter((event) => PUBLIC_PROOF_EVENT_TYPES.has(event.type))
    .map((event) => ({
      ...event,
      payload: Object.fromEntries(
        Object.entries(event.payload).filter(
          ([key, value]) =>
            ["decision", "amount", "orderState"].includes(key) &&
            (typeof value === "string" || typeof value === "number"),
        ),
      ),
    }));
  return {
    ...run,
    requestId: "",
    currentOperation: null,
    clientAddress: null,
    providerAddress: null,
    lastError: null,
    events: safeEvents,
    reviewOrder: run.reviewOrder
      ? {
          ...run.reviewOrder,
          claimExpiresAt: null,
          lastError: null,
        }
      : null,
    capabilities: {
      canPurchase: false,
      canRetry: false,
      canArchive: false,
      isTerminal: true,
    },
  };
}

export function formatDemoTime(value: string | null): string {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function formatUsdcAmount(value: string): string {
  if (!/^\d+$/.test(value)) return value || "—";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
