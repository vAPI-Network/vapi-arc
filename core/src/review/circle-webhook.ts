import {
  createPublicKey,
  createVerify,
  type KeyObject,
} from "node:crypto";

const CIRCLE_API_BASE_URL = "https://api.circle.com";
const KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CircleNotificationKeyResponse {
  data?: {
    id?: string;
    algorithm?: string;
    publicKey?: string;
  };
}

export interface CircleWebhookVerifier {
  verify(input: {
    keyId: string;
    signature: string;
    body: Buffer;
  }): Promise<boolean>;
}

export class CircleWebhookKeyServiceError extends Error {}
export class CircleWebhookInvalidKeyError extends Error {}

export class LiveCircleWebhookVerifier implements CircleWebhookVerifier {
  private readonly keys = new Map<
    string,
    { key: KeyObject; expiresAt: number }
  >();
  private readonly failures = new Map<
    string,
    { error: Error; expiresAt: number }
  >();
  private readonly inFlight = new Map<string, Promise<KeyObject>>();

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async verify(input: {
    keyId: string;
    signature: string;
    body: Buffer;
  }): Promise<boolean> {
    if (!KEY_ID_PATTERN.test(input.keyId)) return false;
    const key = await this.getKey(input.keyId);
    const verifier = createVerify("SHA256");
    verifier.update(input.body);
    verifier.end();
    return verifier.verify(key, Buffer.from(input.signature, "base64"));
  }

  private async getKey(keyId: string): Promise<KeyObject> {
    const cached = this.keys.get(keyId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    if (cached) this.keys.delete(keyId);
    const failed = this.failures.get(keyId);
    if (failed && failed.expiresAt > Date.now()) throw failed.error;
    if (failed) this.failures.delete(keyId);
    const pending = this.inFlight.get(keyId);
    if (pending) return pending;

    const request = this.fetchKey(keyId).finally(() => {
      this.inFlight.delete(keyId);
    });
    this.inFlight.set(keyId, request);
    return request;
  }

  private async fetchKey(keyId: string): Promise<KeyObject> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${CIRCLE_API_BASE_URL}/v2/notifications/publicKey/${encodeURIComponent(keyId)}`,
        {
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (cause) {
      const error = new CircleWebhookKeyServiceError(
        "Circle notification key service is unavailable",
        { cause },
      );
      this.rememberFailure(keyId, error, 30_000);
      throw error;
    }
    if (!response.ok) {
      const unavailable = response.status >= 500 || response.status === 429;
      const error = unavailable
        ? new CircleWebhookKeyServiceError(
            `Circle notification key service returned ${response.status}`,
          )
        : new CircleWebhookInvalidKeyError(
            "Circle notification key was not recognized",
          );
      this.rememberFailure(keyId, error, unavailable ? 30_000 : 5 * 60_000);
      throw error;
    }
    try {
      const decoded = (await response.json()) as CircleNotificationKeyResponse;
      const keyData = decoded.data;
      if (
        keyData?.id !== keyId ||
        keyData.algorithm !== "ECDSA_SHA_256" ||
        !keyData.publicKey
      ) {
        throw new Error("invalid key response");
      }
      const key = createPublicKey({
        key: Buffer.from(keyData.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      if (this.keys.size >= 100) {
        const oldest = this.keys.keys().next().value as string | undefined;
        if (oldest) this.keys.delete(oldest);
      }
      this.keys.set(keyId, {
        key,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });
      return key;
    } catch (cause) {
      const error = new CircleWebhookKeyServiceError(
        "Circle notification key service returned malformed data",
        { cause },
      );
      this.rememberFailure(keyId, error, 30_000);
      throw error;
    }
  }

  private rememberFailure(keyId: string, error: Error, ttlMs: number): void {
    if (this.failures.size >= 100) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest) this.failures.delete(oldest);
    }
    this.failures.set(keyId, { error, expiresAt: Date.now() + ttlMs });
  }
}

export function createCircleWebhookVerifier(
  apiKey: string | undefined,
): CircleWebhookVerifier | undefined {
  return apiKey ? new LiveCircleWebhookVerifier(apiKey) : undefined;
}
