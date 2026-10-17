// SkyeSkiff showcase: a real run against production that writes its own transcript.
//
// A smart-contract wallet opens a room ("holds at least 0.5 USDC on Base"), a regular wallet
// that holds USDC is admitted, a regular wallet that holds none is refused, the admitted one
// sends its USDC away, a re-check removes it, it tries to get back in and is refused, and the
// creator stays. Every call is paid per call with x402 by the smart wallet. Every hash is on
// Base; every receipt verifies against InsumerAPI's public JWKS.
//
//   node showcase.mjs            run it (spends about $1.25 USDC from the smart wallet)
//   node showcase.mjs --dry      print the plan and balances, call nothing
// Env: CREATOR_OWNER_KEY, CREATOR_ACCOUNT (Coinbase Smart Wallet on Base, deployed, holding ~2 USDC), AGENT_B_KEY (holds ~1 USDC + a little ETH), AGENT_C_KEY (empty).
// Deps: viem, @x402/core, @x402/evm, jose (npm i in examples/).
import fs from 'fs';
const NM = new URL('./node_modules/', import.meta.url).pathname;
const { privateKeyToAccount } = await import(NM + 'viem/_esm/accounts/index.js');
const { createPublicClient, createWalletClient, http, encodeAbiParameters, hashMessage, hashTypedData, getAddress, formatUnits, parseUnits } = await import(NM + 'viem/_esm/index.js');
const { base } = await import(NM + 'viem/_esm/chains/index.js');
const { x402Client } = await import(NM + '@x402/core/dist/esm/client/index.mjs');
const { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } = await import(NM + '@x402/core/dist/esm/http/index.mjs');
const { registerExactEvmScheme } = await import(NM + '@x402/evm/dist/esm/exact/client/index.mjs');
const { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } = await import(NM + 'jose/dist/node/esm/index.js');

const DRY = process.argv.includes('--dry');
const NET = 'eip155:8453';
const API = 'https://skyeskiff.skyemeta.com/api/skyeskiff';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const THRESHOLD = '0.5';
const dir = new URL('.', import.meta.url);
// Keys come from the environment: CREATOR_OWNER_KEY + CREATOR_ACCOUNT (a Coinbase Smart Wallet on Base), AGENT_B_KEY, AGENT_C_KEY.
const sw = { ownerKey: process.env.CREATOR_OWNER_KEY, account: process.env.CREATOR_ACCOUNT };
const ag = { b: { key: process.env.AGENT_B_KEY }, c: { key: process.env.AGENT_C_KEY } };
const owner = privateKeyToAccount(sw.ownerKey);
const SW = getAddress(sw.account);
const B = privateKeyToAccount(ag.b.key), C = privateKeyToAccount(ag.c.key);
const pc = createPublicClient({ chain: base, transport: http() });
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const usdc = async a => formatUnits(await pc.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [a] }), 6);

// ---- transcript ----------------------------------------------------------
const T = [];
const say = (...a) => { const l = a.join(' '); T.push(l); console.log(l); };
const h2 = t => say('\n## ' + t + '\n');
const code = o => say('```\n' + (typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n```');
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const scan = tx => `https://basescan.org/tx/${tx}`;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

// ---- Coinbase Smart Wallet: ERC-1271 signatures ------------------------
async function smartSign(hash) {
  const replaySafe = hashTypedData({
    domain: { name: 'Coinbase Smart Wallet', version: '1', chainId: base.id, verifyingContract: SW },
    types: { CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }] },
    primaryType: 'CoinbaseSmartWalletMessage', message: { hash },
  });
  const inner = await owner.sign({ hash: replaySafe });
  return encodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], [{ ownerIndex: 0n, signatureData: inner }]);
}
const payer = { address: SW, signTypedData: async td => smartSign(hashTypedData(td)) };

