import { createRequire } from "node:module";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "../chain.js";
import { humanResolveV3Abi } from "./chain.js";
import type { ReviewServiceConfig } from "./config.js";
import type {
  CircleTransactionResult,
  ReviewOrder,
  ReviewerSnapshot,
} from "./types.js";

const circleSdk = createRequire(import.meta.url)(
  "@circle-fin/developer-controlled-wallets",
) as typeof import("@circle-fin/developer-controlled-wallets");

const ARC_TESTNET_BLOCKCHAIN = "ARC-TESTNET" as const;

export interface CircleRail {
  transfer(input: {
    destination: Address;
    amount: string;
    idempotencyKey: string;
    reference: string;
    onCreated?: (transaction: CircleTransactionResult) => void;
  }): Promise<CircleTransactionResult>;
  resolve(input: {
    order: ReviewOrder;
    reviewer: ReviewerSnapshot;
    evidenceHash: Hex;
    payoutTransactionHash: Hex;
    onCreated?: (transaction: CircleTransactionResult) => void;
  }): Promise<CircleTransactionResult>;
  getTransaction(id: string): Promise<CircleTransactionResult>;
  assertReady?(): Promise<void>;
  checkTreasuryBalance?(): Promise<{
    balance: string;
    minimum: string;
  }>;
}

