import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";

import { escrowV1Abi, reputationRegistryAbi } from "./abi/escrow-v1";
import { arcTestnet, type ChainRuntimeConfig } from "./chains";
import { syncLogStore } from "./log-store";

export type MarketplaceOrder = {
  address: Address;
  seller: Address;
  buyer: Address;
  token: Address;
  amount: string;
  offerDeadline: number;
  workDuration: number;
  reviewWindow: number;
  termsHash: Hex;
  state: number;
  blockNumber: string;
};

export type MarketplaceSnapshot = {
  orders: MarketplaceOrder[];
  blockNumber?: string;
  error?: string;
};

export type OrderSnapshot = MarketplaceOrder & {
  resolution: number;
  deliveryHash: Hex;
  workDeadline: number;
  reviewDeadline: number;
  disputedAt: number;
  counterEvidenceDeadline: number;
  disputeRaisedBy?: Address;
};

export type DisputeSnapshot = {
  escrow: Address;
  raisedBy: Address;
  commitDeadline: number;
  revealDeadline: number;
  committed: number;
  revealed: number;
  releaseVotes: number;
  refundVotes: number;
  splitVotes: number;
  executed: boolean;
  outcome?: number;
  blockNumber: string;
};

export type ReputationScore = {
  settled: number;
  released: number;
  refunded: number;
  disputed: number;
  splits: number;
};

export type Attestation = {
  escrow: Address;
  seller: Address;
  buyer: Address;
  resolution: number;
  transactionHash: Hex;
  blockNumber: string;
};

export type ReputationSnapshot = {
  subject?: Address;
  score?: ReputationScore;
  attestations: Attestation[];
  unattested: MarketplaceOrder[];
  error?: string;
};

export const MOCK_ORDER = getAddress(
  "0x1000000000000000000000000000000000000001",
);
export const MOCK_BUYER = getAddress(
  "0x2000000000000000000000000000000000000001",
);
export const MOCK_SELLER = getAddress(
  "0x3000000000000000000000000000000000000001",
);

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const TERMS_HASH = `0x${"1".repeat(64)}` as Hex;
const DELIVERY_HASH = `0x${"2".repeat(64)}` as Hex;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function mockOrders(config: ChainRuntimeConfig): MarketplaceOrder[] {
  const now = nowSeconds();
  return [
    {
      address: MOCK_ORDER,
      seller: MOCK_SELLER,
      buyer: MOCK_BUYER,
      token: config.usdc,
      amount: "125000000",
      offerDeadline: now + 86_400,
      workDuration: 604_800,
      reviewWindow: 172_800,
      termsHash: TERMS_HASH,
      state: 3,
      blockNumber: "1240091",
    },
    {
      address: "0x1000000000000000000000000000000000000002",
      seller: "0x3000000000000000000000000000000000000002",
      buyer: MOCK_BUYER,
      token: config.usdc,
      amount: "48000000",
      offerDeadline: now + 43_200,
      workDuration: 259_200,
      reviewWindow: 86_400,
      termsHash: `0x${"3".repeat(64)}`,
      state: 5,
      blockNumber: "1240082",
    },
    {
      address: "0x1000000000000000000000000000000000000003",
      seller: MOCK_SELLER,
      buyer: "0x2000000000000000000000000000000000000003",
      token: config.usdc,
      amount: "300000000",
      offerDeadline: now - 172_800,
      workDuration: 432_000,
      reviewWindow: 86_400,
      termsHash: `0x${"4".repeat(64)}`,
      state: 4,
      blockNumber: "1240044",
    },
  ];
}

export function makePublicClient(config: ChainRuntimeConfig) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(config.rpcUrl, { timeout: 10_000 }),
  });
}

