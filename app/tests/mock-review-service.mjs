import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = 8797;
const tx = (digit) => `0x${digit.repeat(64)}`;
const client = "0x1111111111111111111111111111111111111111";
const provider = "0x2222222222222222222222222222222222222222";
const reviewer = "0x35Cb22DdEA20a8515f01281730601278d8B679C5";
const resolver = "0x025d2216594469E19EA70F38ef9D08E47e5dd3E7";
let run = null;
let escrowPolls = 0;
let reviewPolls = 0;
let telegramVerdictStarted = false;
let statusRequests = 0;
let readinessRequests = 0;
let snapshotRequests = 0;
let snapshotMode = "ready";

function event(id, type, payload = {}) {
  return {
    id,
    type,
    payload,
    createdAt: new Date(Date.now() + id * 1_000).toISOString(),
  };
}

function baseRun(id, requestId) {
  const now = new Date().toISOString();
  return {
    id,
    requestId,
    scenario: "human-only",
    scenarioVersion: "human-review-v1",
    state: "queued",
    currentOperation: "create_job",
    jobId: null,
    orderId: null,
    title: "API contract compliance review",
    description: `API contract compliance review [vAPI demo run ${id}]`,
    acceptanceCriteria:
      'API responses contain "status" and "result"; unauthenticated requests return HTTP 401.',
    deliverableContent:
      "Contract summary, final deliverable. The service returns status and result and rejects unauthenticated requests with HTTP 401.",
    deliverableHash: tx("d"),
    clientAddress: client,
    providerAddress: provider,
    budget: "1000000",
    reviewPrice: "250000",
    reward: "200000",
    expiresAt: String(Math.floor(Date.now() / 1_000) + 86_400),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    onChainVerified: false,
    lastError: null,
    transactions: {
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
    },
    events: [event(1, "demo_run_created")],
    reviewOrder: null,
    capabilities: {
      canPurchase: false,
      canRetry: false,
      canArchive: false,
      isTerminal: false,
    },
  };
}

function advanceEscrow() {
  if (!run || !["queued", "preparing_escrow"].includes(run.state)) return;
  escrowPolls += 1;
  if (escrowPolls === 1) {
    run.state = "preparing_escrow";
    run.currentOperation = "fund_escrow";
    run.jobId = "160001";
    Object.assign(run.transactions, {
      createJob: tx("1"),
      setLane: tx("2"),
      setBudget: tx("3"),
      approval: tx("4"),
      fund: tx("5"),
      submit: tx("6"),
    });
    run.events.push(
      event(2, "escrow_job_created"),
      event(3, "human_lane_selected"),
      event(4, "escrow_budget_set"),
      event(5, "escrow_allowance_ready"),
      event(6, "escrow_funded"),
      event(7, "deliverable_committed"),
    );
  } else {
    run.state = "awaiting_purchase";
    run.currentOperation = null;
    run.transactions.escalation = tx("7");
    run.events.push(
      event(8, "judge_escalation_confirmed"),
      event(9, "human_judgment_required"),
    );
    run.capabilities.canPurchase = true;
    run.capabilities.canArchive = true;
  }
  run.updatedAt = new Date().toISOString();
}

function attachOrder() {
  const now = new Date().toISOString();
  run.state = "review_active";
  run.currentOperation = "wait_for_review";
  run.orderId = randomUUID();
  run.transactions.payment = tx("8");
  run.events.push(
    event(10, "x402_challenge_received", { amount: "250000" }),
    event(11, "x402_authorization_signed"),
    event(12, "x402_payment_accepted", { amount: "250000" }),
    event(13, "review_order_attached"),
  );
  run.reviewOrder = {
    orderId: run.orderId,
    state: "dispatched",
    payer: client,
    reviewPrice: "250000",
    network: "eip155:5042002",
    gatewayTransaction: tx("8"),
    reviewer: null,
    decision: null,
    reasoning: null,
    evidenceHash: null,
    evidenceUrl: null,
    evidenceVerified: null,
    payoutTransactionHash: null,
    resolutionTransactionHash: null,
    refundTransactionHash: null,
    claimExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    dispatchCount: 1,
    createdAt: now,
    claimedAt: null,
    verdictAt: null,
    paidAt: null,
    settledAt: null,
    lastError: null,
  };
  run.capabilities.canPurchase = false;
  run.capabilities.canArchive = false;
}