// ---- API helpers ------------------------------------------------------------
const post = async (path, body, pay) => {
  const h = { 'content-type': 'application/json' }; if (pay) h['payment-signature'] = pay;
  const r = await fetch(API + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, required: r.headers.get('payment-required'), response: r.headers.get('payment-response') };
};
async function challenge(who, action) {
  const r = await (await fetch(API + '/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: who.address, action }) })).json();
  const signature = who.smart ? await smartSign(hashMessage(r.message)) : await who.account.signMessage({ message: r.message });
  return { signature, nonce: r.nonce };
}
async function pay(required) {
  const q = decodePaymentRequiredHeader(required);
  q.accepts = q.accepts.filter(a => a.network === NET);
  return encodePaymentSignatureHeader(await registerExactEvmScheme(new x402Client(), { signer: payer }).createPaymentPayload(q));
}
// One call, paid by the smart wallet if a quote comes back. Prints quote, payment and result.
async function paidCall(label, path, body) {
  const first = await post(path, body);
  if (first.status !== 402 || !first.required) { say(`${label}: HTTP ${first.status}`); return first; }
  const q = decodePaymentRequiredHeader(first.required).accepts.find(a => a.network === NET);
  say(`${label}: HTTP 402, quote ${Number(q.amount) / 1e6} USDC on Base. Paying as ${short(SW)} (smart wallet, ERC-1271)…`);
  const paid = await post(path, body, await pay(first.required));
  const s = paid.response && decodePaymentResponseHeader(paid.response);
  say(`${label}: HTTP ${paid.status}${s ? `, settled: ${s.success}, tx ${scan(s.transaction)}` : ''}`);
  return paid;
}
const receipt = (who, att) => {
  if (!att) return;
  const hdr = decodeProtectedHeader(att.jwt);
  say(`Receipt for ${who}: attestation ${att.attestation?.id || att.id || '(id in jwt)'}, pass=${att.attestation?.pass ?? att.pass}, signed by kid ${hdr.kid} (ES256)${att.pqKid ? ` and ${att.pqKid} (ML-DSA-65)` : ''}`);
};

// ---- the run ----------------------------------------------------------------
const who = { SW: { address: SW, smart: true }, B: { address: B.address, account: B }, C: { address: C.address, account: C } };
say(`# SkyeSkiff, watched live\n\nRun at ${now()} against https://skyeskiff.skyemeta.com. Nothing here is staged: every transaction is on Base and every receipt checks against InsumerAPI's public keys.\n`);
say(`Cast:\n- Creator: ${SW}, a Coinbase Smart Wallet (a contract account; signs with ERC-1271). It also pays for every call, per call, with x402.\n- Agent B: ${B.address}, a regular wallet holding ${await usdc(B.address)} USDC.\n- Agent C: ${C.address}, a regular wallet holding ${await usdc(C.address)} USDC.\n\nThe room's rule: hold at least ${THRESHOLD} USDC on Base.`);
if (DRY) { say('\n(dry run: no calls made)'); process.exit(0); }

h2('1. The smart wallet opens the room');
const conditions = [{ type: 'token_balance', chainId: 8453, contractAddress: USDC, threshold: THRESHOLD }];
const d = await paidCall('declare', '/declare', { wallet: SW, ...(await challenge(who.SW, 'declare')), conditions, capacity: 3, autoStart: true, reverifyPolicy: 'members' });
if (d.status !== 200) { code(d.body); throw new Error('declare did not succeed'); }
const { channelId, sessionId } = d.body;
say(`Room ${channelId} is open and live (session ${sessionId}). The creator's own wallet was checked first: it holds ${await usdc(SW)} USDC.`);
code({ channelId, sessionId, conditions, capacity: 3 });

h2('2. A regular wallet that qualifies joins');
const jb = await paidCall('join B', '/join', { channelId, wallet: B.address, ...(await challenge(who.B, 'join')) });
const bEntry = jb.body?.agents?.find(a => a.wallet.toLowerCase() === B.address.toLowerCase());
if (jb.status !== 200) { code(jb.body); throw new Error('B should have been admitted'); }
say(`B is in. Members now: ${jb.body.agents.map(a => short(a.wallet)).join(', ')}.`);
receipt('B', bEntry?.attestation);

h2('3. A regular wallet that does not qualify is refused');
const jc = await paidCall('join C', '/join', { channelId, wallet: C.address, ...(await challenge(who.C, 'join')) });
code(jc.body);
say(jc.status === 403 && jc.body?.pass === false ? `C is refused: InsumerAPI signed "not met" for ${THRESHOLD} USDC. The call was paid for (a signed answer is an answer), and C never entered.` : `Unexpected: ${jc.status}`);

h2('4. B stops qualifying: it sends its USDC away');
const bBal = await pc.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [B.address] });
const wc = createWalletClient({ account: B, chain: base, transport: http() });
const tx = await wc.writeContract({ address: USDC, abi: erc20, functionName: 'transfer', args: [SW, bBal] });
const rc = await pc.waitForTransactionReceipt({ hash: tx });
say(`B sent ${formatUnits(bBal, 6)} USDC to the creator: ${scan(tx)} (block ${rc.blockNumber}, ${rc.status}). B now holds ${await usdc(B.address)} USDC. Nothing told SkyeSkiff; the room still lists B.`);
const before = await (await fetch(`${API}/session?id=${sessionId}`)).json();
say(`Session read before any re-check: members ${before.agents?.map(a => short(a.wallet)).join(', ')}.`);
await new Promise(r => setTimeout(r, 8000));

