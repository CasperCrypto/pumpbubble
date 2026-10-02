/* ==========================================================================
   pumpbubble.fun — Solana buy alerts, polled from free public RPCs

   Solana buys used to arrive by Helius webhook. Helius's free plan is a
   million credits a month, every delivered transaction costs one, and the
   top traders' wallets the Smart money tab follows are bots that trade all
   day — 371,067 deliveries in six hours on 2026-09-30. The plan ran dry on
   2026-10-01, a halted plan delivers nothing until the month turns, and
   every group's buy alerts stopped with it. A second free account would
   only be a second cliff, and it would get both banned.

   So Solana is now read the way Base, Ethereum and Robinhood already are
   (src/evmbuy.mjs): a Durable Object (`SolWatch`, worker/index.js) polls
   every few seconds while any group follows a token. One poll is one
   batched getSignaturesForAddress for every followed mint and pool, newer
   than the last signature seen at each, then getTransaction for the new
   ones. Those come back in the raw shape Helius delivered, so
   src/solbuy.mjs reads them unchanged and the alert is the same alert.

   Free public endpoints, tried in order; one that fails or rate-limits
   sits out a minute. Probed on 2026-10-02 from a laptop only — a throwaway
   probe Worker was not allowed — so `/api/tg/status` → `sol` shows which
   one Cloudflare's egress actually gets (`rpc`) and its last error:

   | endpoint                          | sigs | tx | batches                     |
   |-----------------------------------|------|----|-----------------------------|
   | api.mainnet-beta.solana.com       | yes  | yes| mixed                       |
   | solana-rpc.publicnode.com         | yes  | yes| one getTransaction per batch|
   | public.rpc.solanavibestation.com  | yes  | yes| one method per batch        |
   | dRPC, Ankr, BlockPI, OnFinality,  | no — a key, a paid plan, a 429 or a 5xx |
   | Omnia, LeoRPC                     |                                    |

   Every batch here is one method, which all three accept; a refused
   getTransaction batch falls back to single calls for that endpoint.
   SOL_POLL_RPC (a secret: any provider's own free-key URL) goes first when
   set. Helius's RPC (SOLANA_RPC) is never polled: what it has left is for
   payments.

   Pure apart from fetch, which every function takes as an argument so the
   test (scripts/solwatch.test.mjs) runs without a network.
   ========================================================================== */

export const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://public.rpc.solanavibestation.com',
];

export const EVERY = 4000;          // between polls while something moved lately
export const IDLE_EVERY = 8000;     // after QUIET_MS with nothing new anywhere
export const QUIET_MS = 120_000;
export const SIG_LIMIT = 25;        // signatures per address per poll
export const TX_MAX = 20;           // transactions read per poll, newest first
export const MAX_AGE_S = 180;       // a buy older than this is history, not an alert
export const BENCH_MS = 60_000;     // a failing endpoint sits out this long
const TX_OPTS = { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };

/* Who delivers Solana buys: this watcher, unless SOL_BUYS is "helius" — the
   switch back for the day there is a paid plan and the webhook's speed is
   worth its credits. Exactly one of the two may, or every buy posts twice. */
export const solPolling = env => String((env && env.SOL_BUYS) || 'poll').trim().toLowerCase() !== 'helius';

export function rpcList(env = {}) {
  const own = String(env.SOL_POLL_RPC || '').trim();
  return (/^https:\/\/\S+$/.test(own) ? [own] : []).concat(RPCS);
}

/* For status lines and errors: the host, never a path that might carry a key. */
export const host = u => { try { return new URL(u).host; } catch { return ''; } };

/* What to poll for the tracked list ([{mint, pool}] from tg:mints): every
   mint, and its deepest pool where one is known — the same set the Helius
   webhook watched, because some routes name only the pool. */
export function watchList(list) {
  const out = [];
  for (const r of list || []) {
    if (r && r.mint) out.push(String(r.mint));
    if (r && r.pool) out.push(String(r.pool));
  }
  return [...new Set(out)];
}

