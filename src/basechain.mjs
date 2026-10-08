/* ==========================================================================
   pumpbubble.fun — Base

   Base is a large chain and none of the usual doors open onto it. Its own
   Blockscout instance answers 503 (eth.blockscout.com is fine from the same
   code, so it is Base's instance and not us). GeckoTerminal ranks it properly
   and 429s Cloudflare's shared egress on every request, as it does for every
   other chain. DexScreener knows what everything is worth and still has no
   chain-wide listing: sixteen searches turned up twenty-seven unique Base
   tokens, because each query comes back as one ticker's clones.

   What Base does have, and Robinhood Chain did not, is a **canonical list**.
   CoinGecko publishes one per platform as a static file — 2,677 Base tokens
   with addresses — from tokens.coingecko.com rather than their rate-limited
   API. It is a curated universe rather than a ranking, which is exactly the
   half we were missing: DexScreener supplies the ranking.

   That ordering matters for more than convenience. Discovery by search returns
   whatever shares a name with a search term, which on any memecoin chain means
   a swarm of clones of whatever is currently hot. Starting from a list somebody
   maintains means a token has to have been listed before it can appear at all.

   Pricing 2,677 addresses is ninety DexScreener requests, far too many for one
   build, so it is swept: each cron tick prices a slice and caches it, tokens
   with a pool are refreshed often and the rest are re-checked slowly. The map
   reads the cache, so it never waits for any of this.
   ========================================================================== */

import { txnsOf } from './core.mjs';

const LIST = 'https://tokens.coingecko.com/base/all.json';
const DEXS = 'https://api.dexscreener.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';
const HEAD = { accept: 'application/json', 'user-agent': UA };

export const KEY = 'basechain';
export const UNIVERSE_KEY = 'baseuni';

/* The list barely changes day to day and is half a megabyte. */
const UNIVERSE_TTL = 24 * 60 * 60 * 1000;

/* Per cron tick. Six batches of thirty is 180 addresses, which sweeps the whole
   universe in about a quarter of a day and leaves room for every other feed
   sharing the invocation. */
const BATCHES_PER_TICK = 6;

/* A token with a pool is worth re-checking often; one without is worth
   re-checking eventually, in case it lists later. */
const LIVE_TTL = 12 * 60 * 1000;
const DEAD_TTL = 6 * 60 * 60 * 1000;

const norm = a => String(a || '').toLowerCase();
const isAddr = a => /^0x[0-9a-f]{40}$/.test(norm(a));
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
/* A window with no data is null, not zero. */
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;

