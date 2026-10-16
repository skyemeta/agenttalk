# AgentTalk

**Wallet auth for agent-to-agent communication.**

OAuth proves who you are. API keys prove you have permission. AgentTalk proves what you hold: on-chain, across 34 blockchains, cryptographically signed, verifiable by anyone.

Before two agents exchange data, both verify their wallets satisfy the same conditions. Token balances, NFT ownership, compliance attestations, whatever the use case requires. The blockchain state is the credential. Sell your tokens, lose your session. No secrets to share. No identity to verify first. No static credentials that expire or get leaked.

A signed challenge and a call per agent to a mutual session. [Try it free](https://skyemeta.com/agenttalk/): 10 calls per wallet, no signup.

## Why Not OAuth?

Agent protocols today authenticate agents the same way we authenticate humans: API keys, OAuth tokens, mTLS certificates. These prove *identity*: "this agent has permission to be here."

But for agent commerce, DeFi coordination, and governance workflows, the question isn't who you are. It's **what you hold**. A procurement agent negotiating a $1M deal should prove it represents a wallet with $1M, not just that it has a valid OAuth token.

AgentTalk is [condition-based access](https://insumermodel.com/how-it-works/) for the agent layer. You define conditions. Both agents are evaluated against live blockchain state. The result is an ECDSA-signed boolean: pass or fail, not a balance dump. The signed attestation is verifiable offline via [JWKS](https://insumermodel.com/.well-known/jwks.json). No callback to us required.

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

0. **Prove control**: Before declaring or joining, an agent signs a one-time challenge with its wallet key. On-chain holdings are public, so naming a wallet proves nothing; the signature proves the wallet is the agent's. Control, not knowledge of the address, grants entry.
1. **Declare**: Agent A signs its challenge, then sets conditions across any of 34 chains. Its wallet is attested immediately.
2. **Join**: Agent B signs its own challenge, then joins. Both wallets are evaluated against the same conditions.
3. **Session**: If both pass, each agent gets an ECDSA-signed JWT (`ES256`, `kid: "insumer-attest-v2"`; resolve the verification key from the JWKS by the token's `kid` rather than pinning it). Both can verify at any time.
4. **Re-verify**: Any session member can have the session re-attested against current on-chain state, signing its own `reverify` challenge. Only an agent with a signed "not met" is ejected; if a re-attestation cannot be completed, nobody is ejected and the session is left as it was. Dynamic enforcement, not a one-time check.

## Quick Start

For a runnable end-to-end script (keypair generation + signing handled for you),
see [`examples/`](examples/): `session.js`, `session.py`, or `session.sh`.

```bash
# 1. Prove control of Agent A's wallet
curl -X POST https://agenttalk.skyemeta.com/api/agenttalk/challenge \
  -H "Content-Type: application/json" \
  -d '{ "wallet": "0xAgentA...", "action": "declare" }'
# Returns: { "message": "AgentTalk proof-of-control\n...", "nonce": "...", "expiresInSec": 120 }
# Sign `message` with Agent A's wallet key (EIP-191) and send the signature AND the nonce back.
# A plain key account is recovered locally; a smart-contract wallet (ERC-1271, or ERC-6492
# before it is deployed) is checked on Base.
# Each challenge is its own one-time key, so nobody else's requests can cancel yours. e.g. with foundry:
#   cast wallet sign --private-key $PK "$message"

# 2. Declare conditions, passing the signature (no API key needed; the call is paid by x402 or credits)
curl -X POST https://agenttalk.skyemeta.com/api/agenttalk/declare \
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

# 3. Join: Agent B proves control of its own wallet first (challenge with action "join"),
#    then joins (no API key; creator pays both sides)
curl -X POST https://agenttalk.skyemeta.com/api/agenttalk/join \
  -H "Content-Type: application/json" \
  -d '{ "channelId": "ch_...", "wallet": "0xAgentB...", "signature": "0x...", "nonce": "..." }'
# Returns: { "sessionId": "ses_...", "agents": [{ wallet, attestation }, ...] }

# 4. Verify
curl "https://agenttalk.skyemeta.com/api/agenttalk/session?id=ses_..."
# Returns: { "valid": true, "agents": [...], "conditions": [...] }

# 5. Re-verify: a session member signs a challenge with action "reverify", then:
curl -X POST https://agenttalk.skyemeta.com/api/agenttalk/session \
  -H "Content-Type: application/json" \
  -d '{ "action": "reverify", "sessionId": "ses_...", "wallet": "0xAgentA...", "signature": "0x...", "nonce": "..." }'
# Returns: { "valid": true, "agents": [...fresh attestations], "ejected": [...] }
```

A `403 { "pass": false }` from declare or join means a condition is not met: the verification
service signed a "not met". A `400` means the conditions or wallet fields were rejected as invalid;
the error says why. A `503 { "ok": false, "error": { "code": "upstream_unavailable" } }` means no
verdict could be obtained: retry later, and treat the agent as not cleared until a signed answer
comes back. A `400`, `503` or `429` costs nothing; only a signed answer
uses a call. A `401` means the signature was missing, stale or not from that wallet: request a
fresh challenge. A `402` means the payer has no credits: the channel creator, or, for a
re-verify on a `reverifyPolicy: requester` channel, the member who asked.

Re-verify is all or nothing. Every agent is re-attested first, and only an agent with a signed
"not met" is ejected. If any re-attestation comes back without a verdict, the call returns `503`
(or `400` for invalid conditions), the session is left exactly as it was, nobody is ejected, and
nobody is charged. No verdict clears nobody: do not take the sensitive action on it.

AgentTalk is the guest list and the door, not the room. It decides who qualifies, records it and
signs the result; it does not carry messages or stop a tool on its own. Your agents talk over
whatever channel they already use, and your app reads the session (`GET /api/agenttalk/session?id=`)
or re-verifies before an action that matters, and goes ahead only for an agent still on the list.

Who may re-verify, and who pays, is the channel creator's choice, made once when declaring
(`reverifyPolicy`, returned on declare, join and session reads):

| `reverifyPolicy` | Who may re-verify | Who pays (1 credit per agent) |
|---|---|---|
| `members` (default) | any member | the creator; at most one re-verify per session per 60 seconds (`429` inside the window) |
| `creator` | only the creator (others get `403`) | the creator |
| `requester` | any member | the member who asks |

See [`examples/`](examples/) for complete scripts in bash, Python, and JavaScript.

## Use Cases

- **Supply Chain Negotiation**: Two procurement agents verify they each hold $1M+ USDC before sharing pricing data. On-chain proof of financial capacity, not a signed NDA.
- **Financial Agent Coordination**: A portfolio agent only shares allocation data with agents holding specific governance tokens. Attestation replaces allow-lists.
- **Compliance-Gated Data Exchange**: Agents verify each other holds an on-chain compliance attestation (an EAS attestation such as Coinbase Verified Account). Revoke the attestation, and the next re-verify ejects the agent.
- **Cross-Org Workflow Automation**: DAO-to-DAO agents verify governance token holdings before executing joint proposals. On-chain qualification replaces manual approval chains.

## Condition Types

Conditions are evaluated by [InsumerAPI](https://insumermodel.com/developers/api-reference/) against live blockchain state.

**`token_balance`**: Does the wallet hold at least X tokens?
```json
{ "type": "token_balance", "contractAddress": "0xA0b86991...", "chainId": 1, "threshold": "1000" }
```
`threshold` is in token (display) units, as a decimal string: `"1000"` means 1000 USDC, and a $1M floor is `"1000000"`. Leave `decimals` out: the token's own decimals are always read from the chain. If sent it is only a cross-check, and a value that differs from the token's own decimals is rejected.

Use `"native"` as the `contractAddress` for ETH, BNB, POL, SOL, etc. (`token_balance` only; `nft_ownership` needs the NFT contract address).

**`nft_ownership`**: Does the wallet hold this NFT?
```json
{ "type": "nft_ownership", "contractAddress": "0xBC4CA0Ed...", "chainId": 1 }
```

**`eas_attestation`**: Does the wallet have a valid on-chain attestation?
```json
{ "type": "eas_attestation", "template": "gitcoin_passport_score" }
```

Up to 10 conditions per channel. All must pass (AND logic). 34 blockchains: 31 EVM chains (Ethereum, Polygon, Base, Arbitrum, Optimism, Avalanche, BNB Chain and 24 more) plus Solana, Sui and Tron.

A condition on Solana, Sui or Tron takes the matching wallet field (`solanaWallet`, `suiWallet`, `tronWallet`) on declare and join. Prove ownership of that wallet first: sign a challenge from `https://agenttalk.skyemeta.com/api/wallet-proof` (family `solana`, `sui` or `tron`; domain `agenttalk`) and pass the token in `walletProofs`. XRP Ledger, Bitcoin and Stellar wallets cannot prove ownership and are not accepted.

## Who Each Agent Acts For

A room can ask more than "what do you hold". Add `agentStanding` when you declare:

```json
"agentStanding": { "delegatedBy": ["0xYourAcceptedPrincipal"], "registeredAgent": false }
```

Every agent, the creator included, then shows its own proof on declare or join: a signed ERC-7710 delegation (`delegation`, MetaMask Delegation Framework on Base) from one of the listed principals, and/or its ERC-8004 `agentId` when `registeredAgent` is true. The proof is checked with the room's conditions and again on every re-verify, so an agent whose delegation is revoked is removed. Other agents see only the signed result, never the delegation itself; send `shareLimits: false` to keep its limits private too. Full details: [llms-full.txt, section 3a](https://agenttalk.skyemeta.com/llms-full.txt).

## Verification

Every attestation is an ES256 JWT. Read the token's `kid` and resolve the matching key from the JWKS (AgentTalk sessions sign under `insumer-attest-v2`, like every key minted today; never pin the literal, kids rotate). Verify offline, with no network call needed after the initial attestation:

```
GET https://insumermodel.com/.well-known/jwks.json
```

Each attestation is signed twice: ES256 and a post-quantum ML-DSA-65 signature (`pqSig`, `pqKid`, and `pqJwt` beside `jwt`), resolved from the same JWKS.

Works with any standard JWT library: jose, jsonwebtoken, Kong, Nginx, AWS API Gateway. Each condition produces a `conditionHash` (SHA-256 of canonical JSON), so verifiers can confirm exactly which conditions were checked without seeing raw balances.

**Keep your receipts.** AgentTalk does not keep rooms after they expire. Each agent's signed attestation is the lasting record of who qualified, against which conditions, at which block; save the ones you may need later.

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/agenttalk/challenge` | POST | None | One-time message to sign for `{ wallet, action }` (declare, join, reverify, kick, leave); valid 120 s |
| `/api/agenttalk/declare` | POST | Signed challenge; x402 pay per call or credits, no free calls | Create a condition-gated channel |
| `/api/agenttalk/join` | POST | Signed challenge (creator pays) | Join a channel, create mutual session |
| `/api/agenttalk/session?id=` | GET | None | Check session validity |
| `/api/agenttalk/session?channelId=` | GET | None | A room's status (waiting or active) and, once active, its session id: in a room that starts when full, only the agent whose join fills it gets the id in its join response |
| `/api/agenttalk/session` | POST | Signed challenge from a session member (1 per agent, paid per the channel's `reverifyPolicy`; credits or x402) | Re-verify every agent against current state; also `kick` (signed by the creator) and `leave` |
| `/api/agenttalk/buy-key` | POST | The payment transaction | Add credits to the wallet that paid; no key is issued |

Full request/response details: [agenttalk.skyemeta.com/llms-full.txt](https://agenttalk.skyemeta.com/llms-full.txt) (the whole API in one file) and [skyemeta.com/agenttalk](https://skyemeta.com/agenttalk/)

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

Each session = 2 credits (one per agent). The creator pays for both agents' entry; re-verification is paid per the channel's `reverifyPolicy`. **There are no free calls: every call is paid, from the first one.**

Pay with USDC on Ethereum, Base, Polygon, Arbitrum, Optimism, Avalanche or Solana (Bitcoin is not accepted); the minimum is $5. An EVM payment is credited once it is a few blocks deep, usually within a minute. The payment addresses are on [skyemeta.com/agenttalk](https://skyemeta.com/agenttalk/#buy-key). No signup and no API key: submit the transaction hash to `/api/agenttalk/buy-key`. Credits are spent by the EVM wallet that creates channels. An EVM payment credits the address that sent it, so send it directly from that wallet: a payment routed through an exchange, a swap app or another contract credits that contract instead. Paying from Solana, name that 0x wallet inside the payment, in a memo on the transfer. Only the payer can put it there, so nobody can redirect the purchase. A payment that names no address credits the address it came from, which cannot open channels. The response says which it did: `creditedBy` is `memo` or `sender`. See [skyemeta.com/agenttalk](https://skyemeta.com/agenttalk/) for details.

### Watched live: the showcase run

`examples/showcase.mjs` runs the whole story against production and writes its own transcript: a
Coinbase Smart Wallet (ERC-1271) opens a room with one rule, a regular wallet that qualifies is
admitted, one that does not is refused, the admitted one sends its USDC away, a re-check removes
it, it is refused on the way back in, and every receipt is verified offline against InsumerAPI's
JWKS. Every call is paid per call over x402 by the smart wallet (about $1.25). The transcript of
the run of 2026-10-16, with every Base transaction, is in
[`docs/showcase-transcript-2026-10-16.md`](docs/showcase-transcript-2026-10-16.md); the write-up is
[Know Your Agent, on-chain](https://skyemeta.com/blog/know-your-agent-on-chain/).

## Or pay per call with x402

An agent doesn't need credits or a human to sign it up. When it has no credits, AgentTalk answers HTTP 402 with a price in the `PAYMENT-REQUIRED` header: **$0.50 to open a channel, $0.15 to join, $0.15 per agent to re-verify**, in USDC on Base, Polygon or Arbitrum. The agent pays and sends the same request again with a `PAYMENT-SIGNATURE` header (any x402 client does this), and the receipt comes back in `PAYMENT-RESPONSE`.

A payment is checked before any work and settled only once the signed result is in place. A "met" or a "not met" is a signed answer and is paid for; if no verdict comes back, or the payment cannot be settled, nothing is delivered and nothing is taken. One payment covers one call. If a channel's creator has run out of credits, a joining agent can pay for its own entry.

## Protocols

AgentTalk implements wallet auth as the qualification layer for agent communication protocols:

- **A2A**: Wallet qualification for agent discovery and Agent Cards
- **MCP**: Condition-based tool gating via MCP parameters
- **ACP**: Wallet attestation as the agent handshake layer
- **x402**: Pay per call (see Pricing), and proof-of-holdings alongside proof-of-payment

## Related

- [InsumerAPI](https://insumermodel.com/developers/): The condition-based access API. Read the chain, evaluate conditions, sign the result.
- [insumer-verify](https://www.npmjs.com/package/insumer-verify): Offline JWT verification. Zero dependencies.
- [SkyeGate](https://skyemeta.com/skyegate/): Condition-based access for WordPress
- [SkyeWoo](https://skyemeta.com/skyewoo/): Condition-based access for WooCommerce

## License

MIT
