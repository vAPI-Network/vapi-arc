import {
  createWalletClient,
  custom,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { arbiterRegistryAbi } from "./abi/escrow-v1";
import {
  ARC_CHAIN_ID,
  ARC_EXPLORER_URL,
  ARC_RPC_URL,
  arcTestnet,
  type ChainRuntimeConfig,
} from "./chains";
import { makePublicClient } from "./chain-data";

type RequestArguments = { method: string; params?: unknown[] | object };
type EthereumProvider = {
  request(arguments_: RequestArguments): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type ContractWrite = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};

type WalletContextValue = {
  account?: Address;
  chainId?: number;
  connected: boolean;
  isArbiter: boolean;
  connecting: boolean;
  connect(): Promise<void>;
  switchActor(): Promise<void>;
  switchToArc(): Promise<void>;
  writeContract(request: ContractWrite): Promise<Hex>;
  sendTransaction(to: Address, data: Hex): Promise<Hex>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function provider() {
  return typeof window === "undefined" ? undefined : window.ethereum;
}

function firstAddress(value: unknown): Address | undefined {
  return Array.isArray(value) && typeof value[0] === "string"
    ? (value[0] as Address)
    : undefined;
}

export function WalletProvider({
  config,
  children,
}: {
  config: ChainRuntimeConfig;
  children: ReactNode;
}) {
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [isArbiter, setIsArbiter] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const sync = useCallback(async () => {
    const ethereum = provider();
    if (!ethereum) return;
    const [accounts, chain] = await Promise.all([
      ethereum.request({ method: "eth_accounts" }),
      ethereum.request({ method: "eth_chainId" }),
    ]);
    setAccount(firstAddress(accounts));
    setChainId(typeof chain === "string" ? Number(chain) : undefined);
  }, []);

  useEffect(() => {
    void sync();
    const ethereum = provider();
    if (!ethereum?.on) return;
    const accountsChanged = (accounts: unknown) => setAccount(firstAddress(accounts));
    const chainChanged = (chain: unknown) =>
      setChainId(typeof chain === "string" ? Number(chain) : undefined);
    ethereum.on("accountsChanged", accountsChanged);
    ethereum.on("chainChanged", chainChanged);
    return () => {
      ethereum.removeListener?.("accountsChanged", accountsChanged);
      ethereum.removeListener?.("chainChanged", chainChanged);
    };
  }, [sync]);

  useEffect(() => {
    const registry = config.contracts.arbiterRegistry;
    if (!account || !registry || config.mock) {
      setIsArbiter(config.mock && Boolean(account));
      return;
    }
    let active = true;
    makePublicClient(config)
      .readContract({
        address: registry,
        abi: arbiterRegistryAbi,
        functionName: "isArbiter",
        args: [account],
      })
      .then((allowed) => {
        if (active) setIsArbiter(allowed);
      })
      .catch(() => {
        if (active) setIsArbiter(false);
      });
    return () => {
      active = false;
    };
  }, [account, config]);

  const connect = useCallback(async () => {
    const ethereum = provider();
    if (!ethereum) throw new Error("No injected wallet found in this browser.");
    setConnecting(true);
    try {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      setAccount(firstAddress(accounts));
      await sync();
    } finally {
      setConnecting(false);
    }
  }, [sync]);

  const switchActor = useCallback(async () => {
    const ethereum = provider();
    if (!ethereum) throw new Error("No injected wallet found in this browser.");
    try {
      await ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      await ethereum.request({ method: "eth_requestAccounts" });
    }
    await sync();
  }, [sync]);

  const switchToArc = useCallback(async () => {
    const ethereum = provider();
    if (!ethereum) throw new Error("No injected wallet found in this browser.");
    const chainHex = numberToHex(ARC_CHAIN_ID);
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: "Arc Testnet",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: [ARC_RPC_URL],
            blockExplorerUrls: [ARC_EXPLORER_URL],
          },
        ],
      });
    }
    await sync();
  }, [sync]);

  const walletClient = useCallback(() => {
    const ethereum = provider();
    if (!ethereum || !account) throw new Error("Connect a wallet to continue.");
    return createWalletClient({
      account,
      chain: arcTestnet,
      transport: custom(ethereum),
    });
  }, [account]);

  const writeContract = useCallback(
    async (request: ContractWrite) =>
      walletClient().writeContract({
        ...request,
        account: account!,
        chain: arcTestnet,
      } as never),
    [account, walletClient],
  );

  const sendTransaction = useCallback(
    async (to: Address, data: Hex) =>
      walletClient().sendTransaction({
        account: account!,
        chain: arcTestnet,
        to,
        data,
      }),
    [account, walletClient],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      account,
      chainId,
      connected: Boolean(account),
      isArbiter,
      connecting,
      connect,
      switchActor,
      switchToArc,
      writeContract,
      sendTransaction,
    }),
    [
      account,
      chainId,
      connect,
      connecting,
      isArbiter,
      sendTransaction,
      switchActor,
      switchToArc,
      writeContract,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}
