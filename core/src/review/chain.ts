import {
  getAddress,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { publicClient, type ArcPublicClient } from "../chain.js";
import {
  agenticCommerceAbi,
  defaultAgenticCommerceAddress,
  evaluationRouterAbi,
} from "../contracts.js";
import { computeDeliverableHash } from "../deliverables.js";
import type {
  ReviewDecision,
  ReviewOrder,
  ReviewerSnapshot,
  ValidatedReviewJob,
} from "./types.js";
import type { ReviewServiceConfig } from "./config.js";

const STATUS_SUBMITTED = 2;
const RESOLUTION_ESCALATED = 3;
const LOG_BLOCK_RANGE = 2_000n;
const MAX_CONCURRENT_VALIDATIONS = 4;
const DELIVERABLE_CACHE_LIMIT = 2_048;
const jobSubmittedEvent = parseAbiItem(
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
);

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export const humanResolveV3Abi = parseAbi([
  "function humanResolve(uint256 jobId,address reviewer,bool approve,uint256 reward,bytes32 evidenceHash,bytes32 payoutTxHash)",
]);

interface RawJob {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
}

export class ReviewValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 422,
    readonly code = "invalid_review_job",
    readonly permanent = false,
  ) {
    super(message);
  }
}

export interface ReviewValidationOptions {
  minJobExpiryBufferSeconds?: number;
}

export interface ReviewChain {
  validateReview(
    jobId: string,
    content: string,
    options?: ReviewValidationOptions,
  ): Promise<ValidatedReviewJob>;
  preflightHumanResolve(input: {
    order: ReviewOrder;
    reviewer: ReviewerSnapshot;
    evidenceHash: Hex;
    payoutTransactionHash: Hex;
  }): Promise<void>;
  assertReady?(): Promise<void>;
}

export interface LiveReviewChainOptions {
  client?: ArcPublicClient;
  routerAddress: Address;
  commerceAddress?: Address;
  resolverAddress?: Address;
  logLookbackBlocks?: bigint;
  minJobExpiryBufferSeconds?: number;
}

export class LiveReviewChain implements ReviewChain {
  private readonly client: ArcPublicClient;
  private readonly routerAddress: Address;
  private readonly commerceAddress: Address;
  private readonly resolverAddress?: Address;
  private readonly logLookbackBlocks: bigint;
  private readonly minJobExpiryBufferSeconds: number;
  private readonly validationSemaphore = new AsyncSemaphore(
    MAX_CONCURRENT_VALIDATIONS,
  );
  private readonly deliverableHashes = new Map<string, Hex>();
  private readonly deliverableHashRequests = new Map<string, Promise<Hex>>();

  constructor(options: LiveReviewChainOptions) {
    this.client = options.client ?? publicClient;
    this.routerAddress = getAddress(options.routerAddress);
    this.commerceAddress = getAddress(
      options.commerceAddress ?? defaultAgenticCommerceAddress,
    );
    this.resolverAddress = options.resolverAddress
      ? getAddress(options.resolverAddress)
      : undefined;
    this.logLookbackBlocks = options.logLookbackBlocks ?? 100_000n;
    this.minJobExpiryBufferSeconds = options.minJobExpiryBufferSeconds ?? 0;
  }

  async validateReview(
    jobIdString: string,
    content: string,
    options: ReviewValidationOptions = {},
  ): Promise<ValidatedReviewJob> {
    return this.validationSemaphore.run(() =>
      this.validateReviewWithRpc(jobIdString, content, options),
    );
  }

  private async validateReviewWithRpc(
    jobIdString: string,
    content: string,
    options: ReviewValidationOptions,
  ): Promise<ValidatedReviewJob> {
    const jobId = BigInt(jobIdString);
    const raw = (await this.client.readContract({
      address: this.commerceAddress,
      abi: agenticCommerceAbi,
      functionName: "getJob",
      args: [jobId],
    })) as RawJob;
    const job: RawJob = {
      ...raw,
      id: BigInt(raw.id),
      client: getAddress(raw.client),
      provider: getAddress(raw.provider),
      evaluator: getAddress(raw.evaluator),
      budget: BigInt(raw.budget),
      expiredAt: BigInt(raw.expiredAt),
      status: Number(raw.status),
      hook: getAddress(raw.hook),
    };
    if (job.id !== jobId) {
      throw new ReviewValidationError(
        "job does not exist",
        404,
        "job_not_found",
      );
    }
    if (!isAddressEqual(job.evaluator, this.routerAddress)) {
      throw new ReviewValidationError(
        "job is not assigned to the current EvaluationRouter",
        409,
        "wrong_evaluator",
        true,
      );
    }
    if (job.status !== STATUS_SUBMITTED) {
      throw new ReviewValidationError(
        "job is not in Submitted state",
        409,
        "wrong_job_status",
        job.status === 3 || job.status === 4,
      );
    }
    const expiryBuffer =
      options.minJobExpiryBufferSeconds ?? this.minJobExpiryBufferSeconds;
    if (!Number.isSafeInteger(expiryBuffer) || expiryBuffer < 0) {
      throw new Error(
        "review expiry buffer must be a safe non-negative integer",
      );
    }
    const minimumExpiry =
      BigInt(Math.floor(Date.now() / 1_000)) + BigInt(expiryBuffer);
    if (job.expiredAt < minimumExpiry) {
      throw new ReviewValidationError(
        `job expires too soon for the current review phase; require at least ${expiryBuffer} seconds`,
        409,
        "job_expiry_too_close",
        true,
      );
    }

    const resolution = Number(
      await this.client.readContract({
        address: this.routerAddress,
        abi: evaluationRouterAbi,
        functionName: "resolutions",
        args: [jobId],
      }),
    );
    if (resolution !== RESOLUTION_ESCALATED) {
      throw new ReviewValidationError(
        "job has not been escalated for human review",
        409,
        "job_not_escalated",
        [1, 2, 4, 5].includes(resolution),
      );
    }
    const [deliverableHash, escalationReasonHash] = await Promise.all([
      this.findDeliverableHash(jobId),
      this.client.readContract({
        address: this.routerAddress,
        abi: evaluationRouterAbi,
        functionName: "evidence",
        args: [jobId],
      }) as Promise<Hex>,
    ]);
    if (
      computeDeliverableHash(content).toLowerCase() !==
      deliverableHash.toLowerCase()
    ) {
      throw new ReviewValidationError(
        "deliverable content does not match the on-chain commitment",
        422,
        "deliverable_hash_mismatch",
        true,
      );
    }
    return {
      jobId: jobId.toString(),
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      description: job.description,
      budget: job.budget.toString(),
      expiredAt: job.expiredAt.toString(),
      deliverableHash,
      escalationReasonHash,
    };
  }

