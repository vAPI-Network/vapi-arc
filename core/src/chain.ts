import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "./env.js";

const DEFAULT_RPC_URL = "https://rpc.testnet.arc.network";

function arcRpcUrl(): string {
  return process.env.ARC_RPC_URL || DEFAULT_RPC_URL;
}

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [arcRpcUrl()],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(arcRpcUrl()),
});

export type ArcPublicClient = typeof publicClient;

function readOraclePrivateKey(): Hex {
  const privateKey = process.env.ORACLE_PK;
  if (!privateKey) {
    throw new Error("ORACLE_PK is required for live transaction submission");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("ORACLE_PK must be a 32-byte 0x-prefixed private key");
  }
  return privateKey as Hex;
}

export function createOracleWalletClient() {
  const account = privateKeyToAccount(readOraclePrivateKey());
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcRpcUrl()),
  });
}

export type OracleWalletClient = ReturnType<typeof createOracleWalletClient>;
