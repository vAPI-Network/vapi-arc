#!/usr/bin/env bash
set -euo pipefail

CONTRACT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACT_ROOT/../.." && pwd)"
DEPLOYMENT="${DEPLOYMENT:-$CONTRACT_ROOT/deployments/arc-testnet.json}"
REPORT="${REPORT:-$REPO_ROOT/.superpowers/sdd/rehearsal-report.md}"
RPC_URL="${RPC_URL:-${ARC_RPC_URL:-https://rpc.testnet.arc.network}}"
EXPLORER="${EXPLORER:-https://testnet.arcscan.app}"
CHAIN_ID_EXPECTED="${CHAIN_ID_EXPECTED:-5042002}"
RPC_TIMEOUT="${RPC_TIMEOUT:-120}"
RECEIPT_TIMEOUT="${RECEIPT_TIMEOUT:-120}"

: "${SELLER_PK:?SELLER_PK is required}"
: "${BUYER_PK:?BUYER_PK is required}"
: "${ARBITER_1_PK:?ARBITER_1_PK is required}"
: "${ARBITER_2_PK:?ARBITER_2_PK is required}"
: "${ARBITER_3_PK:?ARBITER_3_PK is required}"

FACTORY="$(jq -er '.escrowFactory' "$DEPLOYMENT")"
PANEL="$(jq -er '.disputePanel' "$DEPLOYMENT")"
REGISTRY="$(jq -er '.arbiterRegistry' "$DEPLOYMENT")"
FEE_ROUTER="$(jq -er '.feeRouter' "$DEPLOYMENT")"
REPUTATION="$(jq -er '.reputationRegistry' "$DEPLOYMENT")"
TOKEN="$(cast call --rpc-url "$RPC_URL" "$FACTORY" 'paymentToken()(address)')"
TREASURY="$(cast call --rpc-url "$RPC_URL" "$FEE_ROUTER" 'treasury()(address)')"
FEE_BP="$(cast call --rpc-url "$RPC_URL" "$FEE_ROUTER" 'feeBp()(uint16)')"
SELLER="$(cast wallet address --private-key "$SELLER_PK")"
BUYER="$(cast wallet address --private-key "$BUYER_PK")"
ARBITER_1="$(cast wallet address --private-key "$ARBITER_1_PK")"
ARBITER_2="$(cast wallet address --private-key "$ARBITER_2_PK")"
ARBITER_3="$(cast wallet address --private-key "$ARBITER_3_PK")"

AMOUNT="${DEMO_AMOUNT:-1000000}"
WORK_DURATION="${DEMO_WORK_DURATION:-1200}"
REVIEW_WINDOW="${DEMO_REVIEW_WINDOW:-180}"
SALT="${DEMO_SALT:-$(cast keccak "dispute-encore-$(date +%s)-$RANDOM")}"
TERMS_HASH="${DEMO_TERMS_HASH:-$(cast keccak 'dispute-encore-terms')}"
DELIVERY_HASH="${DEMO_DELIVERY_HASH:-$(cast keccak 'dispute-encore-delivery')}"
EVIDENCE_HASH="${DEMO_EVIDENCE_HASH:-$(cast keccak 'dispute-encore-buyer-evidence')}"
VOTE_SALT_1="${VOTE_SALT_1:-$(cast keccak "dispute-encore-vote-1-$SALT")}"
VOTE_SALT_2="${VOTE_SALT_2:-$(cast keccak "dispute-encore-vote-2-$SALT")}"
VOTE_SALT_3="${VOTE_SALT_3:-$(cast keccak "dispute-encore-vote-3-$SALT")}"

EVIDENCE_WINDOW="$(cast call --rpc-url "$RPC_URL" "$PANEL" 'evidenceWindow()(uint64)')"
COMMIT_WINDOW="$(cast call --rpc-url "$RPC_URL" "$PANEL" 'commitWindow()(uint64)')"
REVEAL_WINDOW="$(cast call --rpc-url "$RPC_URL" "$PANEL" 'revealWindow()(uint64)')"
if [[ -n "${DEMO_ESCROW:-}" ]]; then
  ESCROW="$DEMO_ESCROW"