export async function readMarketplace(
  config: ChainRuntimeConfig,
): Promise<MarketplaceSnapshot> {
  if (config.mock) return { orders: mockOrders(config), blockNumber: "1240100" };
  const factory = config.contracts.factory;
  if (!factory) return { orders: [] };

  try {
    const client = makePublicClient(config);
    const { store, error } = await syncLogStore(client, config);
    const logs = store.created;
    if (error && logs.length === 0) return { orders: [], error };
    const stateResults = await client.multicall({
      allowFailure: true,
      contracts: logs.map((log) => ({
        address: log.args.escrow,
        abi: escrowV1Abi,
        functionName: "state" as const,
      })),
    });
    const orders = logs.map((log, index) => {
      const result = stateResults[index];
      return {
        address: log.args.escrow,
        seller: log.args.seller,
        buyer: log.args.buyer,
        token: log.args.token,
        amount: log.args.amount.toString(),
        offerDeadline: Number(log.args.offerDeadline),
        workDuration: Number(log.args.workDuration),
        reviewWindow: Number(log.args.reviewWindow),
        termsHash: log.args.termsHash,
        state:
          result?.status === "success" ? Number(result.result) : 0,
        blockNumber: (log.blockNumber ?? 0n).toString(),
      } satisfies MarketplaceOrder;
    });
    orders.reverse();
    return { orders, blockNumber: store.cursor.toString(), error };
  } catch (error) {
    return {
      orders: [],
      error: error instanceof Error ? error.message : "Arc RPC read failed",
    };
  }
}

export async function readOrder(
  config: ChainRuntimeConfig,
  address: Address,
): Promise<OrderSnapshot | undefined> {
  if (config.mock) {
    const base = mockOrders(config).find(
      (order) => order.address.toLowerCase() === address.toLowerCase(),
    );
    if (!base) return undefined;
    const now = nowSeconds();
    return {
      ...base,
      resolution: 0,
      deliveryHash: base.state >= 3 ? DELIVERY_HASH : ZERO_HASH,
      workDeadline: now + 172_800,
      reviewDeadline: now + 39_600,
      disputedAt: base.state === 4 ? now - 3_600 : 0,
      counterEvidenceDeadline: base.state === 4 ? now + 18_000 : 0,
      disputeRaisedBy: base.state === 4 ? base.buyer : undefined,
    };
  }
  const factory = config.contracts.factory;
  if (!factory) return undefined;

  const client = makePublicClient(config);
  const { store, error } = await syncLogStore(client, config);
  const created = store.created
    .filter((log) => log.args.escrow.toLowerCase() === address.toLowerCase())
    .at(-1);
  if (!created) {
    if (error) throw new Error(error);
    return undefined;
  }
  const values = (await client.multicall({
    allowFailure: false,
    contracts: [
      "state",
      "resolution",
      "buyer",
      "seller",
      "token",
      "amount",
      "termsHash",
      "deliveryHash",
      "offerDeadline",
      "workDeadline",
      "reviewDeadline",
      "disputedAt",
      "counterEvidenceDeadline",
    ].map((functionName) => ({
      address,
      abi: escrowV1Abi,
      functionName,
    })) as never,
  })) as readonly unknown[];
  const opened = store.opened
    .filter((log) => log.args.escrow.toLowerCase() === address.toLowerCase())
    .at(-1);
  return {
    address,
    state: Number(values[0]),
    resolution: Number(values[1]),
    buyer: values[2] as Address,
    seller: values[3] as Address,
    token: values[4] as Address,
    amount: (values[5] as bigint).toString(),
    termsHash: values[6] as Hex,
    deliveryHash: values[7] as Hex,
    offerDeadline: Number(values[8]),
    workDeadline: Number(values[9]),
    reviewDeadline: Number(values[10]),
    disputedAt: Number(values[11]),
    counterEvidenceDeadline: Number(values[12]),
    disputeRaisedBy: opened?.args.raisedBy,
    workDuration: Number(created.args.workDuration),
    reviewWindow: Number(created.args.reviewWindow),
    blockNumber: (created.blockNumber ?? 0n).toString(),
  };
}

