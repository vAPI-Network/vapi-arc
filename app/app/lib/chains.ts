import { defineChain, getAddress, isAddress, type Address } from "viem";

export const ARC_CHAIN_ID = 5_042_002;
export const ARC_RPC_URL = "https://rpc.testnet.arc.network";
export const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
export const ARC_USDC = getAddress(
  "0x3600000000000000000000000000000000000000",
);
export const USDC_DECIMALS = 6;
export const CHAIN_POLL_INTERVAL_MS = 12_000;

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: {
    default: { name: "ArcScan", url: ARC_EXPLORER_URL },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
  },
  testnet: true,
});

export type ContractAddresses = {
  factory?: Address;
  disputePanel?: Address;
  arbiterRegistry?: Address;
  feeRouter?: Address;
  reputationRegistry?: Address;
};

export type ChainRuntimeConfig = {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  usdc: Address;
  deployBlock: string;
  contracts: ContractAddresses;
  mock: boolean;
};

function envAddress(value: string | undefined): Address | undefined {
  return value && isAddress(value) ? getAddress(value) : undefined;
}

export function getServerChainConfig(): ChainRuntimeConfig {
  const mock = process.env.VAPI_CHAIN_MOCK === "1";
  return {
    chainId: ARC_CHAIN_ID,
    rpcUrl: ARC_RPC_URL,
    explorerUrl: ARC_EXPLORER_URL,
    usdc: ARC_USDC,
    deployBlock: process.env.VAPI_DEPLOY_BLOCK ?? "0",
    contracts: {
      factory:
        envAddress(process.env.VAPI_ESCROW_FACTORY) ??
        (mock ? "0x1111111111111111111111111111111111111111" : undefined),
      disputePanel:
        envAddress(process.env.VAPI_DISPUTE_PANEL) ??
        (mock ? "0x2222222222222222222222222222222222222222" : undefined),
      arbiterRegistry:
        envAddress(process.env.VAPI_ARBITER_REGISTRY) ??
        (mock ? "0x3333333333333333333333333333333333333333" : undefined),
      feeRouter:
        envAddress(process.env.VAPI_FEE_ROUTER) ??
        (mock ? "0x4444444444444444444444444444444444444444" : undefined),
      reputationRegistry:
        envAddress(process.env.VAPI_REPUTATION_REGISTRY) ??
        (mock ? "0x5555555555555555555555555555555555555555" : undefined),
    },
    mock,
  };
}

export function explorerAddress(address: Address) {
  return `${ARC_EXPLORER_URL}/address/${address}`;
}

export function explorerTransaction(hash: `0x${string}`) {
  return `${ARC_EXPLORER_URL}/tx/${hash}`;
}
