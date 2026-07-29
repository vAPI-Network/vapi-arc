import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getAddress,
  isAddressEqual,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { publicClient, type ArcPublicClient } from "./chain.js";
import { envAddress } from "./config.js";
import {
  agenticCommerceAbi,
  defaultAgenticCommerceAddress,
  evaluationRouterAbi,
} from "./contracts.js";
import { dataRoot } from "./paths.js";
import type { AgenticJob, SubmittedJob } from "./types.js";

const jobSubmittedEvent = parseAbiItem(
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
);
const DEFAULT_BLOCK_RANGE = 2_000n;

interface CursorState {
  nextBlock: string;
}

export interface WatcherOptions {
  client?: ArcPublicClient;
  commerceAddress?: Address;
  routerAddress?: Address;
  statePath?: string;
  blockRange?: bigint;
}

async function readNextBlock(statePath: string): Promise<bigint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<CursorState>;
    if (typeof parsed.nextBlock !== "string" || !/^\d+$/.test(parsed.nextBlock)) {
      throw new Error("state.nextBlock must be an unsigned integer string");
    }
    return BigInt(parsed.nextBlock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read watcher cursor ${statePath}: ${String(error)}`);
  }
}

async function writeNextBlock(statePath: string, nextBlock: bigint): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const state: CursorState = { nextBlock: nextBlock.toString() };
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

function normalizeJob(raw: unknown): AgenticJob {
  const job = raw as {
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
  return {
    id: BigInt(job.id),
    client: getAddress(job.client),
    provider: getAddress(job.provider),
    evaluator: getAddress(job.evaluator),
    description: job.description,
    budget: BigInt(job.budget),
    expiredAt: BigInt(job.expiredAt),
    status: Number(job.status),
    hook: getAddress(job.hook),
  };
}

export async function* pollSubmittedJobs(
  options: WatcherOptions = {},
): AsyncGenerator<SubmittedJob> {
  const client = options.client ?? publicClient;
  const commerceAddress =
    options.commerceAddress ??
    envAddress("AGENTIC_COMMERCE", defaultAgenticCommerceAddress);
  const routerAddress =
    options.routerAddress ?? envAddress("ROUTER_ADDRESS");
  const statePath = options.statePath ?? path.join(dataRoot, "state.json");
  const blockRange = options.blockRange ?? DEFAULT_BLOCK_RANGE;
  if (blockRange < 1n) throw new Error("Watcher blockRange must be positive");

  const latestBlock = await client.getBlockNumber();
  let fromBlock = (await readNextBlock(statePath)) ?? latestBlock;
  if (fromBlock > latestBlock) return;

  while (fromBlock <= latestBlock) {
    const toBlock =
      fromBlock + blockRange - 1n > latestBlock
        ? latestBlock
        : fromBlock + blockRange - 1n;
    const logs = await client.getLogs({
      address: commerceAddress,
      event: jobSubmittedEvent,
      fromBlock,
      toBlock,
      strict: true,
    });

    for (const log of logs) {
      const jobId = log.args.jobId;
      const deliverable = log.args.deliverable;
      if (jobId === undefined || deliverable === undefined) continue;
      const rawJob = await client.readContract({
        address: commerceAddress,
        abi: agenticCommerceAbi,
        functionName: "getJob",
        args: [jobId],
      });
      const job = normalizeJob(rawJob);
      if (!isAddressEqual(job.evaluator, routerAddress)) continue;
      // A previously processed job can be encountered again when a later job
      // in the same log range is retried. Terminal jobs change status, while an
      // escalated job deliberately remains Submitted, so both checks are
      // required to make the cursor crash-safe.
      if (job.status !== 2) continue;
      const resolution = await client.readContract({
        address: routerAddress,
        abi: evaluationRouterAbi,
        functionName: "resolutions",
        args: [jobId],
      });
      if (Number(resolution) !== 0) continue;
      yield {
        ...job,
        deliverable: deliverable as Hex,
        submittedAtBlock: log.blockNumber,
      };
    }

    fromBlock = toBlock + 1n;
    await writeNextBlock(statePath, fromBlock);
  }
}
