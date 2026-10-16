/**
 * AgentTalk: full session flow (prove control → declare → join → verify → re-verify)
 *
 * No API key and no signup. The channel creator's wallet gets 10 free calls. After
 * that, a call answers HTTP 402 with its price in the PAYMENT-REQUIRED header: any
 * x402 client pays in USDC (Base, Polygon or Arbitrum) and sends it again. Teams can
 * buy credits in advance instead (POST /api/agenttalk/buy-key). Declare and every
 * join are billed to the creator; re-verify costs 1 per agent, paid as the channel's
 * reverifyPolicy says (the creator by default).
 *
 * Proof-of-control: on-chain holdings are public, so before declare, join and
 * re-verify the acting agent fetches a one-time challenge for { wallet, action }
 * and signs it with its wallet key (EIP-191). The challenge is good for one action
 * and expires after 120 seconds.
 *
 * Wallets: by default this generates fresh, throwaway keypairs. The signature is
 * accepted, but a fresh wallet holds nothing, so the demo stops at the condition
 * gate. To complete a full session, supply two different wallets you control that
 * each hold at least 1 USDC on Ethereum:
 *
 *     DEMO_PRIVATE_KEY_A=0xKEY_A DEMO_PRIVATE_KEY_B=0xKEY_B node session.js
 *
 * (DEMO_PRIVATE_KEY is accepted for Agent A.) Keys are read only at runtime and
 * never leave your machine.
 *
 * Run: npm install && node session.js
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const BASE_URL = 'https://agenttalk.skyemeta.com/api/agenttalk';

// Fresh throwaway keypairs unless you supply your own funded ones via env.
const agentA = privateKeyToAccount(process.env.DEMO_PRIVATE_KEY_A || process.env.DEMO_PRIVATE_KEY || generatePrivateKey());
const agentB = privateKeyToAccount(process.env.DEMO_PRIVATE_KEY_B || generatePrivateKey());

// Prove control of `account` for `action`: fetch a one-time challenge, sign the
// returned message (EIP-191), return the signature and the challenge's nonce. Send
// both: with the nonce, nobody else's challenge requests can cancel yours.
async function proveControl(account, action) {
  const res = await fetch(`${BASE_URL}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: account.address, action }),
  });
  if (!res.ok) throw new Error(`challenge failed: ${res.status} ${await res.text()}`);
  const { message, nonce } = await res.json();
  return { signature: await account.signMessage({ message }), nonce };
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function declareChannel(account, conditions) {
  const { signature, nonce } = await proveControl(account, 'declare');
  return postJson('/declare', { wallet: account.address, signature, nonce, conditions });
}

async function joinChannel(channelId, account) {
  // Billed to the channel creator. The joiner still proves control of its wallet.
  const { signature, nonce } = await proveControl(account, 'join');
  return postJson('/join', { channelId, wallet: account.address, signature, nonce });
}

async function verifySession(sessionId) {
  const res = await fetch(`${BASE_URL}/session?id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`verify failed: ${res.status}`);
  return res.json();
}

async function reverifySession(sessionId, member) {
  // Re-attests every agent against current on-chain state. It must be requested
  // by a session member, signing a 'reverify' challenge; 1 per agent is
  // paid as the channel's reverifyPolicy says (the creator by default).
  const { signature, nonce } = await proveControl(member, 'reverify');
  return postJson('/session', { action: 'reverify', sessionId, wallet: member.address, signature, nonce });
}

// Explain a response that did not admit the agent. Returns nothing; the caller stops.
//   401          the signature was missing, stale or not from this wallet: request a
//                fresh challenge and sign again
//   402          no free calls or credits left: pay with x402 (PAYMENT-REQUIRED header)
//                or buy credits (buy-key)
//   400          the conditions or wallet fields were rejected as invalid (see error)
//   403 pass:false  a condition is not met: the verification service signed "not met"
//   503          no verdict could be obtained: retry later; not cleared, do not act on it
//   A 400, 503 or 429 costs nothing; only a signed answer uses a call.
function explainRefusal(label, res) {
  const { status, data } = res;
  if (status === 403 && data.pass === false) {
    console.log(`\nNot admitted (${label}): a condition is not met (expected for a fresh throwaway wallet).`);
  } else if (status === 400) {
    console.log(`\nConditions rejected (${label}): ${data.error}. Nothing was charged.`);
  } else if (status === 502 || status === 503) {
    console.log(`\nVerification unavailable (${label}). Nothing was charged; retry in a few seconds.`);
  } else if (status === 401) {
    console.log(`\nProof-of-control rejected (${label}): ${data.error}. Request a new challenge and sign again.`);
  } else if (status === 402) {
    console.log(`\nPayment needed (${label}): pay this call with any x402 client (price in the PAYMENT-REQUIRED header), or buy credits via /buy-key.`);
  } else {
    console.log(`\n${label} failed with HTTP ${status}: ${data.error || JSON.stringify(data)}`);
  }
}

async function main() {
  // Condition: wallet holds >= 1 USDC on Ethereum
  const conditions = [
    {
      type: 'token_balance',
      contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      chainId: 1,
      threshold: '1',
    },
  ];

  console.log(`Agent A: ${agentA.address}`);
  console.log(`Agent B: ${agentB.address}`);

  console.log('\n=== Step 1: Prove control + declare channel ===');
  const channel = await declareChannel(agentA, conditions);
  console.log(`HTTP ${channel.status}: ${JSON.stringify(channel.data)}`);
  if (channel.status !== 200 || !channel.data.channelId) {
    explainRefusal('declare', channel);
    return;
  }

  console.log('\n=== Step 2: Prove control + join channel ===');
  const session = await joinChannel(channel.data.channelId, agentB);
  console.log(`HTTP ${session.status}: ${JSON.stringify(session.data)}`);
  if (session.status !== 200 || !session.data.sessionId) {
    explainRefusal('join', session);
    return;
  }

  console.log('\n=== Step 3: Verify session ===');
  const status = await verifySession(session.data.sessionId);
  console.log(JSON.stringify(status, null, 2));

  console.log('\n=== Step 4: Re-verify (checks current on-chain state) ===');
  const fresh = await reverifySession(session.data.sessionId, agentA);
  console.log(`HTTP ${fresh.status}: ${JSON.stringify(fresh.data, null, 2)}`);
  if (fresh.status !== 200) {
    explainRefusal('re-verify', fresh);
  } else if (fresh.data.ejected) {
    console.log(`Removed on re-verify: ${fresh.data.ejected.join(', ')}`);
  }
}

main().catch(console.error);
