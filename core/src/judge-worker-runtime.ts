import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import {
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_JUDGE_READINESS_MAX_AGE_MS = 5 * 60_000;

export interface JudgeWorkerConfig {
  port: number;
  readinessMaxAgeMs: number;
}

interface JudgeReadinessOptions {
  maxAgeMs: number;
  now?: () => number;
}

export interface JudgeReadinessSnapshot {
  ready: boolean;
  reason: "ready" | "no_successful_poll" | "stale" | "shutting_down";
  lastSuccessfulPollAt: string | null;
  ageMs: number | null;
}

function requiredValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): string | undefined {
  const value = environment[name]?.trim();
  if (!value) {
    issues.push(`${name} is required`);
    return undefined;
  }
  return value;
}

function validateAddress(
  environment: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): Address | undefined {
  const raw = requiredValue(environment, name, issues);
  if (!raw) return undefined;
  try {
    const address = getAddress(raw);
    if (isAddressEqual(address, zeroAddress)) {
      issues.push(`${name} must not be the zero address`);
      return undefined;
    }
    return address;
  } catch {
    issues.push(`${name} must be a valid non-zero EVM address`);
    return undefined;
  }
}

function validateHttpUrl(
  environment: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): void {
  const raw = requiredValue(environment, name, issues);
  if (!raw) return;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname
    ) {
      throw new Error("unsupported URL");
    }
  } catch {
    issues.push(`${name} must be a valid HTTP(S) URL`);
  }
}

function validateUnsignedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): void {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be an unsigned base-10 integer`);
  }
}

function validateBasisPoints(
  environment: NodeJS.ProcessEnv,
  name: string,
  issues: string[],
): void {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be an integer from 0 to 10000`);
    return;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    issues.push(`${name} must be an integer from 0 to 10000`);
  }
}

function readPort(
  environment: NodeJS.ProcessEnv,
  issues: string[],
): number | undefined {
  const railwayPort = environment.PORT?.trim();
  const localPort = environment.JUDGE_PORT?.trim();
  const raw = railwayPort || localPort;
  if (!raw) {
    issues.push("PORT/JUDGE_PORT is required");
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    issues.push("PORT/JUDGE_PORT must be an integer from 1 to 65535");
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    issues.push("PORT/JUDGE_PORT must be an integer from 1 to 65535");
    return undefined;
  }
  return port;
}

function readReadinessMaxAge(
  environment: NodeJS.ProcessEnv,
  issues: string[],
): number {
  const raw = environment.JUDGE_HEALTH_MAX_STALENESS_MS?.trim();
  if (!raw) return DEFAULT_JUDGE_READINESS_MAX_AGE_MS;
  if (!/^\d+$/.test(raw)) {
    issues.push(
      "JUDGE_HEALTH_MAX_STALENESS_MS must be an integer from 1000 to 1800000",
    );
    return DEFAULT_JUDGE_READINESS_MAX_AGE_MS;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > 30 * 60_000
  ) {
    issues.push(
      "JUDGE_HEALTH_MAX_STALENESS_MS must be an integer from 1000 to 1800000",
    );
    return DEFAULT_JUDGE_READINESS_MAX_AGE_MS;
  }
  return value;
}

function throwConfigurationIssues(issues: string[]): void {
  if (issues.length > 0) {
    throw new Error(`Judge configuration invalid: ${issues.join("; ")}`);
  }
}

/**
 * Validate every dependency that the long-running live judge may use before it
 * begins polling. Error messages intentionally contain setting names only:
 * malformed credentials and credential-bearing URLs are never echoed.
 */
