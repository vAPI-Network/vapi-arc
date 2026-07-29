import type { Hex } from "viem";
import {
  parseAIEvidence,
  verifyAIEvidence,
  type AIEvidenceV1,
} from "./evidence.js";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

class NonRetryablePublishError extends Error {}

export interface PublishAIEvidenceOptions {
  baseUrl?: string;
  internalToken?: string;
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

function requiredSetting(
  explicit: string | undefined,
  environmentName: string,
): string {
  const value = explicit?.trim() || process.env[environmentName]?.trim();
  if (!value) {
    throw new Error(
      `${environmentName} is required before AI evidence can be published`,
    );
  }
  return value;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function responseDetail(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 500).trim();
  return body || response.statusText || `HTTP ${response.status}`;
}

export async function publishAIEvidence(
  record: AIEvidenceV1,
  evidenceHash: Hex,
  options: PublishAIEvidenceOptions = {},
): Promise<void> {
  const parsed = parseAIEvidence(record);
  if (!verifyAIEvidence(parsed, evidenceHash)) {
    throw new Error("AI evidence does not match its canonical evidence hash");
  }
  const baseUrl = requiredSetting(
    options.baseUrl,
    "REVIEW_SERVICE_INTERNAL_URL",
  ).replace(/\/+$/, "");
  const internalToken = requiredSetting(
    options.internalToken,
    "REVIEW_INTERNAL_TOKEN",
  );
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("AI evidence publish attempts must be between 1 and 10");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("AI evidence publish timeout must be positive");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/internal/ai-evidence`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${internalToken}`,
          "content-type": "application/json",
          "idempotency-key": evidenceHash.toLowerCase(),
        },
        body: JSON.stringify({ evidenceHash, evidence: parsed }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      const detail = await responseDetail(response);
      lastError = new Error(
        `AI evidence service rejected ${evidenceHash} with HTTP ${response.status}: ${detail}`,
      );
      if (!retryableStatus(response.status)) {
        throw new NonRetryablePublishError(lastError.message);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof NonRetryablePublishError) throw error;
    }
    if (attempt < attempts) await wait(250 * 2 ** (attempt - 1));
  }

  throw new Error(
    `AI evidence publication failed closed after ${attempts} attempts: ${
      lastError?.message ?? "unknown error"
    }`,
    { cause: lastError },
  );
}