function advanceReview() {
  if (
    !telegramVerdictStarted ||
    !run?.reviewOrder ||
    run.state !== "review_active"
  ) {
    return;
  }
  reviewPolls += 1;
  const now = new Date().toISOString();
  if (reviewPolls === 1) {
    run.reviewOrder.state = "claimed";
    run.reviewOrder.reviewer = { alias: "asyncmac", address: reviewer };
    run.reviewOrder.claimedAt = now;
  } else if (reviewPolls === 2) {
    run.reviewOrder.state = "verdict_submitted";
    run.reviewOrder.decision = "approve";
    run.reviewOrder.reasoning =
      "The response contract and HTTP 401 behavior satisfy the stated criteria.";
    run.reviewOrder.verdictAt = now;
  } else if (reviewPolls === 3) {
    run.reviewOrder.state = "reviewer_paid";
    run.reviewOrder.payoutTransactionHash = tx("9");
    run.reviewOrder.paidAt = now;
    run.transactions.payout = tx("9");
    run.events.push(event(14, "payout_confirmed"));
  } else if (reviewPolls >= 4) {
    run.state = "finalized";
    run.currentOperation = null;
    run.completedAt = now;
    run.reviewOrder.state = "settled";
    run.reviewOrder.evidenceHash = tx("e");
    run.reviewOrder.evidenceUrl = `http://127.0.0.1:${port}/v1/evidence/${tx("e")}`;
    run.reviewOrder.evidenceVerified = true;
    run.reviewOrder.resolutionTransactionHash = tx("a");
    run.reviewOrder.settledAt = now;
    run.onChainVerified = true;
    run.transactions.resolution = tx("a");
    run.events.push(
      event(15, "resolution_confirmed"),
      event(16, "on_chain_provenance_verified"),
      event(17, "demo_run_finalized", {
        decision: "approve",
        orderState: "settled",
      }),
    );
    run.capabilities.isTerminal = true;
  }
  run.updatedAt = now;
}

function readiness() {
  return {
    ready: true,
    enabled: true,
    checks: [
      ["demo", "Live demo"],
      ["arc", "Arc and deployed contracts"],
      ["escrow_funds", "Client escrow funds"],
      ["gateway", "Gateway buyer balance"],
      ["x402", "x402 seller"],
      ["telegram", "Telegram council"],
      ["circle", "Circle treasury and resolver"],
      ["judge", "Judge worker"],
    ].map(([key, label]) => ({
      key,
      label,
      status: "ready",
      message: `${label} is ready.`,
    })),
    amounts: {
      escrowBudget: "1000000",
      reviewPrice: "250000",
      reviewerReward: "200000",
    },
    limits: { maxRunsPerHour: 3, jobTtlSeconds: 86_400 },
    addresses: {
      client,
      provider,
      reviewer,
      resolver,
      seller: resolver,
      commerce: "0x0747EEf0706327138c69792bF28Cd525089e4583",
      router: "0x44A51C365eB3eC703534ebb56394E7015930533D",
    },
    balances: {
      clientEscrow: "8295499",
      clientGas: "1",
      providerGas: "1",
      gatewayAvailable: "500000",
      gatewayTotal: "500000",
      circleTreasury: "3000000",
    },
    checkedAt: new Date().toISOString(),
  };
}

