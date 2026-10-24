/* ==========================================================================
   pumpbubble.fun — the Launch Kit: a pump.fun token, its page, its Telegram
   group with the bot, its X post, in one flow.

   Asked for on 2026-10-24 ("one click: a token on pump.fun, a website, a
   Telegram group with the bot"). The reasoning that shaped it: pump.fun
   takes 92% of launchpad revenue, so a launchpad of our own would compete
   for crumbs; but 21,700 tokens a day are launched there and 79% trade only
   on their first day. Creators do not lack a button that mints a token —
   they lack everything after it. So the token is launched ON pump.fun, and
   everything after is ours: the page (/t/<mint>), the bot, the gold bubble,
   the post.

   Non-custodial, and that is the line held everywhere below:
   - the token's own key (the mint keypair) is made in the creator's
     browser and never leaves it;
   - the transaction comes from PumpPortal's keyless Local Transaction API
     (free for creation; PumpPortal keeps 0.5% of the dev buy), and before
     the wallet sees it the server reads it — two signers, the creator pays,
     only the programs a pump.fun create uses — and simulates it, so the
     page can say exactly what it will cost, and refuse when that is more
     than the dev buy and the fees;
   - we never hold a key, a balance or a fee. A launch costs us nothing and
     earns us nothing directly: the page's Buy goes through our swap (1%),
     the gold bubble is the upsell.

   Metadata: pump.fun no longer takes uploads from outside, so the image
   and the metadata JSON are kept by us, content-addressed (the id is the
   SHA-256 of the bytes, so a URI can never come to mean something else),
   at /m/<id>.<ext>, served immutable — or pinned to IPFS through Pinata
   when PINATA_JWT is set.
   ========================================================================== */

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPPORTAL = 'https://pumpportal.fun/api/trade-local';
export const PINATA = 'https://uploads.pinata.cloud/v3/files';
export const MAX_IMG = 512 * 1024;
export const MAX_DEV_BUY = 50;               // SOL; pump.fun's own form allows far less in practice

/* Every program a pump.fun create through PumpPortal touches at the top
   level, read off a live transaction on 2026-10-24: compute budget, the
   pump.fun program, the associated-token program, and PumpPortal's router
   for the dev buy. The token programs and Metaplex are allowed for when
   the layout moves. Anything else and the page refuses to sign. */
export const ALLOWED_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  PUMP_PROGRAM,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe',
  /* Lighthouse: Phantom adds its own assertions to a transaction it signs —
     they only check, they never move anything */
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
]);

