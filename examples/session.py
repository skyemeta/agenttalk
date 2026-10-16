"""
AgentTalk: full session flow (prove control -> declare -> join -> verify -> re-verify)

No API key and no signup. The channel creator's wallet gets 10 free calls. After
that, a call answers HTTP 402 with its price in the PAYMENT-REQUIRED header: any
x402 client pays in USDC (Base, Polygon or Arbitrum) and sends it again. Teams can
buy credits in advance instead (POST /api/agenttalk/buy-key). Declare and every
join are billed to the creator; re-verify costs 1 per agent, paid as the channel's
reverifyPolicy says (the creator by default).

Proof-of-control: on-chain holdings are public, so before declare, join and
re-verify the acting agent fetches a one-time challenge for { wallet, action }
and signs it with its wallet key (EIP-191). The challenge is good for one action
and expires after 120 seconds.

Wallets: by default this generates fresh, throwaway keypairs. The signature is
accepted, but a fresh wallet holds nothing, so the demo stops at the condition
gate. To complete a full session, supply two different wallets you control that
each hold at least 1 USDC on Ethereum:

    DEMO_PRIVATE_KEY_A=0xKEY_A DEMO_PRIVATE_KEY_B=0xKEY_B python session.py

(DEMO_PRIVATE_KEY is accepted for Agent A.) Keys are read only at runtime and
never leave your machine.

Install: pip install requests eth-account
Run:     python session.py
"""

from __future__ import annotations

import json
import os

import requests
from eth_account import Account
from eth_account.messages import encode_defunct

BASE_URL = "https://agenttalk.skyemeta.com/api/agenttalk"


def make_account(*env_names: str):
    """A wallet from the first env-supplied private key, or a fresh throwaway one."""
    pk = next((os.environ[n] for n in env_names if os.environ.get(n)), None)
    return Account.from_key(pk) if pk else Account.create()


def prove_control(account, action: str) -> tuple:
    """Fetch a one-time challenge, sign the message (EIP-191), return (0x signature, nonce).

    Send both back: with the nonce, nobody else's challenge requests can cancel yours.
    """
    resp = requests.post(
        f"{BASE_URL}/challenge",
        json={"wallet": account.address, "action": action},
        headers={"Content-Type": "application/json"},
    )
    resp.raise_for_status()
    challenge = resp.json()
    message = challenge["message"]
    signed = Account.sign_message(encode_defunct(text=message), account.key)
    sig = signed.signature.hex()
    sig = sig if sig.startswith("0x") else "0x" + sig  # eth-account may omit 0x
    return sig, challenge["nonce"]


def declare_channel(account, conditions: list) -> requests.Response:
    """Agent A proves control, then declares conditions for a channel."""
    signature, nonce = prove_control(account, "declare")
    body = {"wallet": account.address, "signature": signature, "nonce": nonce, "conditions": conditions}
    return requests.post(f"{BASE_URL}/declare", json=body, headers={"Content-Type": "application/json"})


def join_channel(channel_id: str, account) -> requests.Response:
    """Agent B proves control, then joins. Billed to the channel creator."""
    signature, nonce = prove_control(account, "join")
    return requests.post(
        f"{BASE_URL}/join",
        json={"channelId": channel_id, "wallet": account.address, "signature": signature, "nonce": nonce},
        headers={"Content-Type": "application/json"},
    )


def verify_session(session_id: str) -> dict:
    """Check if a session is still valid."""
    resp = requests.get(f"{BASE_URL}/session", params={"id": session_id})
    resp.raise_for_status()
    return resp.json()


def reverify_session(session_id: str, member) -> requests.Response:
    """Re-attest every agent against current on-chain state. Must be requested by a
    session member, signing a 'reverify' challenge; 1 per agent, paid as the channel's
    reverifyPolicy says (the creator by default)."""
    signature, nonce = prove_control(member, "reverify")
    return requests.post(
        f"{BASE_URL}/session",
        json={"action": "reverify", "sessionId": session_id,
              "wallet": member.address, "signature": signature, "nonce": nonce},
        headers={"Content-Type": "application/json"},
    )


def body_of(resp: requests.Response) -> dict:
    try:
        return resp.json()
    except ValueError:
        return {}


def explain_refusal(label: str, resp: requests.Response) -> None:
    """Explain a response that did not admit the agent.

    401          the signature was missing, stale or not from this wallet: request a
                 fresh challenge and sign again
    402          no free calls or credits left: pay with x402 (PAYMENT-REQUIRED header)
                 or buy credits (buy-key)
    400          the conditions or wallet fields were rejected as invalid (see error)
    403 pass:false  a condition is not met: the verification service signed "not met"
    503          no verdict could be obtained: retry later; not cleared, do not act on it
    A 400, 503 or 429 costs nothing; only a signed answer uses a call.
    """
    status, data = resp.status_code, body_of(resp)
    if status == 403 and data.get("pass") is False:
        print(f"\nNot admitted ({label}): a condition is not met (expected for a fresh throwaway wallet).")
    elif status == 400:
        print(f"\nConditions rejected ({label}): {data.get('error')}. Nothing was charged.")
    elif status in (502, 503):
        print(f"\nVerification unavailable ({label}). Nothing was charged; retry in a few seconds.")
    elif status == 401:
        print(f"\nProof-of-control rejected ({label}): {data.get('error')}. "
              "Request a new challenge and sign again.")
    elif status == 402:
        print(f"\nPayment needed ({label}): pay this call with any x402 client (price in the PAYMENT-REQUIRED header), or buy credits via /buy-key.")
    else:
        print(f"\n{label} failed with HTTP {status}: {data.get('error') or resp.text}")


if __name__ == "__main__":
    agent_a = make_account("DEMO_PRIVATE_KEY_A", "DEMO_PRIVATE_KEY")
    agent_b = make_account("DEMO_PRIVATE_KEY_B")

    # Condition: wallet holds >= 1 USDC on Ethereum
    conditions = [
        {
            "type": "token_balance",
            "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "chainId": 1,
            "threshold": "1",
        }
    ]

    print(f"Agent A: {agent_a.address}")
    print(f"Agent B: {agent_b.address}")

    print("\n=== Step 1: Prove control + declare channel ===")
    declare_resp = declare_channel(agent_a, conditions)
    print(f"HTTP {declare_resp.status_code}: {declare_resp.text}")
    channel = body_of(declare_resp) if declare_resp.ok else {}
    if not channel.get("channelId"):
        explain_refusal("declare", declare_resp)
        raise SystemExit(0)

    print("\n=== Step 2: Prove control + join channel ===")
    join_resp = join_channel(channel["channelId"], agent_b)
    print(f"HTTP {join_resp.status_code}: {join_resp.text}")
    session = body_of(join_resp) if join_resp.ok else {}
    if not session.get("sessionId"):
        explain_refusal("join", join_resp)
        raise SystemExit(0)

    print("\n=== Step 3: Verify session ===")
    print(json.dumps(verify_session(session["sessionId"]), indent=2))

    print("\n=== Step 4: Re-verify (checks current on-chain state) ===")
    reverify_resp = reverify_session(session["sessionId"], agent_a)
    print(f"HTTP {reverify_resp.status_code}: {json.dumps(body_of(reverify_resp), indent=2)}")
    if reverify_resp.status_code != 200:
        explain_refusal("re-verify", reverify_resp)
    elif body_of(reverify_resp).get("ejected"):
        print("Removed on re-verify: " + ", ".join(body_of(reverify_resp)["ejected"]))
