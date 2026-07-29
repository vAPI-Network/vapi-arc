import { randomUUID } from "node:crypto";
import { isAddressEqual } from "viem";
import { computeDeliverableHash } from "../deliverables.js";
import type { CircleRail } from "./circle.js";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import type {
  DemoChainRail,
  DemoChainReadiness,
  DemoPaymentHooks,
} from "./demo-chain.js";
import {
  DemoRepository,
  DemoRepositoryError,
} from "./demo-repository.js";
import type {
  CircleOperation,
  DemoReadiness,
  DemoReadinessCheck,
  DemoRun,
  DemoRunState,
  DemoTransactionKey,
  PublicDemoRun,
  ReviewOrder,
} from "./types.js";

export const DEMO_SCENARIO = {
  version: "human-review-v1" as const,
  title: "API contract compliance review",
  acceptanceCriteria:
    'API responses contain "status" and "result"; unauthenticated requests return HTTP 401.',
  deliverable: `Contract summary, final deliverable.

The service agreement obliges the vendor to return JSON responses carrying "status" and "result" fields and to reject unauthenticated requests with HTTP 401. Sections 4 and 7 of the underlying agreement qualify both obligations; the client asked for a human reviewer to weigh those qualifications.`,
} as const;

const ACTIVE_STATES = new Set<DemoRunState>([
  "queued",
  "preparing_escrow",
  "awaiting_escalation",
  "purchasing_review",
  "review_active",
  "archived_refund_pending",
]);
const TERMINAL_STATES = new Set<DemoRunState>([
  "finalized",
  "archived_refunded",
]);
const CIRCLE_TERMINAL_FAILURES = new Set([
  "FAILED",
  "DENIED",
  "CANCELLED",
]);
const RETRYABLE_TRANSACTION_BY_OPERATION: Partial<
  Record<string, DemoTransactionKey>
> = {
  create_job: "createJob",
  set_human_lane: "setLane",
  set_budget: "setBudget",
  approve_usdc: "approval",
  fund_escrow: "fund",
  submit_deliverable: "submit",
  wait_for_refund_eligibility: "escrowRefund",
};
const READY_READINESS_CACHE_MS = 30_000;
const BLOCKED_READINESS_CACHE_MS = 2_000;

export interface DemoController {
  readiness(): Promise<DemoReadiness>;
  createRun(requestId: string): Promise<{
    run: PublicDemoRun;
    created: boolean;
  }>;
  latest(terminalOnly?: boolean): PublicDemoRun | null;
  getRun(runId: string): PublicDemoRun | null;
  purchase(runId: string): PublicDemoRun;
  retry(runId: string): PublicDemoRun;
  archive(runId: string): PublicDemoRun;
}

export interface DemoProcessorDependencies {
  config: ReviewServiceConfig;
  database: ReviewDatabase;
  repository: DemoRepository;
  chain?: DemoChainRail;
  circle?: CircleRail;
  wakeReviewOrder?: (orderId: string, source: string) => void;
}

export class DemoProcessor implements DemoController {
  private readonly processing = new Set<string>();
  private interval?: NodeJS.Timeout;
  private activeSweeps = 0;
  private walletMutationTail: Promise<void> = Promise.resolve();
  private readinessCache?: {
    value: DemoReadiness;
    expiresAt: number;
  };
  private readinessInFlight?: Promise<DemoReadiness>;

