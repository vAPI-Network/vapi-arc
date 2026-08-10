#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:18545}"

live_send() {
  local label="$1"
  local receipt
  shift
  receipt="$(cast send --rpc-url "$RPC_URL" --json "$@")"
  printf '%s tx=%s\n' "$label" "$(jq -r '.transactionHash' <<<"$receipt")"
}

run_live_happy_path() {
  : "${BUYER_PK:?BUYER_PK is required for LIVE=true}"
  : "${SELLER_PK:?SELLER_PK is required for LIVE=true}"

  local deployment="${DEPLOYMENT:-$ROOT_DIR/deployments/arc-testnet.json}"
  local factory token buyer seller escrow token_balance state escrow_balance code allowance
  local amount="${DEMO_AMOUNT:-1000000}"
  local work_duration="${DEMO_WORK_DURATION:-1200}"
  local review_window="${DEMO_REVIEW_WINDOW:-180}"
  local salt="${DEMO_SALT:-$(cast keccak "vapi-arc-live-happy-$(date +%s)")}"
  local terms_hash="${DEMO_TERMS_HASH:-$(cast keccak "vapi-arc-live-happy-terms")}"

  factory="$(jq -er '.escrowFactory' "$deployment")"
  token="$(cast call --rpc-url "$RPC_URL" "$factory" 'paymentToken()(address)')"
  buyer="$(cast wallet address --private-key "$BUYER_PK")"
  seller="$(cast wallet address --private-key "$SELLER_PK")"
  escrow="$(cast call --rpc-url "$RPC_URL" "$factory" \
    'predictEscrow(address,bytes32)(address)' "$seller" "$salt")"
  token_balance="$(cast call --rpc-url "$RPC_URL" "$token" \
    'balanceOf(address)(uint256)' "$buyer")"
  token_balance="${token_balance%% *}"
  if (( token_balance < amount )); then
    printf 'buyer %s has %s token units; %s required\n' "$buyer" "$token_balance" "$amount" >&2
    return 1
  fi

  printf 'live walkthrough buyer=%s seller=%s escrow=%s amount=%s\n' \
    "$buyer" "$seller" "$escrow" "$amount"
  code="$(cast code --rpc-url "$RPC_URL" "$escrow")"
  if [[ "$code" == "0x" ]]; then
    live_send create "$factory" \
      'createEscrow(address,address,uint256,uint64,uint64,bytes32,bytes32)(address)' \
      "$buyer" "$token" "$amount" "$work_duration" "$review_window" "$terms_hash" "$salt" \
      --private-key "$SELLER_PK"
  fi

  state="$(cast call --rpc-url "$RPC_URL" "$escrow" 'state()(uint8)')"
  state="${state%% *}"
  if [[ "$state" == "1" ]]; then
    allowance="$(cast call --rpc-url "$RPC_URL" "$token" \
      'allowance(address,address)(uint256)' "$buyer" "$escrow")"
    allowance="${allowance%% *}"
    if (( allowance < amount )); then
      live_send approve "$token" 'approve(address,uint256)(bool)' "$escrow" "$amount" \
        --private-key "$BUYER_PK"
    fi
    live_send deposit "$escrow" 'depositFunds()' --private-key "$SELLER_PK"
    state="2"
  fi
  if [[ "$state" == "2" ]]; then
    live_send submit "$escrow" 'submitDelivery(bytes32)' "$(cast keccak "live-delivery")" \
      --private-key "$SELLER_PK"
    state="3"
  fi
  if [[ "$state" == "3" ]]; then
    live_send release "$escrow" 'releaseFunds()' --private-key "$BUYER_PK"
  fi

  state="$(cast call --rpc-url "$RPC_URL" "$escrow" 'state()(uint8)')"
  state="${state%% *}"
  escrow_balance="$(cast call --rpc-url "$RPC_URL" "$token" \
    'balanceOf(address)(uint256)' "$escrow")"
  escrow_balance="${escrow_balance%% *}"
  test "$state" = "5"
  test "$escrow_balance" = "0"
  printf 'walkthrough complete: happy=%s state=%s escrowBalance=%s\n' \
    "$escrow" "$state" "$escrow_balance"
}

if [[ "${LIVE:-false}" == "true" ]]; then
  run_live_happy_path
  exit
fi

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
