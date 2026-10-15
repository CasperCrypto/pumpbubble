/* ==========================================================================
   pumpbubble.fun — shared data core
   Runs unchanged in a Cloudflare Worker and in Node 22 (fetch + WebCrypto are
   global in both). Zero dependencies, by house rule.

   Why this file exists at all:
   pump.fun's API returns 403 to any request carrying an `Origin` header — i.e.
   to every browser fetch(). The data this product is built on can therefore
   only be read server-side. See CLAUDE.md → Data.
   ========================================================================== */

import { fetchActivity } from './activity.mjs';

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
/* A window with no data is null, not zero. Zero is a claim the price did not
   move, which is a statement about the asset rather than about our data. */
const keep = v => (v == null || !Number.isFinite(+v)) ? null : +v;

/* Token names and symbols are attacker-supplied: minting a coin called
   `<img src=x onerror=…>` costs a few cents, and it lands in every visitor's
   DOM. The front end escapes on write, but strip the dangerous characters here
   too — defence in depth, so one forgotten template is not an incident on a
   page that shows a payment address. Also drops control characters, which
   break layout and hide text. */
export const clean = (s, max) => String(s == null ? '' : s)
  .replace(/[<>]/g, '')
  // control chars, zero-width joiners and bidi marks: layout breakage + spoofing
  .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\uFEFF]/g, '')
  .trim()
  .slice(0, max);

/* A mint must look like a Solana address before we build anything around it. */
export const isMint = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const isEvmAddr = s => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
/* Anything somebody could paste into the boost box. */
export const isCA = s => isMint(s) || isEvmAddr(s);

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
    banned: !!c.is_banned,
    twitter: c.twitter || '',
    /* the project's own links, typed by whoever launched it: shown only as
       https links and always escaped (the console's outreach list reads them) */
    telegram: typeof c.telegram === 'string' ? c.telegram.slice(0, 200) : '',
    website: typeof c.website === 'string' ? c.website.slice(0, 200) : '',
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
/* One pump.fun coin record by mint.

   **pump.fun retired `GET /coins/<mint>`** — it answers 404 "Cannot GET" now,
   found 2026-09-30 when production could not name UDR, a token sitting on the
   map: three lookups in four 404'd in 0.3s, and the one that worked was served
   from a warm feed. Everything that names a single token went through that
   route — the boost box, a boost for a token off the map, the bot's /setup and
   its alert market cap, adding to Tap wars — so all of it failed quietly as
   "no token found". `/coins-v2/<mint>` is the same record (socials included
   when the creator set any); v3 is the spare. The list pages and the batch
   `coins-v2/mints` are unaffected. */
export const COIN_PATHS = ['/coins-v2/', '/coins-v3/'];
export async function pumpCoin(mint, ms = 7000) {
  if (!isMint(mint)) return null;
  for (const p of COIN_PATHS) {
    try {
      const c = await jget(PUMP + p + encodeURIComponent(mint), { ms });
      if (c && c.mint === mint) return c;
    } catch { /* next route */ }
  }
  return null;
}

