import {
  formatUnits,
  getAbiItem,
  getAddress,
  isAddressEqual,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "../chain.js";
import {
  agenticCommerceAbi,
  defaultAgenticCommerceAddress,
  evaluationRouterAbi,
} from "../contracts.js";
import { HUMAN_LANE_REASON_HASH } from "../evidence.js";
import type { ReviewServiceConfig } from "./config.js";
import type { ReviewDatabase } from "./database.js";
import type {
  DashboardChainSnapshot,
  DashboardFeedRow,
  DashboardJobRecord,
  DashboardReviewRecord,
} from "./types.js";

const DASHBOARD_SNAPSHOT_VERSION = 1;
const LOG_CHUNK_SIZE = 9_000n;
const MAX_DASHBOARD_LOOKBACK_BLOCKS = 50_000n;
// A full public-RPC lookback is intentionally low-frequency. Demo and review
// processing use their own targeted reads, so the dashboard must not contend
// with financial operations by continuously replaying the same log range.
const MINIMUM_REFRESH_INTERVAL_MS = 180_000;
const AGENTIC_EVENT_NAMES = [
  "JobSubmitted",
  "JobCompleted",
  "JobRejected",
] as const;
const ROUTER_EVENT_NAMES = [
  "AIVerdict",
  "Escalated",
  "HumanVerdict",
  "LaneSet",
] as const;

type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: unknown };