h2('5. A member asks for a fresh check');
const rv = await paidCall('re-verify', '/session', { action: 'reverify', sessionId, wallet: SW, ...(await challenge(who.SW, 'reverify')) });
code({ valid: rv.body?.valid, ejected: rv.body?.ejected, remaining: rv.body?.agents?.map(a => a.wallet) });
const ejectedB = (rv.body?.ejected || []).map(x => x.toLowerCase()).includes(B.address.toLowerCase());
say(ejectedB ? `B is out. The creator stays. No admin pressed anything: the chain changed, the next check noticed.` : 'Unexpected: B was not ejected');
for (const a of rv.body?.agents || []) receipt(short(a.wallet), a.attestation);

h2('6. B tries to get back in');
const again = await paidCall('join B again', '/join', { channelId, wallet: B.address, ...(await challenge(who.B, 'join')) });
code(again.body);
say(again.status === 403 && again.body?.pass === false ? 'Refused: a signed "not met". Being in once buys nothing; the rule is checked every time.' : `Unexpected: ${again.status}`);

h2('7. Who is in the room now');
const after = await (await fetch(`${API}/session?id=${sessionId}`)).json();
code({ valid: after.valid, members: after.agents?.map(a => a.wallet) });

h2('8. Check the receipts without trusting anyone');
const JWKS = createRemoteJWKSet(new URL('https://insumermodel.com/.well-known/jwks.json'));
const jwts = [['B at join', bEntry?.attestation?.jwt], ...(rv.body?.agents || []).map(a => [`${short(a.wallet)} at re-check`, a.attestation?.jwt])].filter(x => x[1]);
for (const [label, jwt] of jwts) {
  try { const { payload, protectedHeader } = await jwtVerify(jwt, JWKS, { algorithms: ['ES256'] }); say(`${label}: ES256 signature VERIFIED against https://insumermodel.com/.well-known/jwks.json (kid ${protectedHeader.kid}); pass=${payload.pass ?? payload.attestation?.pass}`); }
  catch (e) { say(`${label}: verification FAILED: ${e.message}`); }
}
say(`\nBalances at the end: creator ${await usdc(SW)} USDC, B ${await usdc(B.address)} USDC, C ${await usdc(C.address)} USDC. Every call above was paid per call by the smart wallet over x402.`);
const out = new URL('./showcase-transcript.md', dir);
fs.writeFileSync(out, T.join('\n') + '\n');
console.log('\ntranscript written to', out.pathname);