/* The new signatures in one poll. `rows` maps each address to
   getSignaturesForAddress's answer (newest first), or null when that call
   failed — which keeps the address's cursor where it was. A first look at an
   address only remembers where it is: a group that just ran /setup must not
   get the last hour's buys. Failed transactions, ones older than MAX_AGE_S
   (a cursor from before a long sleep) and ones already read are dropped; the
   rest are taken newest first, TX_MAX at most, and `skipped` counts what a
   burst left out. */
export function pickNew(rows, cursors = {}, { now = Date.now(), seen = null, max = TX_MAX } = {}) {
  const next = { ...cursors };
  const found = new Map();
  for (const [addr, list] of Object.entries(rows || {})) {
    if (!Array.isArray(list) || !list.length || !list[0] || !list[0].signature) continue;
    const first = !cursors[addr];
    next[addr] = list[0].signature;
    if (first) continue;
    for (const r of list) {
      if (!r || !r.signature || r.err) continue;
      if (r.blockTime && now / 1000 - r.blockTime > MAX_AGE_S) continue;
      if (seen && seen.has(r.signature)) continue;
      if (!found.has(r.signature)) found.set(r.signature, r);
    }
  }
  const all = [...found.values()].sort((a, b) => (b.slot || 0) - (a.slot || 0));
  return { sigs: all.slice(0, max).map(r => r.signature), next, skipped: Math.max(0, all.length - max) };
}

/* One JSON-RPC request (single or batch) to one endpoint. A rate limit throws
   with `.limited`; a refused batch with `.noBatch`. A batch answers in
   request order, with null where an item failed. */
export async function rpcCall(url, body, fetcher = fetch, ms = 8000) {
  const r = await fetcher(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'pumpbubble.fun/1.0' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* an HTML error page */ }
  const msg = (j && !Array.isArray(j) && j.error && (j.error.message || JSON.stringify(j.error))) || (j ? '' : txt.slice(0, 120));
  if (r.status === 429 || /too many requests|rate limit/i.test(msg)) {
    const e = new Error('429 ' + host(url)); e.limited = true; throw e;
  }
  if (Array.isArray(body)) {
    if (!Array.isArray(j)) {
      const e = new Error(host(url) + ' ' + r.status + ' ' + String(msg).slice(0, 120));
      if (/batch/i.test(msg)) e.noBatch = true;
      throw e;
    }
    const by = new Map(j.map(x => [x && x.id, x]));
    const out = body.map(b => { const x = by.get(b.id); return x && !x.error && x.result !== undefined ? x.result : null; });
    /* per-item errors are kept on the answer (a batch can half-work), and a
       batch where every item failed is the endpoint failing — thrown, so the
       next one is tried instead of reading as a quiet market */
    out.errors = body.map(b => by.get(b.id)).filter(x => !x || x.error)
      .map(x => String(x ? (x.error.message || JSON.stringify(x.error)) : 'no answer for an item').slice(0, 120));
    if (out.errors.length === body.length && body.length) {
      const e = new Error(host(url) + ' ' + out.errors[0]);
      if (/too many|rate limit|429/i.test(out.errors[0])) e.limited = true;
      throw e;
    }
    return out;
  }
  if (!j || j.error) throw new Error(host(url) + ' ' + r.status + ' ' + String(msg).slice(0, 120));
  return j.result;
}

/* The endpoints and what each has shown it can do. Lives as long as the
   Durable Object's isolate; nothing about it needs saving. */
export class Endpoints {
  constructor(urls) { this.urls = urls.slice(); this.bench = new Map(); this.single = new Set(); }
  live(now = Date.now()) {
    const up = this.urls.filter(u => !(this.bench.get(u) > now));
    return up.length ? up : this.urls.slice();          // everyone benched: try them all anyway
  }
  sit(url, now = Date.now()) { this.bench.set(url, now + BENCH_MS); }
}

