# AgentTalk

**Wallet auth for agent-to-agent communication.**

OAuth proves who you are. API keys prove you have permission. AgentTalk proves what you hold: on-chain, across 34 blockchains, cryptographically signed, verifiable by anyone.

Before two agents exchange data, both verify their wallets satisfy the same conditions. Token balances, NFT ownership, compliance attestations — whatever the use case requires. The blockchain state is the credential. Sell your tokens, lose your session. No secrets to share. No identity to verify first. No static credentials that expire or get leaked.

A signed challenge and a call per agent to a mutual session. [Try it free](https://skyemeta.com/agenttalk/) — 10 calls per wallet, no signup.

## Why Not OAuth?

Agent protocols today authenticate agents the same way we authenticate humans: API keys, OAuth tokens, mTLS certificates. These prove *identity* — "this agent has permission to be here."

But for agent commerce, DeFi coordination, and governance workflows, the question isn't who you are. It's **what you hold**. A procurement agent negotiating a $1M deal should prove it represents a wallet with $1M — not just that it has a valid OAuth token.

AgentTalk is [condition-based access](https://insumermodel.com/how-it-works/) for the agent layer. You define conditions. Both agents are evaluated against live blockchain state. The result is an ECDSA-signed boolean — pass or fail — not a balance dump. The signed attestation is verifiable offline via [JWKS](https://insumermodel.com/.well-known/jwks.json). No callback to us required.

| | AgentTalk | OAuth 2.0 | API Keys | mTLS |
|---|---|---|---|---|
| Proves what agent holds | Yes | No | No | No |
| Dynamic (sell token = lose access) | Yes | No | No | No |
| Multi-chain (34 blockchains) | Yes | No | No | No |
| Mutual verification (both sides) | Yes | No | No | Yes |
| Composable (up to 10 conditions) | Yes | No | No | No |
| No shared secrets | Yes | No | No | Yes |

## How It Works

Read the chain. Evaluate the conditions. Sign the result.

```
Agent A                          AgentTalk                         Agent B
   |-- POST /challenge (declare) -->|                                |
   |<-- message to sign ------------|                                |
   |-- POST /declare (sig, conds) ->|                                |
   |<-- channelId, conditionsHash --|                                |
   |                                |<-- POST /challenge (join) -----|
   |                                |--- message to sign ----------->|
   |                                |<-- POST /join (sig, channelId)-|
   |                                |--- sessionId, attestations --->|
   |-- GET /session?id=ses_... ---->|                                |
   |<-- { valid: true, agents } ----|                                |
```

0. **Prove control** — Before declaring or joining, an agent signs a one-time challenge with its wallet key. On-chain holdings are public, so naming a wallet proves nothing; the signature proves the wallet is the agent's. Control — not knowledge of the address — grants entry.
1. **Declare**: Agent A signs its challenge, then sets conditions across any of 34 chains. Its wallet is attested immediately.
2. **Join** — Agent B signs its own challenge, then joins. Both wallets are evaluated against the same conditions.
3. **Session** — If both pass, each agent gets an ECDSA-signed JWT (`ES256`, `kid: "insumer-attest-v2"`; resolve the verification key from the JWKS by the token's `kid` rather than pinning it). Both can verify at any time.
4. **Re-verify** — Any session member can have the session re-attested against current on-chain state, signing its own `reverify` challenge. Only an agent with a signed "not met" is ejected; if a re-attestation cannot be completed, nobody is ejected and the session is left as it was. Dynamic enforcement, not a one-time check.

## Quick Start

For a runnable end-to-end script (keypair generation + signing handled for you),
see [`examples/`](examples/) — `session.js`, `session.py`, or `session.sh`.

```bash
# 1. Prove control of Agent A's wallet
curl -X POST https://skyemeta.com/api/agenttalk/challenge \
  -H "Content-Type: application/json" \
  -d '{ "wallet": "0xAgentA...", "action": "declare" }'
# Returns: { "message": "AgentTalk proof-of-control\n...", "nonce": "...", "expiresInSec": 120 }
# Sign `message` with Agent A's wallet key (EIP-191) and send the signature AND the nonce back.
# Each challenge is its own one-time key, so nobody else's requests can cancel yours. e.g. with foundry:
#   cast wallet sign --private-key $PK "$message"

# 2. Declare conditions, passing the signature (free tier — no API key needed)
curl -X POST https://skyemeta.com/api/agenttalk/declare \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xAgentA...",
    "signature": "0x...",
    "nonce": "...",
    "reverifyPolicy": "members",
    "conditions": [
      {
        "type": "token_balance",
        "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "chainId": 1,
        "threshold": "1000",
        "label": "USDC >= 1000"
      }
    ]
  }'
# Returns: { "channelId": "ch_...", "conditionsHash": "0x...", "expiresAt": "..." }

# 3. Join — Agent B proves control of its own wallet first (challenge with action "join"),
#    then joins (no API key — creator pays both sides)
curl -X POST https://skyemeta.com/api/agenttalk/join \
  -H "Content-Type: application/json" \
  -d '{ "channelId": "ch_...", "wallet": "0xAgentB...", "signature": "0x...", "nonce": "..." }'
# Returns: { "sessionId": "ses_...", "agents": [{ wallet, attestation }, ...] }

# 4. Verify
curl "https://skyemeta.com/api/agenttalk/session?id=ses_..."
# Returns: { "valid": true, "agents": [...], "conditions": [...] }

# 5. Re-verify — a session member signs a challenge with action "reverify", then:
curl -X POST https://skyemeta.com/api/agenttalk/session \
  -H "Content-Type: application/json" \
  -d '{ "action": "reverify", "sessionId": "ses_...", "wallet": "0xAgentA...", "signature": "0x...", "nonce": "..." }'
# Returns: { "valid": true, "agents": [...fresh attestations], "ejected": [...] }
```

A `403 { "pass": false }` from declare or join means a condition is not met: the verification
service signed a "not met". A `400` means the conditions or wallet fields were rejected as invalid;
the error says why. A `503 { "ok": false, "error": { "code": "upstream_unavailable" } }` means no
verdict could be obtained: retry later. A `400`, `503` or `429` costs nothing; only a signed answer
uses a call. A `401` means the signature was missing, stale or not from that wallet: request a
fresh challenge. A `402` means the payer is out of free calls and credits: the channel creator, or, for a
re-verify on a `reverifyPolicy: requester` channel, the member who asked.

Re-verify is all or nothing. Every agent is re-attested first, and only an agent with a signed
"not met" is ejected. If any re-attestation comes back without a verdict, the call returns `503`
(or `400` for invalid conditions), the session is left exactly as it was, nobody is ejected, and
nobody is charged.

Who may re-verify, and who pays, is the channel creator's choice, made once when declaring
(`reverifyPolicy`, returned on declare, join and session reads):

| `reverifyPolicy` | Who may re-verify | Who pays (1 credit per agent) |
|---|---|---|
| `members` (default) | any member | the creator; at most one re-verify per session per 60 seconds (`429` inside the window) |
| `creator` | only the creator (others get `403`) | the creator |
| `requester` | any member | the member who asks |

See [`examples/`](examples/) for complete scripts in bash, Python, and JavaScript.

## Use Cases

- **Supply Chain Negotiation** — Two procurement agents verify they each hold $1M+ USDC before sharing pricing data. On-chain proof of financial capacity, not a signed NDA.
- **Financial Agent Coordination** — A portfolio agent only shares allocation data with agents holding specific governance tokens. Attestation replaces allow-lists.
- **Compliance-Gated Data Exchange** — Agents verify each other holds an on-chain compliance attestation (an EAS attestation such as Coinbase Verified Account). Revoke the attestation, and the next re-verify ejects the agent.
- **Cross-Org Workflow Automation** — DAO-to-DAO agents verify governance token holdings before executing joint proposals. On-chain qualification replaces manual approval chains.

## Condition Types

Conditions are evaluated by [InsumerAPI](https://insumermodel.com/developers/api-reference/) against live blockchain state.

**`token_balance`** — Does the wallet hold at least X tokens?
```json
{ "type": "token_balance", "contractAddress": "0xA0b86991...", "chainId": 1, "threshold": "1000" }
```
`threshold` is in token (display) units, as a decimal string: `"1000"` means 1000 USDC, and a $1M floor is `"1000000"`. Leave `decimals` out: the token's own decimals are always read from the chain. If sent it is only a cross-check, and a value that differs from the token's own decimals is rejected.

Use `"native"` as the `contractAddress` for ETH, BNB, POL, SOL, XRP, BTC, etc. (`token_balance` only; `nft_ownership` needs the NFT contract address).

**`nft_ownership`** — Does the wallet hold this NFT?
```json
{ "type": "nft_ownership", "contractAddress": "0xBC4CA0Ed...", "chainId": 1 }
```

**`eas_attestation`** — Does the wallet have a valid on-chain attestation?
```json
{ "type": "eas_attestation", "template": "gitcoin_passport_score" }
```

Up to 10 conditions per channel. All must pass (AND logic). 34 blockchains: 31 EVM chains (Ethereum, Polygon, Base, Arbitrum, Optimism, Avalanche, BNB Chain and 24 more) plus Solana, Sui and Tron.

A condition on Solana, Sui or Tron takes the matching wallet field (`solanaWallet`, `suiWallet`, `tronWallet`) on declare and join. Prove ownership of that wallet first: sign a challenge from `https://skyemeta.com/api/wallet-proof` (family `solana`, `sui` or `tron`; domain `agenttalk`) and pass the token in `walletProofs`. XRP Ledger, Bitcoin and Stellar wallets cannot prove ownership and are not accepted.

## Verification

Every attestation is an ES256 JWT. Read the token's `kid` and resolve the matching key from the JWKS (AgentTalk sessions sign under `insumer-attest-v2`, like every key minted today; never pin the literal, kids rotate). Verify offline — no network call needed after the initial attestation:

```
GET https://insumermodel.com/.well-known/jwks.json
```

Each attestation also carries a post-quantum companion (`pqSig`, `pqKid`, and `pqJwt` beside `jwt`; ML-DSA-65), resolved from the same JWKS. The ES256 signature is unchanged.

Works with any standard JWT library: jose, jsonwebtoken, Kong, Nginx, AWS API Gateway. Each condition produces a `conditionHash` (SHA-256 of canonical JSON), so verifiers can confirm exactly which conditions were checked without seeing raw balances.

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/agenttalk/challenge` | POST | None | One-time message to sign for `{ wallet, action }` (declare, join, reverify, kick, leave); valid 120 s |
| `/api/agenttalk/declare` | POST | Signed challenge; 10 free calls per wallet, then credits | Create a condition-gated channel |
| `/api/agenttalk/join` | POST | Signed challenge (creator pays) | Join a channel, create mutual session |
| `/api/agenttalk/session` | GET | None | Check session validity |
| `/api/agenttalk/session` | POST | Signed challenge from a session member (1 credit per agent, paid per the channel's `reverifyPolicy`) | Re-verify every agent against current state; also `kick` (signed by the creator) and `leave` |
| `/api/agenttalk/buy-key` | POST | The payment transaction | Add credits to the wallet that paid; no key is issued |

Full request/response details: [skyemeta.com/agenttalk](https://skyemeta.com/agenttalk/)

## Discovery

```
GET https://skyemeta.com/.well-known/agents.json
```

## Pricing

| Tier | Rate | Spend |
|------|------|-------|
| Starter | 25 credits/$1 | $5–$99 |
| Growth | 33 credits/$1 | $100–$499 |
| Scale | 50 credits/$1 | $500+ |

Each session = 2 credits (one per agent). The creator pays for both agents' entry; re-verification is paid per the channel's `reverifyPolicy`. **Free tier: 10 calls per wallet, no key needed.**

Pay with USDC or USDT on Ethereum, Polygon, Arbitrum, Optimism, Avalanche, BNB Chain or Solana, USDC on Base, or BTC; the minimum is $5. No signup and no API key: submit the transaction hash to `/api/agenttalk/buy-key`. Credits are spent by the EVM wallet that creates channels. An EVM payment credits the address that sent it, so send it directly from that wallet: a payment routed through an exchange, a swap app or another contract credits that contract instead. Paying from Solana or Bitcoin, name that 0x wallet inside the payment: a memo on the Solana transfer, or an `OP_RETURN` output on the Bitcoin transaction (the address as text, or its 20 raw bytes). Only the payer can put it there, so nobody can redirect the purchase. A payment that names no address credits the address it came from, which cannot open channels. The response says which it did: `creditedBy` is `memo` or `sender`. See [skyemeta.com/agenttalk](https://skyemeta.com/agenttalk/) for details.

## Protocols

AgentTalk implements wallet auth as the qualification layer for agent communication protocols:

- **A2A** — Wallet qualification for agent discovery and Agent Cards
- **MCP** — Condition-based tool gating via MCP parameters
- **ACP** — Wallet attestation as the agent handshake layer
- **x402** — Proof-of-holdings alongside proof-of-payment

## Related

- [InsumerAPI](https://insumermodel.com/developers/) — The wallet auth engine. Read the chain, evaluate conditions, sign the result.
- [insumer-verify](https://www.npmjs.com/package/insumer-verify) — Offline JWT verification. Zero dependencies.
- [SkyeGate](https://skyemeta.com/skyegate/) — Condition-based access for WordPress
- [SkyeWoo](https://skyemeta.com/skyewoo/) — Condition-based access for WooCommerce

## License

MIT