export async function fetchCoin(mint, secret) {
  if (!isMint(mint)) return null;
  try {
    const c = await pumpCoin(mint);
    if (!c) return null;
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

/* Resolve a pasted contract address on whatever chain it lives on.

   A boost is paid in SOL to a Solana treasury, but nothing about that requires
   the *token* to be on Solana — the payment rail and the advertised token are
   independent. So the boost box takes any address, and this is what turns one
   into a token we can name, price and draw.

   DexScreener's /latest/dex/tokens/<address> is chain-agnostic: it answers for
   Solana, Base, Ethereum and Robinhood Chain from the same URL and says which
   chain each pair is on. pump.fun is still tried first for a Solana mint,
   because it knows things a DEX does not — graduation state, the creator's
   socials, the original art.

   The deepest pool wins. A token can be quoted in several places and the deep
   one is the price somebody could actually trade against. */
export async function resolveAnyToken(addr, secret) {
  if (isMint(addr)) {
    const t = await fetchCoin(addr, secret);
    if (t) return { ...t, chain: 'solana' };
  }
  if (!isCA(addr)) return null;

  let pairs;
  try {
    const j = await jget(DEXS + '/latest/dex/tokens/' + encodeURIComponent(addr), { ms: 9000 });
    pairs = (j && j.pairs) || [];
  } catch { return null; }
  if (!pairs.length) return null;

  const p = pairs.slice().sort((a, b) =>
    num(b.liquidity && b.liquidity.usd) - num(a.liquidity && a.liquidity.usd))[0];

  const chain = String(p.chainId || '');
  const evm = isEvmAddr(addr);
  const pc = p.priceChange || {};
  const rawImg = (p.info && typeof p.info.imageUrl === 'string') ? p.info.imageUrl : '';

  const t = {
    id: (evm ? chain + ':' : '') + (evm ? addr.toLowerCase() : addr),
    chain,
    mint: evm ? '' : addr,
    addr: evm ? addr.toLowerCase() : '',
    sym: clean(p.baseToken && p.baseToken.symbol, 12) || '?',
    name: clean((p.baseToken && p.baseToken.name) || (p.baseToken && p.baseToken.symbol), 48) || 'unknown',
    rawImg,
    img: '',
    mcap: num(p.marketCap) || num(p.fdv),
    ath: 0,
    vol: num(p.volume && p.volume.h24),
    liq: num(p.liquidity && p.liquidity.usd),
    price: num(p.priceUsd),
    created: num(p.pairCreatedAt),
    grad: true,
    pc: { m5: keep(pc.m5), h1: keep(pc.h1), h6: keep(pc.h6), h24: keep(pc.h24),
          d7: null, d30: null, y1: null },
    copies: 1, flags: [], solid: true,
  };

  /* Art goes through the signed proxy like every other image on the page,
     which is served img-src 'self'. */
  if (t.rawImg && secret) {
    try {
      t.img = '/api/img?u=' + encodeURIComponent(t.rawImg) + '&s=' + await signUrl(t.rawImg, secret);
    } catch { t.img = ''; }
  }
  return t;
}

/* A CID is on every gateway; a gateway is not always answering.

   ipfs.io and dweb.link are one operator behind one rate limiter, so a 429
   from either is a 429 from both, and w3s.link and nftstorage.link are a
   second such pair. Measured against three CIDs a live top ten could not
   load: filebase answered all three in 150-620ms, pinata answered all three
   in 4-7 seconds, cloudflare-ipfs is dead (as the map already knew), and the
   two pairs above returned 429 to everything. Fast first, slow second.

   This matters beyond the share cards: the image proxy passed the failure
   straight through, so those tokens wore a letter avatar on the map itself. */
const IPFS_RE = /^https?:\/\/[^/]+\/ipfs\/([A-Za-z0-9]+)/;
const IPFS_ALTS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
export function altGateways(url) {
  const m = IPFS_RE.exec(String(url || ''));
  return m ? IPFS_ALTS.map(g => g + m[1]) : [];
}

export async function fetchSolPrice() {
  try { return num((await jget(PUMP + '/sol-price', { ms: 5000 })).solPrice); }
  catch { return 0; }
}

/* =================================================== DexScreener enrichment */
/* pump.fun exposes no price-change field, and colour is the whole point of the
   map. DexScreener covers graduated pump.fun mints at ~100%, is free and needs
   no key, so it supplies change + volume only. Identity stays pump.fun's. */
/* DexScreener's answers, remembered per isolate.

   Every isolate used to re-ask for all 300 pump.fun tokens every ten seconds:
   ten requests a build, ~60 a minute each, against a limit of ~300 a minute
   per IP — and Cloudflare's egress IPs are shared with every other Worker on
   the platform. A few busy isolates were enough to be refused, a refused pass
   left every token with no liquidity and no volume, the quality filter then
   called all of them unbacked, and the map showed **five bubbles with 295
   hidden**. Measured live, intermittently, on the default tab.

   So an answer is reused for a minute before it is asked again (DexScreener's
   own numbers move no faster than that), and when a request *fails* the last
   good answer stands in for up to fifteen minutes. It is the same pair
   DexScreener returned, not a number made up in its place; a token with no
   answer at all still gets none. */
const DEX_MEM = new Map();          // chain:key -> { at, p }
const DEX_FRESH_MS = 60_000;
const DEX_KEEP_MS = 15 * 60_000;
const DEX_MEM_MAX = 6000;
function dexRemember(key, p, now) {
  DEX_MEM.set(key, { at: now, p });
  if (DEX_MEM.size > DEX_MEM_MAX) {
    for (const [k, v] of DEX_MEM) { if (now - v.at > DEX_KEEP_MS || DEX_MEM.size > DEX_MEM_MAX * 0.9) DEX_MEM.delete(k); else break; }
  }
}
export function _dexMemForTests() { return DEX_MEM; }
export function _actMemForTests() { return ACT_MEM; }
/* What DexScreener last said when it refused, for /api/health. A refusal
   is otherwise silent by design — a failed batch is skipped — which is right
   for the map and useless for finding out why the map is grey. */
export const dexStatus = { lastError: '', lastErrorAt: 0, lastOkAt: 0, memSize: 0 };
const ACT_MEM = new Map();          // mint -> { at, a }  pump.fun market activity

export async function enrich(tokens, chain = 'solana') {
  /* Solana addresses are base58 and case-sensitive; EVM addresses are hex and
     are not. Blockscout returns them checksummed and DexScreener does not
     always agree on the casing, so for an EVM chain both sides are lowered
     before they are compared — otherwise every lookup misses and the whole
     chain renders grey with no error anywhere. */
  const evm = chain !== 'solana';
  const keyOf = t => {
    const a = (t && (t.addr || t.mint)) || '';
    return evm ? a.toLowerCase() : a;
  };

  const now = Date.now();
  const memKey = k => chain + ':' + k;
  const mints = tokens.map(keyOf).filter(Boolean);
  const byMint = new Map();
  /* only what has not been answered in the last minute goes back out */
  const need = [];
  for (const k of mints) {
    const m = DEX_MEM.get(memKey(k));
    if (m && now - m.at < DEX_FRESH_MS) { if (m.p) byMint.set(k, m.p); }
    else need.push(k);
  }
  const batches = [];
  for (let i = 0; i < need.length; i += 30) batches.push(need.slice(i, i + 30));
  const answered = new Set();

  /* modest concurrency — DexScreener rate-limits per minute, not per burst */
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const res = await Promise.allSettled(group.map(b =>
      jget(DEXS + '/tokens/v1/' + chain + '/' + b.join(','), { ms: 7000 })));
    for (let bi = 0; bi < res.length; bi++) {
      const r = res[bi];
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) {
        dexStatus.lastError = String((r.reason && r.reason.message) || 'not an array').slice(0, 120);
        dexStatus.lastErrorAt = Date.now();
        continue;
      }
      dexStatus.lastOkAt = Date.now();
      /* a batch that answered is an answer for every mint in it — including
         "no pair", which is remembered too so it is not re-asked each build */
      for (const k of group[bi]) answered.add(k);
      for (const p of r.value) {
        const raw = p && p.baseToken && p.baseToken.address;
        if (!raw) continue;
        const k = evm ? raw.toLowerCase() : raw;
        /* a mint can have many pools; keep the deepest one */
        const prev = byMint.get(k);
        if (!prev || num(p.liquidity && p.liquidity.usd) > num(prev.liquidity && prev.liquidity.usd)) {
          byMint.set(k, p);
        }
      }
    }
  }

  for (const k of answered) dexRemember(memKey(k), byMint.get(k) || null, now);
  /* a batch that failed: the last good answer, if it is recent enough */
  for (const k of need) {
    if (answered.has(k) || byMint.has(k)) continue;
    const m = DEX_MEM.get(memKey(k));
    if (m && m.p && now - m.at < DEX_KEEP_MS) byMint.set(k, m.p);
  }

  /* DexScreener refused, or has never heard of it: ask pump.fun. Its own
     market-activity endpoint carries price change, volume and buys/sells —
     the colour and the size of the map — and answers the Worker when
     DexScreener's shared-IP limit does not. It has no liquidity, so those
     tokens are marked `liqUnknown` and judged by turnover instead (see
     scoreMemecoins). Solana only: it is pump.fun's API. */
  const fromPump = new Map();
  if (chain === 'solana') {
    const miss = mints.filter(k => !byMint.has(k));
    const ask = [];
    for (const k of miss) {
      const m = ACT_MEM.get(k);
      if (m && now - m.at < DEX_FRESH_MS) { if (m.a) fromPump.set(k, m.a); }
      else ask.push(k);
    }
    if (ask.length) {
      let got = new Map();
      try { got = await fetchActivity(ask); } catch { got = new Map(); }
      for (const k of ask) {
        const a = got.get(k);
        if (a) { ACT_MEM.set(k, { at: now, a }); fromPump.set(k, a); }
        else {
          const m = ACT_MEM.get(k);
          if (m && m.a && now - m.at < DEX_KEEP_MS) fromPump.set(k, m.a);
          /* "nothing for this one" is an answer too — not re-asked for a minute */
          else ACT_MEM.set(k, { at: now, a: null });
        }
      }
      if (ACT_MEM.size > DEX_MEM_MAX) ACT_MEM.clear();
    }
  }

  let hit = 0;
  for (const t of tokens) {
    const a = fromPump.get(keyOf(t));
    if (a && !byMint.has(keyOf(t))) {
      const w = x => (a[x] && a[x].priceChangePercent != null && Number.isFinite(+a[x].priceChangePercent)) ? +a[x].priceChangePercent : null;
      const d = a['24h'];
      if (!d && !a['1h']) continue;
      hit++;
      t.pc = { ...(t.pc || {}), m5: w('5m'), h1: w('1h'), h6: w('6h'), h24: w('24h') };
      t.vol = num(d && d.volumeUSD);
      t.volH1 = num(a['1h'] && a['1h'].volumeUSD);
      const buys = num(d && d.numBuys), sells = num(d && d.numSells), n = buys + sells;
      t.txns = n ? { buys, sells, n, sellShare: sells / n } : null;
      t.liqUnknown = true;
      continue;
    }
    const p = byMint.get(keyOf(t));
    if (!p) continue;
    hit++;
    const pc = p.priceChange || {};
    /* Absent stays absent. DexScreener omits a window entirely when nothing
       traded in it — LINK on Robinhood Chain comes back as {h24:-1.38} with no
       h1 key at all — and num() turned that missing key into 0, so the map
       asserted the price had not moved in an hour when nothing had measured
       it. Invisible on pump.fun, where everything trades every minute;
       glaring on a chain full of quiet pairs. */
    t.pc = { m5: keep(pc.m5), h1: keep(pc.h1), h6: keep(pc.h6), h24: keep(pc.h24) };
    /* Trade counts and the last hour's volume. Both were in every response
       already and thrown away: counts are what separates a market from a
       handful of wallets, and an hour against the daily average is what
       separates "trending" from "traded a lot yesterday". */
    t.txns = txnsOf(p);
    t.volH1 = num(p.volume && p.volume.h1);
    t.vol = num(p.volume && p.volume.h24);
    t.liq = num(p.liquidity && p.liquidity.usd);
    t.price = num(p.priceUsd);
    /* DexScreener's own market cap, kept beside the feed's rather than over
       it: pump.fun's figure stays the one the map draws, and a source with no
       feed of its own (the tap arena) has this to read. */
    t.dexMcap = num(p.marketCap) || num(p.fdv);

    /* A few pump.fun records carry no image_uri at all — the art lives only in
       their metadata_uri, which would cost an extra fetch per token. Since
       DexScreener has already been called for the price change, take its image
       when pump.fun has none. pump.fun stays the preferred source; this only
       fills a gap that would otherwise render as a blank circle. */
    if (!t.rawImg && p.info && p.info.imageUrl) t.rawImg = fastImage(p.info.imageUrl);
  }
  return hit;
}