export interface DashboardSnapshotClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(input: {
    address: Address | Address[];
    events: AbiEvent[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<unknown[]>;
  multicall(input: {
    allowFailure: true;
    contracts: Array<{
      address: Address;
      abi: Abi;
      functionName: string;
      args: unknown[];
    }>;
  }): Promise<MulticallResult[]>;
}

export interface DashboardSnapshotProcessorOptions {
  config: ReviewServiceConfig;
  database: ReviewDatabase;
  client?: DashboardSnapshotClient;
  intervalMs?: number;
  staleAfterMs?: number;
  pinnedJobIds?: string[];
  now?: () => Date;
}

interface ChainEvent {
  eventName: string;
  address: Address;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

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

export class DashboardSnapshotProcessor {
  private readonly config: ReviewServiceConfig;
  private readonly database: ReviewDatabase;
  private readonly client: DashboardSnapshotClient;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly pinnedJobIds: string[];
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private refreshPromise: Promise<DashboardChainSnapshot> | undefined;

  constructor(options: DashboardSnapshotProcessorOptions) {
    this.config = options.config;
    this.database = options.database;
    this.client =
      options.client ?? (publicClient as unknown as DashboardSnapshotClient);
    this.intervalMs =
      options.intervalMs ??
      Math.max(
        options.config.backgroundIntervalMs,
        MINIMUM_REFRESH_INTERVAL_MS,
      );
    this.staleAfterMs =
      options.staleAfterMs ?? Math.max(this.intervalMs * 3, 60_000);
    this.pinnedJobIds =
      options.pinnedJobIds ?? parsePinnedJobIds(process.env.DEMO_JOB_IDS);
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.stopped) void this.refresh();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const inFlight = this.refreshPromise;
    if (!inFlight) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inFlight.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getSnapshot(): DashboardChainSnapshot {
    return this.deriveStatus(
      this.database.getDashboardChainSnapshot() ?? this.initialSnapshot(),
    );
  }

  refresh(): Promise<DashboardChainSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    const lastAttemptAt = this.now().toISOString();
    this.refreshPromise = this.refreshUnsafe(lastAttemptAt)
      .catch((error: unknown) =>
        this.recordRefreshFailure(lastAttemptAt, error),
      )
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  private initialSnapshot(): DashboardChainSnapshot {
    const configured = Boolean(this.config.routerAddress);
    return {
      version: DASHBOARD_SNAPSHOT_VERSION,
      configured,
      status: configured ? "syncing" : "degraded",
      latestBlock: null,
      indexedAt: null,
      lastAttemptAt: null,
      lastError: configured ? null : "ROUTER_ADDRESS is not configured",
      feed: [],
      reviewQueue: [],
    };
  }

  private deriveStatus(
    snapshot: DashboardChainSnapshot,
  ): DashboardChainSnapshot {
    if (!snapshot.configured || snapshot.status === "degraded") {
      return snapshot;
    }
    if (!snapshot.indexedAt) return snapshot;
    const indexedAt = Date.parse(snapshot.indexedAt);
    if (!Number.isFinite(indexedAt)) {
      return {
        ...snapshot,
        status: "degraded",
        lastError: "stored dashboard chain snapshot has an invalid indexedAt",
      };
    }
    const ageMs = this.now().getTime() - indexedAt;
    return ageMs > this.staleAfterMs
      ? { ...snapshot, status: "stale" }
      : { ...snapshot, status: "ready" };
  }

  private async refreshUnsafe(
    lastAttemptAt: string,
  ): Promise<DashboardChainSnapshot> {
    if (!this.config.routerAddress) {
      const snapshot: DashboardChainSnapshot = {
        ...this.initialSnapshot(),
        lastAttemptAt,
      };
      this.database.putDashboardChainSnapshot(snapshot);
      return snapshot;
    }

    const router = this.config.routerAddress;
    const commerce =
      this.config.commerceAddress ?? defaultAgenticCommerceAddress;
    const latestBlock = await this.client.getBlockNumber();
    const lookbackBlocks =
      this.config.logLookbackBlocks > MAX_DASHBOARD_LOOKBACK_BLOCKS
        ? MAX_DASHBOARD_LOOKBACK_BLOCKS
        : this.config.logLookbackBlocks;
    const fromBlock =
      latestBlock > lookbackBlocks
        ? latestBlock - lookbackBlocks
        : 0n;
    const events = await this.sweepEvents({
      router,
      commerce,
      fromBlock,
      toBlock: latestBlock,
    });
    const agentic = events.filter((event) =>
      isAddressEqual(event.address, commerce),
    );
    const routerLogs = events.filter((event) =>
      isAddressEqual(event.address, router),
    );
    const submitted = latestByJob(
      agentic.filter((event) => event.eventName === "JobSubmitted"),
    );
    const pinnedIds = this.database.listDashboardPinnedJobIds(
      this.pinnedJobIds,
    );
    const feedIds = [
      ...agentic.map(jobIdFrom).filter((id): id is string => id !== null),
      ...routerLogs.map(jobIdFrom).filter((id): id is string => id !== null),
      ...pinnedIds,
    ];
    const jobs = await this.getJobs(commerce, feedIds);
    for (const [jobId, job] of jobs) {
      if (!isAddressEqual(job.evaluator, router)) jobs.delete(jobId);
    }

    const verdicts = routerLogs.filter(
      (event) => event.eventName !== "LaneSet",
    );
    const feed = buildFeedRows(jobs, agentic, verdicts);
    const laneByJob = latestByJob(
      routerLogs.filter((event) => event.eventName === "LaneSet"),
    );
    const lanes = await this.readRouterNumbers(
      router,
      "lanes",
      feed.filter((row) => row.lane === null).map((row) => row.id),
    );
    for (const row of feed) {
      const laneEvent = laneByJob.get(row.id);
      const lane =
        laneEvent !== undefined
          ? Number(laneEvent.args.lane)
          : lanes.get(row.id);
      if (lane === 1) row.lane = "human";
      if (lane === 0) row.lane = "AI";
    }
    await this.backfillProvenance(router, feed);
    const reviewQueue = await this.buildReviewQueue({
      router,
      jobs,
      routerLogs,
      submitted,
      feed,
    });

    const indexedAt = this.now().toISOString();
    const snapshot: DashboardChainSnapshot = {
      version: DASHBOARD_SNAPSHOT_VERSION,
      configured: true,
      status: "ready",
      latestBlock: latestBlock.toString(),
      indexedAt,
      lastAttemptAt,
      lastError: null,
      feed,
      reviewQueue,
    };
    this.database.putDashboardChainSnapshot(snapshot);
    return snapshot;
  }

  private async buildReviewQueue(input: {
    router: Address;
    jobs: Map<string, DashboardJobRecord>;
    routerLogs: ChainEvent[];
    submitted: Map<string, ChainEvent>;
    feed: DashboardFeedRow[];
  }): Promise<DashboardReviewRecord[]> {
    const escalations = latestByJob(
      input.routerLogs.filter((event) => event.eventName === "Escalated"),
    );
    const terminalIds = new Set<string>();
    for (const event of input.routerLogs) {
      if (event.eventName !== "HumanVerdict") continue;
      const jobId = jobIdFrom(event);
      if (jobId) terminalIds.add(jobId);
    }
    const metadata = new Map(
      this.database
        .listDashboardPinnedReviewMetadata()
        .map((entry) => [entry.jobId, entry]),
    );
    const candidates = new Set<string>();
    for (const jobId of escalations.keys()) {
      if (!terminalIds.has(jobId)) candidates.add(jobId);
    }
    for (const row of input.feed) {
      if (row.provenance === "escalated" && !terminalIds.has(row.id)) {
        candidates.add(row.id);
      }
    }
    const reasonBackfill = await this.readRouterHexes(
      input.router,
      "evidence",
      [...candidates].filter((jobId) => !escalations.has(jobId)),
    );
    const queue: DashboardReviewRecord[] = [];
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    for (const jobId of candidates) {
      const job = input.jobs.get(jobId);
      if (!job || job.statusCode !== 2 || job.expiredAt <= nowSeconds) continue;
      const escalation = escalations.get(jobId);
      const stored = metadata.get(jobId);
      const rawReasonHash =
        escalation?.args.reasonHash ?? stored?.reasonHash ?? reasonBackfill.get(jobId);
      if (typeof rawReasonHash !== "string") continue;
      const reasonHash = rawReasonHash as Hex;
      const submittedDeliverable = input.submitted.get(jobId)?.args.deliverable;
      const deliverableHash =
        typeof submittedDeliverable === "string"
          ? (submittedDeliverable as Hex)
          : (stored?.deliverableHash ?? null);
      queue.push({
        ...job,
        deliverableHash,
        reasonHash,
        escalationTxHash:
          escalation?.transactionHash ?? stored?.escalationTxHash ?? null,
        clientRequested:
          reasonHash.toLowerCase() === HUMAN_LANE_REASON_HASH.toLowerCase(),
      });
    }
    queue.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    return queue;
  }

  private async sweepEvents(input: {
    router: Address;
    commerce: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainEvent[]> {
    const events = [
      ...AGENTIC_EVENT_NAMES.map((name) =>
        eventFromAbi(agenticCommerceAbi, name),
      ),
      ...ROUTER_EVENT_NAMES.map((name) =>
        eventFromAbi(evaluationRouterAbi, name),
      ),
    ];
    const logs: ChainEvent[] = [];
    for (
      let chunkStart = input.fromBlock;
      chunkStart <= input.toBlock;
      chunkStart += LOG_CHUNK_SIZE
    ) {
      const chunkEnd =
        chunkStart + LOG_CHUNK_SIZE - 1n > input.toBlock
          ? input.toBlock
          : chunkStart + LOG_CHUNK_SIZE - 1n;
      const chunk = await this.client.getLogs({
        address: [input.commerce, input.router],
        events,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of chunk) {
        const normalized = toChainEvent(log);
        if (normalized) logs.push(normalized);
      }
    }
    return logs;
  }

  private async getJobs(
    commerce: Address,
    jobIds: string[],
  ): Promise<Map<string, DashboardJobRecord>> {
    const uniqueIds = normalizeJobIds(jobIds);
    if (uniqueIds.length === 0) return new Map();
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: uniqueIds.map((jobId) => ({
        address: commerce,
        abi: agenticCommerceAbi,
        functionName: "getJob",
        args: [BigInt(jobId)],
      })),
    });
    throwOnTransientRpcFailures(results);
    const jobs = new Map<string, DashboardJobRecord>();
    results.forEach((result, index) => {
      const jobId = uniqueIds[index];
      if (!jobId) return;
      if (result.status !== "success") return;
      try {
        const job = normalizeJob(result.result as RawJob);
        if (job.id === jobId) jobs.set(jobId, job);
      } catch {
        // A corrupt or unknown pinned job must not poison the full snapshot.
      }
    });
    return jobs;
  }

  private async readRouterNumbers(
    router: Address,
    functionName: "lanes" | "resolutions",
    jobIds: string[],
  ): Promise<Map<string, number>> {
    const uniqueIds = normalizeJobIds(jobIds);
    if (uniqueIds.length === 0) return new Map();
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: uniqueIds.map((jobId) => ({
        address: router,
        abi: evaluationRouterAbi,
        functionName,
        args: [BigInt(jobId)],
      })),
    });
    throwOnTransientRpcFailures(results);
    const values = new Map<string, number>();
    results.forEach((result, index) => {
      const jobId = uniqueIds[index];
      if (!jobId) return;
      if (result.status !== "success") return;
      values.set(jobId, Number(result.result));
    });
    return values;
  }

  private async readRouterHexes(
    router: Address,
    functionName: "evidence",
    jobIds: string[],
  ): Promise<Map<string, Hex>> {
    const uniqueIds = normalizeJobIds(jobIds);
    if (uniqueIds.length === 0) return new Map();
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: uniqueIds.map((jobId) => ({
        address: router,
        abi: evaluationRouterAbi,
        functionName,
        args: [BigInt(jobId)],
      })),
    });
    throwOnTransientRpcFailures(results);
    const values = new Map<string, Hex>();
    results.forEach((result, index) => {
      const jobId = uniqueIds[index];
      if (!jobId) return;
      if (result.status !== "success" || typeof result.result !== "string") {
        return;
      }
      values.set(jobId, result.result as Hex);
    });
    return values;
  }

  private async backfillProvenance(
    router: Address,
    rows: DashboardFeedRow[],
  ): Promise<void> {
    const missing = rows.filter((row) => row.provenance === null);
    const resolutions = await this.readRouterNumbers(
      router,
      "resolutions",
      missing.map((row) => row.id),
    );
    for (const row of missing) {
      const code = resolutions.get(row.id);
      if (code === 1 || code === 2) row.provenance = "AI auto";
      if (code === 3) row.provenance = "escalated";
      if (code === 4 || code === 5) row.provenance = "human";
    }
  }

  private recordRefreshFailure(
    lastAttemptAt: string,
    error: unknown,
  ): DashboardChainSnapshot {
    const message = dashboardRefreshErrorMessage(error);
    const previous =
      this.database.getDashboardChainSnapshot() ?? this.initialSnapshot();
    const snapshot: DashboardChainSnapshot = {
      ...previous,
      status: "degraded",
      lastAttemptAt,
      lastError: message,
    };
    this.database.putDashboardChainSnapshot(snapshot);
    return snapshot;
  }
}

