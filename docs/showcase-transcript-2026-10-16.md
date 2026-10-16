# AgentTalk, watched live

Run at 2026-10-16 21:07:07 UTC against https://agenttalk.skyemeta.com. Nothing here is staged: every transaction is on Base and every receipt checks against InsumerAPI's public keys.

Cast:
- Creator: 0xF4605E4964FCEe7fba5908619C19a1aF0b5cb98E, a Coinbase Smart Wallet (a contract account; signs with ERC-1271). It also pays for every call, per call, with x402.
- Agent B: 0xCd97C6e12503C5F012532362B4A32ce0e185C157, a regular wallet holding 1.1 USDC.
- Agent C: 0x9d3C52e867579722715Dc487A9019386B7c3C4ad, a regular wallet holding 0 USDC.

The room's rule: hold at least 0.5 USDC on Base.

## 1. The smart wallet opens the room

declare: HTTP 402, quote 0.5 USDC on Base. Paying as 0xF460…b98E (smart wallet, ERC-1271)…
declare: HTTP 200, settled: true, tx https://basescan.org/tx/0x987cfe8d3638974c7f48dde182743cd92a224a75f4284ca9a142641b6643218e
Room ch_eade98bee11b20c87b133e60459de233 is open and live (session ses_5833d94472c1e5a584f7255e81e476b2). The creator's own wallet was checked first: it holds 2 USDC.
```
{
  "channelId": "ch_eade98bee11b20c87b133e60459de233",
  "sessionId": "ses_5833d94472c1e5a584f7255e81e476b2",
  "conditions": [
    {
      "type": "token_balance",
      "chainId": 8453,
      "contractAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "threshold": "0.5"
    }
  ],
  "capacity": 3
}
```

## 2. A regular wallet that qualifies joins

join B: HTTP 402, quote 0.15 USDC on Base. Paying as 0xF460…b98E (smart wallet, ERC-1271)…
join B: HTTP 200, settled: true, tx https://basescan.org/tx/0x87ec96f674741765c217106c3f4dcd22e9ed52fd0894c1c6c9bc44153033f45e
B is in. Members now: 0xf460…b98e, 0xcd97…c157.
Receipt for B: attestation ATST-D525FBA91A3CC662, pass=true, signed by kid insumer-attest-v2 (ES256) and insumer-attest-pq1 (ML-DSA-65)

## 3. A regular wallet that does not qualify is refused

join C: HTTP 402, quote 0.15 USDC on Base. Paying as 0xF460…b98E (smart wallet, ERC-1271)…
join C: HTTP 403, settled: true, tx https://basescan.org/tx/0x08e130f537d1e244cc18172f3f3722142f62240bb52c0de89a37c0c33985ff23
```
{
  "pass": false
}
```
C is refused: InsumerAPI signed "not met" for 0.5 USDC. The call was paid for (a signed answer is an answer), and C never entered.

## 4. B stops qualifying: it sends its USDC away

B sent 1.1 USDC to the creator: https://basescan.org/tx/0x2016b1020466aef58422d46edc3b74f973e33d1a82f2b07770e46da4d521c7a4 (block 52697745, success). B now holds 0 USDC (balance re-read at block 52697759; the node first answered with the pre-transfer figure). Nothing told AgentTalk; the room still lists B.
Session read before any re-check: members 0xf460…b98e, 0xcd97…c157.

## 5. A member asks for a fresh check

re-verify: HTTP 402, quote 0.3 USDC on Base. Paying as 0xF460…b98E (smart wallet, ERC-1271)…
re-verify: HTTP 200, settled: true, tx https://basescan.org/tx/0x407b815a049c4a8396ad26fd1f91734d3401247bb4ad935b076650bd301ad3c4
```
{
  "valid": true,
  "ejected": [
    "0xcd97c6e12503c5f012532362b4a32ce0e185c157"
  ],
  "remaining": [
    "0xf4605e4964fcee7fba5908619c19a1af0b5cb98e"
  ]
}
```
B is out. The creator stays. No admin pressed anything: the chain changed, the next check noticed.
Receipt for 0xf460…b98e: attestation ATST-2493133864C54B51, pass=true, signed by kid insumer-attest-v2 (ES256) and insumer-attest-pq1 (ML-DSA-65)

## 6. B tries to get back in

join B again: HTTP 402, quote 0.15 USDC on Base. Paying as 0xF460…b98E (smart wallet, ERC-1271)…
join B again: HTTP 403, settled: true, tx https://basescan.org/tx/0xf91c71ed39c25b5b10e76ecfc70e98c45127c1d59a96448d2aeef0643375fdb3
```
{
  "pass": false
}
```
Refused: a signed "not met". Being in once buys nothing; the rule is checked every time.

## 7. Who is in the room now

```
{
  "valid": true,
  "members": [
    "0xf4605e4964fcee7fba5908619c19a1af0b5cb98e"
  ]
}
```

## 8. Check the receipts without trusting anyone

B at join: ES256 signature VERIFIED against https://insumermodel.com/.well-known/jwks.json (kid insumer-attest-v2); pass=true
0xf460…b98e at re-check: ES256 signature VERIFIED against https://insumermodel.com/.well-known/jwks.json (kid insumer-attest-v2); pass=true

Balances at the end (block 52697759): creator 1.85 USDC (2 + B's 1.1, less 1.25 paid for five calls), B 0 USDC, C 0 USDC. Every call above was paid per call by the smart wallet over x402.