/* Buys and sells over 24h, and what share of them were sells.

   A market has two sides. When almost every trade is a buy, either nobody can
   sell or the buys are the same few wallets going round — and the holder cannot
   tell which, because both look like a chart that only goes up. Measured across
   sixty traded pump.fun tokens the median sell share is 46%; USWS sat at 0.9%,
   811 buys against 7 sells, on a $97M market cap. */
export function txnsOf(p) {
  const h = (p && p.txns && p.txns.h24) || null;
  if (!h) return null;
  const buys = num(h.buys), sells = num(h.sells);
  const n = buys + sells;
  if (!n) return null;
  return { buys, sells, n, sellShare: sells / n };
}

/* ====================================================== change from history
   Fallback for anything DexScreener does not cover (fresh / pre-graduation
   tokens): derive change from our own market-cap snapshots.

   Retention is tiered so 24h of history costs ~120 samples per token rather
   than 8640: keep everything under 10min, then thin out with age. */
/* Calibrated, not guessed: across sixty traded pump.fun tokens the median sell
   share is 46.4%, and everything under 10% was a honeypot shape (USWS 0.9%,
   UPONLY 2.9%, SPSN 3.2%). NIKE at 10.5% and LBRETT at 13.1% are left alone. */
export const ONEWAY_SELL_SHARE = 0.10;
export const ONEWAY_MIN_TXNS = 30;

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
const UNKNOWN_LIQ_TURNOVER = 2000;  // mcap/24h volume, used only when liquidity is unknown