export async function readDisputes(
  config: ChainRuntimeConfig,
): Promise<{ disputes: DisputeSnapshot[]; error?: string }> {
  if (config.mock) {
    const now = nowSeconds();
    return {
      disputes: [
        {
          escrow: "0x1000000000000000000000000000000000000003",
          raisedBy: "0x2000000000000000000000000000000000000003",
          commitDeadline: now + 10_800,
          revealDeadline: now + 32_400,
          committed: 2,
          revealed: 0,
          releaseVotes: 0,
          refundVotes: 0,
          splitVotes: 0,
          executed: false,
          blockNumber: "1240048",
        },
      ],
    };
  }
  const panel = config.contracts.disputePanel;
  if (!panel) return { disputes: [] };
  try {
    const client = makePublicClient(config);
    const { store, error } = await syncLogStore(client, config);
    if (error && store.opened.length === 0) return { disputes: [], error };
    const { opened, committed, revealed, executed } = store;
    const disputes = opened.map((log) => {
      const escrow = log.args.escrow;
      const caseCommits = committed.filter(
        (item) => item.args.escrow.toLowerCase() === escrow.toLowerCase(),
      );
      const caseReveals = revealed.filter(
        (item) => item.args.escrow.toLowerCase() === escrow.toLowerCase(),
      );
      const execution = [...executed].reverse().find(
        (item) => item.args.escrow.toLowerCase() === escrow.toLowerCase(),
      );
      return {
        escrow,
        raisedBy: log.args.raisedBy,
        commitDeadline: Number(log.args.commitDeadline),
        revealDeadline: Number(log.args.revealDeadline),
        committed: new Set(
          caseCommits.map((item) => item.args.arbiter.toLowerCase()),
        ).size,
        revealed: caseReveals.length,
        releaseVotes: caseReveals.filter((item) => item.args.vote === 1).length,
        refundVotes: caseReveals.filter((item) => item.args.vote === 2).length,
        splitVotes: caseReveals.filter((item) => item.args.vote === 3).length,
        executed: Boolean(execution),
        outcome: execution ? Number(execution.args.outcome) : undefined,
        blockNumber: (log.blockNumber ?? 0n).toString(),
      } satisfies DisputeSnapshot;
    });
    disputes.reverse();
    return { disputes, error };
  } catch (error) {
    return {
      disputes: [],
      error: error instanceof Error ? error.message : "Arc RPC read failed",
    };
  }
}

export async function readReputation(
  config: ChainRuntimeConfig,
  subject?: Address,
): Promise<ReputationSnapshot> {
  if (config.mock) {
    return {
      subject,
      score: subject
        ? { settled: 12, released: 8, refunded: 2, disputed: 3, splits: 2 }
        : undefined,
      attestations: subject
        ? [
            {
              escrow: MOCK_ORDER,
              seller: MOCK_SELLER,
              buyer: MOCK_BUYER,
              resolution: 1,
              transactionHash: `0x${"a".repeat(64)}`,
              blockNumber: "1240098",
            },
          ]
        : [],
      unattested: subject
        ? mockOrders(config).filter((order) => order.state === 5)
        : [],
    };
  }
  const registry = config.contracts.reputationRegistry;
  if (!registry) return { subject, attestations: [], unattested: [] };
  try {
    const client = makePublicClient(config);
    const { store, error } = await syncLogStore(client, config);
    const [score, market] = await Promise.all([
      subject
        ? client.readContract({
            address: registry,
            abi: reputationRegistryAbi,
            functionName: "scoreOf",
            args: [subject],
          })
        : undefined,
      subject ? readMarketplace(config) : undefined,
    ]);
    const logs = store.attested;
    const attestations = logs
      .filter(
        (log) =>
          !subject ||
          log.args.seller.toLowerCase() === subject.toLowerCase() ||
          log.args.buyer.toLowerCase() === subject.toLowerCase(),
      )
      .map((log) => ({
        escrow: log.args.escrow,
        seller: log.args.seller,
        buyer: log.args.buyer,
        resolution: Number(log.args.resolution),
        transactionHash: log.transactionHash,
        blockNumber: (log.blockNumber ?? 0n).toString(),
      }))
      .reverse();
    const attested = new Set(logs.map((log) => log.args.escrow.toLowerCase()));
    const unattested = (market?.orders ?? []).filter(
      (order) =>
        order.state === 5 &&
        !attested.has(order.address.toLowerCase()) &&
        (order.buyer.toLowerCase() === subject?.toLowerCase() ||
          order.seller.toLowerCase() === subject?.toLowerCase()),
    );
    return {
      subject,
      error,
      score: score
        ? {
            settled: Number(score[0]),
            released: Number(score[1]),
            refunded: Number(score[2]),
            disputed: Number(score[3]),
            splits: Number(score[4]),
          }
        : undefined,
      attestations,
      unattested,
    };
  } catch (error) {
    return {
      subject,
      attestations: [],
      unattested: [],
      error: error instanceof Error ? error.message : "Arc RPC read failed",
    };
  }
}
