/* ==========================================================================
   pumpbubble.fun — shared data core
   Runs unchanged in a Cloudflare Worker and in Node 22 (fetch + WebCrypto are
   global in both). Zero dependencies, by house rule.

   Why this file exists at all:
   pump.fun's API returns 403 to any request carrying an `Origin` header — i.e.
   to every browser fetch(). The data this product is built on can therefore
   only be read server-side. See CLAUDE.md → Data.
   ========================================================================== */

export const PUMP = 'https://frontend-api-v3.pump.fun';
export const DEXS = 'https://api.dexscreener.com';
/* pump.fun rejects on Origin, not on User-Agent, but a browser-ish UA is the
   least surprising thing to send from a server. */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';

/* ------------------------------------------------------------------ utils */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };

async function jget(url, { ms = 9000, headers = {} } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { accept: 'application/json', 'user-agent': UA, ...headers },
    });
    if (!r.ok) throw new Error(r.status + ' ' + url.slice(0, 90));
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ============================================================= image proxy */
/* Token art is ~66% IPFS-hosted. Hotlinking it tanks framerate (CLAUDE.md), so
   images are served through our own edge cache. The proxy must not become an
   open relay, so every URL is HMAC-signed here and verified at the edge. */

const enc = new TextEncoder();
let keyCache = null, keyCacheSecret = null;

async function hmacKey(secret) {
  if (keyCache && keyCacheSecret === secret) return keyCache;
  keyCacheSecret = secret;
  keyCache = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return keyCache;
}