function dashboardSnapshot() {
  const timestamp = new Date().toISOString();
  if (snapshotMode === "syncing") {
    return {
      version: 1,
      configured: true,
      status: "syncing",
      latestBlock: null,
      indexedAt: null,
      lastAttemptAt: timestamp,
      lastError: null,
      feed: [],
      reviewQueue: [],
    };
  }
  return {
    version: 1,
    configured: true,
    status: snapshotMode === "stale" ? "stale" : "ready",
    latestBlock: "200000",
    indexedAt: timestamp,
    lastAttemptAt: timestamp,
    lastError:
      snapshotMode === "stale"
        ? "Arc RPC rate limit reached; the background indexer will retry."
        : null,
    feed: [
      {
        id: "160000",
        client,
        provider,
        evaluator: "0x44A51C365eB3eC703534ebb56394E7015930533D",
        description: "Mock verified API contract job",
        budget: "1000000",
        budgetUsdc: "1",
        expiredAt: Math.floor(Date.now() / 1_000) + 86_400,
        statusCode: 3,
        status: "Completed",
        hook: "0x0000000000000000000000000000000000000000",
        provenance: "human",
        lane: "human",
        confidenceBP: null,
        statusTxHash: tx("b"),
        verdictTxHash: tx("a"),
        latestBlock: "199999",
      },
    ],
    reviewQueue: [],
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") return json(response, 200, { status: "ok" });
  if (url.pathname === "/__reset" && request.method === "POST") {
    run = null;
    escrowPolls = 0;
    reviewPolls = 0;
    telegramVerdictStarted = false;
    statusRequests = 0;
    readinessRequests = 0;
    snapshotRequests = 0;
    snapshotMode = "ready";
    return json(response, 200, { reset: true });
  }
  if (
    url.pathname === "/__snapshot-mode" &&
    request.method === "POST"
  ) {
    const mode = url.searchParams.get("mode");
    if (!["ready", "syncing", "stale"].includes(mode)) {
      return json(response, 400, { error: "invalid mode" });
    }
    snapshotMode = mode;
    return json(response, 200, { mode });
  }
  if (url.pathname === "/__stats") {
    return json(response, 200, {
      statusRequests,
      readinessRequests,
      snapshotRequests,
    });
  }
  if (url.pathname === "/__telegram-verdict" && request.method === "POST") {
    telegramVerdictStarted = true;
    for (let step = 0; step < 4; step += 1) advanceReview();
    return json(response, 202, { accepted: true });
  }
  if (url.pathname === "/internal/demo/readiness") {
    readinessRequests += 1;
    return setTimeout(
      () => json(response, 200, { readiness: readiness() }),
      150,
    );
  }
  if (url.pathname === "/internal/dashboard-chain-snapshot") {
    snapshotRequests += 1;
    return json(response, 200, { snapshot: dashboardSnapshot() });
  }
  if (url.pathname === "/internal/review-orders") {
    return json(response, 200, { orders: [] });
  }
  if (url.pathname === "/internal/demo-runs/latest") {
    const terminalOnly = url.searchParams.get("terminal") === "true";
    const visibleRun =
      terminalOnly &&
      run &&
      !["finalized", "archived_refunded"].includes(run.state)
        ? null
        : run;
    return json(response, 200, { run: visibleRun });
  }
  if (url.pathname === "/internal/demo-runs" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      run = baseRun(randomUUID(), parsed.requestId);
      return json(response, 202, {
        runId: run.id,
        state: run.state,
        statusUrl: `/internal/demo-runs/${run.id}`,
      });
    });
    return;
  }
  const match = url.pathname.match(
    /^\/internal\/demo-runs\/([0-9a-f-]+)(?:\/(purchase|retry|archive))?$/,
  );
  if (match) {
    if (!run || match[1] !== run.id) {
      return json(response, 404, {
        error: { code: "demo_run_not_found", message: "Demo run was not found" },
      });
    }
    if (match[2] === "purchase" && request.method === "POST") {
      attachOrder();
      return json(response, 202, { run });
    }
    statusRequests += 1;
    advanceEscrow();
    advanceReview();
    return json(response, 200, { run });
  }
  if (url.pathname === "/openapi.json") {
    return json(response, 200, {
      openapi: "3.1.0",
      info: { title: "Mock review API", version: "1.0.0" },
      paths: {},
    });
  }
  return json(response, 404, { error: "not found" });
}).listen(port, "127.0.0.1");
