import {
  DEMO_RUN_STATES,
  EMPTY_TRANSACTIONS,
  type DemoCapabilities,
  type DemoReadiness,
  type DemoReadinessCheck,
  type DemoReviewOrder,
  type DemoRun,
  type DemoRunEvent,
  type DemoRunState,
  type DemoTransactions,
} from "./demo";
import type {
  ReviewDecision,
  ReviewServiceErrorKind,
  ReviewServiceResult,
} from "./review-service";

const REQUEST_TIMEOUT_MS = 10_000;
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(
  value: unknown,
  fallback = "",
): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function nullableString(value: unknown): string | null {
  const parsed = stringValue(value);
  return parsed ? parsed : null;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

function parseCheck(value: unknown, index: number): DemoReadinessCheck {
  const check = asRecord(value) ?? {};
  const rawStatus = stringValue(check.status);
  const status =
    rawStatus === "ready" || rawStatus === "warning" || rawStatus === "blocked"
      ? rawStatus
      : "blocked";
  return {
    key: stringValue(check.key, `check-${index}`),
    label: stringValue(check.label, "Readiness check"),
    status,
    message: stringValue(check.message, "No status detail was returned."),
  };
}

function parseReadiness(value: unknown): DemoReadiness {
  const root = asRecord(value);
  if (!root) throw new Error("Invalid readiness payload");
  const readiness = asRecord(root.readiness) ?? root;
  const amounts = asRecord(readiness.amounts) ?? {};
  const limits = asRecord(readiness.limits) ?? {};
  const addresses = asRecord(readiness.addresses) ?? {};
  const balances = asRecord(readiness.balances) ?? {};
  return {
    ready: booleanValue(readiness.ready),
    enabled: booleanValue(readiness.enabled),
    checks: Array.isArray(readiness.checks)
      ? readiness.checks.map(parseCheck)
      : [],
    amounts: {
      escrowBudget: stringValue(amounts.escrowBudget, "1000000"),
      reviewPrice: stringValue(amounts.reviewPrice, "250000"),
      reviewerReward: stringValue(amounts.reviewerReward, "200000"),
    },
    limits: {
      maxRunsPerHour: integerValue(limits.maxRunsPerHour, 3),
      jobTtlSeconds: integerValue(limits.jobTtlSeconds, 86_400),
    },
    addresses: {
      client: nullableString(addresses.client),
      provider: nullableString(addresses.provider),
      reviewer: nullableString(addresses.reviewer),
      resolver: nullableString(addresses.resolver),
      seller: nullableString(addresses.seller),
      commerce: nullableString(addresses.commerce),
      router: nullableString(addresses.router),
    },
    balances: {
      clientEscrow: nullableString(balances.clientEscrow),
      clientGas: nullableString(balances.clientGas),
      providerGas: nullableString(balances.providerGas),
      gatewayAvailable: nullableString(balances.gatewayAvailable),
      gatewayTotal: nullableString(balances.gatewayTotal),
      circleTreasury: nullableString(balances.circleTreasury),
    },
    checkedAt: stringValue(readiness.checkedAt, new Date(0).toISOString()),
  };
}

function parseEvent(value: unknown, index: number): DemoRunEvent {
  const event = asRecord(value) ?? {};
  return {
    id: stringValue(event.id, String(index)),
    type: stringValue(event.type, "demo_event"),
    createdAt: stringValue(event.createdAt, new Date(0).toISOString()),
    payload: asRecord(event.payload) ?? {},
  };
}

function transactionValue(
  transactions: JsonRecord,
  key: keyof DemoTransactions,
): string | null {
  return nullableString(transactions[key]);
}

function parseTransactions(value: unknown): DemoTransactions {
  const transactions = asRecord(value);
  if (!transactions) return { ...EMPTY_TRANSACTIONS };
  return {
    createJob: transactionValue(transactions, "createJob"),
    setLane: transactionValue(transactions, "setLane"),
    setBudget: transactionValue(transactions, "setBudget"),
    approval: transactionValue(transactions, "approval"),
    fund: transactionValue(transactions, "fund"),
    submit: transactionValue(transactions, "submit"),
    escalation: transactionValue(transactions, "escalation"),
    payment: transactionValue(transactions, "payment"),
    payout: transactionValue(transactions, "payout"),
    resolution: transactionValue(transactions, "resolution"),
    reviewRefund: transactionValue(transactions, "reviewRefund"),
    escrowRefund: transactionValue(transactions, "escrowRefund"),
  };
}

function parseReviewer(value: unknown): DemoReviewOrder["reviewer"] {
  const reviewer = asRecord(value);
  if (!reviewer) return null;
  const alias = stringValue(reviewer.alias);
  const address = stringValue(reviewer.address);
  return alias && address ? { alias, address } : null;
}

function parseDecision(value: unknown): ReviewDecision | null {
  return value === "approve" || value === "reject" ? value : null;
}

function parseReviewOrder(value: unknown): DemoReviewOrder | null {
  const order = asRecord(value);
  if (!order) return null;
  return {
    orderId: nullableString(order.orderId),
    state: stringValue(order.state, "paid"),
    payer: nullableString(order.payer),
    reviewPrice: stringValue(order.reviewPrice, "250000"),
    network: nullableString(order.network),
    gatewayTransaction: nullableString(order.gatewayTransaction),
    reviewer: parseReviewer(order.reviewer),
    decision: parseDecision(order.decision),
    reasoning: nullableString(order.reasoning),
    evidenceHash: nullableString(order.evidenceHash),
    evidenceUrl: nullableString(order.evidenceUrl),
    evidenceVerified:
      typeof order.evidenceVerified === "boolean"
        ? order.evidenceVerified
        : null,
    payoutTransactionHash: nullableString(order.payoutTransactionHash),
    resolutionTransactionHash: nullableString(order.resolutionTransactionHash),
    refundTransactionHash: nullableString(order.refundTransactionHash),
    claimExpiresAt: nullableString(order.claimExpiresAt),
    dispatchCount: integerValue(order.dispatchCount, 0),
    createdAt: nullableString(order.createdAt),
    claimedAt: nullableString(order.claimedAt),
    verdictAt: nullableString(order.verdictAt),
    paidAt: nullableString(order.paidAt),
    settledAt: nullableString(order.settledAt),
    lastError: nullableString(order.lastError),
  };
}

function parseCapabilities(value: unknown): DemoCapabilities {
  const capabilities = asRecord(value) ?? {};
  return {
    canPurchase: booleanValue(capabilities.canPurchase),
    canRetry: booleanValue(capabilities.canRetry),
    canArchive: booleanValue(capabilities.canArchive),
    isTerminal: booleanValue(capabilities.isTerminal),
  };
}

function parseState(value: unknown): DemoRunState {
  const state = stringValue(value);
  return DEMO_RUN_STATES.includes(state as DemoRunState)
    ? (state as DemoRunState)
    : "failed";
}

function parseRunObject(value: unknown): DemoRun {
  const run = asRecord(value);
  if (!run) throw new Error("Invalid demo run");
  const id = stringValue(run.id ?? run.runId);
  if (!id) throw new Error("Missing demo run id");

  return {
    id,
    requestId: stringValue(run.requestId),
    scenario: stringValue(run.scenario, "human-review-v1"),
    state: parseState(run.state),
    currentOperation: nullableString(run.currentOperation),
    jobId: nullableString(run.jobId),
    orderId: nullableString(run.orderId),
    title: stringValue(run.title, "API contract compliance review"),
    description: stringValue(
      run.description,
      "A reasoned human decision settles an agentic freelance escrow.",
    ),
    acceptanceCriteria: stringValue(
      run.acceptanceCriteria,
      "API responses contain status and result; unauthenticated requests return HTTP 401.",
    ),
    deliverableContent: stringValue(run.deliverableContent),
    deliverableHash: nullableString(run.deliverableHash),
    budget: stringValue(run.budget, "1000000"),
    reviewPrice: stringValue(run.reviewPrice, "250000"),
    reward: stringValue(run.reward, "200000"),
    expiresAt: nullableString(run.expiresAt),
    clientAddress: nullableString(run.clientAddress),
    providerAddress: nullableString(run.providerAddress),
    createdAt: stringValue(run.createdAt, new Date(0).toISOString()),
    updatedAt: stringValue(run.updatedAt, new Date(0).toISOString()),
    completedAt: nullableString(run.completedAt),
    onChainVerified: booleanValue(run.onChainVerified),
    lastError: nullableString(run.lastError),
    transactions: parseTransactions(run.transactions),
    events: Array.isArray(run.events) ? run.events.map(parseEvent) : [],
    reviewOrder: parseReviewOrder(run.reviewOrder),
    capabilities: parseCapabilities(run.capabilities),
  };
}

function parseRun(value: unknown): DemoRun | null {
  const root = asRecord(value);
  if (!root) throw new Error("Invalid demo run envelope");
  const candidate = Object.hasOwn(root, "run") ? root.run : root;
  return candidate === null || candidate === undefined
    ? null
    : parseRunObject(candidate);
}

function reviewServiceUrl(): URL | null {
  const raw =
    process.env.REVIEW_SERVICE_URL?.trim() ||
    process.env.REVIEW_SERVICE_INTERNAL_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
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

async function internalRequest(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<ReviewServiceResult<unknown>> {
  const url = endpoint(path);
  const token = process.env.REVIEW_INTERNAL_TOKEN?.trim();
  if (!url || !token) {
    return failure(
      "not_configured",
      "The live demo service is not connected to the dashboard.",
    );
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response
      .json()
      .catch(() => ({ error: `Review service returned HTTP ${response.status}` }));
    if (response.status === 401 || response.status === 403) {
      return failure(
        "unauthorized",
        "The live demo service rejected the dashboard credentials.",
      );
    }
    if (response.status === 404) {
      return failure("not_found", "That demo run was not found.");
    }
    if (!response.ok) {
      const detail = asRecord(payload);
      const nestedError = asRecord(detail?.error);
      return failure(
        "unavailable",
        stringValue(
          detail?.message ?? nestedError?.message ?? detail?.error,
          `The live demo service returned HTTP ${response.status}.`,
        ),
      );
    }
    return { ok: true, data: payload };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return failure(
        "timeout",
        "The live demo service did not respond within ten seconds.",
      );
    }
    return failure(
      "unavailable",
      "The live demo service is temporarily unreachable.",
    );
  }
}

function invalidResponse<T>(noun: string): ReviewServiceResult<T> {
  return failure(
    "invalid_response",
    `The live demo service returned an unexpected ${noun} payload.`,
  );
}

export async function getDemoReadiness(): Promise<
  ReviewServiceResult<DemoReadiness>
> {
  const result = await internalRequest("/internal/demo/readiness");
  if (!result.ok) return result;
  try {
    return { ok: true, data: parseReadiness(result.data) };
  } catch {
    return invalidResponse("readiness");
  }
}

export async function getLatestDemoRun(
  terminalOnly = false,
): Promise<
  ReviewServiceResult<DemoRun | null>
> {
  const result = await internalRequest(
    `/internal/demo-runs/latest${terminalOnly ? "?terminal=true" : ""}`,
  );
  if (!result.ok) {
    return result.kind === "not_found" ? { ok: true, data: null } : result;
  }
  try {
    return { ok: true, data: parseRun(result.data) };
  } catch {
    return invalidResponse("demo run");
  }
}

export async function getDemoRun(
  runId: string,
): Promise<ReviewServiceResult<DemoRun>> {
  const result = await internalRequest(
    `/internal/demo-runs/${encodeURIComponent(runId)}`,
  );
  if (!result.ok) return result;
  try {
    const run = parseRun(result.data);
    return run ? { ok: true, data: run } : invalidResponse("demo run");
  } catch {
    return invalidResponse("demo run");
  }
}

export async function createDemoRun(
  requestId: string,
): Promise<ReviewServiceResult<{ runId: string; state: string }>> {
  const result = await internalRequest("/internal/demo-runs", {
    method: "POST",
    body: { requestId, scenario: "human-only" },
  });
  if (!result.ok) return result;
  const payload = asRecord(result.data);
  const runId = stringValue(payload?.runId);
  return runId
    ? {
        ok: true,
        data: { runId, state: stringValue(payload?.state, "queued") },
      }
    : invalidResponse("create-run");
}

async function mutateDemoRun(
  runId: string,
  operation: "purchase" | "retry" | "archive",
): Promise<ReviewServiceResult<DemoRun>> {
  const result = await internalRequest(
    `/internal/demo-runs/${encodeURIComponent(runId)}/${operation}`,
    { method: "POST" },
  );
  if (!result.ok) return result;
  try {
    const run = parseRun(result.data);
    return run ? { ok: true, data: run } : invalidResponse("demo run");
  } catch {
    return invalidResponse("demo run");
  }
}

export function purchaseDemoReview(runId: string) {
  return mutateDemoRun(runId, "purchase");
}

export function retryDemoRun(runId: string) {
  return mutateDemoRun(runId, "retry");
}

export function archiveDemoRun(runId: string) {
  return mutateDemoRun(runId, "archive");
}
