import path from "node:path";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import "../env.js";
import { dataRoot } from "../paths.js";

const ARC_TESTNET_NETWORK = "eip155:5042002";
const DEFAULT_GATEWAY_URL = "https://gateway-api-testnet.circle.com";
const MAX_BOOTSTRAP_REVIEWERS = 20;
const BOOTSTRAP_REVIEWER_KEYS = new Set([
  "telegramUserId",
  "telegramChatId",
  "alias",
  "payoutAddress",
  "skills",
  "active",
]);

export interface ReviewerBootstrapConfig {
  telegramUserId: string;
  telegramChatId: string;
  alias: string;
  payoutAddress: Address;
  skills: string[];
  active: boolean;
}

interface OperationalConfig {
  port: number;
  claimTtlSeconds: number;
  reviewSlaSeconds: number;
  minJobExpiryBufferSeconds: number;
  maxDispatches: number;
  circleMaxAttempts: number;
  transactionPollTimeoutMs: number;
  backgroundIntervalMs: number;
  logLookbackBlocks: number;
}

function optionalAddress(name: string): Address | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${name} must be a valid EVM address`);
  return getAddress(value);
}

function unsignedInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large`);
  }
  return parsed;
}

function requiredString(
  value: unknown,
  path: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new Error(`${path} must be at most ${maximumLength} characters`);
  }
  return trimmed;
}