/* ---------------------------------------------------------------- base58 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(bytes) {
  let n = 0n, s = '';
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export function b58dec(str) {
  const s = String(str || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return new Uint8Array(out);
}
export const isKey = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && (b58dec(s) || []).length === 32;

export const b64enc = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
export const b64dec = str => { const s = atob(String(str || '')); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

/* ------------------------------------------------------------ the form */
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const okLink = (u, host) => {
  const v = String(u || '').trim();
  if (!v) return '';
  if (!/^https:\/\/[^\s"'<>]{4,200}$/i.test(v)) return null;
  try { const h = new URL(v).hostname.toLowerCase(); if (host && !host.test(h)) return null; } catch { return null; }
  return v;
};

/* What a creator typed, as pump.fun will carry it. A field that is wrong
   is named, so the page can say which. */
export function checkLaunch(f = {}) {
  const errors = [];
  const name = clean(f.name, 32), symbol = clean(f.symbol, 10).replace(/^\$/, '');
  const description = clean(f.description, 500).replace(/\n{3,}/g, '\n\n');
  if (!name) errors.push('name');
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) errors.push('symbol');
  const twitter = okLink(f.twitter, /^(www\.)?(x|twitter)\.com$/), telegram = okLink(f.telegram, /^(www\.)?(t\.me|telegram\.me)$/), website = okLink(f.website);
  if (twitter === null) errors.push('twitter');
  if (telegram === null) errors.push('telegram');
  if (website === null) errors.push('website');
  return { ok: !errors.length, errors, value: { name, symbol: symbol.toUpperCase(), description, twitter: twitter || '', telegram: telegram || '', website: website || '' } };
}

/* An image is judged by its bytes, never its name or a declared type */
export function imageType(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}
export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export async function contentId(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* the metadata JSON pump.fun's own launches carry, with our name on it */
export function metadata(v, image) {
  return {
    name: v.name, symbol: v.symbol, description: v.description, image, showName: true, createdOn: 'https://pumpbubble.fun',
    ...(v.twitter ? { twitter: v.twitter } : {}), ...(v.telegram ? { telegram: v.telegram } : {}), ...(v.website ? { website: v.website } : {}),
  };
}

/* ------------------------------------------------------------ the store */
/* `s` is any {get, put}: a Durable Object's storage, or a Map in dev. */
export class LaunchBook {
  constructor(s) { this.s = s; }
  async putFile(id, type, bytes) { if (!(await this.s.get('f:' + id))) await this.s.put('f:' + id, { type, b64: b64enc(bytes) }); }
  async getFile(id) { const f = await this.s.get('f:' + id); return f ? { type: f.type, bytes: b64dec(f.b64) } : null; }
  async record(e) {
    if (!e || !isKey(e.mint)) return false;
    if (await this.s.get('l:' + e.mint)) return false;
    await this.s.put('l:' + e.mint, e);
    const recent = (await this.s.get('recent')) || [];
    recent.unshift(e.mint);
    await this.s.put('recent', recent.slice(0, 300));
    return true;
  }
  async get(mint) { return isKey(mint) ? (await this.s.get('l:' + mint)) || null : null; }
  async recent(n = 30) {
    const ids = ((await this.s.get('recent')) || []).slice(0, Math.min(100, n));
    const out = [];
    for (const m of ids) { const e = await this.s.get('l:' + m); if (e) out.push(e); }
    return out;
  }
}

/* ------------------------------------------------------- transactions */
/* A Solana transaction, read without a library: signatures, then a legacy
   or v0 message — header, static keys, blockhash, instructions, lookups. */
export function parseTx(bytes) {
  let o = 0;
  const cu = () => { let v = 0, sh = 0, b; do { b = bytes[o++]; if (b === undefined) throw new Error('short'); v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return v; };
  const nsig = cu(), sigStart = o;
  o += 64 * nsig;
  const msgStart = o;
  let version = 'legacy';
  if (bytes[o] & 0x80) version = bytes[o++] & 0x7f;
  const header = [bytes[o++], bytes[o++], bytes[o++]];
  const nk = cu(), keys = [];
  for (let i = 0; i < nk; i++) { keys.push(b58enc(bytes.subarray(o, o + 32))); o += 32; }
  o += 32;
  const ni = cu(), instructions = [];
  for (let i = 0; i < ni; i++) {
    const p = bytes[o++], na = cu(), accounts = Array.from(bytes.subarray(o, o + na)); o += na;
    const dl = cu(), data = bytes.subarray(o, o + dl); o += dl;
    instructions.push({ program: keys[p] || '', programIndex: p, accounts, data });
  }
  if (o > bytes.length) throw new Error('short');
  return { nsig, sigStart, msgStart, version, header, keys, instructions, signers: keys.slice(0, header[0]), message: bytes.subarray(msgStart) };
}

/* A create, for this creator and this mint, and nothing else */
export function checkCreateTx(tx, { user, mint }) {
  if (!tx) return 'no transaction';
  if (tx.nsig !== 2 || tx.header[0] !== 2) return 'expected two signers';
  if (tx.keys[0] !== user) return 'the creator is not the payer';
  if (!tx.signers.includes(mint)) return 'the token key does not sign';
  const odd = tx.instructions.map(i => i.program).filter(p => !ALLOWED_PROGRAMS.has(p));
  if (odd.length) return 'an unexpected program: ' + odd[0];
  if (!tx.instructions.some(i => i.program === PUMP_PROGRAM)) return 'not a pump.fun create';
  return '';
}

/* the two signature slots, by who signs them */
export function sigSlot(tx, key) { const i = tx.signers.indexOf(key); return i < 0 ? -1 : tx.sigStart + 64 * i; }
export const signed = (bytes, tx, key) => { const at = sigSlot(tx, key); return at >= 0 && bytes.subarray(at, at + 64).some(x => x !== 0); };

/* ----------------------------------------------------------------- RPC */
export function rpcUrl(env = {}) {
  const k = String(env.ALCHEMY_KEY || '').trim();
  if (/^[A-Za-z0-9_-]{8,}$/.test(k)) return 'https://solana-mainnet.g.alchemy.com/v2/' + k;
  return /^https:\/\//.test(String(env.SOLANA_RPC || '')) ? env.SOLANA_RPC : 'https://api.mainnet-beta.solana.com';
}
export async function rpc(url, method, params, fetcher = fetch, ms = 15_000) {
  const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('rpc ' + r.status);
  if (j.error) { const e = new Error(String(j.error.message || 'rpc error').slice(0, 200)); e.rpc = j.error; throw e; }
  return j.result;
}

/* What the transaction takes from the creator, measured: their balance now,
   and after a simulation that replaces the blockhash and skips signatures. */
export async function simulateCost(url, txB64, user, fetcher = fetch) {
  const pre = await rpc(url, 'getBalance', [user, { commitment: 'confirmed' }], fetcher);
  const sim = await rpc(url, 'simulateTransaction', [txB64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [user] } }], fetcher);
  const v = sim && sim.value;
  const post = v && v.accounts && v.accounts[0] ? +v.accounts[0].lamports : null;
  const balance = +(pre && pre.value != null ? pre.value : pre) || 0;
  const err = v && v.err ? JSON.stringify(v.err).slice(0, 160) : '';
  return { balance, cost: post != null && !err ? balance - post : null, err, logs: ((v && v.logs) || []).slice(-6) };
}

/* the most a create may take: the dev buy, a margin for its slippage and
   PumpPortal's 0.5%, and 0.05 SOL for rent and fees */
export const costCap = sol => Math.round((Math.max(0, +sol || 0) * 1.12 + 0.05) * 1e9);

export async function buildCreateTx({ publicKey, mint, name, symbol, uri, amount, slippage = 10, priorityFee = 0.00005 }, fetcher = fetch) {
  const r = await fetcher(PUMPPORTAL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ publicKey, action: 'create', tokenMetadata: { name, symbol, uri }, mint, denominatedInSol: 'true', amount: +amount, slippage: +slippage, priorityFee: +priorityFee, pool: 'pump' }) });
  if (!r.ok) throw new Error('PumpPortal ' + r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 120));
  return new Uint8Array(await r.arrayBuffer());
}

