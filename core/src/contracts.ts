import {
  getAddress,
  getContract,
  type Abi,
  type Address,
} from "viem";
import agenticCommerceArtifact from "../../adapters/arc/abi/AgenticCommerce.json" with {
  type: "json",
};
import evaluationRouterArtifact from "../../adapters/arc/abi/EvaluationRouter.json" with {
  type: "json",
};
import {
  publicClient,
  type ArcPublicClient,
  type OracleWalletClient,
} from "./chain.js";

export const agenticCommerceAbi = agenticCommerceArtifact.abi as Abi;
export const evaluationRouterAbi = evaluationRouterArtifact.abi as Abi;
export const defaultAgenticCommerceAddress = getAddress(
  agenticCommerceArtifact.proxy,
);
export const arcPaymentTokenAddress = getAddress(
  agenticCommerceArtifact.paymentToken,
);

export function getAgenticCommerceContract(
  address: Address = defaultAgenticCommerceAddress,
  client: ArcPublicClient = publicClient,
) {
  return getContract({
    address,
    abi: agenticCommerceAbi,
    client,
  });
}

export function getEvaluationRouterReadContract(
  address: Address,
  client: ArcPublicClient = publicClient,
) {
  return getContract({
    address,
    abi: evaluationRouterAbi,
    client,
  });
}

export function getEvaluationRouterWriteContract(
  address: Address,
  walletClient: OracleWalletClient,
  client: ArcPublicClient = publicClient,
) {
  return getContract({
    address,
    abi: evaluationRouterAbi,
    client: {
      public: client,
      wallet: walletClient,
    },
  });
}
