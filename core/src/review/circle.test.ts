import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { LiveCircleRail } from "./circle.js";
import type { ReviewServiceConfig } from "./config.js";

const PAYOUT_TX = `0x${"a".repeat(64)}` as Hex;

function testConfig(): ReviewServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "http://review.test",
    databasePath: ":memory:",
    routerAddress: getAddress(
      "0x3333333333333333333333333333333333333333",
    ),
    sellerAddress: getAddress(
      "0x5555555555555555555555555555555555555555",
    ),
    gatewayNetwork: "eip155:5042002",
    gatewayUrl: "https://gateway.invalid",
    reviewPrice: "250000",
    reviewPriceDisplay: "$0.25",
    reviewerReward: "200000",
    claimTtlSeconds: 600,
    reviewSlaSeconds: 1_800,
    minJobExpiryBufferSeconds: 2_220,
    maxDispatches: 2,
    circleApiKey: "test-api-key",
    circleEntitySecret: "test-entity-secret",
    circleWalletId: "test-wallet-id",
    circleWalletAddress: getAddress(
      "0x7777777777777777777777777777777777777777",
    ),
    usdcTokenAddress: getAddress(
      "0x3600000000000000000000000000000000000000",
    ),
    minimumTreasuryBalance: "450000",
    circleMaxAttempts: 3,
    transactionPollTimeoutMs: 1_000,
    backgroundIntervalMs: 60_000,
    logLookbackBlocks: 10_000n,
    allowPartialConfiguration: false,
  };
}

describe("Circle treasury balance cache", () => {
  it("invalidates when a transfer is created and again when it completes", async () => {
    const config = testConfig();
    const rail = new LiveCircleRail(config);
    let releaseCompletion!: () => void;
    let signalPolling!: () => void;
    let transferRequest: Record<string, unknown> | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const pollingStarted = new Promise<void>((resolve) => {
      signalPolling = resolve;
    });
    Object.defineProperty(rail, "client", {
      value: {
        async createTransaction(input: Record<string, unknown>) {
          transferRequest = input;
          return { data: { id: "circle-payout-1" } };
        },
        async getTransaction() {
          signalPolling();
          await completionGate;
          return {
            data: {
              transaction: {
                state: "COMPLETE",
                txHash: PAYOUT_TX,
              },
            },
          };
        },
      },
    });
    const internal = rail as unknown as {
      treasuryBalanceCache?: {
        expiresAt: number;
        value: { balance: string; minimum: string };
      };
    };
    internal.treasuryBalanceCache = {
      expiresAt: Date.now() + 30_000,
      value: { balance: "1000000", minimum: "450000" },
    };

    const transfer = rail.transfer({
      destination: getAddress(
        "0x4444444444444444444444444444444444444444",
      ),
      amount: "200000",
      idempotencyKey: "payout-key",
      reference: "vapi-review-payout:test",
    });
    await pollingStarted;
    assert.equal(internal.treasuryBalanceCache, undefined);
    assert.deepEqual(transferRequest, {
      walletAddress: config.circleWalletAddress,
      blockchain: "ARC-TESTNET",
      tokenAddress: config.usdcTokenAddress,
      amount: ["0.2"],
      destinationAddress: getAddress(
        "0x4444444444444444444444444444444444444444",
      ),
      fee: {
        type: "level",
        config: { feeLevel: "MEDIUM" },
      },
      idempotencyKey: "payout-key",
      refId: "vapi-review-payout:test",
    });

    internal.treasuryBalanceCache = {
      expiresAt: Date.now() + 30_000,
      value: { balance: "800000", minimum: "450000" },
    };
    releaseCompletion();
    assert.deepEqual(await transfer, {
      id: "circle-payout-1",
      state: "COMPLETE",
      txHash: PAYOUT_TX,
    });
    assert.equal(internal.treasuryBalanceCache, undefined);
  });
});