/* The first endpoint that answers the batch, benching the ones that do not. */
async function firstAnswer(eps, body, fetcher, now) {
  let last = null;
  for (const url of eps.live(now)) {
    try { return { url, res: await rpcCall(url, body, fetcher) }; }
    catch (e) { last = e; eps.sit(url, now); }
  }
  throw last || new Error('no rpc');
}

/* getTransaction for each signature from one endpoint: one batch where it
   allows that, one call each where it does not — and then only SINGLE_MAX of
   them, because every call is a subrequest and the free plan allows fifty
   per alarm, alerts included. A null is a transaction that endpoint has not
   caught up with yet (or one left for the next poll). */
export const SINGLE_MAX = 8;
export async function readTxs(eps, url, sigs, fetcher = fetch) {
  const reqs = sigs.map((s, i) => ({ jsonrpc: '2.0', id: 100 + i, method: 'getTransaction', params: [s, TX_OPTS] }));
  if (!eps.single.has(url)) {
    try { return await rpcCall(url, reqs, fetcher); }
    catch (e) { if (!e.noBatch) throw e; eps.single.add(url); }
  }
  return Promise.all(reqs.map((q, i) => i >= SINGLE_MAX ? null
    : rpcCall(url, q, fetcher).catch(e => { if (e.limited) throw e; return null; })));
}

/* The endpoint that listed the signatures first (its view of the chain is
   the one they came from), then the others; one that fails sits out. */
async function readTxsAny(eps, url, sigs, fetcher, now) {
  let last = null;
  for (const u of [url, ...eps.live(now).filter(x => x !== url)]) {
    try { return await readTxs(eps, u, sigs, fetcher); }
    catch (e) { last = e; eps.sit(u, now); }
  }
  throw last || new Error('no rpc');
}

/* One poll, apart from posting: the signatures since each cursor, then the
   transactions behind the new ones. `retry` carries signatures whose
   transaction was not there yet last time (each gets one more try). */
export async function poll(addrs, cursors, eps, { now = Date.now(), seen = null, retry = [], fetcher = fetch } = {}) {
  if (!addrs.length) return { txs: [], next: {}, skipped: 0, again: [], rpc: '', diag: { rows: [], warn: '' } };
  const reqs = addrs.map((a, i) => ({
    jsonrpc: '2.0', id: i + 1, method: 'getSignaturesForAddress',
    params: [a, cursors[a] ? { limit: SIG_LIMIT, until: cursors[a], commitment: 'confirmed' } : { limit: 1, commitment: 'confirmed' }],
  }));
  const { url, res } = await firstAnswer(eps, reqs, fetcher, now);
  const rows = {};
  addrs.forEach((a, i) => { rows[a] = Array.isArray(res[i]) ? res[i] : null; });
  /* what each address answered (a count, or x for a failed item), and the
     first item error — for /api/tg/status, because a quiet poll and a broken
     one otherwise look the same */
  const diag = { rows: addrs.map(a => Array.isArray(rows[a]) ? rows[a].length : 'x'), warn: (res.errors || [])[0] || '' };
  const keep = {};
  for (const a of addrs) if (cursors[a]) keep[a] = cursors[a];       // addresses nobody follows any more fall away
  const picked = pickNew(rows, keep, { now, seen });
  const { sigs, next } = picked;
  let skipped = picked.skipped;
  const all = [...new Set(retry.concat(sigs))];
  const want = all.slice(0, TX_MAX + 5);
  skipped += all.length - want.length;
  if (!want.length) return { txs: [], next, skipped, again: [], rpc: host(url), diag };
  const got = await readTxsAny(eps, url, want, fetcher, now);
  const txs = [], again = [];
  want.forEach((s, i) => {
    if (got[i]) txs.push(got[i]);
    else if (!retry.includes(s)) again.push(s);
  });
  diag.txs = want.length + ':' + txs.length;
  if (!diag.warn && got.errors && got.errors.length) diag.warn = got.errors[0];
  return { txs, next, skipped, again, rpc: host(url), diag };
}