function usdcUnitsToDecimal(units: string): string {
  if (!/^\d+$/.test(units)) throw new Error("USDC amount must be an integer");
  const amount = BigInt(units);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function transactionHash(value: string | undefined): Hex | null {
  return value && isHex(value) && value.length === 66 ? (value as Hex) : null;
}

export class LiveCircleRail implements CircleRail {
  private readonly client: ReturnType<
    typeof circleSdk.initiateDeveloperControlledWalletsClient
  >;
  private treasuryBalanceCache?: {
    expiresAt: number;
    value: { balance: string; minimum: string };
  };

  constructor(private readonly config: ReviewServiceConfig) {
    if (!config.circleApiKey || !config.circleEntitySecret) {
      throw new Error(
        "CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required for Circle Wallets",
      );
    }
    if (
      !config.circleWalletId ||
      !config.circleWalletAddress ||
      !config.routerAddress
    ) {
      throw new Error(
        "CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS, and ROUTER_ADDRESS are required for Circle Wallets",
      );
    }
    this.client = circleSdk.initiateDeveloperControlledWalletsClient({
      apiKey: config.circleApiKey,
      entitySecret: config.circleEntitySecret,
    });
  }

  async transfer(input: {
    destination: Address;
    amount: string;
    idempotencyKey: string;
    reference: string;
    onCreated?: (transaction: CircleTransactionResult) => void;
  }): Promise<CircleTransactionResult> {
    const created = await this.client.createTransaction({
      walletAddress: this.config.circleWalletAddress!,
      blockchain: ARC_TESTNET_BLOCKCHAIN,
      tokenAddress: this.config.usdcTokenAddress,
      amount: [usdcUnitsToDecimal(input.amount)],
      destinationAddress: getAddress(input.destination),
      fee: {
        type: "level",
        config: { feeLevel: "MEDIUM" },
      },
      idempotencyKey: input.idempotencyKey,
      refId: input.reference,
    });
    const id = created.data?.id;
    if (!id) throw new Error("Circle did not return a transaction id");
    this.treasuryBalanceCache = undefined;
    input.onCreated?.({ id, state: "INITIATED", txHash: null });
    const completed = await this.waitForComplete(id);
    this.treasuryBalanceCache = undefined;
    return completed;
  }

  async resolve(input: {
    order: ReviewOrder;
    reviewer: ReviewerSnapshot;
    evidenceHash: Hex;
    payoutTransactionHash: Hex;
    onCreated?: (transaction: CircleTransactionResult) => void;
  }): Promise<CircleTransactionResult> {
    if (!input.order.decision) throw new Error("verdict is missing");
    const callData = encodeFunctionData({
      abi: humanResolveV3Abi,
      functionName: "humanResolve",
      args: [
        BigInt(input.order.jobId),
        input.reviewer.payoutAddress,
        input.order.decision === "approve",
        BigInt(input.order.reward),
        input.evidenceHash,
        input.payoutTransactionHash,
      ],
    });
    const created = await this.client.createContractExecutionTransaction({
      walletId: this.config.circleWalletId!,
      contractAddress: this.config.routerAddress!,
      callData,
      fee: {
        type: "level",
        config: { feeLevel: "MEDIUM" },
      },
      idempotencyKey: input.order.resolutionIdempotencyKey,
      refId: `vapi-review-resolution:${input.order.id}`,
    });
    const id = created.data?.id;
    if (!id) {
      throw new Error("Circle did not return a contract execution id");
    }
    input.onCreated?.({ id, state: "INITIATED", txHash: null });
    return this.waitForComplete(id);
  }

  async assertReady(): Promise<void> {
    const response = await this.client.getWallet({
      id: this.config.circleWalletId!,
    });
    const wallet = response.data?.wallet;
    if (!wallet) {
      throw new Error(
        `Circle wallet ${this.config.circleWalletId} was not found`,
      );
    }
    if (
      getAddress(wallet.address) !== getAddress(this.config.circleWalletAddress!)
    ) {
      throw new Error(
        "CIRCLE_WALLET_ID and CIRCLE_WALLET_ADDRESS refer to different wallets",
      );
    }
    if (wallet.blockchain !== ARC_TESTNET_BLOCKCHAIN) {
      throw new Error(
        `Circle wallet must use ${ARC_TESTNET_BLOCKCHAIN}, received ${wallet.blockchain}`,
      );
    }
    await this.checkTreasuryBalance();
  }

  async checkTreasuryBalance(): Promise<{
    balance: string;
    minimum: string;
  }> {
    if (
      this.treasuryBalanceCache &&
      this.treasuryBalanceCache.expiresAt > Date.now()
    ) {
      return this.treasuryBalanceCache.value;
    }
    const balance = await publicClient.readContract({
      address: this.config.usdcTokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.config.circleWalletAddress!],
    });
    const minimum = BigInt(this.config.minimumTreasuryBalance);
    if (balance < minimum) {
      throw new Error(
        `Circle treasury has ${balance.toString()} USDC base units; minimum ${minimum.toString()} required`,
      );
    }
    const value = {
      balance: balance.toString(),
      minimum: minimum.toString(),
    };
    this.treasuryBalanceCache = {
      expiresAt: Date.now() + 30_000,
      value,
    };
    return value;
  }

  async getTransaction(id: string): Promise<CircleTransactionResult> {
    const response = await this.client.getTransaction({ id });
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error(`Circle transaction ${id} was not found`);
    return {
      id,
      state: transaction.state,
      txHash: transactionHash(transaction.txHash),
    };
  }

  private async waitForComplete(id: string): Promise<CircleTransactionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Circle transaction polling timed out")),
      this.config.transactionPollTimeoutMs,
    );
    try {
      const response = await this.client.getTransaction({
        id,
        waitForState: "COMPLETE",
        pollingInterval: 2_000,
        signal: controller.signal,
      });
      const transaction = response.data?.transaction;
      if (!transaction) {
        throw new Error(`Circle transaction ${id} returned no transaction`);
      }
      const txHash = transactionHash(transaction.txHash);
      if (!txHash) {
        throw new Error(`Circle transaction ${id} completed without a tx hash`);
      }
      return { id, state: transaction.state, txHash };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createLiveCircleRail(
  config: ReviewServiceConfig,
): CircleRail | undefined {
  if (
    !config.circleApiKey ||
    !config.circleEntitySecret ||
    !config.circleWalletId ||
    !config.circleWalletAddress ||
    !config.routerAddress
  ) {
    return undefined;
  }
  return new LiveCircleRail(config);
}
