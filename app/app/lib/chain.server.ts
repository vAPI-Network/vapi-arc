import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAbiItem,
  getAddress,
  http,
  isAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hash,
} from "viem";

import agenticCommerceArtifact from "../../../adapters/arc/abi/AgenticCommerce.json";
import evaluationRouterArtifact from "../../../adapters/arc/abi/EvaluationRouter.json";

const ARC_CHAIN_ID = 5_042_002;
const ARC_RPC_URL =
  process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const RECENT_BLOCKS = 50_000n;
const LOG_CHUNK_SIZE = 9_000n;
const CACHE_TTL_MS = 15_000;

const agenticCommerceAddress = getAddress(
  agenticCommerceArtifact.proxy as Address,
);
const agenticCommerceAbi = agenticCommerceArtifact.abi as Abi;
const evaluationRouterAbi = evaluationRouterArtifact.abi as Abi;

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, {
    retryCount: 2,
    retryDelay: 250,
    timeout: 12_000,
  }),
});

type CacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();

export function cached<T>(
  key: string,
  producer: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return existing.value;

  const value = producer().catch((error) => {
    memoryCache.delete(key);
    throw error;
  });
  memoryCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

export type ChainEvent = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
};

export type JobRecord = {
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
};

export type FeedRow = JobRecord & {
  provenance: "AI auto" | "escalated" | "human" | null;
  confidenceBP: number | null;
  statusTxHash: Hash | null;
  verdictTxHash: Hash | null;
  latestBlock: string;
};

export type ReviewRecord = JobRecord & {
  deliverableHash: Hash | null;
  reasonHash: Hash;
  escalationTxHash: Hash;
};

export type ReputationData = {
  address: Address;
  completed: number;
  rejected: number;
  n: number;
  volumeUsdc: string;
  reliability: number | null;
  rated: boolean;
  disclaimer: string;
  history: FeedRow[];
};

function configuredRouterAddress(): Address | null {
  const value = process.env.ROUTER_ADDRESS;
  return value && isAddress(value) ? getAddress(value) : null;
}

export function hasConfiguredRouter(): boolean {
  return configuredRouterAddress() !== null;
}

function eventFromAbi(abi: Abi, name: string): AbiEvent {
  return getAbiItem({ abi, name }) as AbiEvent;
}

function toChainEvent(eventName: string, log: unknown): ChainEvent | null {
  const value = log as {
    args?: Record<string, unknown>;
    blockNumber?: bigint | null;
    logIndex?: number | null;
    transactionHash?: Hash | null;
  };
  if (
    value.blockNumber === null ||
    value.blockNumber === undefined ||
    value.logIndex === null ||
    value.logIndex === undefined ||
    !value.transactionHash
  ) {
    return null;
  }
  return {
    eventName,
    args: value.args ?? {},
    blockNumber: value.blockNumber,
    logIndex: value.logIndex,
    transactionHash: value.transactionHash,
  };
}

async function recentRange(): Promise<{ fromBlock: bigint; toBlock: bigint }> {
  const toBlock = await cached("latest-block", () =>
    publicClient.getBlockNumber(),
  );
  return {
    fromBlock: toBlock > RECENT_BLOCKS ? toBlock - RECENT_BLOCKS : 0n,
    toBlock,
  };
}

async function getLogsChunked(
  address: Address,
  abi: Abi,
  eventName: string,
): Promise<ChainEvent[]> {
  const { fromBlock, toBlock } = await recentRange();
  const cacheKey = [
    "logs",
    address,
    eventName,
    fromBlock.toString(),
    toBlock.toString(),
  ].join(":");

  return cached(cacheKey, async () => {
    const event = eventFromAbi(abi, eventName);
    const logs: ChainEvent[] = [];

    for (
      let chunkStart = fromBlock;
      chunkStart <= toBlock;
      chunkStart += LOG_CHUNK_SIZE
    ) {
      const chunkEnd =
        chunkStart + LOG_CHUNK_SIZE - 1n > toBlock
          ? toBlock
          : chunkStart + LOG_CHUNK_SIZE - 1n;
      const chunk = await publicClient.getLogs({
        address,
        event,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of chunk) {
        const normalized = toChainEvent(eventName, log);
        if (normalized) logs.push(normalized);
      }
    }

    return logs;
  });
}

async function agenticEvents(names: string[]): Promise<ChainEvent[]> {
  const groups = await Promise.all(
    names.map((name) =>
      getLogsChunked(
        agenticCommerceAddress,
        agenticCommerceAbi,
        name,
      ),
    ),
  );
  return groups.flat();
}

async function routerEvents(
  router: Address,
  names: string[],
): Promise<ChainEvent[]> {
  const groups = await Promise.all(
    names.map((name) =>
      getLogsChunked(router, evaluationRouterAbi, name),
    ),
  );
  return groups.flat();
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

function statusName(
  statusCode: number,
  expiredAt: number,
  nowSeconds = Math.floor(Date.now() / 1000),
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

type RawJob = {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
};

function normalizeJob(raw: RawJob): JobRecord {
  const expiredAt = Number(raw.expiredAt);
  const statusCode = Number(raw.status);
  return {
    id: raw.id.toString(),
    client: getAddress(raw.client),
    provider: getAddress(raw.provider),
    evaluator: getAddress(raw.evaluator),
    description: raw.description,
    budget: raw.budget.toString(),
    budgetUsdc: formatUnits(raw.budget, 6),
    expiredAt,
    statusCode,
    status: statusName(statusCode, expiredAt),
    hook: getAddress(raw.hook),
  };
}

async function getJobs(jobIds: string[]): Promise<Map<string, JobRecord>> {
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length === 0) return new Map();
  const key = `jobs:${uniqueIds.slice().sort().join(",")}`;

  return cached(key, async () => {
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: uniqueIds.map((jobId) => ({
        address: agenticCommerceAddress,
        abi: agenticCommerceAbi,
        functionName: "getJob",
        args: [BigInt(jobId)],
      })),
    });

    const jobs = new Map<string, JobRecord>();
    results.forEach((result, index) => {
      if (result.status !== "success") return;
      const raw = result.result as RawJob;
      jobs.set(uniqueIds[index], normalizeJob(raw));
    });
    return jobs;
  });
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function eventBlock(event: ChainEvent | undefined): bigint {
  return event?.blockNumber ?? 0n;
}

function buildFeedRows(
  jobs: Map<string, JobRecord>,
  agentic: ChainEvent[],
  router: ChainEvent[],
): FeedRow[] {
  const agenticLatest = latestByJob(agentic);
  const routerLatest = latestByJob(router);

  return [...jobs.entries()]
    .map(([jobId, job]) => {
      const jobEvent = agenticLatest.get(jobId);
      const verdictEvent = routerLatest.get(jobId);
      let provenance: FeedRow["provenance"] = null;
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
        confidenceBP,
        statusTxHash: jobEvent?.transactionHash ?? null,
        verdictTxHash: verdictEvent?.transactionHash ?? null,
        latestBlock: latestBlock.toString(),
      };
    })
    .sort((a, b) => Number(BigInt(b.latestBlock) - BigInt(a.latestBlock)));
}