export function validateLiveJudgeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const issues: string[] = [];
  validateHttpUrl(environment, "ARC_RPC_URL", issues);
  validateAddress(environment, "AGENTIC_COMMERCE", issues);
  validateAddress(environment, "ROUTER_ADDRESS", issues);

  const oraclePrivateKey = requiredValue(environment, "ORACLE_PK", issues);
  if (oraclePrivateKey) {
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(oraclePrivateKey)) {
        throw new Error("invalid private key");
      }
      privateKeyToAccount(oraclePrivateKey as Hex);
    } catch {
      issues.push("ORACLE_PK must be a valid 32-byte 0x-prefixed private key");
    }
  }

  requiredValue(environment, "ANTHROPIC_API_KEY", issues);
  validateHttpUrl(environment, "REVIEW_SERVICE_INTERNAL_URL", issues);
  requiredValue(environment, "REVIEW_INTERNAL_TOKEN", issues);

  const dataRoot = requiredValue(environment, "VAPI_DATA_ROOT", issues);
  if (dataRoot && !path.isAbsolute(dataRoot)) {
    issues.push("VAPI_DATA_ROOT must be an absolute path");
  }

  const judgeModel = environment.JUDGE_MODEL;
  if (judgeModel !== undefined && judgeModel.trim() === "") {
    issues.push("JUDGE_MODEL must not be empty when configured");
  }
  validateUnsignedInteger(environment, "AUTO_SETTLE_CAP", issues);
  validateBasisPoints(environment, "MIN_CONFIDENCE_BP", issues);
  throwConfigurationIssues(issues);
}

export function loadJudgeWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): JudgeWorkerConfig {
  validateLiveJudgeEnvironment(environment);
  const issues: string[] = [];
  const port = readPort(environment, issues);
  const readinessMaxAgeMs = readReadinessMaxAge(environment, issues);
  throwConfigurationIssues(issues);
  return {
    port: port!,
    readinessMaxAgeMs,
  };
}

export class JudgeReadiness {
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #lastSuccessfulPollAt: number | undefined;
  #shuttingDown = false;

  constructor(options: JudgeReadinessOptions) {
    if (
      !Number.isSafeInteger(options.maxAgeMs) ||
      options.maxAgeMs < 1
    ) {
      throw new Error("Judge readiness max age must be a positive integer");
    }
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
  }

  markPollSucceeded(): void {
    this.#lastSuccessfulPollAt = this.#now();
  }

  markShuttingDown(): void {
    this.#shuttingDown = true;
  }

  snapshot(): JudgeReadinessSnapshot {
    const lastSuccessfulPollAt = this.#lastSuccessfulPollAt;
    const timestamp =
      lastSuccessfulPollAt === undefined
        ? null
        : new Date(lastSuccessfulPollAt).toISOString();
    if (this.#shuttingDown) {
      return {
        ready: false,
        reason: "shutting_down",
        lastSuccessfulPollAt: timestamp,
        ageMs:
          lastSuccessfulPollAt === undefined
            ? null
            : Math.max(0, this.#now() - lastSuccessfulPollAt),
      };
    }
    if (lastSuccessfulPollAt === undefined) {
      return {
        ready: false,
        reason: "no_successful_poll",
        lastSuccessfulPollAt: null,
        ageMs: null,
      };
    }
    const ageMs = Math.max(0, this.#now() - lastSuccessfulPollAt);
    return {
      ready: ageMs <= this.#maxAgeMs,
      reason: ageMs <= this.#maxAgeMs ? "ready" : "stale",
      lastSuccessfulPollAt: timestamp,
      ageMs,
    };
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: object,
  headOnly = false,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(headOnly ? undefined : payload);
}

function handleHealthRequest(
  readiness: JudgeReadiness,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const pathname = (request.url ?? "/").split("?", 1)[0];
  if (pathname !== "/health") {
    sendJson(response, 404, {
      status: "not_found",
      service: "vapi-judge",
    });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendJson(response, 405, {
      status: "method_not_allowed",
      service: "vapi-judge",
    });
    return;
  }
  const snapshot = readiness.snapshot();
  sendJson(
    response,
    snapshot.ready ? 200 : 503,
    {
      status: snapshot.ready ? "ok" : "unavailable",
      service: "vapi-judge",
      reason: snapshot.reason,
      lastSuccessfulPollAt: snapshot.lastSuccessfulPollAt,
      pollAgeMs: snapshot.ageMs,
    },
    request.method === "HEAD",
  );
}

export function createJudgeHealthServer(readiness: JudgeReadiness): Server {
  return createServer((request, response) => {
    handleHealthRequest(readiness, request, response);
  });
}

export async function listenJudgeHealthServer(
  server: Server,
  port: number,
  host = "0.0.0.0",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function closeJudgeHealthServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
