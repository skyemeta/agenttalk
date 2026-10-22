#!/usr/bin/env bash
# SkyeSkiff: full session flow (prove control → declare → join → verify → re-verify)
#
# No API key, no signup and no free calls: every call is paid. From the first
# one, a call answers HTTP 402 with its price in the PAYMENT-REQUIRED header: any
# x402 client pays in USDC (Base, Polygon, Arbitrum or Solana) and sends it again. Teams can
# buy credits in advance instead (POST /api/skyeskiff/buy-key). Declare and every
# join are billed to the creator; re-verify costs 1 per agent, paid as the channel's
# reverifyPolicy says (the creator by default).
#
# Proof-of-control: on-chain holdings are public, so before declare, join and
# re-verify the acting agent fetches a one-time challenge for { wallet, action }
# and signs it with its wallet key (EIP-191). The challenge is good for one action
# and expires after 120 seconds.
#
# Wallets: by default this generates fresh, throwaway keypairs (cast wallet new).
# The signature is accepted, but a fresh wallet has no credits, so the first call
# answers 402 with its price and the demo stops there (this script does not pay
# over x402). To complete a full session, supply two different wallets you control
# that each hold at least 1 USDC on Ethereum, with credits on wallet A (it pays
# for the join too):
#
#     DEMO_PRIVATE_KEY_A=0xKEY_A DEMO_PRIVATE_KEY_B=0xKEY_B ./session.sh
#
# (DEMO_PRIVATE_KEY is accepted for Agent A.)
#
# Requires: curl, python3, and foundry's `cast` (https://getfoundry.sh) for
# keypair generation and EIP-191 message signing.

set -euo pipefail

BASE_URL="https://skyeskiff.skyemeta.com/api/skyeskiff"

# json_field <json-string> <key>: extract a top-level string/number field.
# Uses printf (not echo) so escaped \n in the JSON is not mangled by the shell.
json_field() {
  printf '%s' "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null || true
}

pretty() { printf '%s' "$1" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$1"; }

# post_json <path> <json-body>: POST, then set STATUS and BODY.
post_json() {
  local out
  out=$(curl -s -w $'\n%{http_code}' -X POST "$BASE_URL$1" \
    -H "Content-Type: application/json" -d "$2")
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# explain_refusal <label>: explain a response that did not admit the agent.
#   401            signature missing, stale or not from this wallet: sign a fresh challenge
#   402            no credits: pay with x402 (PAYMENT-REQUIRED header)
#                or buy credits (buy-key)
#   400            the conditions or wallet fields were rejected as invalid (see error)
#   403 pass:false a condition is not met: the verification service signed "not met"
#   503            no verdict could be obtained: retry later; not cleared, do not act on it
#   A 400, 503 or 429 costs nothing; only a signed answer uses a call.
explain_refusal() {
  echo ""
  case "$STATUS" in
    403)
      if [ "$(json_field "$BODY" pass)" = "False" ]; then
        echo "Not admitted ($1): a condition is not met."
      else
        echo "$1 refused (HTTP 403): $(json_field "$BODY" error)"
      fi ;;
    400) echo "Conditions rejected ($1): $(json_field "$BODY" error). Nothing was charged." ;;
    502|503) echo "Verification unavailable ($1). Nothing was charged; retry in a few seconds." ;;
    401) echo "Proof-of-control rejected ($1): $(json_field "$BODY" error). Sign a fresh challenge." ;;
    402) echo "Payment needed ($1): pay this call with any x402 client (price in the PAYMENT-REQUIRED header), or buy credits via /buy-key. (Expected for a fresh throwaway wallet.)" ;;
    *)   echo "$1 failed with HTTP $STATUS: check the response above." ;;
  esac
}

# make_key <ENV_VAR_NAME> [FALLBACK_ENV_VAR]: echo a private key from env, else a
# fresh throwaway one.
make_key() {
  local envval="${!1:-}"
  if [ -z "$envval" ] && [ -n "${2:-}" ]; then envval="${!2:-}"; fi
  if [ -n "$envval" ]; then
    echo "$envval"
  else
    cast wallet new | awk '/Private key:/{print $3}'
  fi
}

# prove_control <address> <private_key> <action>: echo "<signature> <nonce>" for the
# one-time challenge for this wallet + action. Send both back: with the nonce, nobody
# else's challenge requests can cancel yours.
prove_control() {
  local addr="$1" pk="$2" action="$3" resp msg nonce
  resp=$(curl -s -X POST "$BASE_URL/challenge" \
    -H "Content-Type: application/json" \
    -d "{\"wallet\": \"$addr\", \"action\": \"$action\"}")
  msg=$(json_field "$resp" message)
  nonce=$(json_field "$resp" nonce)
  echo "$(cast wallet sign --private-key "$pk" "$msg") $nonce"
}

PK_A=$(make_key DEMO_PRIVATE_KEY_A DEMO_PRIVATE_KEY)
PK_B=$(make_key DEMO_PRIVATE_KEY_B)
ADDR_A=$(cast wallet address --private-key "$PK_A")
ADDR_B=$(cast wallet address --private-key "$PK_B")

echo "Agent A: $ADDR_A"
echo "Agent B: $ADDR_B"

echo ""
echo "=== Step 1: Agent A proves control + declares conditions ==="
read -r SIG_A NONCE_A <<< "$(prove_control "$ADDR_A" "$PK_A" "declare")"
post_json /declare "{
    \"wallet\": \"$ADDR_A\",
    \"signature\": \"$SIG_A\",
    \"nonce\": \"$NONCE_A\",
    \"conditions\": [
      {
        \"type\": \"token_balance\",
        \"contractAddress\": \"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",
        \"chainId\": 1,
        \"threshold\": \"1\"
      }
    ]
  }"

echo "HTTP $STATUS"
pretty "$BODY"
CHANNEL_ID=$(json_field "$BODY" channelId)

if [ "$STATUS" != "200" ] || [ -z "$CHANNEL_ID" ]; then
  explain_refusal declare
  exit 0
fi

echo ""
echo "=== Step 2: Agent B proves control + joins the channel ==="
read -r SIG_B NONCE_B <<< "$(prove_control "$ADDR_B" "$PK_B" "join")"
post_json /join "{
    \"channelId\": \"$CHANNEL_ID\",
    \"wallet\": \"$ADDR_B\",
    \"signature\": \"$SIG_B\",
    \"nonce\": \"$NONCE_B\"
  }"

echo "HTTP $STATUS"
pretty "$BODY"
SESSION_ID=$(json_field "$BODY" sessionId)

if [ "$STATUS" != "200" ] || [ -z "$SESSION_ID" ]; then
  explain_refusal join
  exit 0
fi

echo ""
echo "=== Step 3: Verify session ==="
pretty "$(curl -s "$BASE_URL/session?id=$SESSION_ID")"

echo ""
echo "=== Step 4: Agent A (a session member) proves control + re-verifies ==="
# Re-attests every agent against current on-chain state; 1 per agent, paid as the
# channel's reverifyPolicy says (the creator by default).
read -r SIG_R NONCE_R <<< "$(prove_control "$ADDR_A" "$PK_A" "reverify")"
post_json /session "{
    \"action\": \"reverify\",
    \"sessionId\": \"$SESSION_ID\",
    \"wallet\": \"$ADDR_A\",
    \"signature\": \"$SIG_R\",
    \"nonce\": \"$NONCE_R\"
  }"

echo "HTTP $STATUS"
pretty "$BODY"
if [ "$STATUS" != "200" ]; then
  explain_refusal re-verify
fi