export function parseReviewerBootstrap(
  value: string | undefined,
): ReviewerBootstrapConfig[] {
  if (!value?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("REVIEW_BOOTSTRAP_REVIEWERS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("REVIEW_BOOTSTRAP_REVIEWERS_JSON must be a JSON array");
  }
  if (parsed.length > MAX_BOOTSTRAP_REVIEWERS) {
    throw new Error(
      `REVIEW_BOOTSTRAP_REVIEWERS_JSON supports at most ${MAX_BOOTSTRAP_REVIEWERS} reviewers`,
    );
  }

  const telegramUserIds = new Set<string>();
  const telegramChatIds = new Set<string>();
  const payoutAddresses = new Set<string>();
  return parsed.map((entry, index) => {
    const prefix = `REVIEW_BOOTSTRAP_REVIEWERS_JSON[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${prefix} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const unknownKey = Object.keys(record).find(
      (key) => !BOOTSTRAP_REVIEWER_KEYS.has(key),
    );
    if (unknownKey) {
      throw new Error(`${prefix}.${unknownKey} is not a supported field`);
    }
    const telegramUserId = requiredString(
      record.telegramUserId,
      `${prefix}.telegramUserId`,
      32,
    );
    if (!/^[1-9]\d*$/.test(telegramUserId)) {
      throw new Error(`${prefix}.telegramUserId must be a positive numeric id`);
    }
    const telegramChatId = requiredString(
      record.telegramChatId,
      `${prefix}.telegramChatId`,
      32,
    );
    if (!/^-?[1-9]\d*$/.test(telegramChatId)) {
      throw new Error(
        `${prefix}.telegramChatId must be a Telegram numeric chat id`,
      );
    }
    const alias = requiredString(record.alias, `${prefix}.alias`, 80);
    const payoutAddressValue = requiredString(
      record.payoutAddress,
      `${prefix}.payoutAddress`,
      42,
    );
    if (!isAddress(payoutAddressValue)) {
      throw new Error(`${prefix}.payoutAddress must be a valid EVM address`);
    }
    if (
      record.skills !== undefined &&
      (!Array.isArray(record.skills) ||
        record.skills.length > 20 ||
        record.skills.some(
          (skill) =>
            typeof skill !== "string" ||
            skill.trim().length === 0 ||
            skill.trim().length > 64,
        ))
    ) {
      throw new Error(
        `${prefix}.skills must contain at most 20 non-empty strings up to 64 characters`,
      );
    }
    if (record.active !== undefined && typeof record.active !== "boolean") {
      throw new Error(`${prefix}.active must be a boolean`);
    }

    const payoutAddress = getAddress(payoutAddressValue);
    if (payoutAddress === zeroAddress) {
      throw new Error(`${prefix}.payoutAddress cannot be the zero address`);
    }
    const normalizedPayoutAddress = payoutAddress.toLowerCase();
    if (telegramUserIds.has(telegramUserId)) {
      throw new Error(
        `REVIEW_BOOTSTRAP_REVIEWERS_JSON contains duplicate telegramUserId ${telegramUserId}`,
      );
    }
    if (telegramChatIds.has(telegramChatId)) {
      throw new Error(
        `REVIEW_BOOTSTRAP_REVIEWERS_JSON contains duplicate telegramChatId ${telegramChatId}`,
      );
    }
    if (payoutAddresses.has(normalizedPayoutAddress)) {
      throw new Error(
        `REVIEW_BOOTSTRAP_REVIEWERS_JSON contains duplicate payoutAddress ${payoutAddress}`,
      );
    }
    telegramUserIds.add(telegramUserId);
    telegramChatIds.add(telegramChatId);
    payoutAddresses.add(normalizedPayoutAddress);

    return {
      telegramUserId,
      telegramChatId,
      alias,
      payoutAddress,
      skills: [
        ...new Set(
          ((record.skills as string[] | undefined) ?? []).map((skill) =>
            skill.trim(),
          ),
        ),
      ].sort(),
      active: record.active ?? true,
    };
  });
}

export function validateOperationalConfig(config: OperationalConfig): void {
  const positiveValues = [
    ["PORT/REVIEW_PORT", config.port],
    ["REVIEW_CLAIM_TTL_SECONDS", config.claimTtlSeconds],
    ["REVIEW_SLA_SECONDS", config.reviewSlaSeconds],
    ["REVIEW_MIN_JOB_EXPIRY_SECONDS", config.minJobExpiryBufferSeconds],
    ["REVIEW_MAX_DISPATCHES", config.maxDispatches],
    ["CIRCLE_MAX_ATTEMPTS", config.circleMaxAttempts],
    ["CIRCLE_TRANSACTION_TIMEOUT_MS", config.transactionPollTimeoutMs],
    ["REVIEW_BACKGROUND_INTERVAL_MS", config.backgroundIntervalMs],
    ["REVIEW_LOG_LOOKBACK_BLOCKS", config.logLookbackBlocks],
  ] as const;
  for (const [name, value] of positiveValues) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (config.port > 65_535) {
    throw new Error("PORT/REVIEW_PORT must be between 1 and 65535");
  }
  if (
    BigInt(config.backgroundIntervalMs) >
    BigInt(config.claimTtlSeconds) * 1_000n
  ) {
    throw new Error(
      "REVIEW_BACKGROUND_INTERVAL_MS cannot exceed REVIEW_CLAIM_TTL_SECONDS",
    );
  }
  const dispatchWindowMs =
    BigInt(config.claimTtlSeconds) *
      1_000n *
      BigInt(config.maxDispatches) +
    BigInt(config.backgroundIntervalMs) *
      BigInt(Math.max(0, config.maxDispatches - 1));
  if (dispatchWindowMs > BigInt(config.reviewSlaSeconds) * 1_000n) {
    throw new Error(
      "REVIEW_SLA_SECONDS must cover every claim window and redispatch interval",
    );
  }

  const requiredExpiryBuffer =
    BigInt(config.reviewSlaSeconds) +
    (2n * BigInt(config.transactionPollTimeoutMs) + 999n) / 1_000n +
    60n;
  if (requiredExpiryBuffer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("configured review and Circle SLA is too large");
  }
  if (BigInt(config.minJobExpiryBufferSeconds) < requiredExpiryBuffer) {
    throw new Error(
      `REVIEW_MIN_JOB_EXPIRY_SECONDS must be at least ${requiredExpiryBuffer.toString()} for the configured review and Circle SLA`,
    );
  }
}

function usdcUnits(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a 6-decimal USDC integer string`);
  }
  return value;
}

function booleanValue(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function toDollarPrice(units: string): string {
  const value = BigInt(units);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `$${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export interface ReviewServiceConfig {
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  routerAddress?: Address;
  commerceAddress?: Address;
  sellerAddress?: Address;
  gatewayNetwork: string;
  gatewayUrl: string;
  reviewPrice: string;
  reviewPriceDisplay: string;
  reviewerReward: string;
  claimTtlSeconds: number;
  reviewSlaSeconds: number;
  minJobExpiryBufferSeconds: number;
  maxDispatches: number;
  internalToken?: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  circleApiKey?: string;
  circleEntitySecret?: string;
  circleWalletId?: string;
  circleWalletAddress?: Address;
  usdcTokenAddress: Address;
  minimumTreasuryBalance: string;
  circleMaxAttempts: number;
  transactionPollTimeoutMs: number;
  backgroundIntervalMs: number;
  logLookbackBlocks: bigint;
  bootstrapReviewers?: ReviewerBootstrapConfig[];
  allowPartialConfiguration: boolean;
}

export function loadReviewServiceConfig(): ReviewServiceConfig {
  const allowPartialConfiguration = booleanValue(
    "REVIEW_ALLOW_PARTIAL_CONFIG",
    false,
  );
  const reviewPrice = usdcUnits("REVIEW_PRICE_USDC", "250000");
  const reward = usdcUnits("REVIEWER_REWARD_USDC", "200000");
  const minimumTreasuryBalance = usdcUnits(
    "REVIEW_MIN_TREASURY_USDC",
    (BigInt(reviewPrice) + BigInt(reward)).toString(),
  );
  const circleMaxAttempts = unsignedInteger("CIRCLE_MAX_ATTEMPTS", 3);
  const reviewSlaSeconds = unsignedInteger("REVIEW_SLA_SECONDS", 1_800);
  const transactionPollTimeoutMs = unsignedInteger(
    "CIRCLE_TRANSACTION_TIMEOUT_MS",
    180_000,
  );
  const requiredExpiryBuffer =
    BigInt(reviewSlaSeconds) +
    (2n * BigInt(transactionPollTimeoutMs) + 999n) / 1_000n +
    60n;
  if (requiredExpiryBuffer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("configured review and Circle SLA is too large");
  }
  const requiredExpiryBufferSeconds = Number(requiredExpiryBuffer);
  const minJobExpiryBufferSeconds = unsignedInteger(
    "REVIEW_MIN_JOB_EXPIRY_SECONDS",
    requiredExpiryBufferSeconds,
  );
  if (BigInt(reviewPrice) < 1n) {
    throw new Error("REVIEW_PRICE_USDC must be positive");
  }
  if (BigInt(reward) < 1n) {
    throw new Error("REVIEWER_REWARD_USDC must be positive");
  }
  if (BigInt(minimumTreasuryBalance) < 1n) {
    throw new Error("REVIEW_MIN_TREASURY_USDC must be positive");
  }
  if (BigInt(reward) > BigInt(reviewPrice)) {
    throw new Error("REVIEWER_REWARD_USDC cannot exceed REVIEW_PRICE_USDC");
  }
  if (circleMaxAttempts < 1) {
    throw new Error("CIRCLE_MAX_ATTEMPTS must be at least 1");
  }
  const publicBaseUrl = (
    process.env.REVIEW_PUBLIC_BASE_URL ?? "http://localhost:8787"
  ).replace(/\/+$/, "");
  const gatewayNetwork =
    process.env.X402_NETWORK?.trim() || ARC_TESTNET_NETWORK;
  if (gatewayNetwork !== ARC_TESTNET_NETWORK) {
    throw new Error(
      `X402_NETWORK must be ${ARC_TESTNET_NETWORK}; the hackathon payout and escrow rails are Arc Testnet only`,
    );
  }
  const port = unsignedInteger("PORT", unsignedInteger("REVIEW_PORT", 8787));
  const claimTtlSeconds = unsignedInteger("REVIEW_CLAIM_TTL_SECONDS", 600);
  const maxDispatches = unsignedInteger("REVIEW_MAX_DISPATCHES", 2);
  const backgroundIntervalMs = unsignedInteger(
    "REVIEW_BACKGROUND_INTERVAL_MS",
    5_000,
  );
  const logLookbackBlocks = unsignedInteger(
    "REVIEW_LOG_LOOKBACK_BLOCKS",
    100_000,
  );
  validateOperationalConfig({
    port,
    claimTtlSeconds,
    reviewSlaSeconds,
    minJobExpiryBufferSeconds,
    maxDispatches,
    circleMaxAttempts,
    transactionPollTimeoutMs,
    backgroundIntervalMs,
    logLookbackBlocks,
  });
  return {
    port,
    publicBaseUrl,
    databasePath:
      process.env.REVIEW_DATABASE_PATH?.trim() ||
      path.join(dataRoot, "review-exchange.sqlite"),
    routerAddress: optionalAddress("ROUTER_ADDRESS"),
    commerceAddress: optionalAddress("AGENTIC_COMMERCE"),
    sellerAddress: optionalAddress("X402_SELLER_ADDRESS"),
    gatewayNetwork,
    gatewayUrl: process.env.X402_FACILITATOR_URL ?? DEFAULT_GATEWAY_URL,
    reviewPrice,
    reviewPriceDisplay: toDollarPrice(reviewPrice),
    reviewerReward: reward,
    claimTtlSeconds,
    reviewSlaSeconds,
    minJobExpiryBufferSeconds,
    maxDispatches,
    internalToken: process.env.REVIEW_INTERNAL_TOKEN,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    circleApiKey: process.env.CIRCLE_API_KEY,
    circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET,
    circleWalletId: process.env.CIRCLE_WALLET_ID,
    circleWalletAddress: optionalAddress("CIRCLE_WALLET_ADDRESS"),
    usdcTokenAddress:
      optionalAddress("ARC_USDC") ??
      getAddress("0x3600000000000000000000000000000000000000"),
    minimumTreasuryBalance,
    circleMaxAttempts,
    transactionPollTimeoutMs,
    backgroundIntervalMs,
    logLookbackBlocks: BigInt(logLookbackBlocks),
    bootstrapReviewers: parseReviewerBootstrap(
      process.env.REVIEW_BOOTSTRAP_REVIEWERS_JSON,
    ),
    allowPartialConfiguration,
  };
}