  private async findDeliverableHash(jobId: bigint): Promise<Hex> {
    const key = jobId.toString();
    const cached = this.deliverableHashes.get(key);
    if (cached) return cached;
    let request = this.deliverableHashRequests.get(key);
    if (!request) {
      request = this.scanDeliverableHash(jobId);
      this.deliverableHashRequests.set(key, request);
    }
    try {
      const hash = await request;
      if (this.deliverableHashes.size >= DELIVERABLE_CACHE_LIMIT) {
        const oldest = this.deliverableHashes.keys().next().value;
        if (oldest !== undefined) this.deliverableHashes.delete(oldest);
      }
      this.deliverableHashes.set(key, hash);
      return hash;
    } finally {
      if (this.deliverableHashRequests.get(key) === request) {
        this.deliverableHashRequests.delete(key);
      }
    }
  }

  private async scanDeliverableHash(jobId: bigint): Promise<Hex> {
    const latest = await this.client.getBlockNumber();
    const earliest =
      latest > this.logLookbackBlocks ? latest - this.logLookbackBlocks : 0n;
    let toBlock = latest;
    while (toBlock >= earliest) {
      const fromBlock =
        toBlock - earliest + 1n > LOG_BLOCK_RANGE
          ? toBlock - LOG_BLOCK_RANGE + 1n
          : earliest;
      const logs = await this.client.getLogs({
        address: this.commerceAddress,
        event: jobSubmittedEvent,
        args: { jobId },
        fromBlock,
        toBlock,
        strict: true,
      });
      const latestLog = logs.at(-1);
      if (latestLog?.args.deliverable) {
        return latestLog.args.deliverable as Hex;
      }
      if (fromBlock === earliest) break;
      toBlock = fromBlock - 1n;
    }
    throw new ReviewValidationError(
      "JobSubmitted commitment was not found within the configured block lookback",
      422,
      "deliverable_commitment_not_found",
    );
  }

  async preflightHumanResolve(input: {
    order: ReviewOrder;
    reviewer: ReviewerSnapshot;
    evidenceHash: Hex;
    payoutTransactionHash: Hex;
  }): Promise<void> {
    if (!input.order.decision) throw new Error("verdict is missing");
    if (!this.resolverAddress) {
      throw new Error(
        "CIRCLE_WALLET_ADDRESS is required to preflight human resolution",
      );
    }
    await this.client.simulateContract({
      account: this.resolverAddress,
      address: this.routerAddress,
      abi: humanResolveV3Abi,
      functionName: "humanResolve",
      args: [
        BigInt(input.order.jobId),
        input.reviewer.payoutAddress,
        input.order.decision === "approve",
        BigInt(input.order.reward),
        input.evidenceHash,
        input.payoutTransactionHash,
      ],
    });
  }

  async assertReady(): Promise<void> {
    if (!this.resolverAddress) {
      throw new Error(
        "CIRCLE_WALLET_ADDRESS is required for the paid review service",
      );
    }
    const [target, humanResolver] = await Promise.all([
      this.client.readContract({
        address: this.routerAddress,
        abi: evaluationRouterAbi,
        functionName: "target",
      }),
      this.client.readContract({
        address: this.routerAddress,
        abi: evaluationRouterAbi,
        functionName: "humanResolver",
      }),
    ]);
    if (!isAddressEqual(getAddress(target as Address), this.commerceAddress)) {
      throw new Error("ROUTER_ADDRESS target does not match AGENTIC_COMMERCE");
    }
    if (
      !isAddressEqual(
        getAddress(humanResolver as Address),
        this.resolverAddress,
      )
    ) {
      throw new Error(
        "EvaluationRouter humanResolver does not match CIRCLE_WALLET_ADDRESS",
      );
    }
  }
}

export function createLiveReviewChain(
  config: ReviewServiceConfig,
): ReviewChain | undefined {
  if (!config.routerAddress) return undefined;
  return new LiveReviewChain({
    routerAddress: config.routerAddress,
    commerceAddress: config.commerceAddress,
    resolverAddress: config.circleWalletAddress,
    logLookbackBlocks: config.logLookbackBlocks,
    minJobExpiryBufferSeconds: config.minJobExpiryBufferSeconds,
  });
}

export function verdictApproved(decision: ReviewDecision): boolean {
  return decision === "approve";
}
