import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, publicClient } from "../chain.js";
import {
  agenticCommerceAbi,
  evaluationRouterAbi,
} from "../contracts.js";
import type { ReviewServiceConfig } from "./config.js";
import type { DemoRun } from "./types.js";

const commerceWriteAbi = parseAbi([
  "function createJob(address provider,address evaluator,uint256 expiresAt,string description,address hook) returns (uint256)",
  "function setBudget(uint256 jobId,uint256 budget,bytes data)",
  "function fund(uint256 jobId,bytes data)",
  "function submit(uint256 jobId,bytes32 deliverable,bytes data)",
  "function claimRefund(uint256 jobId)",
]);
const routerWriteAbi = parseAbi([
  "function setLane(uint256 jobId,uint8 lane)",
]);
const routerReadAbi = parseAbi([
  "function humanResolver() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const jobCreatedEvent = parseAbiItem(
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
);
const escalatedEvent = parseAbiItem(
  "event Escalated(uint256 indexed jobId,bytes32 reasonHash)",
);
const ZERO_DATA = "0x" as Hex;
const LOG_BLOCK_RANGE = 2_000n;

interface RawJob {
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

export interface DemoChainReadiness {
  chainId: number;
  contractsReady: boolean;
  clientAddress: Address;
  providerAddress: Address;
  resolverAddress: Address;
  clientTokenBalance: string;
  clientNativeBalance: string;
  providerNativeBalance: string;
  gatewayAvailable: string;
  gatewayTotal: string;
}

export interface DemoPaymentHooks {
  onChallenge(requirements: {
    amount: string;
    network: string;
    payTo: string;
  }): void;
  onAuthorization(): void;
}

export interface DemoPaymentResult {
  orderId: string;
  transaction: string;
  amount: string;
  status: number;
}

export interface DemoHumanResolution {
  resolution: number;
  evidenceHash: Hex;
  reviewer: Address;
  reward: string;
  payoutTransactionHash: Hex;
}

export interface DemoChainRail {
  readonly clientAddress: Address;
  readonly providerAddress: Address;
  getBlockNumber(): Promise<bigint>;
  getJob(jobId: string): Promise<RawJob>;
  findCreatedJob(run: DemoRun): Promise<{
    jobId: string;
    transactionHash: Hex;
  } | null>;
  sendCreateJob(run: DemoRun): Promise<Hex>;
  sendSetLane(jobId: string): Promise<Hex>;
  sendSetBudget(jobId: string, budget: string): Promise<Hex>;
  getAllowance(): Promise<bigint>;
  sendApprove(amount: string): Promise<Hex>;
  hasBudget(jobId: string): Promise<boolean>;
  sendFund(jobId: string): Promise<Hex>;
  sendSubmit(jobId: string, deliverableHash: Hex): Promise<Hex>;
  sendClaimRefund(jobId: string): Promise<Hex>;
  getLane(jobId: string): Promise<number>;
  getResolution(jobId: string): Promise<number>;
  getHumanResolution(jobId: string): Promise<DemoHumanResolution>;
  findEscalationTransaction(
    jobId: string,
    fromBlock: string | null,
  ): Promise<Hex | null>;
  getReceipt(hash: string): Promise<TransactionReceipt | null>;
  readiness(budget: string): Promise<DemoChainReadiness>;
  purchaseReview(
    run: DemoRun,
    hooks: DemoPaymentHooks,
  ): Promise<DemoPaymentResult>;
}

export class LiveDemoChainRail implements DemoChainRail {
  readonly clientAddress: Address;
  readonly providerAddress: Address;
  private readonly clientWallet;
  private readonly providerWallet;

  constructor(private readonly config: ReviewServiceConfig) {
    if (
      !config.demoClientPrivateKey ||
      !config.demoProviderPrivateKey ||
      !config.commerceAddress ||
      !config.routerAddress
    ) {
      throw new Error("live demo chain configuration is incomplete");
    }
    const clientAccount = privateKeyToAccount(config.demoClientPrivateKey);
    const providerAccount = privateKeyToAccount(config.demoProviderPrivateKey);
    this.clientAddress = clientAccount.address;
    this.providerAddress = providerAccount.address;
    const rpcUrl =
      process.env.ARC_RPC_URL?.trim() ||
      "https://rpc.testnet.arc.network";
    this.clientWallet = createWalletClient({
      account: clientAccount,
      chain: arcTestnet,
      transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000 }),
    });
    this.providerWallet = createWalletClient({
      account: providerAccount,
      chain: arcTestnet,
      transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000 }),
    });
  }

  async getBlockNumber(): Promise<bigint> {
    return publicClient.getBlockNumber();
  }

  async getJob(jobId: string): Promise<RawJob> {
    const raw = (await publicClient.readContract({
      address: this.requireCommerce(),
      abi: agenticCommerceAbi,
      functionName: "getJob",
      args: [BigInt(jobId)],
    })) as RawJob;
    return {
      ...raw,
      id: BigInt(raw.id),
      client: getAddress(raw.client),
      provider: getAddress(raw.provider),
      evaluator: getAddress(raw.evaluator),
      budget: BigInt(raw.budget),
      expiredAt: BigInt(raw.expiredAt),
      status: Number(raw.status),
      hook: getAddress(raw.hook),
    };
  }

  async findCreatedJob(
    run: DemoRun,
  ): Promise<{ jobId: string; transactionHash: Hex } | null> {
    if (!run.chainStartBlock) return null;
    const latest = await publicClient.getBlockNumber();
    let fromBlock = BigInt(run.chainStartBlock);
    while (fromBlock <= latest) {
      const toBlock =
        latest - fromBlock + 1n > LOG_BLOCK_RANGE
          ? fromBlock + LOG_BLOCK_RANGE - 1n
          : latest;
      const logs = await publicClient.getLogs({
        address: this.requireCommerce(),
        event: jobCreatedEvent,
        args: {
          client: this.clientAddress,
          provider: this.providerAddress,
        },
        fromBlock,
        toBlock,
        strict: true,
      });
      for (const log of logs) {
        const jobId = log.args.jobId?.toString();
        if (!jobId) continue;
        const job = await this.getJob(jobId);
        if (
          job.description === run.description &&
          isAddressEqual(job.evaluator, this.requireRouter()) &&
          job.expiredAt.toString() === run.expiresAt
        ) {
          return { jobId, transactionHash: log.transactionHash };
        }
      }
      fromBlock = toBlock + 1n;
    }
    return null;
  }

  sendCreateJob(run: DemoRun): Promise<Hex> {
    return this.clientWallet.writeContract({
      address: this.requireCommerce(),
      abi: commerceWriteAbi,
      functionName: "createJob",
      args: [
        this.providerAddress,
        this.requireRouter(),
        BigInt(run.expiresAt),
        run.description,
        zeroAddress,
      ],
    });
  }

  sendSetLane(jobId: string): Promise<Hex> {
    return this.clientWallet.writeContract({
      address: this.requireRouter(),
      abi: routerWriteAbi,
      functionName: "setLane",
      args: [BigInt(jobId), 1],
    });
  }

  sendSetBudget(jobId: string, budget: string): Promise<Hex> {
    return this.providerWallet.writeContract({
      address: this.requireCommerce(),
      abi: commerceWriteAbi,
      functionName: "setBudget",
      args: [BigInt(jobId), BigInt(budget), ZERO_DATA],
    });
  }

  async getAllowance(): Promise<bigint> {
    return publicClient.readContract({
      address: this.config.usdcTokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.clientAddress, this.requireCommerce()],
    });
  }

  sendApprove(amount: string): Promise<Hex> {
    return this.clientWallet.writeContract({
      address: this.config.usdcTokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.requireCommerce(), BigInt(amount)],
    });
  }

  hasBudget(jobId: string): Promise<boolean> {
    return publicClient.readContract({
      address: this.requireCommerce(),
      abi: agenticCommerceAbi,
      functionName: "jobHasBudget",
      args: [BigInt(jobId)],
    }) as Promise<boolean>;
  }

  sendFund(jobId: string): Promise<Hex> {
    return this.clientWallet.writeContract({
      address: this.requireCommerce(),
      abi: commerceWriteAbi,
      functionName: "fund",
      args: [BigInt(jobId), ZERO_DATA],
    });
  }

  sendSubmit(jobId: string, deliverableHash: Hex): Promise<Hex> {
    return this.providerWallet.writeContract({
      address: this.requireCommerce(),
      abi: commerceWriteAbi,
      functionName: "submit",
      args: [BigInt(jobId), deliverableHash, ZERO_DATA],
    });
  }

  sendClaimRefund(jobId: string): Promise<Hex> {
    return this.clientWallet.writeContract({
      address: this.requireCommerce(),
      abi: commerceWriteAbi,
      functionName: "claimRefund",
      args: [BigInt(jobId)],
    });
  }

  async getLane(jobId: string): Promise<number> {
    return Number(
      await publicClient.readContract({
        address: this.requireRouter(),
        abi: evaluationRouterAbi,
        functionName: "lanes",
        args: [BigInt(jobId)],
      }),
    );
  }

  async getResolution(jobId: string): Promise<number> {
    return Number(
      await publicClient.readContract({
        address: this.requireRouter(),
        abi: evaluationRouterAbi,
        functionName: "resolutions",
        args: [BigInt(jobId)],
      }),
    );
  }

  async getHumanResolution(jobId: string): Promise<DemoHumanResolution> {
    const id = BigInt(jobId);
    const [resolution, evidenceHash, reviewer, reward, payoutTransactionHash] =
      await Promise.all([
        publicClient.readContract({
          address: this.requireRouter(),
          abi: evaluationRouterAbi,
          functionName: "resolutions",
          args: [id],
        }),
        publicClient.readContract({
          address: this.requireRouter(),
          abi: evaluationRouterAbi,
          functionName: "evidence",
          args: [id],
        }),
        publicClient.readContract({
          address: this.requireRouter(),
          abi: evaluationRouterAbi,
          functionName: "reviewers",
          args: [id],
        }),
        publicClient.readContract({
          address: this.requireRouter(),
          abi: evaluationRouterAbi,
          functionName: "reviewerRewards",
          args: [id],
        }),
        publicClient.readContract({
          address: this.requireRouter(),
          abi: evaluationRouterAbi,
          functionName: "reviewerPayouts",
          args: [id],
        }),
      ]);
    return {
      resolution: Number(resolution),
      evidenceHash: evidenceHash as Hex,
      reviewer: getAddress(reviewer as Address),
      reward: BigInt(reward as bigint).toString(),
      payoutTransactionHash: payoutTransactionHash as Hex,
    };
  }

  async findEscalationTransaction(
    jobId: string,
    fromBlockValue: string | null,
  ): Promise<Hex | null> {
    const latest = await publicClient.getBlockNumber();
    let fromBlock = fromBlockValue
      ? BigInt(fromBlockValue)
      : latest > 10_000n
        ? latest - 10_000n
        : 0n;
    while (fromBlock <= latest) {
      const toBlock =
        latest - fromBlock + 1n > LOG_BLOCK_RANGE
          ? fromBlock + LOG_BLOCK_RANGE - 1n
          : latest;
      const logs = await publicClient.getLogs({
        address: this.requireRouter(),
        event: escalatedEvent,
        args: { jobId: BigInt(jobId) },
        fromBlock,
        toBlock,
        strict: true,
      });
      const log = logs.at(-1);
      if (log) return log.transactionHash;
      fromBlock = toBlock + 1n;
    }
    return null;
  }

  async getReceipt(hash: string): Promise<TransactionReceipt | null> {
    try {
      return await publicClient.getTransactionReceipt({ hash: hash as Hex });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("could not be found") ||
        message.includes("TransactionReceiptNotFound")
      ) {
        return null;
      }
      throw error;
    }
  }

  async readiness(budget: string): Promise<DemoChainReadiness> {
    const [
      chainId,
      commerceCode,
      routerCode,
      tokenCode,
      resolverAddress,
      clientTokenBalance,
      clientNativeBalance,
      providerNativeBalance,
    ] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: this.requireCommerce() }),
      publicClient.getCode({ address: this.requireRouter() }),
      publicClient.getCode({ address: this.config.usdcTokenAddress }),
      publicClient.readContract({
        address: this.requireRouter(),
        abi: routerReadAbi,
        functionName: "humanResolver",
      }),
      publicClient.readContract({
        address: this.config.usdcTokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.clientAddress],
      }),
      publicClient.getBalance({ address: this.clientAddress }),
      publicClient.getBalance({ address: this.providerAddress }),
    ]);
    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: this.config.demoClientPrivateKey!,
      rpcUrl: process.env.ARC_RPC_URL?.trim(),
    });
    const balances = await gateway.getBalances();
    return {
      chainId,
      contractsReady: Boolean(
        commerceCode &&
          commerceCode !== "0x" &&
          routerCode &&
          routerCode !== "0x" &&
          tokenCode &&
          tokenCode !== "0x",
      ),
      clientAddress: this.clientAddress,
      providerAddress: this.providerAddress,
      resolverAddress: getAddress(resolverAddress),
      clientTokenBalance: clientTokenBalance.toString(),
      clientNativeBalance: clientNativeBalance.toString(),
      providerNativeBalance: providerNativeBalance.toString(),
      gatewayAvailable: balances.gateway.available.toString(),
      gatewayTotal: balances.gateway.total.toString(),
    };
  }

  async purchaseReview(
    run: DemoRun,
    hooks: DemoPaymentHooks,
  ): Promise<DemoPaymentResult> {
    if (!run.jobId) throw new Error("demo escrow job is missing");
    if (!this.config.demoClientPrivateKey) {
      throw new Error("DEMO_CLIENT_PK is required");
    }
    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: this.config.demoClientPrivateKey,
      rpcUrl: process.env.ARC_RPC_URL?.trim(),
    });
    gateway
      .onBeforePaymentCreation(async ({ selectedRequirements }) => {
        hooks.onChallenge({
          amount: selectedRequirements.amount,
          network: selectedRequirements.network,
          payTo: selectedRequirements.payTo,
        });
        if (selectedRequirements.amount !== run.reviewPrice) {
          return {
            abort: true,
            reason: "unexpected_review_price",
          };
        }
        if (selectedRequirements.network !== this.config.gatewayNetwork) {
          return {
            abort: true,
            reason: "unexpected_review_network",
          };
        }
        if (
          !this.config.sellerAddress ||
          !isAddressEqual(
            getAddress(selectedRequirements.payTo),
            this.config.sellerAddress,
          )
        ) {
          return {
            abort: true,
            reason: "unexpected_review_seller",
          };
        }
      })
      .onAfterPaymentCreation(async () => {
        hooks.onAuthorization();
      });

    const result = await gateway.pay<{
      orderId: string;
      state: string;
      statusUrl: string;
    }>(`${this.config.publicBaseUrl}/v1/review-orders`, {
      method: "POST",
      body: {
        requestId: run.requestId,
        jobId: run.jobId,
        deliverable: {
          contentType: "text/plain",
          content: run.deliverableContent,
        },
      },
    });
    if (
      result.status !== 202 ||
      !result.data ||
      typeof result.data.orderId !== "string"
    ) {
      throw new Error("x402 review purchase did not return a review order");
    }
    if (
      result.amount !== 0n &&
      result.amount.toString() !== run.reviewPrice
    ) {
      throw new Error("x402 settled an unexpected review amount");
    }
    return {
      orderId: result.data.orderId,
      transaction: result.transaction,
      amount: result.amount.toString(),
      status: result.status,
    };
  }

  private requireCommerce(): Address {
    if (!this.config.commerceAddress) {
      throw new Error("AGENTIC_COMMERCE is required");
    }
    return this.config.commerceAddress;
  }

  private requireRouter(): Address {
    if (!this.config.routerAddress) {
      throw new Error("ROUTER_ADDRESS is required");
    }
    return this.config.routerAddress;
  }
}

export function createLiveDemoChainRail(
  config: ReviewServiceConfig,
): DemoChainRail | undefined {
  if (
    !config.demoEnabled ||
    !config.demoClientPrivateKey ||
    !config.demoProviderPrivateKey ||
    !config.commerceAddress ||
    !config.routerAddress
  ) {
    return undefined;
  }
  return new LiveDemoChainRail(config);
}
