import {
  type DashboardChainSnapshot,
  type DashboardFeedRow,
  type DashboardJobRecord,
  type DashboardReviewRecord,
  type DashboardSnapshotStatus,
  type ReputationData,
  REVIEW_ORDER_STATES,
  type ReviewDecision,
  type ReviewOrder,
  type ReviewOrderEvent,
  type ReviewOrderReviewer,
  type ReviewerProfile,
  type ReviewServiceErrorKind,
  type ReviewServiceResult,
} from "./review-service";
import { formatUnits, getAddress, isAddress } from "viem";

const REQUEST_TIMEOUT_MS = 5_000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 1_500;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function parseReviewer(value: unknown): ReviewOrderReviewer | null {
  if (value === null || value === undefined) return null;
  const reviewer = asRecord(value);
  if (!reviewer) throw new Error("Invalid reviewer");
  return {
    alias: requiredString(reviewer.alias, "reviewer.alias"),
    address: requiredString(reviewer.address, "reviewer.address"),
  };
}

function parseDecision(value: unknown): ReviewDecision | null {
  if (value === null || value === undefined) return null;
  if (value !== "approve" && value !== "reject") {
    throw new Error("Invalid decision");
  }
  return value;
}

function parseEvent(value: unknown): ReviewOrderEvent {
  const event = asRecord(value);
  if (!event) throw new Error("Invalid review event");
  const payload = asRecord(event.payload);
  return {
    id: nonNegativeInteger(event.id, "event.id"),
    orderId: requiredString(event.orderId, "event.orderId"),
    type: requiredString(event.type, "event.type"),
    payload: payload ?? {},
    createdAt: requiredString(event.createdAt, "event.createdAt"),
  };
}

function parseOrder(value: unknown): ReviewOrder {
  const order = asRecord(value);
  if (!order) throw new Error("Invalid order");
  if (
    typeof order.state !== "string" ||
    !REVIEW_ORDER_STATES.includes(
      order.state as (typeof REVIEW_ORDER_STATES)[number],
    )
  ) {
    throw new Error("Invalid order state");
  }

  return {
    orderId: requiredString(order.orderId, "orderId"),
    requestId: requiredString(order.requestId, "requestId"),
    jobId: requiredString(order.jobId, "jobId"),
    jobDescription: nullableString(order.jobDescription, "jobDescription"),
    state: order.state as ReviewOrder["state"],
    payer: requiredString(order.payer, "payer"),
    reviewPrice: requiredString(order.reviewPrice, "reviewPrice"),
    network: requiredString(order.network, "network"),
    gatewayTransaction: nullableString(
      order.gatewayTransaction,
      "gatewayTransaction",
    ),
    deliverableHash: requiredString(order.deliverableHash, "deliverableHash"),
    escalationReasonHash: requiredString(
      order.escalationReasonHash,
      "escalationReasonHash",
    ),
    escalationReasonCode: nullableString(
      order.escalationReasonCode,
      "escalationReasonCode",
    ),
    escalationCause: nullableString(order.escalationCause, "escalationCause"),
    reviewer: parseReviewer(order.reviewer),
    decision: parseDecision(order.decision),
    reasoning: nullableString(order.reasoning, "reasoning"),
    evidenceHash: nullableString(order.evidenceHash, "evidenceHash"),
    reward: requiredString(order.reward, "reward"),
    payoutTransactionHash: nullableString(
      order.payoutTransactionHash,
      "payoutTransactionHash",
    ),
    resolutionTransactionHash: nullableString(
      order.resolutionTransactionHash,
      "resolutionTransactionHash",
    ),
    refundTransactionHash: nullableString(
      order.refundTransactionHash,
      "refundTransactionHash",
    ),
    createdAt: requiredString(order.createdAt, "createdAt"),
    claimedAt: nullableString(order.claimedAt, "claimedAt"),
    verdictAt: nullableString(order.verdictAt, "verdictAt"),
    paidAt: nullableString(order.paidAt, "paidAt"),
    settledAt: nullableString(order.settledAt, "settledAt"),
    settlementAbortCode: nullableString(
      order.settlementAbortCode,
      "settlementAbortCode",
    ),
    settlementAbortedAt: nullableString(
      order.settlementAbortedAt,
      "settlementAbortedAt",
    ),
    updatedAt: requiredString(order.updatedAt, "updatedAt"),
    lastError: nullableString(order.lastError, "lastError"),
    statusUrl: requiredString(order.statusUrl, "statusUrl"),
    evidenceUrl: nullableString(order.evidenceUrl, "evidenceUrl"),
    events: Array.isArray(order.events) ? order.events.map(parseEvent) : [],
    evidenceVerified:
      typeof order.evidenceVerified === "boolean"
        ? order.evidenceVerified
        : null,
  };
}

