import { createHash, timingSafeEqual } from "node:crypto";

import { createCookieSessionStorage } from "react-router";

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const MAX_FAILURES_PER_WINDOW = 5;

type DemoSessionData = {
  presenter?: boolean;
};

type FailureWindow = {
  count: number;
  startedAt: number;
};

const failuresByClient = new Map<string, FailureWindow>();

function configuredSecret(): string | null {
  const value = process.env.DEMO_SESSION_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function configuredAccessCode(): string | null {
  const value = process.env.DEMO_ACCESS_CODE?.trim();
  return value && value.length > 0 ? value : null;
}

function sessionStorage() {
  const secret = configuredSecret();
  if (!secret) return null;
  return createCookieSessionStorage<DemoSessionData>({
    cookie: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Host-vapi_demo"
          : "vapi_demo",
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "strict",
      secrets: [secret],
      secure: process.env.NODE_ENV === "production",
    },
  });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function accessCodeMatches(candidate: string): boolean {
  const expected = configuredAccessCode();
  return expected !== null && timingSafeEqual(digest(candidate), digest(expected));
}

function clearExpiredFailures(now: number): void {
  for (const [key, value] of failuresByClient) {
    if (now - value.startedAt >= FAILURE_WINDOW_MS) {
      failuresByClient.delete(key);
    }
  }
}

export function demoSessionConfigured(): boolean {
  return configuredSecret() !== null && configuredAccessCode() !== null;
}

export function demoUnlockRateLimit(request: Request): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  clearExpiredFailures(now);
  const failure = failuresByClient.get(clientKey(request));
  if (!failure || failure.count < MAX_FAILURES_PER_WINDOW) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((FAILURE_WINDOW_MS - (now - failure.startedAt)) / 1_000),
    ),
  };
}

export function verifyDemoAccessCode(
  request: Request,
  candidate: string,
): boolean {
  const now = Date.now();
  const key = clientKey(request);
  const matches = accessCodeMatches(candidate);
  if (matches) {
    failuresByClient.delete(key);
    return true;
  }

  const existing = failuresByClient.get(key);
  if (!existing || now - existing.startedAt >= FAILURE_WINDOW_MS) {
    failuresByClient.set(key, { count: 1, startedAt: now });
  } else {
    existing.count += 1;
  }
  return false;
}

export async function isDemoPresenter(request: Request): Promise<boolean> {
  const storage = sessionStorage();
  if (!storage) return false;
  const session = await storage.getSession(request.headers.get("cookie"));
  return session.get("presenter") === true;
}

export async function createDemoPresenterCookie(
  request: Request,
): Promise<string | null> {
  const storage = sessionStorage();
  if (!storage) return null;
  const session = await storage.getSession(request.headers.get("cookie"));
  session.set("presenter", true);
  return storage.commitSession(session);
}

export async function destroyDemoPresenterCookie(
  request: Request,
): Promise<string | null> {
  const storage = sessionStorage();
  if (!storage) return null;
  const session = await storage.getSession(request.headers.get("cookie"));
  return storage.destroySession(session);
}

export function isSameOriginMutation(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  try {
    const requestUrl = new URL(request.url);
    const origin = new URL(originHeader);
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      ?.trim();
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim();
    const expectedHost = forwardedHost || requestUrl.host;
    const expectedProtocol = forwardedProtocol
      ? `${forwardedProtocol}:`
      : requestUrl.protocol;

    return origin.host === expectedHost && origin.protocol === expectedProtocol;
  } catch {
    return false;
  }
}
