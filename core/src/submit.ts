import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  arcTestnet,
  createOracleWalletClient,
  publicClient,
} from "./chain.js";
import { evaluationRouterAbi } from "./contracts.js";
import type { GateAction, Verdict } from "./validate.js";

export interface SubmitInput {
  jobId: bigint;
  action: GateAction;
  verdict: Verdict;
  evidenceHash: Hex;
  routerAddress?: Address;
  dryRun?: boolean;
}

export interface SubmitResult {
  calldata: Hex;
  transactionHash?: Hash;
}

function jobLog(jobId: bigint, event: string, fields: object): void {
  console.log(
    `[job:${jobId.toString()}] ${JSON.stringify({ event, ...fields })}`,
  );
}

export async function submitDecision(
  input: SubmitInput,
): Promise<SubmitResult> {
  const calldata =
    input.action === "settle"
      ? encodeFunctionData({
          abi: evaluationRouterAbi,
          functionName: "submitAIVerdict",
          args: [
            input.jobId,
            input.verdict.approve,
            input.verdict.confidenceBP,
            input.evidenceHash,
          ],
        })
      : encodeFunctionData({
          abi: evaluationRouterAbi,
          functionName: "escalate",
          args: [input.jobId, input.evidenceHash],
        });

  if (input.dryRun) {
    jobLog(input.jobId, "dry_run_calldata", {
      action: input.action,
      calldata,
    });
    return { calldata };
  }

  const rawRouterAddress = input.routerAddress ?? process.env.ROUTER_ADDRESS;
  if (!rawRouterAddress) {
    throw new Error("ROUTER_ADDRESS is required for live submission");
  }
  const routerAddress = getAddress(rawRouterAddress);
  const walletClient = createOracleWalletClient();
  const transactionHash = await walletClient.sendTransaction({
    account: walletClient.account,
    chain: arcTestnet,
    to: routerAddress,
    data: calldata,
  });
  jobLog(input.jobId, "transaction_submitted", {
    action: input.action,
    transactionHash,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`Router transaction ${transactionHash} reverted`);
  }
  jobLog(input.jobId, "transaction_confirmed", {
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
  });
  return { calldata, transactionHash };
}