export async function signUrl(url, secret) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(url));
  /* base64url of the first 16 bytes — enough to stop abuse, short in a query string */
  return btoa(String.fromCharCode(...new Uint8Array(sig).slice(0, 16)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifyUrl(url, sig, secret) {
  if (!url || !sig) return false;
  const want = await signUrl(url, secret);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/* Repair dead gateways. Cloudflare shut its public IPFS gateway down, but
   pump.fun still serves cf-ipfs.com / cloudflare-ipfs.com URLs for a slice of
   older tokens — those images are simply broken at the source, and pointing
   them at a live gateway brings the art back.

   Nothing else is rewritten: measured from here, ipfs.io answers in ~0.3s and
   the edge cache in front of this proxy means each image is fetched once per
   colo, so second-guessing the token's own gateway only adds ways to fail. */
const GATEWAY_SWAP = [
  [/^https?:\/\/cf-ipfs\.com\/ipfs\//i, 'https://ipfs.io/ipfs/'],
  [/^https?:\/\/cloudflare-ipfs\.com\/ipfs\//i, 'https://ipfs.io/ipfs/'],
];
export function fastImage(u) {
  if (!u) return '';
  for (const [re, to] of GATEWAY_SWAP) if (re.test(u)) return u.replace(re, to);
  return u;
}

/* ========================================================= pump.fun source */
/* Identity, art, ticker and market cap all come from pump.fun itself — that is
   the product requirement, not an implementation detail. */
/* Token names and symbols are attacker-supplied: minting a coin called
   `<img src=x onerror=…>` costs a few cents, and it lands in every visitor's
   DOM. The front end escapes on write, but strip the dangerous characters here
   too — defence in depth, so one forgotten template is not an incident on a
   page that shows a payment address. Also drops control characters, which
   break layout and hide text. */
const clean = (s, max) => String(s == null ? '' : s)
  .replace(/[<>]/g, '')
  // control chars, zero-width joiners and bidi marks: layout breakage + spoofing
  .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\uFEFF]/g, '')
  .trim()
  .slice(0, max);

/* A mint must look like a Solana address before we build anything around it. */
export const isMint = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function normalizeCoin(c) {
  const mcap = num(c.usd_market_cap) || num(c.market_cap_usd);
  return {
    id: c.mint,
    mint: c.mint,
    sym: clean(c.symbol, 12) || '?',
    name: clean(c.name || c.symbol, 48) || 'unknown',
    rawImg: fastImage(c.image_uri || ''),
    img: '',                                 // filled in below with a signed proxy URL
    mcap,
    ath: num(c.ath_market_cap),
    vol: 0,                                  // DexScreener fills this
    pc: { m5: 0, h1: 0, h6: 0, h24: 0 },     // ditto — pump.fun has no change field
    grad: !!c.complete,                      // graduated off the bonding curve
    liveStream: !!c.is_currently_live,
    pumpBoost: !!(c.boost_mode && c.boost_mode !== 'NONE'),
    created: num(c.created_timestamp),
    lastTrade: num(c.last_trade_timestamp),
    /* SOL sitting in the bonding curve. For a token that has not graduated this
       IS its liquidity, and DexScreener cannot report it because the token is
       not on a DEX yet. Converted to USD in buildSnapshot. */
    curveSol: num(c.real_sol_reserves) / 1e9,
    nsfw: !!c.nsfw,
    twitter: c.twitter || '',
    boost: 0,                                // our paid boost, applied by the worker
  };
}

/* `complete` selects the lifecycle stage: true = graduated onto a DEX,
   false = still on the bonding curve, undefined = both. The two have completely
   different lifetimes, so they are never mixed by default (CLAUDE.md). */
export async function fetchPumpCoins({ pages = 6, perPage = 50, sort = 'market_cap',
                                       includeNsfw = false, complete } = {}) {
  const offsets = Array.from({ length: pages }, (_, i) => i * perPage);
  const filter = complete === undefined ? '' : '&complete=' + complete;
  const results = await Promise.allSettled(offsets.map(off =>
    jget(PUMP + '/coins?offset=' + off + '&limit=' + perPage +
         '&sort=' + sort + '&order=DESC&includeNsfw=' + includeNsfw + filter)
  ));
  const seen = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const c of r.value) {
      if (!c || !c.mint || seen.has(c.mint)) continue;
      const t = normalizeCoin(c);
      if (t.mcap > 0) seen.set(c.mint, t);
    }
  }
  if (!seen.size) throw new Error('pump.fun returned nothing');
  return [...seen.values()];
}

/* Look up one token by mint, whatever its state. The ranked feed only carries
   the top 300, so anything outside that — a small cap, a fresh launch, a
   community that came here specifically to boost their own coin — is invisible
   to it. Being unable to sell those is leaving money on the table, and it is
   the exact case where someone arrives with a contract address in hand. */
export async function fetchCoin(mint, secret) {
  if (!isMint(mint)) return null;
  try {
    const c = await jget(PUMP + '/coins/' + mint, { ms: 7000 });
    if (!c || !c.mint) return null;
    const t = normalizeCoin(c);
    /* one enrichment call so the quote can show real numbers */
    try { await enrich([t]); } catch { /* price change is optional here */ }
    /* Sign the art here too. Without this the token reaches the map with no
       image and renders as a blank circle — the snapshot path signs in
       buildSnapshot, and this path bypasses it entirely. */
    if (secret && t.rawImg) {
      t.img = '/api/img?u=' + encodeURIComponent(t.rawImg) +
              '&s=' + await signUrl(t.rawImg, secret);
    }
    delete t.rawImg;
    return t;
  } catch { return null; }
}

export async function fetchSolPrice() {
  try { return num((await jget(PUMP + '/sol-price', { ms: 5000 })).solPrice); }
  catch { return 0; }
}

/* =================================================== DexScreener enrichment */
/* pump.fun exposes no price-change field, and colour is the whole point of the
   map. DexScreener covers graduated pump.fun mints at ~100%, is free and needs
   no key, so it supplies change + volume only. Identity stays pump.fun's. */
export async function enrich(tokens) {
  const mints = tokens.map(t => t.mint).filter(Boolean);
  const byMint = new Map();
  const batches = [];
  for (let i = 0; i < mints.length; i += 30) batches.push(mints.slice(i, i + 30));

  /* modest concurrency — DexScreener rate-limits per minute, not per burst */
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const res = await Promise.allSettled(group.map(b =>
      jget(DEXS + '/tokens/v1/solana/' + b.join(','), { ms: 7000 })));
    for (const r of res) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const p of r.value) {
        const k = p && p.baseToken && p.baseToken.address;
        if (!k) continue;
        /* a mint can have many pools; keep the deepest one */
        const prev = byMint.get(k);
        if (!prev || num(p.liquidity && p.liquidity.usd) > num(prev.liquidity && prev.liquidity.usd)) {
          byMint.set(k, p);
        }
      }
    }
  }

  let hit = 0;
  for (const t of tokens) {
    const p = byMint.get(t.mint);
    if (!p) continue;
    hit++;
    const pc = p.priceChange || {};
    t.pc = { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) };
    t.vol = num(p.volume && p.volume.h24);
    t.liq = num(p.liquidity && p.liquidity.usd);
    t.price = num(p.priceUsd);
  }
  return hit;
}