  constructor(private readonly dependencies: DemoProcessorDependencies) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(
      () => this.processAllWithLogging(),
      this.dependencies.config.backgroundIntervalMs,
    );
    this.interval.unref();
    this.processAllWithLogging();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.activeSweeps > 0 || this.processing.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return this.activeSweeps === 0 && this.processing.size === 0;
  }

  async readiness(): Promise<DemoReadiness> {
    const cached = this.readinessCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.readinessInFlight) return this.readinessInFlight;

    const check = this.checkReadiness();
    this.readinessInFlight = check;
    try {
      const value = await check;
      this.readinessCache = {
        value,
        expiresAt:
          Date.now() +
          (value.ready
            ? READY_READINESS_CACHE_MS
            : BLOCKED_READINESS_CACHE_MS),
      };
      return value;
    } finally {
      if (this.readinessInFlight === check) {
        this.readinessInFlight = undefined;
      }
    }
  }

  private async checkReadiness(): Promise<DemoReadiness> {
    const { config, database, chain, circle } = this.dependencies;
    const checks: DemoReadinessCheck[] = [];
    const enabled = config.demoEnabled === true;
    checks.push({
      key: "demo",
      label: "Live demo",
      status: enabled ? "ready" : "blocked",
      message: enabled
        ? "Real Arc Testnet transactions are enabled."
        : "Set DEMO_ENABLED=true to enable presenter actions.",
    });

    let chainReadiness: DemoChainReadiness | undefined;
    let treasuryBalance: string | undefined;
    if (!chain) {
      checks.push({
        key: "arc",
        label: "Arc and demo wallets",
        status: "blocked",
        message:
          "DEMO_CLIENT_PK, DEMO_PROVIDER_PK, AGENTIC_COMMERCE, and ROUTER_ADDRESS are required.",
      });
    } else {
      try {
        chainReadiness = await chain.readiness(this.demoBudget);
        const validNetwork = chainReadiness.chainId === 5_042_002;
        const distinctWallets = !isAddressEqual(
          chainReadiness.clientAddress,
          chainReadiness.providerAddress,
        );
        const resolverMatchesCircle =
          config.circleWalletAddress !== undefined &&
          isAddressEqual(
            chainReadiness.resolverAddress,
            config.circleWalletAddress,
          );
        const resolverIsIndependent =
          !isAddressEqual(
            chainReadiness.resolverAddress,
            chainReadiness.clientAddress,
          ) &&
          !isAddressEqual(
            chainReadiness.resolverAddress,
            chainReadiness.providerAddress,
          );
        const enoughToken =
          BigInt(chainReadiness.clientTokenBalance) >= BigInt(this.demoBudget);
        const enoughGas =
          BigInt(chainReadiness.clientNativeBalance) > 0n &&
          BigInt(chainReadiness.providerNativeBalance) > 0n;
        checks.push({
          key: "arc",
          label: "Arc and deployed contracts",
          status:
            validNetwork &&
            chainReadiness.contractsReady &&
            distinctWallets &&
            resolverMatchesCircle &&
            resolverIsIndependent &&
            enoughGas
              ? "ready"
              : "blocked",
          message:
            validNetwork && chainReadiness.contractsReady
              ? distinctWallets &&
                resolverMatchesCircle &&
                resolverIsIndependent &&
                enoughGas
                ? "Arc Testnet, escrow, router, resolver, and signer wallets are ready."
                : "Demo client, provider, and Circle resolver must be distinct, funded, and match the deployed router."
              : "Arc Testnet or a required deployed contract is unavailable.",
        });
        checks.push({
          key: "escrow_funds",
          label: "Client escrow funds",
          status: enoughToken ? "ready" : "blocked",
          message: enoughToken
            ? `${chainReadiness.clientTokenBalance} USDC base units available for escrow.`
            : `${chainReadiness.clientTokenBalance} USDC base units available; ${this.demoBudget} required.`,
        });
        checks.push({
          key: "gateway",
          label: "Gateway buyer balance",
          status:
            BigInt(chainReadiness.gatewayAvailable) >=
            BigInt(config.reviewPrice)
              ? "ready"
              : "blocked",
          message: `${chainReadiness.gatewayAvailable} USDC base units available; ${config.reviewPrice} required.`,
        });
      } catch (error) {
        checks.push({
          key: "arc",
          label: "Arc and demo wallets",
          status: "blocked",
          message: safeMessage(error),
        });
      }
    }

    checks.push({
      key: "x402",
      label: "x402 seller",
      status:
        config.sellerAddress &&
        config.gatewayNetwork === "eip155:5042002"
          ? "ready"
          : "blocked",
      message: config.sellerAddress
        ? `${config.reviewPrice} USDC base-unit review price on Arc Testnet.`
        : "X402_SELLER_ADDRESS is required.",
    });

    const eligibleReviewers =
      chainReadiness === undefined
        ? []
        : database.listEligibleReviewers(
            chainReadiness.clientAddress,
            chainReadiness.providerAddress,
            [chainReadiness.resolverAddress],
          );
    checks.push({
      key: "telegram",
      label: "Telegram council",
      status:
        config.telegramBotToken &&
        config.telegramWebhookSecret &&
        eligibleReviewers.length > 0
          ? "ready"
          : "blocked",
      message:
        eligibleReviewers.length > 0
          ? `${eligibleReviewers.length} non-conflicted auditor${eligibleReviewers.length === 1 ? "" : "s"} available.`
          : "No active non-conflicted Telegram auditor is available.",
    });

    if (!circle?.checkTreasuryBalance) {
      checks.push({
        key: "circle",
        label: "Circle treasury",
        status: "blocked",
        message: "Circle Developer-Controlled Wallets are not configured.",
      });
    } else {
      try {
        const balance = await circle.checkTreasuryBalance();
        treasuryBalance = balance.balance;
        const required =
          BigInt(config.minimumTreasuryBalance) +
          BigInt(config.reviewerReward);
        checks.push({
          key: "circle",
          label: "Circle treasury and resolver",
          status:
            BigInt(balance.balance) >= required ? "ready" : "blocked",
          message: `${balance.balance} USDC base units available; ${required.toString()} required for existing safety reserve plus one reward.`,
        });
      } catch (error) {
        checks.push({
          key: "circle",
          label: "Circle treasury and resolver",
          status: "blocked",
          message: safeMessage(error),
        });
      }
    }

    if (!config.demoJudgeHealthUrl) {
      checks.push({
        key: "judge",
        label: "Judge worker",
        status: "blocked",
        message:
          "DEMO_JUDGE_HEALTH_URL is required so a funded job cannot be stranded waiting for escalation.",
      });
    } else {
      try {
        const response = await fetchWithTimeout(config.demoJudgeHealthUrl, 5_000);
        checks.push({
          key: "judge",
          label: "Judge worker",
          status: response.ok ? "ready" : "blocked",
          message: response.ok
            ? "Judge worker is polling Arc."
            : `Judge health returned HTTP ${response.status}.`,
        });
      } catch (error) {
        checks.push({
          key: "judge",
          label: "Judge worker",
          status: "blocked",
          message: safeMessage(error),
        });
      }
    }

    const blocking = checks.some((check) => check.status === "blocked");
    return {
      ready: enabled && !blocking,
      enabled,
      checks,
      amounts: {
        escrowBudget: this.demoBudget,
        reviewPrice: config.reviewPrice,
        reviewerReward: config.reviewerReward,
      },
      limits: {
        maxRunsPerHour: this.demoMaxRuns,
        jobTtlSeconds: this.demoTtl,
      },
      addresses: {
        client: chainReadiness?.clientAddress ?? null,
        provider: chainReadiness?.providerAddress ?? null,
        reviewer: eligibleReviewers.at(0)?.payoutAddress ?? null,
        resolver: chainReadiness?.resolverAddress ?? null,
        seller: config.sellerAddress ?? null,
        commerce: config.commerceAddress ?? null,
        router: config.routerAddress ?? null,
      },
      balances: {
        clientEscrow: chainReadiness?.clientTokenBalance ?? null,
        clientGas: chainReadiness?.clientNativeBalance ?? null,
        providerGas: chainReadiness?.providerNativeBalance ?? null,
        gatewayAvailable: chainReadiness?.gatewayAvailable ?? null,
        gatewayTotal: chainReadiness?.gatewayTotal ?? null,
        circleTreasury: treasuryBalance ?? null,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async createRun(
    requestId: string,
  ): Promise<{ run: PublicDemoRun; created: boolean }> {
    const existing = this.dependencies.repository.getByRequestId(requestId);
    if (existing) {
      return { run: this.publicRun(existing), created: false };
    }
    const ready = await this.readiness();
    if (!ready.ready) {
      throw new DemoActionError(
        "demo_not_ready",
        "The live demo readiness checks must pass before spending testnet funds",
        503,
        ready,
      );
    }
    const chain = this.requireChain();
    const runId = randomUUID();
    const expiresAt = String(
      Math.floor(Date.now() / 1_000) + this.demoTtl,
    );
    const description = `${DEMO_SCENARIO.acceptanceCriteria} [vAPI demo run ${runId}]`;
    const created = this.dependencies.repository.createRun(
      {
        runId,
        requestId,
        title: DEMO_SCENARIO.title,
        description,
        acceptanceCriteria: DEMO_SCENARIO.acceptanceCriteria,
        deliverableContent: DEMO_SCENARIO.deliverable,
        deliverableHash: computeDeliverableHash(DEMO_SCENARIO.deliverable),
        clientAddress: chain.clientAddress,
        providerAddress: chain.providerAddress,
        budget: this.demoBudget,
        reviewPrice: this.dependencies.config.reviewPrice,
        reward: this.dependencies.config.reviewerReward,
        expiresAt,
      },
      this.demoMaxRuns,
    );
    if (created.created) this.wake(created.run.id, "api_create");
    return {
      run: this.publicRun(created.run),
      created: created.created,
    };
  }

  latest(terminalOnly = false): PublicDemoRun | null {
    const run = terminalOnly
      ? this.dependencies.repository.latestTerminal()
      : this.dependencies.repository.latest();
    return run ? this.publicRun(run) : null;
  }

  getRun(runId: string): PublicDemoRun | null {
    const run = this.dependencies.repository.get(runId);
    return run ? this.publicRun(run) : null;
  }

  purchase(runId: string): PublicDemoRun {
    const run = this.requireRun(runId);
    if (run.state === "purchasing_review" || run.state === "review_active") {
      this.wake(run.id, "api_purchase_replay");
      return this.publicRun(run);
    }
    if (run.state !== "awaiting_purchase") {
      throw new DemoActionError(
        "demo_purchase_not_available",
        "Human review can be purchased only after on-chain escalation",
        409,
      );
    }
    const transitioned = this.dependencies.repository.transition(
      run.id,
      "purchasing_review",
      "purchase_review",
      "review_purchase_requested",
      { amount: run.reviewPrice },
    );
    this.wake(run.id, "api_purchase");
    return this.publicRun(transitioned);
  }

  retry(runId: string): PublicDemoRun {
    let run = this.requireRun(runId);
    const attachedOrder =
      (run.orderId && this.dependencies.database.getOrder(run.orderId)) ||
      this.dependencies.database.getOrderByRequestId(run.requestId);
    if (attachedOrder) this.assertReviewOrderMatchesRun(run, attachedOrder);
    const circleOperation = attachedOrder
      ? this.retryableCircleOperation(attachedOrder)
      : undefined;
    if (attachedOrder && circleOperation) {
      if (!this.circleRetriesExhausted(attachedOrder, circleOperation)) {
        throw new DemoActionError(
          "demo_retry_not_available",
          `Circle ${circleOperation} has not exhausted its automatic retry budget`,
          409,
        );
      }
      this.dependencies.database.resumeCircleOperation(
        attachedOrder.id,
        circleOperation,
        this.dependencies.config.circleMaxAttempts,
      );
      this.dependencies.repository.addEvent(run.id, "review_recovery_requested", {
        orderId: attachedOrder.id,
        operation: circleOperation,
      });
      this.dependencies.wakeReviewOrder?.(
        attachedOrder.id,
        "demo_operator_retry",
      );
      return this.publicRun(this.dependencies.repository.get(run.id)!);
    }
    if (run.state !== "failed") {
      throw new DemoActionError(
        "demo_retry_not_available",
        "Only a failed demo operation or exhausted Circle operation can be retried",
        409,
      );
    }

    const retryKey = run.currentOperation
      ? RETRYABLE_TRANSACTION_BY_OPERATION[run.currentOperation]
      : undefined;
    if (
      retryKey &&
      run.transactions[retryKey] &&
      isRetryableTransactionFailure(run.lastError)
    ) {
      run = this.dependencies.repository.clearTransaction(
        run.id,
        retryKey,
      );
    }

    let recovery =
      run.recoveryState ??
      (attachedOrder ? "review_active" : "preparing_escrow");
    if (
      attachedOrder &&
      (recovery === "purchasing_review" || recovery === "review_active")
    ) {
      recovery = "review_active";
    }
    const currentOperation =
      recovery === "preparing_escrow"
        ? (run.currentOperation ?? "create_job")
        : recovery === "awaiting_escalation"
          ? "wait_for_escalation"
          : recovery === "purchasing_review"
            ? "purchase_review"
            : recovery === "review_active"
              ? "wait_for_review"
              : recovery === "archived_refund_pending"
                ? "wait_for_refund_eligibility"
                : null;
    const transitioned = this.dependencies.repository.transition(
      run.id,
      recovery,
      currentOperation,
      "demo_retry_requested",
    );
    if (ACTIVE_STATES.has(transitioned.state)) {
      this.wake(run.id, "api_retry");
    }
    return this.publicRun(transitioned);
  }

  archive(runId: string): PublicDemoRun {
    const run = this.requireRun(runId);
    if (
      run.state === "finalized" ||
      run.state === "archived_refunded" ||
      run.state === "archived_refund_pending"
    ) {
      return this.publicRun(run);
    }
    if (run.state !== "failed" && run.state !== "awaiting_purchase") {
      throw new DemoActionError(
        "demo_archive_not_available",
        "A demo can be archived only after escalation or from a failed pre-payment operation",
        409,
      );
    }
    const existingOrder =
      (run.orderId && this.dependencies.database.getOrder(run.orderId)) ||
      this.dependencies.database.getOrderByRequestId(run.requestId);
    if (existingOrder) {
      this.assertReviewOrderMatchesRun(run, existingOrder);
      throw new DemoActionError(
        "demo_archive_not_available",
        "A paid human review cannot be archived manually",
        409,
      );
    }
    if (!run.jobId && !run.transactions.createJob) {
      return this.publicRun(
        this.dependencies.repository.transition(
          run.id,
          "archived_refunded",
          null,
          "demo_archived",
          { escrowFunded: false },
        ),
      );
    }
    const transitioned = this.dependencies.repository.transition(
      run.id,
      "archived_refund_pending",
      "wait_for_refund_eligibility",
      "demo_archive_requested",
      { jobId: run.jobId },
    );
    this.wake(run.id, "api_archive");
    return this.publicRun(transitioned);
  }

  /*
   * Circle retry handling is deliberately separate from demo state recovery.
   * The database rotates the idempotency key only after the configured retry
   * budget is durably exhausted, so an operator click cannot repeat a payout.
   */
  private retryableCircleOperation(
    order: ReviewOrder,
  ): CircleOperation | undefined {
    return order.state === "payout_failed"
      ? "payout"
      : order.state === "reviewer_paid_settlement_failed"
        ? "resolution"
        : order.state === "expired"
          ? "refund"
          : undefined;
  }

  private circleRetriesExhausted(
    order: ReviewOrder,
    operation: CircleOperation,
  ): boolean {
    const attempts = this.dependencies.database.listCircleAttempts(
      order.id,
      operation,
    );
    const latest = attempts.at(-1);
    const currentIdempotencyKey =
      operation === "payout"
        ? order.payoutIdempotencyKey
        : operation === "resolution"
          ? order.resolutionIdempotencyKey
          : order.refundIdempotencyKey;
    return Boolean(
      latest &&
        attempts.length >= this.dependencies.config.circleMaxAttempts &&
        CIRCLE_TERMINAL_FAILURES.has(latest.state) &&
        latest.idempotencyKey === currentIdempotencyKey,
    );
  }

  async processAll(): Promise<void> {
    this.activeSweeps += 1;
    try {
      for (const run of this.dependencies.repository.listProcessable()) {
        await this.processRun(run.id);
      }
    } finally {
      this.activeSweeps -= 1;
    }
  }

  async processRun(runId: string): Promise<void> {
    if (this.processing.has(runId)) return;
    this.processing.add(runId);
    try {
      const run = this.dependencies.repository.get(runId);
      if (!run) return;
      switch (run.state) {
        case "queued":
        case "preparing_escrow":
          await this.prepareEscrow(run);
          break;
        case "awaiting_escalation":
          await this.reconcileEscalation(run);
          break;
        case "purchasing_review":
          await this.purchaseReview(run);
          break;
        case "review_active":
          await this.reconcileReview(run);
          break;
        case "archived_refund_pending":
          await this.reconcileArchive(run);
          break;
      }
    } catch (error) {
      if (isTransientDemoError(error)) {
        this.dependencies.repository.noteTransientFailure(runId, error);
      } else {
        this.dependencies.repository.fail(runId, error);
      }
    } finally {
      this.processing.delete(runId);
    }
  }

  private async prepareEscrow(runInput: DemoRun): Promise<void> {
    const chain = this.requireChain();
    let run = runInput;
    if (run.state === "queued") {
      const startBlock =
        run.chainStartBlock ?? (await chain.getBlockNumber()).toString();
      run = this.dependencies.repository.patch(run.id, {
        state: "preparing_escrow",
        currentOperation: "create_job",
        chainStartBlock: startBlock,
        lastError: null,
      });
      this.dependencies.repository.addEvent(run.id, "escrow_preparation_started", {
        chainStartBlock: startBlock,
      });
    }

    switch (run.currentOperation) {
      case "initialize":
      case "create_job":
      case null:
        await this.processCreateJob(run);
        return;
      case "set_human_lane":
        await this.processSetLane(run);
        return;
      case "set_budget":
        await this.processSetBudget(run);
        return;
      case "approve_usdc":
        await this.processApproval(run);
        return;
      case "fund_escrow":
        await this.processFunding(run);
        return;
      case "submit_deliverable":
        await this.processSubmission(run);
        return;
      default:
        throw new Error(`Unknown demo escrow operation ${run.currentOperation}`);
    }
  }

  private async processCreateJob(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const recovered = await chain.findCreatedJob(run);
    if (recovered) {
      if (!run.transactions.createJob) {
        this.dependencies.repository.recordTransaction(
          run.id,
          "createJob",
          recovered.transactionHash,
          "transaction_recovered",
        );
      }
      this.dependencies.repository.completeStep(
        run.id,
        "create_job",
        "set_human_lane",
        "escrow_job_created",
        {
          jobId: recovered.jobId,
          transaction: recovered.transactionHash,
        },
        { jobId: recovered.jobId },
      );
      return;
    }
    if (run.transactions.createJob) {
      const receipt = await this.confirmedReceipt(
        run.id,
        "createJob",
        run.transactions.createJob,
      );
      if (!receipt) return;
      throw new Error(
        "createJob confirmed but its uniquely tagged job could not be recovered",
      );
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendCreateJob(run),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "createJob",
      transaction,
    );
  }

  private async processSetLane(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const jobId = requireJobId(run);
    if ((await chain.getLane(jobId)) === 1) {
      this.dependencies.repository.completeStep(
        run.id,
        "set_human_lane",
        "set_budget",
        "human_lane_selected",
        { jobId },
      );
      return;
    }
    if (run.transactions.setLane) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "setLane",
          run.transactions.setLane,
        ))
      ) {
        return;
      }
      if ((await chain.getLane(jobId)) !== 1) {
        throw new Error("HumanOnly lane transaction did not update the router");
      }
      return;
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendSetLane(jobId),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "setLane",
      transaction,
    );
  }

  private async processSetBudget(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const jobId = requireJobId(run);
    const job = await chain.getJob(jobId);
    if (job.budget.toString() === run.budget) {
      this.dependencies.repository.completeStep(
        run.id,
        "set_budget",
        "approve_usdc",
        "escrow_budget_set",
        { budget: run.budget },
      );
      return;
    }
    if (run.transactions.setBudget) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "setBudget",
          run.transactions.setBudget,
        ))
      ) {
        return;
      }
      const updated = await chain.getJob(jobId);
      if (updated.budget.toString() !== run.budget) {
        throw new Error("setBudget transaction did not update the escrow");
      }
      return;
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendSetBudget(jobId, run.budget),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "setBudget",
      transaction,
    );
  }

  private async processApproval(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    if ((await chain.getAllowance()) >= BigInt(run.budget)) {
      this.dependencies.repository.completeStep(
        run.id,
        "approve_usdc",
        "fund_escrow",
        "escrow_allowance_ready",
        { skipped: run.transactions.approval === null },
      );
      return;
    }
    if (run.transactions.approval) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "approval",
          run.transactions.approval,
        ))
      ) {
        return;
      }
      if ((await chain.getAllowance()) < BigInt(run.budget)) {
        throw new Error("USDC approval did not provide sufficient allowance");
      }
      return;
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendApprove(run.budget),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "approval",
      transaction,
    );
  }

  private async processFunding(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const jobId = requireJobId(run);
    const job = await chain.getJob(jobId);
    if (job.status >= 1) {
      this.dependencies.repository.completeStep(
        run.id,
        "fund_escrow",
        "submit_deliverable",
        "escrow_funded",
        { budget: run.budget },
      );
      return;
    }
    if (run.transactions.fund) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "fund",
          run.transactions.fund,
        ))
      ) {
        return;
      }
      if ((await chain.getJob(jobId)).status < 1) {
        throw new Error("fund transaction did not fund the escrow");
      }
      return;
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendFund(jobId),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "fund",
      transaction,
    );
  }

  private async processSubmission(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const jobId = requireJobId(run);
    if ((await chain.getJob(jobId)).status >= 2) {
      this.dependencies.repository.completeStep(
        run.id,
        "submit_deliverable",
        "wait_for_escalation",
        "deliverable_committed",
        { deliverableHash: run.deliverableHash },
        { state: "awaiting_escalation" },
      );
      return;
    }
    if (run.transactions.submit) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "submit",
          run.transactions.submit,
        ))
      ) {
        return;
      }
      if ((await chain.getJob(jobId)).status < 2) {
        throw new Error("submit transaction did not commit the deliverable");
      }
      return;
    }
    // This invariant is intentionally checked again immediately before
    // submission: HumanOnly must be on-chain before the judge can observe it.
    if ((await chain.getLane(jobId)) !== 1) {
      throw new Error("HumanOnly lane is not set before deliverable submission");
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendSubmit(jobId, run.deliverableHash),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "submit",
      transaction,
    );
  }

  private async reconcileEscalation(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    const jobId = requireJobId(run);
    const resolution = await chain.getResolution(jobId);
    if (resolution === 0) {
      if (BigInt(run.expiresAt) <= BigInt(Math.floor(Date.now() / 1_000))) {
        throw new Error("Escrow expired before the judge escalated it");
      }
      return;
    }
    if (resolution !== 3) {
      throw new Error(
        `Expected HumanOnly escalation, received router resolution ${resolution}`,
      );
    }
    const transaction = await chain.findEscalationTransaction(
      jobId,
      run.chainStartBlock,
    );
    if (transaction && run.transactions.escalation !== transaction) {
      this.dependencies.repository.recordTransaction(
        run.id,
        "escalation",
        transaction,
        "judge_escalation_confirmed",
      );
    }
    this.dependencies.repository.transition(
      run.id,
      "awaiting_purchase",
      null,
      "human_judgment_required",
      { jobId, transaction },
    );
  }

  private async purchaseReview(run: DemoRun): Promise<void> {
    const existing =
      (run.orderId && this.dependencies.database.getOrder(run.orderId)) ||
      this.dependencies.database.getOrderByRequestId(run.requestId);
    if (existing) {
      this.assertReviewOrderMatchesRun(run, existing);
      await this.attachReviewOrder(run, existing);
      return;
    }
    let challengeAlreadyRecorded = this.dependencies.repository
      .listEvents(run.id)
      .some((event) => event.type === "x402_challenge_received");
    let authorizationAlreadyRecorded = this.dependencies.repository
      .listEvents(run.id)
      .some((event) => event.type === "x402_authorization_signed");
    const hooks: DemoPaymentHooks = {
      onChallenge: (requirements) => {
        if (!challengeAlreadyRecorded) {
          this.dependencies.repository.addEvent(
            run.id,
            "x402_challenge_received",
            requirements,
          );
          challengeAlreadyRecorded = true;
        }
      },
      onAuthorization: () => {
        if (!authorizationAlreadyRecorded) {
          this.dependencies.repository.addEvent(
            run.id,
            "x402_authorization_signed",
            { signer: run.clientAddress },
          );
          authorizationAlreadyRecorded = true;
        }
      },
    };
    const payment = await this.requireChain().purchaseReview(run, hooks);
    const order =
      this.dependencies.database.getOrder(payment.orderId) ??
      this.dependencies.database.getOrderByRequestId(run.requestId);
    if (!order) {
      throw new Error(
        "x402 returned a review order that is not present in durable storage",
      );
    }
    this.assertReviewOrderMatchesRun(run, order);
    if (payment.transaction) {
      this.dependencies.repository.recordTransaction(
        run.id,
        "payment",
        payment.transaction,
        "x402_payment_accepted",
      );
    } else {
      this.dependencies.repository.addEvent(run.id, "x402_order_recovered", {
        orderId: order.id,
      });
    }
    await this.attachReviewOrder(
      this.dependencies.repository.get(run.id)!,
      order,
    );
  }

  private async attachReviewOrder(
    run: DemoRun,
    order: ReviewOrder,
  ): Promise<void> {
    this.assertReviewOrderMatchesRun(run, order);
    this.dependencies.repository.completeStep(
      run.id,
      "purchase_review",
      "wait_for_review",
      "review_order_attached",
      { orderId: order.id, state: order.state },
      { orderId: order.id, state: "review_active" },
    );
    await this.reconcileReview(this.dependencies.repository.get(run.id)!);
  }

  private async reconcileReview(run: DemoRun): Promise<void> {
    const order =
      (run.orderId && this.dependencies.database.getOrder(run.orderId)) ||
      this.dependencies.database.getOrderByRequestId(run.requestId);
    if (!order) {
      throw new Error("Attached human review order was not found");
    }
    this.assertReviewOrderMatchesRun(run, order);
    if (!run.orderId) {
      this.dependencies.repository.patch(run.id, { orderId: order.id });
    }
    this.syncOrderTransaction(run, "payment", order.gatewayTransaction);
    this.syncOrderTransaction(run, "payout", order.payoutTransactionHash);
    this.syncOrderTransaction(
      run,
      "resolution",
      order.resolutionTransactionHash,
    );
    this.syncOrderTransaction(
      run,
      "reviewRefund",
      order.refundTransactionHash,
    );
    if (order.state === "refunded") {
      this.dependencies.repository.transition(
        run.id,
        "archived_refund_pending",
        "wait_for_refund_eligibility",
        "review_payment_refunded_escrow_pending",
        {
          orderId: order.id,
          reviewRefundTransaction: order.refundTransactionHash,
          escrowExpiresAt: run.expiresAt,
        },
      );
      return;
    }
    if (order.state === "settled") {
      if (!order.resolutionTransactionHash) {
        throw new Error(
          "Settled review order is missing its humanResolve transaction",
        );
      }
      if (
        !(await this.confirmedReceipt(
          run.id,
          "resolution",
          order.resolutionTransactionHash,
        ))
      ) {
        return;
      }
      const chain = this.requireChain();
      const jobId = requireJobId(run);
      const [job, provenance] = await Promise.all([
        chain.getJob(jobId),
        chain.getHumanResolution(jobId),
      ]);
      const expectedResolution =
        order.decision === "approve"
          ? 4
          : order.decision === "reject"
            ? 5
            : 0;
      const expectedJobStatus =
        order.decision === "approve"
          ? 3
          : order.decision === "reject"
            ? 4
            : 0;
      const evidenceVerified =
        this.dependencies.database.internalOrder(
          order,
          this.dependencies.config.publicBaseUrl,
        ).evidenceVerified === true;
      const provenanceMatches =
        expectedResolution !== 0 &&
        expectedJobStatus !== 0 &&
        job.status === expectedJobStatus &&
        provenance.resolution === expectedResolution &&
        order.evidenceHash !== null &&
        provenance.evidenceHash.toLowerCase() ===
          order.evidenceHash.toLowerCase() &&
        order.reviewerPayoutAddress !== null &&
        isAddressEqual(
          provenance.reviewer,
          order.reviewerPayoutAddress,
        ) &&
        provenance.reward === order.reward &&
        order.payoutTransactionHash !== null &&
        provenance.payoutTransactionHash.toLowerCase() ===
          order.payoutTransactionHash.toLowerCase();
      if (!evidenceVerified || !provenanceMatches) {
        throw new Error(
          "Human review evidence does not match the terminal Arc router provenance",
        );
      }
      if (!run.onChainVerified) {
        this.dependencies.repository.patch(run.id, {
          onChainVerified: true,
        });
        this.dependencies.repository.addEvent(
          run.id,
          "on_chain_provenance_verified",
          {
            resolution: provenance.resolution,
            decision: order.decision,
            evidenceHash: provenance.evidenceHash,
          },
        );
      }
      this.dependencies.repository.transition(
        run.id,
        "finalized",
        null,
        "demo_run_finalized",
        {
          orderId: order.id,
          orderState: order.state,
          decision: order.decision,
          evidenceHash: order.evidenceHash,
        },
      );
    }
  }

  private syncOrderTransaction(
    run: DemoRun,
    key:
      | "payment"
      | "payout"
      | "resolution"
      | "reviewRefund",
    transaction: string | null,
  ): void {
    if (transaction && run.transactions[key] !== transaction) {
      this.dependencies.repository.recordTransaction(
        run.id,
        key,
        transaction,
        `${key}_confirmed`,
      );
    }
  }

  private assertReviewOrderMatchesRun(
    run: DemoRun,
    order: ReviewOrder,
  ): void {
    if (!this.reviewOrderMatchesRun(run, order)) {
      throw new DemoActionError(
        "demo_order_conflict",
        "Existing paid review order does not match the immutable demo run",
        409,
      );
    }
  }

  private reviewOrderMatchesRun(
    run: DemoRun,
    order: ReviewOrder,
  ): boolean {
    return (
      order.requestId === run.requestId &&
      order.jobId === run.jobId &&
      isAddressEqual(order.payer, run.clientAddress) &&
      order.reviewPrice === run.reviewPrice &&
      order.network === this.dependencies.config.gatewayNetwork &&
      order.gatewayTransaction !== null &&
      isAddressEqual(order.jobClient, run.clientAddress) &&
      isAddressEqual(order.jobProvider, run.providerAddress) &&
      order.jobDescription === run.description &&
      order.jobBudget === run.budget &&
      order.deliverableContent === run.deliverableContent &&
      order.deliverableHash.toLowerCase() ===
        run.deliverableHash.toLowerCase() &&
      order.reward === run.reward
    );
  }

  private async reconcileArchive(run: DemoRun): Promise<void> {
    const chain = this.requireChain();
    if (!run.jobId) {
      const recovered = await chain.findCreatedJob(run);
      if (recovered) {
        if (!run.transactions.createJob) {
          this.dependencies.repository.recordTransaction(
            run.id,
            "createJob",
            recovered.transactionHash,
            "transaction_recovered",
          );
        }
        this.dependencies.repository.patch(run.id, {
          jobId: recovered.jobId,
        });
        this.dependencies.repository.addEvent(
          run.id,
          "archived_job_recovered",
          { jobId: recovered.jobId },
        );
        return;
      }
      if (run.transactions.createJob) {
        const receipt = await this.confirmedReceipt(
          run.id,
          "createJob",
          run.transactions.createJob,
        );
        if (!receipt) return;
        throw new Error(
          "Archived createJob confirmed but its tagged job could not be recovered",
        );
      }
      this.dependencies.repository.transition(
        run.id,
        "archived_refunded",
        null,
        "demo_archived",
        { escrowFunded: false },
      );
      return;
    }
    let job = await chain.getJob(run.jobId);
    if (job.status === 3) {
      throw new Error(
        "Archived escrow was completed to the provider and cannot be reported as a client refund",
      );
    }
    if (job.status === 4) {
      this.dependencies.repository.transition(
        run.id,
        "archived_refunded",
        null,
        "demo_archive_complete",
        { refundRequired: false, jobStatus: job.status, recipient: "client" },
      );
      return;
    }
    if (job.status === 0) {
      if (run.transactions.fund) {
        if (
          !(await this.confirmedReceipt(
            run.id,
            "fund",
            run.transactions.fund,
          ))
        ) {
          return;
        }
        job = await chain.getJob(run.jobId);
        if (job.status === 3) {
          throw new Error(
            "Archived escrow was completed to the provider and cannot be reported as a client refund",
          );
        }
        if (job.status === 4) {
          this.dependencies.repository.transition(
            run.id,
            "archived_refunded",
            null,
            "demo_archive_complete",
            {
              refundRequired: false,
              jobStatus: job.status,
              recipient: "client",
            },
          );
          return;
        }
        if (job.status === 0) {
          throw new Error(
            "Confirmed fund transaction did not update the escrow; refund state is uncertain",
          );
        }
      } else {
        this.dependencies.repository.transition(
          run.id,
          "archived_refunded",
          null,
          "demo_archive_complete",
          { refundRequired: false, jobStatus: 0, escrowFunded: false },
        );
        return;
      }
    }
    if (BigInt(job.expiredAt) > BigInt(Math.floor(Date.now() / 1_000))) {
      return;
    }
    if (run.transactions.escrowRefund) {
      if (
        !(await this.confirmedReceipt(
          run.id,
          "escrowRefund",
          run.transactions.escrowRefund,
        ))
      ) {
        return;
      }
      const refundedJob = await chain.getJob(run.jobId);
      if (refundedJob.status === 3) {
        throw new Error(
          "claimRefund receipt conflicts with a provider-completed escrow",
        );
      }
      if (refundedJob.status !== 4) return;
      this.dependencies.repository.transition(
        run.id,
        "archived_refunded",
        null,
        "escrow_refund_confirmed",
        { transaction: run.transactions.escrowRefund },
      );
      return;
    }
    const transaction = await this.serializeWalletMutation(() =>
      chain.sendClaimRefund(run.jobId!),
    );
    this.dependencies.repository.recordTransaction(
      run.id,
      "escrowRefund",
      transaction,
      "escrow_refund_submitted",
    );
  }

  private async confirmedReceipt(
    _runId: string,
    _key: DemoTransactionKey,
    transaction: string,
  ): Promise<true | false> {
    const receipt = await this.requireChain().getReceipt(transaction);
    if (!receipt) return false;
    if (receipt.status !== "success") {
      throw new Error(`Arc transaction reverted: ${transaction}`);
    }
    return true;
  }

  private async serializeWalletMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.walletMutationTail;
    let release!: () => void;
    this.walletMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private publicRun(runInput: DemoRun): PublicDemoRun {
    const latest = this.dependencies.repository.get(runInput.id) ?? runInput;
    const candidateOrder =
      (latest.orderId &&
        this.dependencies.database.getOrder(latest.orderId)) ||
      this.dependencies.database.getOrderByRequestId(latest.requestId);
    const order =
      candidateOrder &&
      this.reviewOrderMatchesRun(latest, candidateOrder)
        ? candidateOrder
        : undefined;
    const {
      recoveryState: _recoveryState,
      chainStartBlock: _chainStartBlock,
      completedSteps: _completedSteps,
      ...safe
    } = latest;
    return {
      ...safe,
      events: this.dependencies.repository
        .listEvents(latest.id)
        .map(({ runId: _runId, ...event }) => event),
      reviewOrder: order
        ? (() => {
            const internal = this.dependencies.database.internalOrder(
              order,
              this.dependencies.config.publicBaseUrl,
            );
            return {
              ...this.dependencies.database.publicOrder(
                order,
                this.dependencies.config.publicBaseUrl,
              ),
              evidenceVerified: internal.evidenceVerified,
              claimExpiresAt: internal.claimExpiresAt,
              dispatchCount: internal.dispatchCount,
            };
          })()
        : null,
      capabilities: {
        canPurchase: latest.state === "awaiting_purchase",
        canRetry:
          latest.state === "failed" ||
          order?.state === "payout_failed" ||
          order?.state === "reviewer_paid_settlement_failed" ||
          (order?.state === "expired" &&
            this.circleRetriesExhausted(order, "refund")),
        canArchive:
          !order &&
          !TERMINAL_STATES.has(latest.state) &&
          (latest.state === "failed" ||
            latest.state === "awaiting_purchase"),
        isTerminal: TERMINAL_STATES.has(latest.state),
      },
    };
  }

  private requireRun(runId: string): DemoRun {
    const run = this.dependencies.repository.get(runId);
    if (!run) {
      throw new DemoRepositoryError(
        "demo_run_not_found",
        "Demo run was not found",
        404,
      );
    }
    return run;
  }

  private requireChain(): DemoChainRail {
    if (!this.dependencies.chain) {
      throw new Error("Live Arc demo rail is not configured");
    }
    return this.dependencies.chain;
  }

  private wake(runId: string, source: string): void {
    queueMicrotask(() => {
      void this.processRun(runId).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "demo_run_wake_failed",
            runId,
            source,
            error: safeMessage(error),
          }),
        );
      });
    });
  }

  private processAllWithLogging(): void {
    void this.processAll().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "demo_processor_failed",
          error: safeMessage(error),
        }),
      );
    });
  }

  private get demoBudget(): string {
    return this.dependencies.config.demoEscrowBudget ?? "1000000";
  }

  private get demoTtl(): number {
    return this.dependencies.config.demoJobTtlSeconds ?? 86_400;
  }

  private get demoMaxRuns(): number {
    return this.dependencies.config.demoMaxRunsPerHour ?? 3;
  }
}

export class DemoActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 409 | 503,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function requireJobId(run: DemoRun): string {
  if (!run.jobId) throw new Error("Demo run is missing its escrow job id");
  return run.jobId;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isTransientDemoError(error: unknown): boolean {
  const name =
    error instanceof Error ? error.name.toLowerCase() : "";
  const message =
    (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    name.includes("timeout") ||
    name.includes("abort") ||
    name.includes("httprequest") ||
    name.includes("socket") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("http 429") ||
    /\bhttp (?:5\d\d)\b/.test(message) ||
    message.includes("rpc request failed")
  );
}

function isRetryableTransactionFailure(message: string | null): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("arc transaction reverted");
}
