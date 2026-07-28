#!/usr/bin/env bash
# End-to-end ERC-8183 job lifecycle against the deployed AgenticCommerce contract on Arc Testnet.
# Proves: createJob -> setBudget -> fund -> submit -> complete, with the evaluator completing settlement.
# Usage: ./scripts/e2e-lifecycle.sh            (EOA evaluator = ORACLE wallet)
#        EVALUATOR_ADDR=0x... ./scripts/e2e-lifecycle.sh --evaluator-contract
#          (evaluator = deployed contract; settlement step must then be driven through that contract)
set -euo pipefail
cd "$(dirname "$0")/.."
source .env

BUDGET=${BUDGET:-1000000} # 1 USDC (6 decimals)
EVALUATOR=${EVALUATOR_ADDR:-$ORACLE_ADDR}
EXPIRES=$(( $(date +%s) + 3600 ))
DELIVERABLE=$(cast keccak "vapi trust network e2e deliverable $(date +%s)")
REASON=$(cast keccak "vapi trust network e2e verdict evidence")

say() { printf '\n== %s\n' "$*"; }
send() { # send <pk> <sig-and-args...>
  local pk=$1; shift
  cast send "$AGENTIC_COMMERCE" "$@" --private-key "$pk" -r "$ARC_RPC_URL" --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["transactionHash"], "status:", d["status"])'
}

say "balances (native gas = USDC on Arc)"
for a in "$CLIENT_ADDR" "$PROVIDER_ADDR" "$EVALUATOR"; do
  printf '  %s native=%s erc20=%s\n' "$a" \
    "$(cast balance "$a" -r "$ARC_RPC_URL")" \
    "$(cast call "$ARC_USDC" 'balanceOf(address)(uint256)' "$a" -r "$ARC_RPC_URL")"
done

say "createJob(provider=$PROVIDER_ADDR, evaluator=$EVALUATOR)"
# jobCounter() is racy on the shared testnet contract; read the id from our own receipt.
JOB_CREATED_TOPIC=0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9
JOB_ID=$(cast send "$AGENTIC_COMMERCE" "createJob(address,address,uint256,string,address)" \
  "$PROVIDER_ADDR" "$EVALUATOR" "$EXPIRES" "vapi trust network e2e: summarize doc per rubric v1" 0x0000000000000000000000000000000000000000 \
  --private-key "$CLIENT_PK" -r "$ARC_RPC_URL" --json \
  | JOB_CREATED_TOPIC="$JOB_CREATED_TOPIC" python3 -c '
import sys, json, os
d = json.load(sys.stdin)
print(d["transactionHash"], "status:", d["status"], file=sys.stderr)
topic = os.environ["JOB_CREATED_TOPIC"]
ids = [int(l["topics"][1], 16) for l in d["logs"] if l["topics"][0].lower() == topic]
assert len(ids) == 1, f"expected 1 JobCreated log, got {len(ids)}"
print(ids[0])
')
say "jobId=$JOB_ID"

say "setBudget($BUDGET) by provider"
send "$PROVIDER_PK" "setBudget(uint256,uint256,bytes)" "$JOB_ID" "$BUDGET" 0x

say "approve + fund by client"
cast send "$ARC_USDC" "approve(address,uint256)" "$AGENTIC_COMMERCE" "$BUDGET" \
  --private-key "$CLIENT_PK" -r "$ARC_RPC_URL" --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["transactionHash"], "status:", d["status"])'
send "$CLIENT_PK" "fund(uint256,bytes)" "$JOB_ID" 0x

say "submit(deliverable=$DELIVERABLE) by provider"
send "$PROVIDER_PK" "submit(uint256,bytes32,bytes)" "$JOB_ID" "$DELIVERABLE" 0x

if [[ "${1:-}" == "--evaluator-contract" ]]; then
  say "evaluator is a contract; drive settlement via the router, then re-run getJob below."
else
  say "complete(reason=$REASON) by EOA evaluator"
  send "$ORACLE_PK" "complete(uint256,bytes32,bytes)" "$JOB_ID" "$REASON" 0x
fi

say "final state: getJob($JOB_ID)"
cast call "$AGENTIC_COMMERCE" "getJob(uint256)" "$JOB_ID" -r "$ARC_RPC_URL"
say "provider USDC after: $(cast call "$ARC_USDC" 'balanceOf(address)(uint256)' "$PROVIDER_ADDR" -r "$ARC_RPC_URL")"
say "explorer: https://testnet.arcscan.app/address/$AGENTIC_COMMERCE"