/* ====================================================== change from history
   Fallback for anything DexScreener does not cover (fresh / pre-graduation
   tokens): derive change from our own market-cap snapshots.

   Retention is tiered so 24h of history costs ~120 samples per token rather
   than 8640: keep everything under 10min, then thin out with age. */
const WINDOWS = { m5: 3e5, h1: 36e5, h6: 216e5, h24: 864e5 };
const TIERS = [[6e5, 0], [36e5, 12e4], [216e5, 9e5], [864e5, 36e5]];

export function pushHistory(hist, tokens, now = Date.now()) {
  for (const t of tokens) {
    let h = hist.get(t.mint);
    if (!h) hist.set(t.mint, (h = []));
    h.push(now, t.mcap);
  }
  /* drop tokens that fell out of the feed entirely */
  if (hist.size > 4000) {
    const live = new Set(tokens.map(t => t.mint));
    for (const k of [...hist.keys()]) if (!live.has(k)) hist.delete(k);
  }
  pruneHistory(hist, now);
}

export function pruneHistory(hist, now = Date.now()) {
  for (const [mint, h] of hist) {
    const out = [];
    let lastKept = Infinity;
    /* walk newest -> oldest, keeping one sample per tier-width bucket */
    for (let i = h.length - 2; i >= 0; i -= 2) {
      const age = now - h[i];
      if (age > 864e5) break;
      const tier = TIERS.find(t => age <= t[0]);
      const gap = tier ? tier[1] : 36e5;
      if (out.length === 0 || lastKept - h[i] >= gap) {
        out.unshift(h[i], h[i + 1]);
        lastKept = h[i];
      }
    }
    if (out.length) hist.set(mint, out); else hist.delete(mint);
  }
}

export function changeFromHistory(hist, mint, mcap, now = Date.now()) {
  const h = hist.get(mint);
  const out = {};
  if (!h || h.length < 4) return out;
  for (const k of Object.keys(WINDOWS)) {
    const target = now - WINDOWS[k];
    /* newest sample that is still at or before the window edge */
    let best = -1;
    for (let i = 0; i < h.length; i += 2) { if (h[i] <= target) best = i; else break; }
    if (best < 0) continue;
    const old = h[best + 1];
    if (!(old > 0)) continue;
    out[k] = ((mcap - old) / old) * 100;
  }
  return out;
}

/* Serialise / restore history so it survives a worker isolate recycling. */
export function histToJSON(hist) {
  const o = {};
  for (const [k, v] of hist) o[k] = v;
  return o;
}
export function histFromJSON(o) {
  const m = new Map();
  if (o && typeof o === 'object') for (const k of Object.keys(o)) {
    if (Array.isArray(o[k])) m.set(k, o[k]);
  }
  return m;
}

/* ============================================================= data quality
   A market cap is price × supply, and price is whatever the last trade said.
   With a thin pool that number is paper: a token can print $250M of "market
   cap" against $1.2M of liquidity nobody could ever sell into. Measured on a
   live feed, healthy tokens sit at 2–22× market cap over liquidity and the
   median is ~14×; the copycat swarm sits at 100–385×.

   Nothing is deleted over this — a screener that hides real trades is lying in
   the other direction. Each token is scored, the front end can filter on it,
   and the numbers stay visible either way. */

/* Calibrated against a live snapshot rather than picked: the median token sits
   at ~14x market cap over liquidity, and established names reach 99x while
   trading millions a day. A high ratio alone is normal for a low-float memecoin,
   so the bar is set where the number stops meaning anything, and the copycat
   count below carries most of the weight. */
