import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "./env.js";

const DEFAULT_RPC_URL = "https://rpc.testnet.arc.network";

function arcRpcUrl(): string {
  return process.env.ARC_RPC_URL || DEFAULT_RPC_URL;
}

// The public Arc RPC allows ~2 req/s and rejects bursts with the nonstandard
// JSON-RPC code -32011 ("request limit reached"), which viem's built-in
// retry does not recognize. Wrap the transport with a backoff for it.
function patientHttp(url: string): Transport {
  const base = http(url, { timeout: 12_000 });
  return (params) => {
    const transport = base(params);
    const request = transport.request.bind(transport);
    const patientRequest: typeof transport.request = async (args, options) => {
      let delayMs = 1_000;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await request(args, options);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const rateLimited =
            message.includes("request limit reached") ||
            message.includes("-32011");
          if (!rateLimited || attempt >= 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
        }
      }
    };
    return { ...transport, request: patientRequest };
  };
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
  transport: patientHttp(arcRpcUrl()),
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
    transport: patientHttp(arcRpcUrl()),
  });
}

export type OracleWalletClient = ReturnType<typeof createOracleWalletClient>;
