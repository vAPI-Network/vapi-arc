import {
  REVIEW_ORDER_STATES,
  type ReviewDecision,
  type ReviewOrder,
  type ReviewOrderEvent,
  type ReviewOrderReviewer,
  type ReviewerProfile,
  type ReviewServiceErrorKind,
  type ReviewServiceResult,
} from "./review-service";

const REQUEST_TIMEOUT_MS = 5_000;

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
): Promise<ReviewServiceResult<unknown>> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        "The review service did not respond within five seconds.",
      );
    }
    return failure(
      "unavailable",
      "The review service is temporarily unreachable.",
    );
  }
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

  const result = await fetchJson(url, {
    authorization: `Bearer ${token}`,
  });
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