const THIN_RATIO = 120;     // mcap/liquidity above this is essentially paper
const DEAD_VOLUME = 1000;   // USD in 24h, below this nobody is trading it
const MAX_COPIES = 2;       // same ticker across more mints than this is a swarm

export function scoreQuality(tokens, solPrice = 0) {
  /* Copycat swarms reuse one ticker across dozens of mints — 14 tokens called
     UOTF in a single snapshot, on a live feed. The count is the signal. */
  const perSymbol = new Map();
  for (const t of tokens) {
    const k = t.sym.toUpperCase();
    perSymbol.set(k, (perSymbol.get(k) || 0) + 1);
  }

  const now = Date.now();
  for (const t of tokens) {
    /* a bonding-curve token's liquidity is the SOL in its curve */
    if (!t.liq && t.curveSol && solPrice) t.liq = t.curveSol * solPrice;

    t.copies = perSymbol.get(t.sym.toUpperCase()) || 1;
    t.ageH = t.created ? (now - t.created) / 36e5 : 0;
    t.mcLiq = t.liq > 0 ? t.mcap / t.liq : null;

    const thin = t.mcLiq === null || t.mcLiq > THIN_RATIO;

    /* Volume comes from DexScreener, which only indexes tokens that have
       graduated onto a DEX. A bonding-curve token therefore reports zero
       volume no matter how briskly it is trading — and "no data" is not "no
       trades". pump.fun's own last_trade_timestamp covers that gap: if it
       traded in the last hour, somebody is buying it. */
    const tradedRecently = t.lastTrade > 0 && (now - t.lastTrade) < 36e5;
    const dead = (t.vol || 0) < DEAD_VOLUME && !tradedRecently;

    t.flags = [];
    if (thin) t.flags.push('thin');                    // cap unsupported by the pool
    if (dead) t.flags.push('quiet');                   // barely trading
    if (t.copies > MAX_COPIES) t.flags.push('copycat');// ticker shared across mints
    if (t.ageH < 24) t.flags.push('new');              // 24h numbers meaningless here

    /* "is this market cap backed by anything" rather than "is this a scam" —
       intent is unknowable, backing is measurable. `new` is not disqualifying:
       plenty of real tokens are hours old, and this is a pump.fun screener. */
    t.solid = !thin && !dead && t.copies <= MAX_COPIES;
  }
  for (const t of tokens) delete t.curveSol;
  return tokens;
}

/* ================================================================ snapshot */
export async function buildSnapshot({ hist, secret, pages = 6, perPage = 50,
                                      sort = 'market_cap', includeNsfw = false,
                                      complete } = {}) {
  const now = Date.now();
  const [tokens, sol] = await Promise.all([
    fetchPumpCoins({ pages, perPage, sort, includeNsfw, complete }),
    fetchSolPrice(),
  ]);

  let enriched = 0;
  try { enriched = await enrich(tokens); }
  catch { /* colour degrades, the map still renders */ }

  scoreQuality(tokens, sol);

  if (hist) {
    pushHistory(hist, tokens, now);
    for (const t of tokens) {
      const own = changeFromHistory(hist, t.mint, t.mcap, now);
      /* our own history only fills gaps DexScreener left */
      for (const k of ['m5', 'h1', 'h6', 'h24']) {
        if (own[k] !== undefined && !t.pc[k]) t.pc[k] = own[k];
      }
    }
  }

  /* Counted before signing so "no images" can be told apart from "no art in the
     upstream data" — the two have completely different causes. */
  const withArt = tokens.filter(t => t.rawImg).length;

  if (secret) {
    await Promise.all(tokens.map(async t => {
      if (!t.rawImg) return;
      t.img = '/api/img?u=' + encodeURIComponent(t.rawImg) +
              '&s=' + await signUrl(t.rawImg, secret);
    }));
  }
  const sampleArt = tokens.find(t => t.rawImg)?.rawImg || '';
  for (const t of tokens) delete t.rawImg;

  return {
    ts: now, sol, count: tokens.length, enriched, withArt, sampleArt,
    solid: tokens.filter(t => t.solid).length,
    signed: !!secret, source: 'pump.fun', tokens,
  };
}