function dashboardRefreshErrorMessage(error: unknown): string {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current;
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined
  ) {
    messages.push(current instanceof Error ? current.message : String(current));
  }
  const detail = messages.join(" ");
  if (
    /request limit reached|-32011|\b(?:status|http)[: ]+\s*429\b/i.test(
      detail,
    )
  ) {
    return "Arc RPC rate limit reached; the background indexer will retry.";
  }
  if (
    /timed? ?out|fetch failed|network error|http request failed|\b(?:status|http)[: ]+\s*5\d\d\b|ECONNRESET|ENOTFOUND|ETIMEDOUT|RPC unavailable/i.test(
      detail,
    )
  ) {
    return "Arc RPC is temporarily unavailable; the background indexer will retry.";
  }
  return "Arc evidence refresh failed; the background indexer will retry.";
}

function parsePinnedJobIds(value: string | undefined): string[] {
  return normalizeJobIds(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function normalizeJobIds(jobIds: string[]): string[] {
  const ids = new Set<string>();
  for (const jobId of jobIds) {
    if (/^(0|[1-9]\d*)$/.test(jobId)) ids.add(BigInt(jobId).toString());
  }
  return [...ids];
}

function throwOnTransientRpcFailures(results: MulticallResult[]): void {
  for (const result of results) {
    if (result.status !== "failure") continue;
    for (
      let current: unknown = result.error;
      current;
      current =
        typeof current === "object" && current !== null
          ? (current as { cause?: unknown }).cause
          : undefined
    ) {
      const message =
        current instanceof Error ? current.message : String(current);
      if (
        isTransientRpcMessage(message)
      ) {
        throw result.error;
      }
    }
  }
  if (
    results.length > 0 &&
    results.every((result) => result.status === "failure")
  ) {
    const failed = results[0];
    throw failed?.status === "failure"
      ? failed.error
      : new Error("Arc multicall returned no successful results");
  }
}

function isTransientRpcMessage(message: string): boolean {
  return /request limit reached|-32011|\b(?:status|http)[: ]+\s*(?:429|5\d\d)\b|timed? ?out|fetch failed|network error|http request failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(
    message,
  );
}

function eventFromAbi(abi: Abi, name: string): AbiEvent {
  return getAbiItem({ abi, name }) as AbiEvent;
}

function toChainEvent(log: unknown): ChainEvent | null {
  const value = log as {
    eventName?: string;
    address?: Address;
    args?: Record<string, unknown>;
    blockNumber?: bigint | null;
    logIndex?: number | null;
    transactionHash?: Hex | null;
  };
  if (
    !value.eventName ||
    !value.address ||
    value.blockNumber === null ||
    value.blockNumber === undefined ||
    value.logIndex === null ||
    value.logIndex === undefined ||
    !value.transactionHash
  ) {
    return null;
  }
  return {
    eventName: value.eventName,
    address: getAddress(value.address),
    args: value.args ?? {},
    blockNumber: value.blockNumber,
    logIndex: value.logIndex,
    transactionHash: value.transactionHash,
  };
}

function jobIdFrom(event: ChainEvent): string | null {
  const jobId = event.args.jobId;
  return typeof jobId === "bigint" ? jobId.toString() : null;
}

function isLater(a: ChainEvent, b: ChainEvent | undefined): boolean {
  if (!b) return true;
  return (
    a.blockNumber > b.blockNumber ||
    (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex)
  );
}

function latestByJob(events: ChainEvent[]): Map<string, ChainEvent> {
  const latest = new Map<string, ChainEvent>();
  for (const event of events) {
    const jobId = jobIdFrom(event);
    if (!jobId) continue;
    const previous = latest.get(jobId);
    if (isLater(event, previous)) latest.set(jobId, event);
  }
  return latest;
}

function eventBlock(event: ChainEvent | undefined): bigint {
  return event?.blockNumber ?? 0n;
}

function statusName(
  statusCode: number,
  expiredAt: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const statuses = [
    "Open",
    "Funded",
    "Submitted",
    "Completed",
    "Rejected",
    "Expired",
  ];
  if (statusCode < 3 && expiredAt > 0 && expiredAt <= nowSeconds) {
    return "Expired";
  }
  return statuses[statusCode] ?? "Open";
}

function normalizeJob(raw: RawJob): DashboardJobRecord {
  const expiredAt = Number(raw.expiredAt);
  const statusCode = Number(raw.status);
  return {
    id: BigInt(raw.id).toString(),
    client: getAddress(raw.client),
    provider: getAddress(raw.provider),
    evaluator: getAddress(raw.evaluator),
    description: raw.description,
    budget: BigInt(raw.budget).toString(),
    budgetUsdc: formatUnits(BigInt(raw.budget), 6),
    expiredAt,
    statusCode,
    status: statusName(statusCode, expiredAt),
    hook: getAddress(raw.hook),
  };
}

function buildFeedRows(
  jobs: Map<string, DashboardJobRecord>,
  agentic: ChainEvent[],
  router: ChainEvent[],
): DashboardFeedRow[] {
  const agenticLatest = latestByJob(agentic);
  const routerLatest = latestByJob(router);

  return [...jobs.entries()]
    .map(([jobId, job]) => {
      const jobEvent = agenticLatest.get(jobId);
      const verdictEvent = routerLatest.get(jobId);
      let provenance: DashboardFeedRow["provenance"] = null;
      let confidenceBP: number | null = null;

      if (verdictEvent?.eventName === "HumanVerdict") provenance = "human";
      if (verdictEvent?.eventName === "Escalated") provenance = "escalated";
      if (verdictEvent?.eventName === "AIVerdict") {
        provenance = "AI auto";
        const rawConfidence = verdictEvent.args.confidenceBP;
        confidenceBP =
          typeof rawConfidence === "number"
            ? rawConfidence
            : typeof rawConfidence === "bigint"
              ? Number(rawConfidence)
              : null;
      }

      const latestBlock =
        eventBlock(jobEvent) > eventBlock(verdictEvent)
          ? eventBlock(jobEvent)
          : eventBlock(verdictEvent);

      return {
        ...job,
        provenance,
        lane: null,
        confidenceBP,
        statusTxHash: jobEvent?.transactionHash ?? null,
        verdictTxHash: verdictEvent?.transactionHash ?? null,
        latestBlock: latestBlock.toString(),
      };
    })
    .sort((a, b) => Number(BigInt(b.latestBlock) - BigInt(a.latestBlock)));
}