function parseInternalOrder(value: unknown): ReviewOrder {
  const order = asRecord(value);
  if (!order) throw new Error("Invalid order");
  if (!Array.isArray(order.events)) {
    throw new Error("Invalid events");
  }
  if (
    order.evidenceVerified !== null &&
    typeof order.evidenceVerified !== "boolean"
  ) {
    throw new Error("Invalid evidenceVerified");
  }

  return {
    ...parseOrder(order),
    jobDescription: requiredString(order.jobDescription, "jobDescription", {
      allowEmpty: true,
    }),
    events: order.events.map(parseEvent),
    evidenceVerified: order.evidenceVerified,
  };
}

function reviewServiceUrl(): URL | null {
  const raw = process.env.REVIEW_SERVICE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function endpoint(path: string): URL | null {
  const base = reviewServiceUrl();
  if (!base) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
  return base;
}

function failure<T>(
  kind: ReviewServiceErrorKind,
  message: string,
): ReviewServiceResult<T> {
  return { ok: false, kind, message };
}

async function fetchJson(
  url: URL,
  headers: HeadersInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ReviewServiceResult<unknown>> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return failure(
        "unauthorized",
        "The review service rejected the dashboard credentials.",
      );
    }
    if (response.status === 404) {
      return failure("not_found", "The requested review record was not found.");
    }
    if (!response.ok) {
      return failure(
        "unavailable",
        `The review service returned HTTP ${response.status}.`,
      );
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return failure(
        "timeout",
        `The review service did not respond within ${(
          timeoutMs / 1_000
        ).toFixed(1)} seconds.`,
      );
    }
    return failure(
      "unavailable",
      "The review service is temporarily unreachable.",
    );
  }
}

function decimalString(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) throw new Error(`Invalid ${field}`);
  return parsed;
}

function addressString(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!isAddress(parsed)) throw new Error(`Invalid ${field}`);
  return getAddress(parsed);
}

function hashString(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}

function nullableHash(value: unknown, field: string): string | null {
  return value === null || value === undefined
    ? null
    : hashString(value, field);
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = requiredString(value, field);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`Invalid ${field}`);
  return parsed;
}

function parseDashboardJob(value: unknown): DashboardJobRecord {
  const job = asRecord(value);
  if (!job) throw new Error("Invalid dashboard job");
  return {
    id: decimalString(job.id, "job.id"),
    client: addressString(job.client, "job.client"),
    provider: addressString(job.provider, "job.provider"),
    evaluator: addressString(job.evaluator, "job.evaluator"),
    description: requiredString(job.description, "job.description", {
      allowEmpty: true,
    }),
    budget: decimalString(job.budget, "job.budget"),
    budgetUsdc: requiredString(job.budgetUsdc, "job.budgetUsdc"),
    expiredAt: nonNegativeInteger(job.expiredAt, "job.expiredAt"),
    statusCode: nonNegativeInteger(job.statusCode, "job.statusCode"),
    status: requiredString(job.status, "job.status"),
    hook: addressString(job.hook, "job.hook"),
  };
}

function parseDashboardFeedRow(value: unknown): DashboardFeedRow {
  const row = asRecord(value);
  if (!row) throw new Error("Invalid dashboard feed row");
  const provenance = row.provenance;
  if (
    provenance !== null &&
    provenance !== "AI auto" &&
    provenance !== "escalated" &&
    provenance !== "human"
  ) {
    throw new Error("Invalid dashboard provenance");
  }
  const lane = row.lane;
  if (lane !== null && lane !== "AI" && lane !== "human") {
    throw new Error("Invalid dashboard lane");
  }
  const confidenceBP =
    row.confidenceBP === null
      ? null
      : nonNegativeInteger(row.confidenceBP, "feed.confidenceBP");
  if (confidenceBP !== null && confidenceBP > 10_000) {
    throw new Error("Invalid feed.confidenceBP");
  }
  return {
    ...parseDashboardJob(row),
    provenance,
    lane,
    confidenceBP,
    statusTxHash: nullableHash(row.statusTxHash, "feed.statusTxHash"),
    verdictTxHash: nullableHash(row.verdictTxHash, "feed.verdictTxHash"),
    latestBlock: decimalString(row.latestBlock, "feed.latestBlock"),
  };
}