/* A floor on what is worth drawing.

   The backing test was doing its job — a third of the bonding feed fails it —
   but passing it does not make a token worth looking at. What survived included
   a $51 market cap and several under $2,000: correctly backed, economically
   nothing, and together they make the map look like junk.

   This is inventory selection, not a quality judgement dressed as arithmetic. A
   screener chooses what to put on screen, and a bubble worth $51 is noise
   rather than information. The number sits above the dust and well below
   anything with a community: measured on a live feed, the median bonding token
   was $11.5k. */
const MIN_BONDING_MCAP = 5000;
const DEAD_VOLUME = 1000;   // USD in 24h, below this nobody is trading it
export const MAX_COPIES = 2; // same ticker across more mints than this is a swarm

/* `kind` selects the rules. 'memecoin' is the full check — an unbacked market
   cap and a copycat ticker swarm are the two ways a launchpad feed lies.
   'major' skips them: Bitcoin trades across every venue at once, so no single
   pool's depth describes it, and two coins sharing a ticker in the top 200 is
   a naming collision rather than a swarm. Applying memecoin rules there would
   flag the entire market as unbacked. */
export function scoreQuality(tokens, solPrice = 0, kind = 'memecoin') {
  if (kind === 'major') {
    for (const t of tokens) {
      t.copies = 1;
      t.ageH = 0;
      t.mcLiq = null;
      t.flags = [];
      t.solid = t.mcap > 0;
      delete t.curveSol;
    }
    return tokens;
  }
  return scoreMemecoins(tokens, solPrice);
}

