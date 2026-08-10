import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";

import {
  disputePanelAbi,
  escrowFactoryAbi,
  reputationRegistryAbi,
} from "./abi/escrow-v1";
import type { ChainRuntimeConfig } from "./chains";

// Arc's public RPC rejects eth_getLogs ranges above ~10k blocks and throttles
// around 2 req/s, so we sweep in bounded chunks and keep a module-level cursor
// cache: the first load after boot scans from the deploy block, every later
// load only scans blocks the cache has not seen.
const CHUNK_BLOCKS = 9_500n;
const CHUNK_DELAY_MS = 250;
const FRESH_WINDOW_MS = 2_000;

function decodeCreated(logs: Log[]) {
  return parseEventLogs({
    abi: escrowFactoryAbi,
    eventName: "EscrowCreated",
    logs,
    strict: true,
  });
}

function decodeOpened(logs: Log[]) {
  return parseEventLogs({
    abi: disputePanelAbi,
    eventName: "DisputeOpened",
    logs,
    strict: true,
  });
}

function decodeCommitted(logs: Log[]) {
  return parseEventLogs({
    abi: disputePanelAbi,
    eventName: "VoteCommitted",
    logs,
    strict: true,
  });
}

function decodeRevealed(logs: Log[]) {
  return parseEventLogs({
    abi: disputePanelAbi,
    eventName: "VoteRevealed",
    logs,
    strict: true,
  });
}

function decodeExecuted(logs: Log[]) {
  return parseEventLogs({
    abi: disputePanelAbi,
    eventName: "DisputeExecuted",
    logs,
    strict: true,
  });
}

function decodeAttested(logs: Log[]) {
  return parseEventLogs({
    abi: reputationRegistryAbi,
    eventName: "SettlementAttested",
    logs,
    strict: true,
  });
}

export type LogStore = {
  cursor: bigint;
  created: ReturnType<typeof decodeCreated>;
  opened: ReturnType<typeof decodeOpened>;
  committed: ReturnType<typeof decodeCommitted>;
  revealed: ReturnType<typeof decodeRevealed>;
  executed: ReturnType<typeof decodeExecuted>;
  attested: ReturnType<typeof decodeAttested>;
  lastSyncMs: number;
  inFlight?: Promise<string | undefined>;
};

const stores = new Map<string, LogStore>();

function storeFor(config: ChainRuntimeConfig): LogStore {
  const key = `${config.rpcUrl}:${config.contracts.factory ?? "none"}`;
  let store = stores.get(key);
  if (!store) {
    store = {
      cursor: BigInt(config.deployBlock) - 1n,
      created: [],
      opened: [],
      committed: [],
      revealed: [],
      executed: [],
      attested: [],
      lastSyncMs: 0,
    };
    stores.set(key, store);
  }
  return store;
}

function sameAddress(left: string, right?: Address) {
  return right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function ingest(config: ChainRuntimeConfig, store: LogStore, logs: Log[]) {
  const factoryLogs = logs.filter((log) =>
    sameAddress(log.address, config.contracts.factory),
  );
  const panelLogs = logs.filter((log) =>
    sameAddress(log.address, config.contracts.disputePanel),
  );
  const registryLogs = logs.filter((log) =>
    sameAddress(log.address, config.contracts.reputationRegistry),
  );
  store.created.push(...decodeCreated(factoryLogs));
  store.opened.push(...decodeOpened(panelLogs));
  store.committed.push(...decodeCommitted(panelLogs));
  store.revealed.push(...decodeRevealed(panelLogs));
  store.executed.push(...decodeExecuted(panelLogs));
  store.attested.push(...decodeAttested(registryLogs));
}

async function sweep(
  client: PublicClient,
  config: ChainRuntimeConfig,
  store: LogStore,
): Promise<string | undefined> {
  const addresses = [
    config.contracts.factory,
    config.contracts.disputePanel,
    config.contracts.reputationRegistry,
  ].filter((address): address is Address => Boolean(address));
  if (addresses.length === 0) return undefined;
  try {
    const latest = await client.getBlockNumber();
    let from = store.cursor + 1n;
    while (from <= latest) {
      const to = from + CHUNK_BLOCKS - 1n > latest ? latest : from + CHUNK_BLOCKS - 1n;
      const logs = await client.getLogs({
        address: addresses,
        fromBlock: from,
        toBlock: to,
      });
      ingest(config, store, logs);
      store.cursor = to;
      from = to + 1n;
      if (from <= latest) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }
    store.lastSyncMs = Date.now();
    return undefined;
  } catch (error) {
    // Cursor stays at the last fully ingested chunk; the next sync resumes there.
    return error instanceof Error ? error.message : "Arc RPC read failed";
  }
}

export async function syncLogStore(
  client: PublicClient,
  config: ChainRuntimeConfig,
): Promise<{ store: LogStore; error?: string }> {
  const store = storeFor(config);
  if (store.inFlight) {
    const error = await store.inFlight;
    return { store, error };
  }
  if (Date.now() - store.lastSyncMs < FRESH_WINDOW_MS) return { store };
  const run = sweep(client, config, store);
  store.inFlight = run;
  try {
    const error = await run;
    return { store, error };
  } finally {
    store.inFlight = undefined;
  }
}