function parseDashboardReviewRecord(value: unknown): DashboardReviewRecord {
  const row = asRecord(value);
  if (!row) throw new Error("Invalid dashboard review row");
  if (typeof row.clientRequested !== "boolean") {
    throw new Error("Invalid review.clientRequested");
  }
  return {
    ...parseDashboardJob(row),
    deliverableHash: nullableHash(
      row.deliverableHash,
      "review.deliverableHash",
    ),
    reasonHash: hashString(row.reasonHash, "review.reasonHash"),
    escalationTxHash: nullableHash(
      row.escalationTxHash,
      "review.escalationTxHash",
    ),
    clientRequested: row.clientRequested,
  };
}

function parseDashboardSnapshot(value: unknown): DashboardChainSnapshot {
  const root = asRecord(value);
  if (!root) throw new Error("Invalid dashboard snapshot envelope");
  const snapshot = asRecord(root.snapshot) ?? root;
  if (snapshot.version !== 1 || typeof snapshot.configured !== "boolean") {
    throw new Error("Invalid dashboard snapshot version");
  }
  const status = snapshot.status;
  const statuses: DashboardSnapshotStatus[] = [
    "syncing",
    "ready",
    "stale",
    "degraded",
  ];
  if (
    typeof status !== "string" ||
    !statuses.includes(status as DashboardSnapshotStatus)
  ) {
    throw new Error("Invalid dashboard snapshot status");
  }
  if (!Array.isArray(snapshot.feed) || !Array.isArray(snapshot.reviewQueue)) {
    throw new Error("Invalid dashboard snapshot collections");
  }
  return {
    version: 1,
    configured: snapshot.configured,
    status: status as DashboardSnapshotStatus,
    latestBlock:
      snapshot.latestBlock === null
        ? null
        : decimalString(snapshot.latestBlock, "snapshot.latestBlock"),
    indexedAt: nullableTimestamp(snapshot.indexedAt, "snapshot.indexedAt"),
    lastAttemptAt: nullableTimestamp(
      snapshot.lastAttemptAt,
      "snapshot.lastAttemptAt",
    ),
    lastError: nullableString(snapshot.lastError, "snapshot.lastError"),
    feed: snapshot.feed.map(parseDashboardFeedRow),
    reviewQueue: snapshot.reviewQueue.map(parseDashboardReviewRecord),
  };
}

let lastDashboardSnapshot: DashboardChainSnapshot | null = null;

function staleDashboardSnapshot(
  message: string,
): ReviewServiceResult<DashboardChainSnapshot> | null {
  if (!lastDashboardSnapshot) return null;
  return {
    ok: true,
    data: {
      ...lastDashboardSnapshot,
      status: "stale",
      lastError: message,
    },
  };
}

export async function getDashboardChainSnapshot(): Promise<
  ReviewServiceResult<DashboardChainSnapshot>
> {
  const url = endpoint("/internal/dashboard-chain-snapshot");
  const token = process.env.REVIEW_INTERNAL_TOKEN?.trim();
  if (!url || !token) {
    return failure(
      "not_configured",
      "Set REVIEW_SERVICE_URL and REVIEW_INTERNAL_TOKEN to connect the Arc snapshot.",
    );
  }

  const result = await fetchJson(
    url,
    { authorization: `Bearer ${token}` },
    DASHBOARD_REQUEST_TIMEOUT_MS,
  );
  if (!result.ok) {
    return staleDashboardSnapshot(result.message) ?? result;
  }

  try {
    const snapshot = parseDashboardSnapshot(result.data);
    lastDashboardSnapshot = snapshot;
    return { ok: true, data: snapshot };
  } catch {
    const message =
      "The review service returned an unexpected Arc snapshot payload.";
    const invalid = failure<DashboardChainSnapshot>(
      "invalid_response",
      message,
    );
    return staleDashboardSnapshot(message) ?? invalid;
  }
}

