import type { Address, Hex } from "viem";

export interface AgenticJob {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
}

export interface SubmittedJob extends AgenticJob {
  deliverable: Hex;
  submittedAtBlock: bigint;
}
