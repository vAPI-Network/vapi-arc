import { useEffect, useState } from "react";

// Job briefs live only in the creating browser: the chain stores a keccak
// fingerprint (termsHash), so the readable text is cached in localStorage at
// creation and matched back by hash. In a single-browser demo every persona
// (client / vendor / reviewer wallets) sees the same titles.
const STORAGE_KEY = "vapi-job-briefs";

type BriefMap = Record<string, string>;

function readAll(): BriefMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BriefMap) : {};
  } catch {
    return {};
  }
}

export function saveBrief(termsHash: string, text: string) {
  if (typeof window === "undefined" || !text.trim()) return;
  try {
    const all = readAll();
    all[termsHash.toLowerCase()] = text.trim();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Cache only — never block the transaction on storage failures.
  }
}

export function briefTitle(text?: string): string | undefined {
  if (!text) return undefined;
  const first = text.split("\n")[0].trim();
  if (!first) return undefined;
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}

/** Hydration-safe: returns {} on the server and first paint, then the cache. */
export function useBriefs(): BriefMap {
  const [briefs, setBriefs] = useState<BriefMap>({});
  useEffect(() => {
    setBriefs(readAll());
  }, []);
  return briefs;
}

export function useBrief(termsHash?: string): string | undefined {
  const briefs = useBriefs();
  return termsHash ? briefs[termsHash.toLowerCase()] : undefined;
}