export function reputationFromSnapshot(
  rawAddress: string,
  snapshot: DashboardChainSnapshot,
): ReputationData {
  if (!isAddress(rawAddress)) {
    throw new Response("Invalid provider address", { status: 400 });
  }
  if (!snapshot.indexedAt) {
    throw new Response("Arc evidence snapshot is not indexed yet", {
      status: 503,
    });
  }
  const address = getAddress(rawAddress);
  const history = snapshot.feed.filter(
    (job) =>
      job.provider.toLowerCase() === address.toLowerCase() &&
      (job.statusCode === 3 || job.statusCode === 4),
  );
  const completed = history.filter((job) => job.statusCode === 3).length;
  const rejected = history.filter((job) => job.statusCode === 4).length;
  const n = completed + rejected;
  const volume = history.reduce(
    (total, job) => total + BigInt(job.budget),
    0n,
  );
  const rated = n >= 5;
  return {
    address,
    completed,
    rejected,
    n,
    volumeUsdc: formatUnits(volume, 6),
    reliability: rated ? completed / n : null,
    rated,
    disclaimer: "Experimental, small sample",
    history,
  };
}

export async function getInternalReviewOrders(): Promise<
  ReviewServiceResult<ReviewOrder[]>
> {
  const url = endpoint("/internal/review-orders");
  const token = process.env.REVIEW_INTERNAL_TOKEN?.trim();
  if (!url || !token) {
    return failure(
      "not_configured",
      "Set REVIEW_SERVICE_URL and REVIEW_INTERNAL_TOKEN to connect the operations feed.",
    );
  }

  const result = await fetchJson(
    url,
    { authorization: `Bearer ${token}` },
    DASHBOARD_REQUEST_TIMEOUT_MS,
  );
  if (!result.ok) return result;

  try {
    const envelope = asRecord(result.data);
    if (!envelope || !Array.isArray(envelope.orders)) {
      throw new Error("Invalid orders envelope");
    }
    return { ok: true, data: envelope.orders.map(parseInternalOrder) };
  } catch {
    return failure(
      "invalid_response",
      "The review service returned an unexpected order payload.",
    );
  }
}

export async function getReviewerProfile(
  address: string,
): Promise<ReviewServiceResult<ReviewerProfile>> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Response("Invalid reviewer address", { status: 400 });
  }
  const url = endpoint(`/v1/reviewers/${address}`);
  if (!url) {
    return failure(
      "not_configured",
      "Set REVIEW_SERVICE_URL to load reviewer history.",
    );
  }

  const result = await fetchJson(url);
  if (!result.ok) return result;

  try {
    const envelope = asRecord(result.data);
    const reviewer = asRecord(envelope?.reviewer);
    if (!reviewer) throw new Error("Invalid reviewer envelope");
    if (!Array.isArray(reviewer.skills) || !Array.isArray(reviewer.reviews)) {
      throw new Error("Invalid reviewer collections");
    }
    if (typeof reviewer.active !== "boolean") {
      throw new Error("Invalid reviewer active state");
    }

    return {
      ok: true,
      data: {
        alias: requiredString(reviewer.alias, "reviewer.alias"),
        address: requiredString(reviewer.address, "reviewer.address"),
        skills: reviewer.skills.map((skill) =>
          requiredString(skill, "reviewer.skills"),
        ),
        active: reviewer.active,
        completedReviews: nonNegativeInteger(
          reviewer.completedReviews,
          "completedReviews",
        ),
        paidReviews: nonNegativeInteger(reviewer.paidReviews, "paidReviews"),
        onChainSettledReviews: nonNegativeInteger(
          reviewer.onChainSettledReviews,
          "onChainSettledReviews",
        ),
        approvals: nonNegativeInteger(reviewer.approvals, "approvals"),
        rejections: nonNegativeInteger(reviewer.rejections, "rejections"),
        totalRewards: requiredString(reviewer.totalRewards, "totalRewards"),
        averageResponseSeconds:
          reviewer.averageResponseSeconds === null
            ? null
            : nonNegativeNumber(
                reviewer.averageResponseSeconds,
                "averageResponseSeconds",
              ),
        reviews: reviewer.reviews.map(parseOrder),
      },
    };
  } catch {
    return failure(
      "invalid_response",
      "The review service returned an unexpected reviewer payload.",
    );
  }
}