/* A sent create, judged on chain: it landed, nothing failed, and it is the
   pump.fun create of this mint by this creator. */
export async function verifyLaunch(url, sig, mint, fetcher = fetch) {
  const t = await rpc(url, 'getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], fetcher);
  if (!t) return { ok: false, why: 'not found yet' };
  if (t.meta && t.meta.err) return { ok: false, why: 'failed on chain' };
  const keys = (t.transaction.message.accountKeys || []).concat((t.meta && t.meta.loadedAddresses && t.meta.loadedAddresses.writable) || [], (t.meta && t.meta.loadedAddresses && t.meta.loadedAddresses.readonly) || []);
  if (!keys.includes(mint) || !keys.includes(PUMP_PROGRAM)) return { ok: false, why: 'not a pump.fun create of this token' };
  return { ok: true, creator: keys[0], at: (t.blockTime || 0) * 1000 };
}

/* --------------------------------------------------------------- IPFS */
export async function pinFile(jwt, bytes, name, type, fetcher = fetch) {
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', new Blob([bytes], { type }), name);
  const r = await fetcher(PINATA, { method: 'POST', headers: { authorization: 'Bearer ' + jwt }, body: form, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  const cid = j && j.data && j.data.cid;
  if (!r.ok || !cid) throw new Error('pinata ' + r.status);
  return 'https://ipfs.io/ipfs/' + cid;
}

/* the startgroup link that sets the bot up for this token, rights included */
export const groupLink = (bot, mint) => 'https://t.me/' + (bot || 'pumpbubblebot') + '?startgroup=setup_' + mint + '&admin=delete_messages+restrict_members+pin_messages+invite_users+change_info';
