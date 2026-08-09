#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:18545}"
MNEMONIC="test test test test test test test test test test test junk"
ANVIL_LOG="${TMPDIR:-/tmp}/vapi-escrow-anvil.log"

pk() { cast wallet private-key "$MNEMONIC" "$1"; }
addr() { cast wallet address --private-key "$1"; }
send() { cast send --rpc-url "$RPC_URL" --json "$@" >/dev/null; }
warp() {
  cast rpc --rpc-url "$RPC_URL" evm_increaseTime "$1" >/dev/null
  cast rpc --rpc-url "$RPC_URL" evm_mine >/dev/null
}

DEPLOYER_PK="$(pk 0)"
BUYER_PK="$(pk 1)"
SELLER_PK="$(pk 2)"
ARBITER_1_PK="$(pk 3)"
ARBITER_2_PK="$(pk 4)"
ARBITER_3_PK="$(pk 5)"
DEPLOYER="$(addr "$DEPLOYER_PK")"
BUYER="$(addr "$BUYER_PK")"
SELLER="$(addr "$SELLER_PK")"
ARBITER_1="$(addr "$ARBITER_1_PK")"
ARBITER_2="$(addr "$ARBITER_2_PK")"
ARBITER_3="$(addr "$ARBITER_3_PK")"

cd "$ROOT_DIR"
anvil --silent --port 18545 --chain-id 31337 --mnemonic "$MNEMONIC" >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in {1..40}; do
  if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
cast chain-id --rpc-url "$RPC_URL" >/dev/null

TOKEN="$(
  forge create test/mocks/MockUSDC3009.sol:MockUSDC3009 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" --broadcast --json |
    jq -r '.deployedTo'
)"

export DEPLOYER_PK PAYMENT_TOKEN="$TOKEN" TREASURY="$DEPLOYER" COUNCIL="$DEPLOYER"
export ARBITER_1 ARBITER_2 ARBITER_3
export CREATE2_SALT
CREATE2_SALT="$(cast keccak "vapi-escrow-local-walkthrough")"
export OFFER_TTL=600 DEADLOCK_TIMEOUT=600 EVIDENCE_WINDOW=60 COMMIT_WINDOW=60 REVEAL_WINDOW=60

forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast >/dev/null
DEPLOYMENT="$ROOT_DIR/deployments/31337.json"
FACTORY="$(jq -r '.escrowFactory' "$DEPLOYMENT")"
PANEL="$(jq -r '.disputePanel' "$DEPLOYMENT")"
AMOUNT=1000000000
TERMS_HASH="$(cast keccak "walkthrough-terms")"

create_and_fund() {
  local salt="$1"
  local escrow
  escrow="$(cast call --rpc-url "$RPC_URL" "$FACTORY" \
    'predictEscrow(address,bytes32)(address)' "$SELLER" "$salt")"
  send "$FACTORY" \
    'createEscrow(address,address,uint256,uint64,uint64,bytes32,bytes32)(address)' \
    "$BUYER" "$TOKEN" "$AMOUNT" 600 60 "$TERMS_HASH" "$salt" \
    --private-key "$SELLER_PK"
  send "$TOKEN" 'mint(address,uint256)' "$BUYER" "$AMOUNT" --private-key "$DEPLOYER_PK"
  send "$TOKEN" 'approve(address,uint256)(bool)' "$escrow" "$AMOUNT" --private-key "$BUYER_PK"
  send "$escrow" 'depositFunds()' --private-key "$DEPLOYER_PK"
  printf '%s' "$escrow"
}

HAPPY_ESCROW="$(create_and_fund "$(cast keccak "happy-path")")"
send "$HAPPY_ESCROW" 'submitDelivery(bytes32)' "$(cast keccak "happy-delivery")" \
  --private-key "$SELLER_PK"
warp 61
send "$HAPPY_ESCROW" 'finalize()' --private-key "$DEPLOYER_PK"
test "$(cast call --rpc-url "$RPC_URL" "$HAPPY_ESCROW" 'state()(uint8)')" = "5"

DISPUTE_ESCROW="$(create_and_fund "$(cast keccak "dispute-path")")"
send "$DISPUTE_ESCROW" 'submitDelivery(bytes32)' "$(cast keccak "disputed-delivery")" \
  --private-key "$SELLER_PK"
send "$DISPUTE_ESCROW" 'raiseDispute(bytes32)' "$(cast keccak "buyer-evidence")" \
  --private-key "$BUYER_PK"
warp 61

VOTE_SALT_1="$(cast keccak "arbiter-1-salt")"
VOTE_SALT_2="$(cast keccak "arbiter-2-salt")"
VOTE_SALT_3="$(cast keccak "arbiter-3-salt")"
commitment() {
  cast keccak "$(cast abi-encode --packed 'f(address,address,uint8,bytes32)' "$1" "$2" 1 "$3")"
}

send "$PANEL" 'commit(address,bytes32)' "$DISPUTE_ESCROW" \
  "$(commitment "$DISPUTE_ESCROW" "$ARBITER_1" "$VOTE_SALT_1")" \
  --private-key "$ARBITER_1_PK"
send "$PANEL" 'commit(address,bytes32)' "$DISPUTE_ESCROW" \
  "$(commitment "$DISPUTE_ESCROW" "$ARBITER_2" "$VOTE_SALT_2")" \
  --private-key "$ARBITER_2_PK"
send "$PANEL" 'commit(address,bytes32)' "$DISPUTE_ESCROW" \
  "$(commitment "$DISPUTE_ESCROW" "$ARBITER_3" "$VOTE_SALT_3")" \
  --private-key "$ARBITER_3_PK"
warp 61
send "$PANEL" 'reveal(address,uint8,bytes32)' "$DISPUTE_ESCROW" 1 "$VOTE_SALT_1" \
  --private-key "$ARBITER_1_PK"
send "$PANEL" 'reveal(address,uint8,bytes32)' "$DISPUTE_ESCROW" 1 "$VOTE_SALT_2" \
  --private-key "$ARBITER_2_PK"
send "$PANEL" 'reveal(address,uint8,bytes32)' "$DISPUTE_ESCROW" 1 "$VOTE_SALT_3" \
  --private-key "$ARBITER_3_PK"
send "$PANEL" 'execute(address)' "$DISPUTE_ESCROW" --private-key "$DEPLOYER_PK"
test "$(cast call --rpc-url "$RPC_URL" "$DISPUTE_ESCROW" 'state()(uint8)')" = "5"
test "$(cast call --rpc-url "$RPC_URL" "$DISPUTE_ESCROW" 'resolution()(uint8)')" = "1"

echo "walkthrough complete: happy=$HAPPY_ESCROW dispute=$DISPUTE_ESCROW"
