import { readFile } from "node:fs/promises";
import path from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import { dataRoot } from "./paths.js";

export const MAX_DELIVERABLE_BYTES = 32 * 1024;

const deliverableFileSchema = z
  .object({
    content: z.string(),
    contentHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  })
  .strict();

export type DeliverableStatus =
  | "ok"
  | "missing"
  | "oversized"
  | "hash-mismatch";

export interface DeliverableInspection {
  status: DeliverableStatus;
  content?: string;
  byteLength: number;
  computedHash?: Hex;
  onChainHash?: Hex;
  detail?: string;
}

export function computeDeliverableHash(content: string): Hex {
  return keccak256(toBytes(content));
}

export function verifyDeliverableHash(
  content: string,
  expectedHash?: Hex,
): boolean {
  return (
    expectedHash === undefined ||
    computeDeliverableHash(content).toLowerCase() === expectedHash.toLowerCase()
  );
}

export async function loadDeliverable(
  jobId: bigint,
  onChainHash?: Hex,
): Promise<DeliverableInspection> {
  const deliverablePath = path.join(
    dataRoot,
    "deliverables",
    `${jobId.toString()}.json`,
  );
  let raw: string;
  try {
    raw = await readFile(deliverablePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        byteLength: 0,
        onChainHash,
        detail: "deliverable file not found",
      };
    }
    throw error;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      status: "missing",
      byteLength: 0,
      onChainHash,
      detail: "deliverable file contains invalid JSON",
    };
  }
  const parsed = deliverableFileSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      status: "missing",
      byteLength: 0,
      onChainHash,
      detail: "deliverable file is invalid",
    };
  }

  const { content, contentHash } = parsed.data;
  const byteLength = Buffer.byteLength(content, "utf8");
  const computedHash = computeDeliverableHash(content);
  if (byteLength > MAX_DELIVERABLE_BYTES) {
    return {
      status: "oversized",
      content,
      byteLength,
      computedHash,
      onChainHash,
      detail: `deliverable exceeds ${MAX_DELIVERABLE_BYTES} bytes`,
    };
  }

  const declaredHash = contentHash as Hex | undefined;
  if (
    !verifyDeliverableHash(content, declaredHash) ||
    !verifyDeliverableHash(content, onChainHash)
  ) {
    return {
      status: "hash-mismatch",
      content,
      byteLength,
      computedHash,
      onChainHash,
      detail: "content hash does not match its declared or on-chain commitment",
    };
  }

  return {
    status: "ok",
    content,
    byteLength,
    computedHash,
    onChainHash,
  };
}