function scoreMemecoins(tokens, solPrice = 0) {
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
    /* Unknown age is null, not zero. A missing creation timestamp became "0
       hours old", which flagged the token `new` and declared its 24h figures
       meaningless — METAc, a tokenised Meta with $1.2M of liquidity behind it,
       was marked a fresh mint purely because the feed it came from does not
       carry a creation date. */
    t.ageH = t.created ? (now - t.created) / 36e5 : null;
    t.mcLiq = t.liq > 0 ? t.mcap / t.liq : null;

    /* With liquidity measured, the pool decides. Without it — DexScreener
       refused and pump.fun's activity filled the colour — turnover stands in:
       a cap nobody trades is paper whatever its pool. Fartcoin at $168M turns
       over its cap every week or so; the $4B copycat swarms at the top of
       pump.fun's own ranking trade next to nothing. */
    const thin = t.liqUnknown
      ? !(t.vol > 0) || t.mcap / t.vol > UNKNOWN_LIQ_TURNOVER
      : (t.mcLiq === null || t.mcLiq > THIN_RATIO);

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
    /* One-way market: buys but effectively no sells. Below a tenth of trades
       being sells is five times under the measured median and is the shape of a
       token nobody is getting out of. Needs enough trades to be a pattern
       rather than an accident of three transactions. */
    if (t.txns && t.txns.n >= ONEWAY_MIN_TXNS && t.txns.sellShare < ONEWAY_SELL_SHARE) {
      t.flags.push('oneway');
    }
    if (t.ageH != null && t.ageH < 24) t.flags.push('new'); // 24h numbers meaningless here

    /* "is this market cap backed by anything" rather than "is this a scam" —
       intent is unknowable, backing is measurable. `new` is not disqualifying:
       plenty of real tokens are hours old, and this is a pump.fun screener. */
    /* pump.fun bans tokens itself. Ignoring that flag meant re-deciding, worse,
       something they had already decided. */
    if (t.banned) t.flags.push('banned');

    /* Only bonding tokens get the floor. A graduated token with a small cap has
       a real pool behind it and belongs on the map; a bonding one at $51 has
       nothing behind it worth a bubble. */
    const dust = !t.grad && t.mcap < MIN_BONDING_MCAP;
    if (dust) t.flags.push('dust');

    /* A one-way market counts against `solid` like every other measurement
       here. Setting the flag alone only wrote a warning line onto a bubble that
       stayed on screen: USWS carried `oneway` and `solid: true` at the same
       time, so it was still the fourth largest thing on the map. */
    const oneway = t.flags.includes('oneway');
    t.solid = !thin && !dead && !dust && !oneway && !t.banned && t.copies <= MAX_COPIES;
  }
  for (const t of tokens) delete t.curveSol;
  return tokens;
}

