import { getAddress, type Address } from "viem";
import "./env.js";

export function envAddress(
  name: string,
  fallback?: Address,
): Address {
  const raw = process.env[name];
  if (!raw) {
    if (fallback) return fallback;
    throw new Error(`${name} is required`);
  }
  try {
    return getAddress(raw);
  } catch {
    throw new Error(`${name} must be a valid EVM address`);
  }
}

export function envUnsignedBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an unsigned base-10 integer`);
  }
  return BigInt(raw);
}

export function envBasisPoints(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from 0 to 10000`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${name} must be an integer from 0 to 10000`);
  }
  return value;
}