async function jget(url, ms = 15000) {
  const r = await fetch(url, { headers: HEAD, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

/* ------------------------------------------------------------------ universe */

export async function loadUniverse(store) {
  try {
    const u = await store.get(UNIVERSE_KEY);
    if (u && Array.isArray(u.addrs) && u.addrs.length) return u;
  } catch { /* fall through and refetch */ }
  return null;
}

export async function refreshUniverse(store, force = false) {
  const have = await loadUniverse(store);
  /* a record from before logos were kept is read again once, so art arrives today */
  if (!force && have && have.logos && (Date.now() - (have.at || 0)) < UNIVERSE_TTL) {
    return { universe: have.addrs.length, cached: true };
  }
  let list;
  try { list = await jget(LIST, 20000); }
  catch (e) { return { universe: have ? have.addrs.length : 0, error: 'list ' + (e.message || 'fail') }; }

  const seen = new Set();
  const addrs = [];
  /* The list carries a logo for every token (2,846 of 2,846 on 2026-10-08)
     while DexScreener had none for a quarter of the map. Kept as CoinGecko's
     image path only, the shared prefix stripped, to keep the record small. */
  const logos = {};
  for (const t of (list && list.tokens) || []) {
    const a = norm(t.address);
    if (!isAddr(a) || seen.has(a)) continue;
    seen.add(a);
    addrs.push(a);
    const path = logoPath(t.logoURI);
    if (path) logos[a] = path;
  }
  if (!addrs.length) return { universe: have ? have.addrs.length : 0, error: 'list empty' };

  const next = { at: Date.now(), addrs, logos };
  try { await store.put(UNIVERSE_KEY, next); } catch { /* next tick retries */ }
  return { universe: addrs.length, cached: false };
}

/* CoinGecko image paths: 'https://assets.coingecko.com/coins/images/53669/thumb/x.jpeg?…'
   is kept as '53669/x.jpeg?…' and served at the large size — the thumb is 25
   pixels, smaller than most bubbles draw it. */
const CG_IMG = /^https:\/\/(?:assets|coin-images)\.coingecko\.com\/coins\/images\/(\d+)\/(?:thumb|small|large)\/([^\s]+)$/;
export function logoPath(uri) {
  const m = CG_IMG.exec(String(uri || ''));
  return m ? m[1] + '/' + m[2] : '';
}
export function logoUrl(path) {
  return path ? 'https://coin-images.coingecko.com/coins/images/' + path.replace('/', '/large/') : '';
}

/* -------------------------------------------------------------------- cache */

const EMPTY = { live: {}, dead: {}, seeds: [], cursor: 0, at: 0 };

export async function loadCache(store) {
  try {
    const c = await store.get(KEY);
    if (!c || typeof c !== 'object') return { ...EMPTY };
    return {
      live: c.live && typeof c.live === 'object' ? c.live : {},
      dead: c.dead && typeof c.dead === 'object' ? c.dead : {},
      seeds: Array.isArray(c.seeds) ? c.seeds : [],
      cursor: c.cursor || 0,
      at: c.at || 0,
    };
  } catch { return { ...EMPTY }; }
}

/* Pin an address so it is priced and mapped whatever the sweep has reached. */
export async function seed(store, addrs) {
  const c = await loadCache(store);
  const good = (addrs || []).map(norm).filter(isAddr);
  const seeds = [...new Set([...(c.seeds || []), ...good])];
  try { await store.put(KEY, { ...c, seeds }); } catch { return { seeds: c.seeds.length, added: 0 }; }
  return { seeds: seeds.length, added: seeds.length - c.seeds.length };
}

async function priceBatch(addrs) {
  const j = await jget(DEXS + '/tokens/v1/base/' + addrs.join(','), 9000);
  if (!Array.isArray(j)) throw new Error('shape');
  const best = new Map();
  for (const p of j) {
    const a = p && p.baseToken && norm(p.baseToken.address);
    if (!a) continue;
    /* A token can sit in several pools; the deepest is the one somebody could
       actually trade against. */
    const prev = best.get(a);
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    if (!prev || liq > (((prev.liquidity && prev.liquidity.usd)) || 0)) best.set(a, p);
  }
  return best;
}

/* One tick's worth of sweeping. Returns counts so a scheduled run says what it
   did rather than reporting silent success. */
export async function sweep(store) {
  const uni = await loadUniverse(store);
  if (!uni) return { skipped: 'no universe' };

  const c = await loadCache(store);
  const now = Date.now();

  /* What to spend this tick on, in priority order: pinned tokens, then live
     ones that have gone stale, then addresses never checked, then the long
     tail of dead ones. */
  const due = [];
  const push = a => { if (a && !due.includes(a) && due.length < BATCHES_PER_TICK * 30) due.push(a); };

  for (const a of c.seeds) push(a);
  for (const [a, v] of Object.entries(c.live)) {
    if (now - (v.at || 0) > LIVE_TTL) push(a);
  }
  const n = uni.addrs.length;
  for (let i = 0; i < n && due.length < BATCHES_PER_TICK * 30; i++) {
    const a = uni.addrs[(c.cursor + i) % n];
    if (c.live[a] && now - (c.live[a].at || 0) <= LIVE_TTL) continue;
    if (c.dead[a] && now - c.dead[a] <= DEAD_TTL) continue;
    push(a);
  }

  if (!due.length) return { priced: 0, live: Object.keys(c.live).length, note: 'all fresh' };

  const batches = [];
  for (let i = 0; i < due.length; i += 30) batches.push(due.slice(i, i + 30));

  let ok = 0, bad = 0, why = '';
  const found = new Map();
  for (let i = 0; i < batches.length; i += 3) {
    const group = batches.slice(i, i + 3);
    const res = await Promise.allSettled(group.map(priceBatch));
    for (const r of res) {
      if (r.status !== 'fulfilled') {
        bad++;
        if (!why) why = String((r.reason && r.reason.message) || r.reason).slice(0, 40);
        continue;
      }
      ok++;
      for (const [a, p] of r.value) found.set(a, p);
    }
  }

  /* A tick where every request failed must not mark the whole slice dead. */
  if (!ok) return { priced: 0, live: Object.keys(c.live).length, failed: bad, why };

  let added = 0;
  for (const a of due) {
    const p = found.get(a);
    if (!p) {
      if (!c.live[a]) c.dead[a] = now;
      continue;
    }
    delete c.dead[a];
    const pc = p.priceChange || {};
    if (!c.live[a]) added++;
    c.live[a] = {
      sym: String((p.baseToken && p.baseToken.symbol) || '').slice(0, 12),
      name: String((p.baseToken && p.baseToken.name) || '').slice(0, 48),
      img: (p.info && typeof p.info.imageUrl === 'string') ? p.info.imageUrl : '',
      mcap: num(p.marketCap) || num(p.fdv),
      vol: num(p.volume && p.volume.h24),
      liq: num(p.liquidity && p.liquidity.usd),
      price: num(p.priceUsd),
      created: num(p.pairCreatedAt),
      pc: { m5: pick(pc.m5), h1: pick(pc.h1), h6: pick(pc.h6), h24: pick(pc.h24) },
      txns: txnsOf(p),
      volH1: num(p.volume && p.volume.h1),
      at: now,
    };
  }

  c.cursor = (c.cursor + due.length) % Math.max(1, uni.addrs.length);
  c.at = now;
  try { await store.put(KEY, c); } catch { /* next tick retries */ }

  return {
    priced: due.length, matched: found.size, added,
    live: Object.keys(c.live).length, dead: Object.keys(c.dead).length,
    batches: batches.length, ok, failed: bad,
  };
}

/* Build the map from what is cached. Never fetches, so the map is never
   waiting on a sweep. */
export async function baseTokens(store, limit = 220) {
  if (!store) return [];
  const c = await loadCache(store);
  /* the list's logo where DexScreener has no picture */
  const uni = await loadUniverse(store).catch(() => null);
  const logos = (uni && uni.logos) || {};
  const rows = [];
  for (const [addr, v] of Object.entries(c.live)) {
    if (!v || !v.sym || !(v.mcap > 0)) continue;
    rows.push({
      id: 'base:' + addr,
      mint: '',                       // no Solana mint; the contract is the id
      /* Stamped on the token, not inferred later. A boost order read the chain
         off the address format and guessed "base" for everything EVM, which
         labelled a Robinhood Chain token as Base inside a payment record. */
      chain: 'base',
      addr,
      sym: v.sym,
      name: v.name || v.sym,
      rawImg: v.img || logoUrl(logos[addr]),
      img: '',
      mcap: v.mcap,
      ath: 0,
      vol: v.vol,
      liq: v.liq,
      price: v.price,
      created: v.created,
      txns: v.txns || null,
      volH1: v.volH1 || 0,
      pc: { ...v.pc, d7: null, d30: null, y1: null },
    });
  }
  rows.sort((a, b) => b.mcap - a.mcap);

  /* Pinned tokens are never ranked off. $MAC is priced correctly at $256k and
     sat outside the top 220 by market cap, so pinning it put it in the cache
     and still not on the map — which is not what pinning means. */
  const pinned = new Set(c.seeds || []);
  const out = rows.slice(0, limit);
  if (pinned.size) {
    const have = new Set(out.map(t => t.addr));
    for (const t of rows) {
      if (pinned.has(t.addr) && !have.has(t.addr)) out.push(t);
    }
  }
  return out;
}