/* ================================================================ snapshot */
/* `source` is an adapter from sources.mjs: it knows how to fetch its own feed,
   whether DexScreener can tell us anything useful about it, and which quality
   rules apply. Everything downstream of the fetch is shared. */
export async function buildSnapshot({ source, hist, secret, store } = {}) {
  const now = Date.now();
  if (!source || typeof source.fetch !== 'function') throw new Error('no source');

  const [tokens, sol] = await Promise.all([
    /* Most sources are a plain HTTP call. Robinhood Chain has no endpoint that
       ranks it, so its list is accumulated in KV over many ticks and it needs
       the store to read that registry. */
    source.fetch(store),
    /* only needed to price bonding-curve liquidity, which is a Solana idea */
    source.chain === 'solana' ? fetchSolPrice() : Promise.resolve(0),
  ]);

  let enriched = 0;
  if (source.enrich !== false) {
    try { enriched = await enrich(tokens, source.chain); }
    catch { /* colour degrades, the map still renders */ }
  }

  scoreQuality(tokens, sol, source.quality);

  /* History is keyed by token id, which is unique per source — a Solana mint
     for launchpads, a coingecko id for the wider market. */
  /* A source whose `mcap` is not a market cap opts out. Traders size by
     realized profit, and pushing that into the price history would back-fill
     their 1H and 6H "price change" from how their profit moved — a number
     with a price change's label and nothing of one's meaning. */
  if (hist && source.history !== false) {
    pushHistory(hist, tokens, now);
    for (const t of tokens) {
      const own = changeFromHistory(hist, t.id, t.mcap, now);
      /* our own history only fills gaps the feed left */
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
  /* `dexMcap` is enrichment's working note — DexScreener's own market cap,
     which only a source with no market cap of its own (the tap arena) reads.
     It was going out on 293 of 300 tokens to every visitor, and nothing on the
     page has ever looked at it. Stripped here, beside rawImg, for the same
     reason: a field the client does not read is payload it still pays for. */
  for (const t of tokens) { delete t.rawImg; delete t.dexMcap; }

  return {
    ts: now, sol, count: tokens.length, enriched, withArt, sampleArt,
    solid: tokens.filter(t => t.solid).length,
    signed: !!secret,
    source: source.id, sourceLabel: source.label, boostable: !!source.boostable,
    tokens,
  };
}