export async function getFeedData(): Promise<{
  configured: boolean;
  rows: FeedRow[];
}> {
  const router = configuredRouterAddress();
  if (!router) return { configured: false, rows: [] };

  return cached(`feed:${router}`, async () => {
    const [agentic, verdicts] = await Promise.all([
      agenticEvents(["JobSubmitted", "JobCompleted", "JobRejected"]),
      routerEvents(router, ["AIVerdict", "Escalated", "HumanVerdict"]),
    ]);
    const ids = agentic.map(jobIdFrom).filter((id): id is string => id !== null);
    const jobs = await getJobs(ids);
    for (const [id, job] of jobs) {
      if (!sameAddress(job.evaluator, router)) jobs.delete(id);
    }
    return { configured: true, rows: buildFeedRows(jobs, agentic, verdicts) };
  });
}

export async function getReviewData(): Promise<{
  configured: boolean;
  queue: ReviewRecord[];
}> {
  const router = configuredRouterAddress();
  if (!router) return { configured: false, queue: [] };

  return cached(`review:${router}`, async () => {
    const [routerLogs, submittedLogs] = await Promise.all([
      routerEvents(router, ["Escalated", "HumanVerdict"]),
      agenticEvents(["JobSubmitted"]),
    ]);
    const escalations = latestByJob(
      routerLogs.filter((event) => event.eventName === "Escalated"),
    );
    const terminalIds = new Set<string>();
    for (const event of routerLogs) {
      if (event.eventName !== "HumanVerdict") continue;
      const jobId = jobIdFrom(event);
      if (jobId) terminalIds.add(jobId);
    }
    const submitted = latestByJob(submittedLogs);
    const pendingIds = [...escalations.keys()].filter(
      (jobId) => !terminalIds.has(jobId),
    );
    const jobs = await getJobs(pendingIds);
    const queue: ReviewRecord[] = [];

    for (const jobId of pendingIds) {
      const job = jobs.get(jobId);
      const escalation = escalations.get(jobId);
      if (!job || !escalation || !sameAddress(job.evaluator, router)) continue;
      const reasonHash = escalation.args.reasonHash;
      const deliverableHash = submitted.get(jobId)?.args.deliverable;
      if (typeof reasonHash !== "string") continue;

      queue.push({
        ...job,
        deliverableHash:
          typeof deliverableHash === "string"
            ? (deliverableHash as Hash)
            : null,
        reasonHash: reasonHash as Hash,
        escalationTxHash: escalation.transactionHash,
      });
    }

    queue.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    return { configured: true, queue };
  });
}

export async function getReputationData(
  rawAddress: string,
): Promise<ReputationData> {
  if (!isAddress(rawAddress)) {
    throw new Response("Invalid provider address", { status: 400 });
  }
  const address = getAddress(rawAddress);
  const router = configuredRouterAddress();
  const disclaimer = "Experimental — small sample";

  if (!router) {
    return {
      address,
      completed: 0,
      rejected: 0,
      n: 0,
      volumeUsdc: "0",
      reliability: null,
      rated: false,
      disclaimer,
      history: [],
    };
  }

  return cached(`reputation:${router}:${address}`, async () => {
    const [terminalLogs, routerLogs] = await Promise.all([
      agenticEvents(["JobCompleted", "JobRejected"]),
      routerEvents(router, ["AIVerdict", "Escalated", "HumanVerdict"]),
    ]);
    const ids = terminalLogs
      .map(jobIdFrom)
      .filter((id): id is string => id !== null);
    const jobs = await getJobs(ids);

    for (const [jobId, job] of jobs) {
      if (
        !sameAddress(job.provider, address) ||
        !sameAddress(job.evaluator, router) ||
        (job.statusCode !== 3 && job.statusCode !== 4)
      ) {
        jobs.delete(jobId);
      }
    }

    const history = buildFeedRows(jobs, terminalLogs, routerLogs);
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
      disclaimer,
      history,
    };
  });
}