else
  ESCROW="$(cast call --rpc-url "$RPC_URL" "$FACTORY" \
    'predictEscrow(address,bytes32)(address)' "$SELLER" "$SALT")"
fi

TX_INDEX=0
LAST_TX=""
EXECUTE_TX=""
ATTEST_TX=""

mkdir -p "$(dirname "$REPORT")"
cat >"$REPORT" <<EOF
# DISPUTE-ENCORE rehearsal report

- Network: Arc Testnet (chain $CHAIN_ID_EXPECTED)
- Factory: \`$FACTORY\`
- Panel: \`$PANEL\`
- Escrow: \`$ESCROW\`
- Seller: \`$SELLER\`
- Buyer: \`$BUYER\`
- Amount: $AMOUNT base units

## Transaction evidence

| # | Transaction hash | Action | Arcscan |
|---:|---|---|---|
EOF

fail() {
  local action="$1"
  local detail="$2"
  {
    printf '\n## Failure\n\n- Action: `%s`\n- Exact error:\n\n```text\n%s\n```\n' "$action" "$detail"
    printf '\n- Status: BLOCKED\n'
  } >>"$REPORT"
  printf 'STATUS: BLOCKED — %s\n' "$action" >&2
  printf '%s\n' "$detail" >&2
  exit 1
}

send_tx() {
  local action="$1"
  local output rc tx receipt status started
  shift
  set +e
  output="$(cast send --rpc-url "$RPC_URL" --rpc-timeout "$RPC_TIMEOUT" \
    --timeout "$RECEIPT_TIMEOUT" --async "$@" 2>&1)"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail "$action" "$output"
  fi
  tx="$(grep -Eo '0x[0-9a-fA-F]{64}' <<<"$output" | tail -n 1)"
  [[ -n "$tx" ]] || fail "$action transaction hash parsing" "$output"
  TX_INDEX=$((TX_INDEX + 1))
  printf '| %d | `%s` | %s | [view](%s/tx/%s) |\n' \
    "$TX_INDEX" "$tx" "$action" "$EXPLORER" "$tx" >>"$REPORT"
  started="$SECONDS"
  while true; do
    set +e
    receipt="$(cast receipt --rpc-url "$RPC_URL" "$tx" --json 2>&1)"
    rc=$?
    set -e
    if (( rc == 0 )); then break; fi
    if (( SECONDS - started >= RECEIPT_TIMEOUT )); then
      fail "$action receipt timeout" "$receipt"
    fi
    sleep 2
  done
  status="$(jq -er '.status' <<<"$receipt")" || fail "$action receipt parsing" "$receipt"
  if [[ "$status" != '0x1' ]]; then
    fail "$action reverted (tx $tx)" "$receipt"
  fi
  LAST_TX="$tx"
  printf '%s tx=%s\n' "$action" "$tx"
}

record_existing_tx() {
  local action="$1" tx="$2" status
  status="$(cast receipt --rpc-url "$RPC_URL" "$tx" --json | jq -er '.status')"
  assert_eq "$action existing receipt status" "$status" '0x1'
  TX_INDEX=$((TX_INDEX + 1))
  printf '| %d | `%s` | %s | [view](%s/tx/%s) |\n' \
    "$TX_INDEX" "$tx" "$action" "$EXPLORER" "$tx" >>"$REPORT"
}

call_uint() {
  local value
  value="$(cast call --rpc-url "$RPC_URL" "$@")"
  printf '%s' "${value%% *}"
}

block_timestamp_for_tx() {
  local tx="$1" block_number timestamp
  block_number="$(cast receipt --rpc-url "$RPC_URL" "$tx" --json | jq -er '.blockNumber')"
  timestamp="$(cast block --rpc-url "$RPC_URL" "$block_number" --json | jq -er '.timestamp')"
  cast to-dec "$timestamp"
}

latest_timestamp() {
  local timestamp
  timestamp="$(cast block --rpc-url "$RPC_URL" latest --json | jq -er '.timestamp')"
  cast to-dec "$timestamp"
}

wait_until() {
  local label="$1" target="$2" now remaining nap
  while true; do
    now="$(latest_timestamp)"
    if (( now >= target )); then
      printf '%s open at chain timestamp %s\n' "$label" "$now"
      return
    fi
    remaining=$((target - now))
    nap=15
    if (( remaining < nap )); then nap="$remaining"; fi
    if (( nap < 1 )); then nap=1; fi
    printf 'waiting for %s: %ss remain (chain=%s target=%s)\n' \
      "$label" "$remaining" "$now" "$target"
    sleep "$nap"
  done
}

commitment() {
  cast keccak "$(cast abi-encode --packed \
    'f(address,address,uint8,bytes32)' "$1" "$2" "$3" "$4")"
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "verification: $label" "expected $expected, got $actual"
  fi
}

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
assert_eq 'chain id' "$CHAIN_ID" "$CHAIN_ID_EXPECTED"
ESCROW_CODE="$(cast code --rpc-url "$RPC_URL" "$ESCROW")"
if [[ -n "${EXISTING_CREATE_TX:-}" ]]; then
  if [[ "$ESCROW_CODE" == '0x' ]]; then
    fail 'resume preflight' "existing create tx supplied but escrow $ESCROW has no code"
  fi
  assert_eq 'existing create receipt status' \
    "$(cast receipt --rpc-url "$RPC_URL" "$EXISTING_CREATE_TX" --json | jq -er '.status')" '0x1'
else
  assert_eq 'fresh predicted escrow' "$ESCROW_CODE" '0x'
fi
assert_eq 'panel factory' "$(cast call --rpc-url "$RPC_URL" "$PANEL" 'factory()(address)')" "$FACTORY"
for arbiter in "$ARBITER_1" "$ARBITER_2" "$ARBITER_3"; do
  assert_eq "registered arbiter $arbiter" \
    "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'isArbiter(address)(bool)' "$arbiter")" 'true'
done
BUYER_BALANCE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$BUYER")"
if (( BUYER_BALANCE < AMOUNT )); then
  fail 'buyer balance preflight' "buyer has $BUYER_BALANCE token units; $AMOUNT required"
fi

read -r SCORE_SETTLED_BEFORE SCORE_RELEASED_BEFORE SCORE_REFUNDED_BEFORE \
  SCORE_DISPUTED_BEFORE SCORE_SPLITS_BEFORE < <(
    cast call --rpc-url "$RPC_URL" "$REPUTATION" \
      'scoreOf(address)(uint64,uint64,uint64,uint64,uint64)' "$SELLER" |
      awk '{print $1}' | paste -sd ' ' -
  )

if [[ -n "${EXISTING_CREATE_TX:-}" ]]; then
  CREATE_TX="$EXISTING_CREATE_TX"
  record_existing_tx create "$CREATE_TX"
else
  send_tx create "$FACTORY" \
    'createEscrow(address,address,uint256,uint64,uint64,bytes32,bytes32)(address)' \
    "$BUYER" "$TOKEN" "$AMOUNT" "$WORK_DURATION" "$REVIEW_WINDOW" "$TERMS_HASH" "$SALT" \
    --private-key "$SELLER_PK"
  CREATE_TX="$LAST_TX"
fi
if [[ -n "${EXISTING_APPROVE_TX:-}" ]]; then
  APPROVE_TX="$EXISTING_APPROVE_TX"
  record_existing_tx approve "$APPROVE_TX"
else
  send_tx approve "$TOKEN" 'approve(address,uint256)(bool)' "$ESCROW" "$AMOUNT" \
    --private-key "$BUYER_PK"
  APPROVE_TX="$LAST_TX"
fi
if [[ -n "${EXISTING_DEPOSIT_TX:-}" ]]; then
  DEPOSIT_TX="$EXISTING_DEPOSIT_TX"
  record_existing_tx depositFunds "$DEPOSIT_TX"
else
  send_tx depositFunds "$ESCROW" 'depositFunds()' --private-key "$BUYER_PK"
  DEPOSIT_TX="$LAST_TX"
fi
assert_eq 'escrow state after funding' "$(call_uint "$ESCROW" 'state()(uint8)')" '2'
send_tx submitDelivery "$ESCROW" 'submitDelivery(bytes32)' "$DELIVERY_HASH" \
  --private-key "$SELLER_PK"
SUBMIT_TX="$LAST_TX"
send_tx raiseDispute "$ESCROW" 'raiseDispute(bytes32)' "$EVIDENCE_HASH" \
  --private-key "$BUYER_PK"
RAISE_TX="$LAST_TX"

RAISED_AT="$(block_timestamp_for_tx "$RAISE_TX")"
COMMIT_START=$((RAISED_AT + EVIDENCE_WINDOW))
COMMIT_DEADLINE=$((COMMIT_START + COMMIT_WINDOW))
REVEAL_DEADLINE=$((COMMIT_DEADLINE + REVEAL_WINDOW))
wait_until 'commit window' "$COMMIT_START"

COMMITMENT_1="$(commitment "$ESCROW" "$ARBITER_1" 1 "$VOTE_SALT_1")"
COMMITMENT_2="$(commitment "$ESCROW" "$ARBITER_2" 1 "$VOTE_SALT_2")"
COMMITMENT_3="$(commitment "$ESCROW" "$ARBITER_3" 2 "$VOTE_SALT_3")"
send_tx 'commit arbiter 1 RELEASE' "$PANEL" 'commit(address,bytes32)' \
  "$ESCROW" "$COMMITMENT_1" --private-key "$ARBITER_1_PK"
COMMIT_1_TX="$LAST_TX"
send_tx 'commit arbiter 2 RELEASE' "$PANEL" 'commit(address,bytes32)' \
  "$ESCROW" "$COMMITMENT_2" --private-key "$ARBITER_2_PK"
COMMIT_2_TX="$LAST_TX"
send_tx 'commit arbiter 3 REFUND' "$PANEL" 'commit(address,bytes32)' \
  "$ESCROW" "$COMMITMENT_3" --private-key "$ARBITER_3_PK"
COMMIT_3_TX="$LAST_TX"

wait_until 'reveal window' "$COMMIT_DEADLINE"
send_tx 'reveal arbiter 1 RELEASE' "$PANEL" 'reveal(address,uint8,bytes32)' \
  "$ESCROW" 1 "$VOTE_SALT_1" --private-key "$ARBITER_1_PK"
REVEAL_1_TX="$LAST_TX"
send_tx 'reveal arbiter 2 RELEASE' "$PANEL" 'reveal(address,uint8,bytes32)' \
  "$ESCROW" 1 "$VOTE_SALT_2" --private-key "$ARBITER_2_PK"
REVEAL_2_TX="$LAST_TX"
send_tx 'reveal arbiter 3 REFUND' "$PANEL" 'reveal(address,uint8,bytes32)' \
  "$ESCROW" 2 "$VOTE_SALT_3" --private-key "$ARBITER_3_PK"
REVEAL_3_TX="$LAST_TX"

SELLER_BALANCE_BEFORE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$SELLER")"
TREASURY_BALANCE_BEFORE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$TREASURY")"
ARBITER_1_BALANCE_BEFORE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_1")"
ARBITER_2_BALANCE_BEFORE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_2")"
ARBITER_3_BALANCE_BEFORE="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_3")"
send_tx execute "$PANEL" 'execute(address)' "$ESCROW" --private-key "$SELLER_PK"
EXECUTE_TX="$LAST_TX"

STATE="$(call_uint "$ESCROW" 'state()(uint8)')"
RESOLUTION="$(call_uint "$ESCROW" 'resolution()(uint8)')"
assert_eq 'escrow state RESOLVED' "$STATE" '5'
assert_eq 'escrow resolution PANEL_RELEASE' "$RESOLUTION" '1'
assert_eq 'escrow token balance' "$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ESCROW")" '0'
assert_eq 'panel token balance' "$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$PANEL")" '0'
assert_eq 'arbiter 1 received no settlement tokens' \
  "$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_1")" "$ARBITER_1_BALANCE_BEFORE"
assert_eq 'arbiter 2 received no settlement tokens' \
  "$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_2")" "$ARBITER_2_BALANCE_BEFORE"
assert_eq 'arbiter 3 received no settlement tokens' \
  "$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$ARBITER_3")" "$ARBITER_3_BALANCE_BEFORE"

FEE=$((AMOUNT * FEE_BP / 10000))
SELLER_NET=$((AMOUNT - FEE))
EXECUTE_RECEIPT="$(cast receipt --rpc-url "$RPC_URL" "$EXECUTE_TX" --json)"
TRANSFER_TOPIC="$(cast keccak 'Transfer(address,address,uint256)')"
TOKEN_LOWER="$(tr '[:upper:]' '[:lower:]' <<<"$TOKEN")"
TRANSFER_TOPIC_LOWER="$(tr '[:upper:]' '[:lower:]' <<<"$TRANSFER_TOPIC")"
ESCROW_TOPIC="0x$(printf '%064s' "${ESCROW#0x}" | tr ' ' 0 | tr '[:upper:]' '[:lower:]')"
SELLER_TOPIC="0x$(printf '%064s' "${SELLER#0x}" | tr ' ' 0 | tr '[:upper:]' '[:lower:]')"
TREASURY_TOPIC="0x$(printf '%064s' "${TREASURY#0x}" | tr ' ' 0 | tr '[:upper:]' '[:lower:]')"
transfer_count() {
  local destination="$1" expected="$2" data count=0 value
  while read -r data; do
    [[ -z "$data" ]] && continue
    value="$(cast to-dec "$data")"
    if [[ "$value" == "$expected" ]]; then count=$((count + 1)); fi
  done < <(jq -r --arg token "$TOKEN_LOWER" --arg topic "$TRANSFER_TOPIC_LOWER" \
    --arg from "$ESCROW_TOPIC" --arg to "$destination" \
    '.logs[] | select((.address|ascii_downcase)==$token and (.topics[0]|ascii_downcase)==$topic and (.topics[1]|ascii_downcase)==$from and (.topics[2]|ascii_downcase)==$to) | .data' \
    <<<"$EXECUTE_RECEIPT")
  printf '%s' "$count"
}
assert_eq 'seller net Transfer event' "$(transfer_count "$SELLER_TOPIC" "$SELLER_NET")" '1'
assert_eq 'treasury fee Transfer event' "$(transfer_count "$TREASURY_TOPIC" "$FEE")" '1'
SELLER_BALANCE_AFTER="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$SELLER")"
TREASURY_BALANCE_AFTER="$(call_uint "$TOKEN" 'balanceOf(address)(uint256)' "$TREASURY")"

send_tx attest "$REPUTATION" 'attest(address)' "$ESCROW" --private-key "$SELLER_PK"
ATTEST_TX="$LAST_TX"
read -r SCORE_SETTLED SCORE_RELEASED SCORE_REFUNDED SCORE_DISPUTED SCORE_SPLITS < <(
  cast call --rpc-url "$RPC_URL" "$REPUTATION" \
    'scoreOf(address)(uint64,uint64,uint64,uint64,uint64)' "$SELLER" |
    awk '{print $1}' | paste -sd ' ' -
)
assert_eq 'score settled increment' "$SCORE_SETTLED" "$((SCORE_SETTLED_BEFORE + 1))"
assert_eq 'score released increment' "$SCORE_RELEASED" "$((SCORE_RELEASED_BEFORE + 1))"
assert_eq 'score refunded unchanged' "$SCORE_REFUNDED" "$SCORE_REFUNDED_BEFORE"
assert_eq 'score disputed increment' "$SCORE_DISPUTED" "$((SCORE_DISPUTED_BEFORE + 1))"
assert_eq 'score splits unchanged' "$SCORE_SPLITS" "$SCORE_SPLITS_BEFORE"

FIRST_COMMIT_AT="$(block_timestamp_for_tx "$COMMIT_1_TX")"
LAST_COMMIT_AT="$(block_timestamp_for_tx "$COMMIT_3_TX")"
FIRST_REVEAL_AT="$(block_timestamp_for_tx "$REVEAL_1_TX")"
LAST_REVEAL_AT="$(block_timestamp_for_tx "$REVEAL_3_TX")"
EXECUTED_AT="$(block_timestamp_for_tx "$EXECUTE_TX")"
{
  cat <<EOF

## Window timing evidence

| Window/action | Start (chain epoch) | Deadline/end (chain epoch) | Duration | Observed transaction time |
|---|---:|---:|---:|---:|
| Evidence | $RAISED_AT | $COMMIT_START | ${EVIDENCE_WINDOW}s | dispute raised $RAISED_AT |
| Commit | $COMMIT_START | $COMMIT_DEADLINE | ${COMMIT_WINDOW}s | first $FIRST_COMMIT_AT; last $LAST_COMMIT_AT |
| Reveal | $COMMIT_DEADLINE | $REVEAL_DEADLINE | ${REVEAL_WINDOW}s | first $FIRST_REVEAL_AT; last $LAST_REVEAL_AT |
| Execute after all reveals | $LAST_REVEAL_AT | n/a | immediate | $EXECUTED_AT |

## Verification

- Escrow state: $STATE (RESOLVED); resolution: $RESOLUTION (PANEL_RELEASE).
- Votes: 3 commits, 3 reveals; RELEASE 2, REFUND 1, SPLIT 0.
- Settlement: seller net $SELLER_NET base units; treasury fee $FEE base units, both proven by token Transfer logs in \`$EXECUTE_TX\`.
- Treasury equals seller: $TREASURY; balance snapshots around execute were seller $SELLER_BALANCE_BEFORE -> $SELLER_BALANCE_AFTER and treasury $TREASURY_BALANCE_BEFORE -> $TREASURY_BALANCE_AFTER (gas is paid in Arc native USDC, so Transfer logs are the exact split evidence).
- Escrow and panel each hold 0 token units after execution. The three arbiter wallets received 0 settlement tokens; their pre-funded Arc USDC gas balances were unchanged by execute.
- Reputation scoreOf(seller): settled=$SCORE_SETTLED, released=$SCORE_RELEASED, refunded=$SCORE_REFUNDED, disputed=$SCORE_DISPUTED, splits=$SCORE_SPLITS.
- Status: DONE
EOF
} >>"$REPORT"

printf 'STATUS: DONE\n'
printf 'ESCROW=%s STATE=%s RESOLUTION=%s\n' "$ESCROW" "$STATE" "$RESOLUTION"
printf 'VOTES=commits:3,reveals:3,release:2,refund:1,split:0\n'
printf 'FEE=%s EXECUTE_TX=%s\n' "$FEE" "$EXECUTE_TX"
printf 'SCORE=settled:%s,released:%s,refunded:%s,disputed:%s,splits:%s\n' \
  "$SCORE_SETTLED" "$SCORE_RELEASED" "$SCORE_REFUNDED" "$SCORE_DISPUTED" "$SCORE_SPLITS"
