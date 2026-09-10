/* ==========================================================================
   pumpbubble.fun — HTTP API, shared by the Worker and the local dev server.
   Written against web-standard Request/Response, which Node 22 and Workers
   both provide, so there is exactly one implementation of every route.
   ========================================================================== */

import { buildSnapshot, verifyUrl, isMint, isCA, isEvmAddr, fetchCoin, fetchSolPrice,
         signUrl, enrich, resolveAnyToken } from './core.mjs';
import { embedConfig, safeAccent } from './embed.mjs';
import { buyConfig } from './refs.mjs';
import { pctLabel, TF_LABEL, TF_SHORT, CARD_W } from './card.mjs';
import { cardSvgFor, boardCardSvgFor, sharePage, page } from './share.mjs';
import { svgToPng } from './png.mjs';
import { creds as xCreds, KEY as XBOT_KEY, topMovers, build as buildPost } from './xbot.mjs';
import { discover } from './rhchain.mjs';
import { refreshUniverse, sweep as baseSweep, seed as baseSeed, loadCache as baseCache } from './basechain.mjs';
import { refreshFlows } from './flows.mjs';
import { buildTrending, TREND_SOURCES } from './trending.mjs';
import { adminEnabled, adminPath, authed, adminPage,
         lockedOut, noteFailure, clearFailures } from './admin.mjs';
import { loadRegistry as rhRegistry, seed as rhSeed } from './rhchain.mjs';
import { loadWindows, applyWindows, refreshWindows } from './stockwin.mjs';
import {
  loadWindows as loadCryptoWin,
  applyWindows as applyCryptoWin,
  refreshWindows as refreshCryptoWin,
} from './cryptowin.mjs';
import { SOURCES, DEFAULT_SOURCE, sourceOf, publicSources, setCoingeckoKey } from './sources.mjs';
import { renderMarketPage, marketTable, marketSummary, marketJsonLd,
         boardTable, boardSummary, boardJsonLd } from './seo.mjs';
import { resolveReferral, statement, getAffiliate, isCode } from './affiliates.mjs';
import { shouldCount, record, dueForFlush, flush as flushStats, summary as statsSummary } from './stats.mjs';
import { board, priceFor, standing, countClick, bidsAsBoostSpend,
         FLOOR_SOL, INCREMENT_SOL } from './bids.mjs';
import {
  TIERS, tierOf, createOrder, signOrder, readOrder, findPayment,
  activeBoosts, activateBoost, applyBoosts, goldShare, bonusFromSpend,
  addPending, listPending, sweepPayments, ORDER_TTL_MS,
} from './boosts.mjs';

const SNAPSHOT_TTL = 10_000;      // pump.fun poll interval
const STALE_OK     = 120_000;     // serve stale rather than fail
const IMG_TTL      = 604_800;     // a token's art never changes: cache a week
const GOLD_CAP     = 0.25;        // hard ceiling on paid share of bubble area
const VIEW_N       = 100;         // bubbles the default desktop view shows

/* Gold share has to be measured against what is actually on screen. Measuring
   it across all 300 fetched tokens would dilute it and quietly allow
   over-selling, so use the default view — the top VIEW_N by market cap — plus
   any boosted token, which is pinned into the view wherever its cap sits. */
function visibleSet(tokens, byMint) {
  const top = [...tokens].sort((a, b) => b.mcap - a.mcap).slice(0, VIEW_N);
  const have = new Set(top.map(t => t.mint));
  for (const t of tokens) if (byMint.has(t.mint) && !have.has(t.mint)) top.push(t);
  return top;
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...extra,
  },
});

/* ---------------------------------------------------------- rate limiting */
/* Per-isolate, in memory. Deliberately not KV: a limiter that writes to KV can
   be used to exhaust the very quota it protects. This stops the obvious abuse
   (one client hammering one colo) at zero cost. The real edge-wide limit
   belongs in a Cloudflare Rate Limiting rule — see docs/security.md. */
const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')
    || 'local';
  const key = bucket + ':' + ip;
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    return null;
  }
  if (++rec.n > max) {
    return json({ ok: false, error: 'slow down — too many requests' }, 429,
      { 'retry-after': String(Math.ceil((rec.reset - now) / 1000)) });
  }
  return null;
}

/* ------------------------------------------------------- snapshot cache */
/* One fetch per TTL per isolate, with in-flight de-duplication so a burst of
   visitors cannot fan out into a burst of pump.fun calls. */
/* One cache per mode: graduated and bonding are separate feeds with different
   lifetimes, and a shared cache would have them evicting each other every poll. */
const caches = new Map();

/* Market data for boosted tokens that are not in the feed being shown.

   A boost is bought for a small token, and small is exactly what does not make
   pump.fun's top-cap pages — so the paid bubble is re-added below, from the
   boost record. That record holds what was paid, not what the token is doing,
   and for a long time the re-added bubble therefore carried a hardcoded zero
   change and zero volume. It rendered as a confident "+0.00%" on the token the
   site most wants people to look at, and would now mint share cards saying the
   same. DexScreener has the real figures; they just were never asked for.

   Cached separately from the snapshot because the re-add happens per request,
   after it. One upstream call a minute for a handful of paid mints. */
/* Which feeds the ranked card is allowed to draw from, and what it calls them.
   A table rather than free text out of the query string: the value reaches the
   rasteriser and is printed onto an image that carries our domain. */
const BOARD_SRC = { pumpfun: 'pumpfun', majors: 'majors', stocks: 'stocks', robinhood: 'robinhood', base: 'base', trending: 'trending' };
const BOARD_SUB = { pumpfun: 'PUMP.FUN · 24H', majors: 'MARKET · 24H', stocks: 'STOCKS · 24H' };
const BOARD_TITLE = {
  pumpfun: 'Top movers on pump.fun today',
  majors: 'Top movers in crypto today',
  stocks: 'Biggest movers in stocks today',
  robinhood: 'Top movers on Robinhood Chain today',
  base: 'Top movers on Base today',
  trending: 'Trending right now across every chain',
};

/* How long a collapsed build waits before trying again. Short, because it
   means an upstream is unwell rather than a market genuinely emptying. */
const EMPTY_RETRY_MS = 20_000;

const boostMkt = new Map();
const BOOST_MKT_TTL = 60_000;

const cacheFor = mode => {
  if (!caches.has(mode)) caches.set(mode, { at: 0, data: null, inflight: null, err: null });
  return caches.get(mode);
};

/* Older links said mode=graduated|bonding. Keep them working rather than
   breaking every embed and bookmark that already exists. */
const LEGACY_MODES = { graduated: 'pumpfun', bonding: 'bonding', all: 'pumpfun' };

function resolveSource(url) {
  const q = url.searchParams.get('source') || '';
  if (SOURCES[q]) return SOURCES[q];
  const legacy = LEGACY_MODES[url.searchParams.get('mode') || ''];
  return SOURCES[legacy] || SOURCES[DEFAULT_SOURCE];
}

/* Locate one token for a share card. Goes through the same feed the map is
   built from rather than a source directly, so a card carries the merged
   figures - boosts, and the long windows filled in by cron - instead of the
   raw upstream row, which has neither. */
async function findToken(ctx, origin, { mint, sym, srcId }) {
  const order = srcId ? [srcId] : (mint ? ['pumpfun'] : ['majors', 'stocks', 'pumpfun']);
  for (const id of order) {
    if (!sourceOf(id)) continue;
    try {
      const r = await handle(new Request(origin + '/api/tokens?source=' + id), ctx);
      if (!r || !r.ok) continue;
      const j = await r.json();
      const list = (j && j.tokens) || [];
      const hit = mint
        ? list.find(t => t.mint === mint)
        : list.find(t => String(t.sym || '').toUpperCase() === sym);
      if (hit) return { t: hit, srcId: id };
    } catch { /* try the next source */ }
  }
  /* A mint the map does not currently rank is still a real token. */
  if (mint && isMint(mint)) {
    try {
      const t = await fetchCoin(mint, ctx.env.IMG_SECRET);
      if (t) return { t, srcId: 'pumpfun' };
    } catch { /* fall through */ }
  }
  return null;
}

async function snapshot(ctx, source, force = false) {
  const src = typeof source === 'string' ? sourceOf(source) : (source || sourceOf(DEFAULT_SOURCE));
  const cache = cacheFor(src.id);
  const now = Date.now();
  /* Each source sets its own lifetime. pump.fun tolerates a 10s poll; the free
     GeckoTerminal and CoinGecko tiers are ~30 requests a minute shared across
     all our traffic, so those feeds are cached far longer. Bitcoin's market cap
     does not move enough in ten seconds to be worth a request. */
  const ttl = src.ttl || SNAPSHOT_TTL;
  if (!force && cache.data && now - cache.at < ttl) return cache.data;
  if (cache.inflight) return raceStale(cache, cache.inflight);

  cache.inflight = (async () => {
    /* Sources marked `shared` are cached in KV as well as in memory. Isolates
       do not share memory, so a per-isolate cache multiplies our upstream
       request count by however many isolates Cloudflare is running — which is
       how a feed with a 2-minute TTL still managed to get itself 429'd. KV is
       the one cache every isolate can see. */
    const kvKey = 'snap:' + src.id;
    if (src.shared && !force) {
      try {
        const saved = await ctx.store.get(kvKey);
        /* Same rule on the way in. A namespace written by an older build may
           still hold an empty snapshot, and reading it back would reinstate
           exactly the outage the write guard exists to prevent. */
        if (saved && saved.tokens && saved.tokens.length && Date.now() - saved.ts < ttl) {
          cache.data = saved; cache.at = Date.now(); cache.err = null;
          return saved;
        }
      } catch { /* KV miss is not an error, just a slower path */ }
    }

    try {
      /* Trending is composed rather than fetched: it ranks the feeds against
         each other, so it has no upstream of its own. Built here rather than in
         a source's fetch() because it needs snapshot(), and each member feed
         keeps its own cache and its own lifetime. */
      const snap = src.id === 'trending'
        ? await (async () => {
            const feeds = [];
            for (const id of TREND_SOURCES) {
              try {
                const m = await snapshot(ctx, sourceOf(id));
                feeds.push({ id, tokens: m.tokens || [] });
              } catch { /* a feed that is down simply does not contribute */ }
            }
            const tokens = buildTrending(feeds);
            return {
              ts: Date.now(), sol: 0, count: tokens.length,
              enriched: tokens.length, withArt: tokens.filter(t => t.img).length,
              sampleArt: '', solid: tokens.length, signed: true,
              source: 'trending', sourceLabel: 'Trending', boostable: true,
              tokens,
            };
          })()
        : await buildSnapshot({
            source: src,
            hist: ctx.hist,
            secret: ctx.env.IMG_SECRET,
            store: ctx.store,
          });
      /* An empty build is a failure wearing a success's clothes. Every upstream
         here fails by returning nothing rather than by throwing — a 429, a
         timeout, a shape that changed — and buildSnapshot cannot tell the
         difference between "the feed is down" and "the chain has no tokens".

         Caching that answer is what turns a blip into an outage: an empty
         snapshot went into KV during a deploy, every isolate then read it back
         as valid for the whole TTL, and the map served one bubble for minutes
         after the upstream had recovered. So an empty result never replaces
         data we already have, and never reaches KV; it just retries sooner. */
      const got = (snap.tokens && snap.tokens.length) || 0;
      const had = (cache.data && cache.data.tokens && cache.data.tokens.length) || 0;

      /* Not just empty — *collapsed*. A pump.fun snapshot is six paged requests
         and ten DexScreener ones; when half of them fail the build still
         succeeds, with a fraction of the feed in it. That is how a map that
         should show three hundred bubbles showed eight, and then kept showing
         eight because the result was cached like any other.

         A quarter of what we had is far outside normal churn for every source
         here, so it is treated as a bad build rather than a small market. */
      /* Token count is not enough on its own. A pump.fun build can return all
         three hundred tokens with the DexScreener pass having failed, and
         liquidity is what decides whether a market cap is backed — so every
         bubble becomes "unbacked", the map's own filter hides them, and three
         hundred tokens render as eight. That is what this looked like from the
         outside, and the snapshot behind it looked perfectly healthy by count.

         So a collapse in enrichment is treated exactly like a collapse in
         tokens, for the sources that depend on it. */
      const enrNow = snap.enriched || 0;
      const enrWas = (cache.data && cache.data.enriched) || 0;
      const enrichBroke = src.enrich !== false && enrWas > 0 && enrNow < enrWas * 0.25;

      const empty = got === 0 || (had > 0 && got < had * 0.25) || enrichBroke;

      if (empty && had) {
        /* Keep the good data, and come back well before the normal lifetime. */
        cache.at = Date.now() - Math.max(0, ttl - EMPTY_RETRY_MS);
        return cache.data;
      }

      cache.data = snap;
      cache.at = empty ? Date.now() - Math.max(0, ttl - EMPTY_RETRY_MS) : Date.now();
      cache.err = null;
      if (src.shared && !empty) {
        try { await ctx.store.put(kvKey, snap); } catch { /* non-fatal */ }
      }
      ctx.onSnapshot?.(snap);
      return snap;
    } catch (e) {
      cache.err = String(e && e.message || e);
      /* Stale data beats an empty map — the front end shows the age. */
      if (cache.data && Date.now() - cache.at < STALE_OK) return cache.data;
      /* For a shared source, fall back to whatever KV holds however old it is.
         A five-minute-old market cap is worth far more than an error page, and
         being rate-limited upstream must not empty the map. */
      if (src.shared) {
        try {
          const saved = await ctx.store.get(kvKey);
          if (saved) { cache.data = saved; return saved; }
        } catch { /* fall through to the throw */ }
      }
      throw e;
    } finally {
      cache.inflight = null;
    }
  })();
  return raceStale(cache, cache.inflight);
}

/* A build that is taking too long must not become a page that never loads.

   Every upstream call has a 9s timeout, but a pump.fun snapshot makes six paged
   requests plus ten DexScreener ones in sequence, so a slow upstream can stall
   the build for a minute — and because everyone shares the in-flight promise,
   every visitor waits exactly that long. Measured in production: one request
   hung for 60 seconds while the next returned in 1.2.

   So the wait is bounded. Past the deadline, whatever is already cached is
   served however old it is, and the build carries on in the background to
   refresh it. Stale data with its age shown beats a spinner, and the front end
   already displays that age. With nothing cached there is nothing to serve, so
   the wait is the only option and the build is awaited in full. */
const BUILD_DEADLINE = 6000;

function raceStale(cache, inflight) {
  if (!cache.data) return inflight;
  return Promise.race([
    inflight,
    new Promise(resolve => setTimeout(() => resolve(cache.data), BUILD_DEADLINE)),
  ]);
}

/* The SOL price, reliably.

   Both a boost and a bid need it to price an order, and both used to read it
   off whatever snapshot happened to be cached. On a cold isolate that is empty,
   so checkout answered "no SOL price available right now" — the one error that
   costs a sale outright. It now falls through three sources, and the KV copy
   means a cold isolate never has to wait on pump.fun to quote a price. */
let solMem = { at: 0, price: 0 };
const SOL_TTL = 120_000;

async function solPriceNow(ctx) {
  const now = Date.now();
  if (solMem.price > 0 && now - solMem.at < SOL_TTL) return solMem.price;

  const cached = cacheFor('pumpfun').data?.sol;
  if (cached > 0) { solMem = { at: now, price: cached }; return cached; }

  try {
    const saved = await ctx.store.get('sol:price');
    if (saved?.price > 0 && now - saved.at < 10 * 60_000) {
      solMem = { at: now, price: saved.price };
      return saved.price;
    }
  } catch { /* KV miss just means we fetch */ }

  const fresh = await fetchSolPrice().catch(() => 0);
  if (fresh > 0) {
    solMem = { at: now, price: fresh };
    try { await ctx.store.put('sol:price', { price: fresh, at: now }); } catch {}
    return fresh;
  }

  /* Last resort: a stale KV price beats refusing the sale. A rate that is ten
     minutes old misprices an order by a fraction of a percent; refusing to
     quote loses the whole thing. */
  try {
    const saved = await ctx.store.get('sol:price');
    if (saved?.price > 0) return saved.price;
  } catch {}
  return 0;
}

/* =============================================================== routes */
export async function handle(req, ctx) {
  setCoingeckoKey(ctx.env.COINGECKO_KEY);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  /* Count page reads here, where every request passes, rather than from a
     script an ad blocker or our own CSP would stop. Never let counting fail a
     request — a missed pageview is not worth a 500. */
  if (ctx.store?.available && shouldCount(path, req.method)) {
    try {
      await record(req, path, ctx.env.IMG_SECRET || 'salt');
      if (dueForFlush()) {
        const p = flushStats(ctx.store);
        if (ctx.waitUntil) ctx.waitUntil(p); else await p;
      }
    } catch { /* best effort */ }
  }

  try {
    /* ------------------------------------------------------- /api/tokens */
    if (path === '/api/tokens') {
      const limited = rateLimit(req, 'tokens', 180, 60_000);
      if (limited) return limited;

      const src = resolveSource(url);
      const snap = await snapshot(ctx, src);
      const { byMint } = await activeBoosts(ctx.store);

      /* Bids join the same paid-size pool as boosts, converted through USD, so
         the renderer needs no idea that bids exist and there is one definition
         of "paid size" rather than two that drift apart. A token that has both
         gets the sum, which is the honest answer. */
      const bidRows = await board(ctx.store);
      if (bidRows.length) {
        const asSpend = bidsAsBoostSpend(bidRows, snap.sol || 0);
        for (const [mint, b] of asSpend) {
          const cur = byMint.get(mint);
          if (cur) {
            cur.liveUsd += b.liveUsd;
            cur.spentUsd += b.spentUsd;
            cur.until = Math.max(cur.until, b.until);
            cur.rank = b.rank;
            cur.bid = true;
          } else {
            byMint.set(mint, b);
          }
        }
        for (const v of byMint.values()) v.bonus = bonusFromSpend(v.liveUsd);
      }
      let tokens = applyBoosts(snap.tokens.map(t => ({ ...t })), byMint);

      /* Monthly and yearly change for stocks is filled in by cron, one slice at
         a time, and merged here. A symbol not reached yet reports null and
         renders grey rather than holding up the map. */
      if (src.id === 'stocks') {
        try { tokens = applyWindows(tokens, await loadWindows(ctx.store)); } catch {}
      }
      /* Same arrangement for the whole-market view, from Binance rather than
         Yahoo. CoinPaprika's own 30d and 1y are zero on the free tier. */
      if (src.id === 'majors') {
        try { tokens = applyCryptoWin(tokens, await loadCryptoWin(ctx.store)); } catch {}
      }

      /* A boosted token that dropped out of the pump.fun feed is re-added so a
         paid bubble never disappears before its time is up. */
      /* Keyed the same way applyBoosts is. Built from `mint` alone this set
         was {''} for an EVM chain, so a boosted Base token was judged absent
         and re-added next to the copy that was already there — two gold MAC
         bubbles, one of them with no data behind it. */
      const have = new Set(tokens.map(t => t.addr || t.mint));
      const readd = [];
      for (const [mint, b] of byMint) {
        if (have.has(mint)) continue;

        /* Art has to go through the signed proxy, exactly like every token in
           the feed. A raw ipfs.io URL is blocked by the page's own CSP
           (img-src 'self'), so a re-added bubble rendered with no picture at
           all — which is the whole point of a paid bubble, missing. The tokens
           built by buildSnapshot are signed there; these never passed through
           it, so they are signed here. */
        let img = '';
        if (b.img && ctx.env.IMG_SECRET) {
          try {
            /* Already a proxy URL if the boost was stored after this landed;
               a raw upstream URL if it was stored before. Sign only the raw
               ones, or the second signing would sign the proxy path itself. */
            img = b.img.startsWith('/api/img?')
              ? b.img
              : '/api/img?u=' + encodeURIComponent(b.img) +
                '&s=' + await signUrl(b.img, ctx.env.IMG_SECRET);
          } catch { img = ''; }
        }
        /* A paid bubble appears in whichever view the visitor is looking at,
           regardless of which feed the token came from. Scoping it to its own
           feed meant a boosted bonding token was invisible on the default map —
           the buyer paid and saw nothing, which is the one outcome that cannot
           happen here.
           The scale problem that scoping was meant to solve is handled where it
           belongs, in sizes(): a boosted bubble is sized by what was paid rather
           than by its market cap, so an out-of-place cap no longer distorts
           anything. */
        /* A boost on an EVM chain carries a contract address where a Solana
           boost carries a mint. Putting that address in `mint` would send the
           chart link to pump.fun, which has never heard of it. */
        const evm = /^0x[0-9a-fA-F]{40}$/.test(mint);
        readd.push({
          id: (b.chain ? b.chain + ':' : '') + mint,
          mint: evm ? '' : mint,
          ...(evm ? { addr: mint.toLowerCase() } : {}),
          sym: b.sym || mint.slice(0, 4), name: b.name || b.sym || 'boosted',
          img, mcap: b.mcap || 0, vol: 0,
          /* null, not zero. If nothing below fills these in, the map greys the
             bubble and the share card refuses to render — both of which say
             "we do not know" instead of "it did not move". */
          pc: { m5: null, h1: null, h6: null, h24: null },
          grad: true, solid: true, flags: [], copies: 1,
          boost: b.bonus, boostUsd: b.spentUsd, boostUntil: b.until,
        });
      }

      if (readd.length) {
        const now = Date.now();
        const keyOf = t => t.addr || t.mint;
        const stale = readd.filter(t => {
          const c = boostMkt.get(keyOf(t));
          return !c || (now - c.at) > BOOST_MKT_TTL;
        });

        /* Solana boosts go through the batched DexScreener pass; a boost on any
           other chain is resolved individually, because enrich() is told one
           chain per call and these can be on several at once. There are only
           ever a handful of paid bubbles, so one request each is cheap. */
        const evmStale = stale.filter(t => isEvmAddr(keyOf(t)));
        const solStale = stale.filter(t => !isEvmAddr(keyOf(t)));

        if (solStale.length) {
          try {
            await enrich(solStale);
            for (const t of solStale) {
              /* enrich fills rawImg when a token has no art; these already
                 carry a signed proxy URL, so the raw one would only travel
                 unused and blocked by the page's own CSP. */
              delete t.rawImg;
              boostMkt.set(keyOf(t), { at: now, pc: t.pc, vol: t.vol, price: t.price, mcap: t.mcap });
            }
          } catch { /* leave them null; grey is honest */ }
        }

        for (const t of evmStale) {
          try {
            const live = await resolveAnyToken(keyOf(t), ctx.env.IMG_SECRET);
            if (!live) continue;
            boostMkt.set(keyOf(t), {
              at: now, pc: live.pc, vol: live.vol, price: live.price, mcap: live.mcap,
            });
          } catch { /* grey is honest */ }
        }

        for (const t of readd) {
          const c = boostMkt.get(keyOf(t));
          if (!c) continue;
          if (c.pc) t.pc = c.pc;
          if (Number.isFinite(c.vol)) t.vol = c.vol;
          if (Number.isFinite(c.price)) t.price = c.price;
          /* A boost record stores the market cap at purchase. Months later that
             is a stale number wearing a live label. */
          if (Number.isFinite(c.mcap) && c.mcap > 0) t.mcap = c.mcap;
        }
        tokens.push(...readd);
      }

      return json({
        ok: true,
        ts: snap.ts,
        age: Date.now() - snap.ts,
        sol: snap.sol,
        source: snap.source,
        sourceLabel: snap.sourceLabel,
        boostable: snap.boostable,
        sources: publicSources(),
        /* Sent once per response rather than per token: 300 near-identical
           URLs for a button most visitors never press is wasted payload. */
        buy: buyConfig(ctx.env),
        enriched: snap.enriched,
        withArt: snap.withArt,
        signed: snap.signed,
        mode: src.id,
        solid: snap.solid,
        goldShare: goldShare(visibleSet(tokens, byMint)),
        stale: Date.now() - snap.ts > SNAPSHOT_TTL * 3,
        tokens,
      });
    }

    /* --------------------------------------------------------- /api/stats */
    /* Public on purpose. Nobody bids for attention without evidence the
       attention exists, so the traffic number is part of the pitch — the same
       reason outbid.lol puts its visitor count on its own board. */
    if (path === '/api/stats') {
      const s = await statsSummary(ctx.store, 7);
      return json({ ok: true, ...s }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/board */
    /* The board rendered as HTML for the worker to inject. Same reason as
       /market: this is the page people link to when they take #1, and a link
       that unfurls into an empty canvas gets clicked once. */
    if (path === '/api/board') {
      const rows = await board(ctx.store);
      return json({
        ok: true,
        ts: Date.now(),
        summary: boardSummary(rows, { floor: FLOOR_SOL }),
        table: boardTable(rows, { increment: INCREMENT_SOL, floor: FLOOR_SOL }),
        jsonld: boardJsonLd(rows, 'https://pumpbubble.fun/board'),
      }, 200, { 'cache-control': 'public, max-age=15' });
    }

    /* ---------------------------------------------------------- /api/bids */
    /* The board, and what each rank costs to take. Public and unauthenticated:
       the whole mechanic depends on everyone being able to see the price of
       being #1 without committing to anything. */
    if (path === '/api/bids') {
      const rows = await board(ctx.store);
      const top = await priceFor(ctx.store, 1);
      return json({
        ok: true,
        floorSol: FLOOR_SOL,
        incrementSol: INCREMENT_SOL,
        treasury: ctx.env.TREASURY_WALLET || null,
        top,
        board: rows,
      });
    }

    /* Where a given token stands, and the cheapest way up. Quoting the gap
       rather than the full price is what makes defending a rank affordable
       enough that a bidding war actually happens. */
    if (path === '/api/bid/standing') {
      const mint = url.searchParams.get('mint') || '';
      if (!isMint(mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);
      return json({ ok: true, ...(await standing(ctx.store, mint)) });
    }

    /* --------------------------------------------------- /api/bid/order */
    if (path === '/api/bid/order' && req.method === 'POST') {
      const limited = rateLimit(req, 'order', 30, 600_000);
      if (limited) return limited;

      /* Same three refusals as a boost: never quote a price we cannot honour. */
      if (!ctx.env.TREASURY_WALLET) return json({ ok: false, error: 'bidding is not open yet' }, 503);
      if (!ctx.store.available) return json({ ok: false, error: 'bidding is temporarily closed — storage is not configured' }, 503);
      if (!ctx.env.SOLANA_RPC) return json({ ok: false, error: 'bidding is temporarily closed — no Solana RPC configured' }, 503);

      const body = await req.json().catch(() => ({}));
      /* Bids stay Solana-only. The board ranks pump.fun tokens and nothing here
         has been taught to price anything else; widening it would be a money
         path nobody had asked for. */
      if (!isMint(body.mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);

      const solAmount = Number(body.sol);
      if (!(solAmount >= FLOOR_SOL)) {
        return json({ ok: false, error: `the smallest bid is ${FLOOR_SOL} SOL` }, 400);
      }

      /* Identity comes from our own data, never the caller — same rule as a
         boost. A bid can name any pump.fun token, including one too small to be
         on the map, which is exactly who wants to buy visibility. */
      let tok = null;
      for (const sid of ['pumpfun', 'bonding']) {
        const s = cacheFor(sid).data;
        tok = s?.tokens.find(t => t.mint === body.mint);
        if (tok) break;
      }
      if (!tok) tok = await fetchCoin(body.mint, ctx.env.IMG_SECRET);
      if (!tok) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);

      const solPrice = await solPriceNow(ctx);
      if (!(solPrice > 0)) return json({ ok: false, error: 'no SOL price available right now' }, 503);

      const inFlight = (await listPending(ctx.store)).map(o => o.lamports);
      const refCode = isCode(body.ref) && await getAffiliate(ctx.store, body.ref) ? body.ref : '';

      let order;
      try {
        order = await createOrder({
          kind: 'bid', bidSol: solAmount, taken: inFlight,
          mint: body.mint, sym: tok.sym, name: tok.name, img: tok.img, mcap: tok.mcap,
          grad: !!tok.grad, solPrice, treasury: ctx.env.TREASURY_WALLET, ref: refCode,
        });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 400);
      }

      /* Say plainly where this lands them, before they pay. Being outbid later
         is the product working, but being surprised at checkout is not. */
      const st = await standing(ctx.store, body.mint);
      const rows = await board(ctx.store);
      const after = (st.current?.sol || 0) + order.amountSol;
      const wouldBeRank = rows.filter(r => r.mint !== body.mint && r.sol > after).length + 1;
      order.projection = {
        currentSol: st.current?.sol || 0,
        afterSol: Math.round(after * 1e6) / 1e6,
        rankNow: st.current?.rank || null,
        rankAfter: wouldBeRank,
      };

      await addPending(ctx.store, order);
      const token = await signOrder(order, ctx.env.IMG_SECRET);
      return json({ ok: true, order, token });
    }

    /* Click-throughs on a ranked token. Counted here rather than in the page so
       the number belongs to us — it is the evidence the next bidder weighs. */
    if (path === '/api/bid/click') {
      const mint = url.searchParams.get('mint') || '';
      if (!isMint(mint)) return json({ ok: false, error: 'bad mint' }, 400);
      const limited = rateLimit(req, 'click', 120, 60_000);
      if (limited) return limited;
      const clicks = await countClick(ctx.store, mint);
      return json({ ok: true, clicks });
    }

    /* ------------------------------------------------------------ /market */
    /* Dev serves the rendered page here; in production the worker does it so
       the injection happens ahead of the asset layer. Same renderer either way. */
    if ((path === '/market' || path === '/board') && ctx.readAsset) {
      const shell = await ctx.readAsset(path === '/board' ? '/board.html' : '/market.html');
      if (!shell) return null;
      let body = shell;
      if (path === '/board') {
        const rows = await board(ctx.store);
        body = shell
          .replace('<!--BOARD_SUMMARY-->', boardSummary(rows, { floor: FLOOR_SOL }))
          .replace('<!--BOARD_TABLE-->', boardTable(rows, { increment: INCREMENT_SOL, floor: FLOOR_SOL }))
          .replace('<!--BOARD_JSONLD-->', boardJsonLd(rows, 'https://pumpbubble.fun/board'));
      } else {
        const snap = await snapshot(ctx, 'majors').catch(() => null);
        if (snap) body = renderMarketPage(shell, snap, 'https://pumpbubble.fun/market');
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    /* -------------------------------------------------------- /api/market */
    /* The market page rendered as HTML, on the server. A canvas is an empty box
       to a crawler — measured, 196 indexable words on the homepage and not one
       coin name — which is why a market-overview query finds coin360 and not
       us. The adapters serve it; the worker injects it into the page. */
    if (path === '/api/market') {
      const snap = await snapshot(ctx, 'majors').catch(() => null);
      if (!snap) return json({ ok: false, error: 'market data unavailable' }, 503);
      return json({
        ok: true,
        ts: snap.ts,
        summary: marketSummary(snap.tokens),
        table: marketTable(snap.tokens),
        jsonld: marketJsonLd(snap.tokens, { url: 'https://pumpbubble.fun/market' }),
      }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/embed */
    /* What this embed is allowed to do. Called by the embedded page itself, so
       partner permissions are decided here rather than trusted from a query
       string that anyone could copy off someone else's site. */
    if (path === '/api/embed') {
      const cfg = await embedConfig(url.searchParams.get('k') || '', ctx.env.IMG_SECRET);
      return json({
        ok: true,
        ...cfg,
        accent: safeAccent(cfg.accent),
        home: 'https://pumpbubble.fun',
      }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/token */
    /* Resolve one mint so the boost modal can show the art and ticker as soon
       as a contract address is pasted. Paying is the wrong moment to discover
       which token you actually named. */
    if (path === '/api/token') {
      const limited = rateLimit(req, 'token', 60, 60_000);
      if (limited) return limited;

      const mint = url.searchParams.get('mint') || '';
      if (!isCA(mint)) return json({ ok: false, error: 'that is not a valid contract address' }, 400);

      /* prefer a feed we already hold — free, and already image-signed */
      /* check every warm cache, whichever sources happen to be loaded */
      const want = isEvmAddr(mint) ? mint.toLowerCase() : mint;
      for (const [sid, c] of caches) {
        const mode = sid;
        const hit = c.data?.tokens.find(t => (t.addr || t.mint) === want);
        if (hit) return json({ ok: true, token: hit, from: mode });
      }

      /* Not in any warm feed: resolve it on whatever chain it lives on. */
      const t = await resolveAnyToken(mint, ctx.env.IMG_SECRET);
      if (!t) return json({ ok: false, error: 'no token found with that contract address' }, 404);
      return json({ ok: true, token: t, from: t.chain || 'pump.fun' });
    }

    /* ------------------------------------------------------- /api/card */
    /* The share image. A PNG rather than the SVG it is built from, because X,
       Telegram and Discord all decline SVG in link previews. */
    if (path === '/api/card') {
      const limited = rateLimit(req, 'card', 60, 60_000);
      if (limited) return limited;

      const tf = url.searchParams.get('tf') || 'h24';
      if (!TF_LABEL[tf]) return json({ ok: false, error: 'unknown timeframe' }, 400);

      /* The ranked card. Same filters the poster uses, so what a project sees
         on the leaderboard is what the account would say about it. */
      if (url.searchParams.get('kind') === 'board') {
        const srcId = BOARD_SRC[url.searchParams.get('source') || 'pumpfun'];
        if (!srcId) return json({ ok: false, error: 'unknown source' }, 400);

        const store0 = globalThis.caches && globalThis.caches.default;
        const bk = new Request(url.origin + '/api/card/board/v1/' + srcId + ':' + tf);
        if (store0) {
          const hit = await store0.match(bk);
          if (hit) return hit;
        }

        const snap = await snapshot(ctx, sourceOf(srcId));
        const top = topMovers(snap.tokens || [], tf, 5, srcId);
        if (top.length < 3) return json({ ok: false, error: 'not enough movers' }, 404);

        const svg = await boardCardSvgFor(top, tf, 'TOP MOVERS', BOARD_SUB[srcId]);
        if (!svg) return json({ ok: false, error: 'no measured changes' }, 404);
        const buf = await svgToPng(svg, CARD_W);
        const out = new Response(buf, {
          headers: {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=600',
            'access-control-allow-origin': '*',
          },
        });
        if (store0) await store0.put(bk, out.clone());
        return out;
      }

      const found = await findToken(ctx, url.origin, {
        mint: url.searchParams.get('mint') || '',
        sym: (url.searchParams.get('sym') || '').toUpperCase(),
        srcId: url.searchParams.get('source') || '',
      });
      if (!found) return json({ ok: false, error: 'no token by that name' }, 404);

      /* Rendering costs real CPU and one post can bring a burst of identical
         requests, so the result is held at the edge. Five minutes is long
         enough to absorb that burst and short enough that the number on the
         card is still the number on the map. */
      const store = globalThis.caches && globalThis.caches.default;
      const ck = new Request(url.origin + '/api/card/v1/'
        + encodeURIComponent((found.t.mint || found.t.sym) + ':' + tf));
      if (store) {
        const hit = await store.match(ck);
        if (hit) return hit;
      }

      const svg = await cardSvgFor(found.t, tf);
      if (!svg) return json({ ok: false, error: 'no measured change for that window' }, 404);

      const png = await svgToPng(svg, CARD_W);
      const res = new Response(png, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=300',
          'access-control-allow-origin': '*',
        },
      });
      if (store) await store.put(ck, res.clone());
      return res;
    }

    /* ------------------------------------------------------------- /s/ */
    /* A share link. Crawlers read the Open Graph tags and show the card;
       people get a page with a way through to the map, because an image on
       its own is a dead end for a visitor. */
    /* The ranked share page. A leaderboard gives five projects a reason to
       repost instead of one, which is the whole reason it is published. */
    if (path === '/s/top') {
      const tf = url.searchParams.get('tf') || 'h24';
      const srcId = BOARD_SRC[url.searchParams.get('source') || 'pumpfun'];
      if (!TF_LABEL[tf] || !srcId) return Response.redirect(url.origin + '/', 302);

      const snap = await snapshot(ctx, sourceOf(srcId));
      const top5 = topMovers(snap.tokens || [], tf, 5, srcId);
      /* Nothing to rank is not a page. Better the map than a card asserting a
         leaderboard we could not fill. */
      if (top5.length < 3) return Response.redirect(url.origin + '/', 302);

      const q = 'kind=board&source=' + srcId + '&tf=' + tf;
      const title = BOARD_TITLE[srcId] + ' — pumpbubble.fun';
      const desc = top5.map(t => '$' + t.sym + ' ' + (Number(t.pc[tf]) >= 0 ? '+' : '')
        + Number(t.pc[tf]).toFixed(0) + '%').join(' · ');
      const share = url.origin + '/s/top'
        + (srcId === 'pumpfun' ? '' : '?source=' + srcId);

      return new Response(page({
        title, desc,
        canonical: url.origin + '/s/top',
        cardUrl: url.origin + '/api/card?' + q,
        mapUrl: url.origin + '/' + (srcId === 'pumpfun' ? '' : '?source=' + srcId),
        tweetUrl: 'https://twitter.com/intent/tweet?text='
          + encodeURIComponent(BOARD_TITLE[srcId]) + '&url=' + encodeURIComponent(share),
        alt: desc,
      }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (path === '/s' || path.startsWith('/s/')) {
      const home = Response.redirect(url.origin + '/', 302);
      const id = decodeURIComponent(path.slice(3).replace(/\/+$/, ''));
      const tf = url.searchParams.get('tf') || 'h24';
      if (!id || !TF_LABEL[tf]) return home;

      const asMint = isMint(id);
      const found = await findToken(ctx, url.origin, {
        mint: asMint ? id : '',
        sym: asMint ? '' : id.toUpperCase(),
        srcId: url.searchParams.get('source') || '',
      });
      const t = found && found.t;
      const pct = t && t.pc ? t.pc[tf] : null;
      /* No measured value means no card, and no card means no page — better a
         visitor lands on the map than on an image asserting a number we do not
         have. */
      if (!t || pct == null || !Number.isFinite(Number(pct))) return home;

      /* X caches a link preview for days. Stamping the URL with the value it
         is showing means a changed number is a new URL and gets refetched,
         while an unchanged one still hits their cache. */
      const v = String(Math.round(Number(pct) * 100));
      const q = (t.mint ? 'mint=' + encodeURIComponent(t.mint)
                        : 'sym=' + encodeURIComponent(t.sym) + '&source=' + found.srcId)
        + '&tf=' + tf + '&v=' + v;
      const key = encodeURIComponent(t.mint || t.sym);
      const share = url.origin + '/s/' + key + (tf === 'h24' ? '' : '?tf=' + tf);
      const text = '$' + t.sym + ' ' + pctLabel(pct) + ' in ' + (TF_SHORT[tf] || tf);

      return new Response(sharePage({
        origin: url.origin, t, tf, pct,
        cardUrl: url.origin + '/api/card?' + q,
        mapUrl: url.origin + '/' + (found.srcId === 'pumpfun' ? '' : '?source=' + found.srcId),
        tweetUrl: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text)
          + '&url=' + encodeURIComponent(share),
      }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=120',
        },
      });
    }

    /* ---------------------------------------------------------- /api/img */
    /* Signed proxy. Unsigned URLs are refused, so this can never be used as an
       open relay. See core.mjs → image proxy. */
    if (path === '/api/img') {
      const u = url.searchParams.get('u') || '';
      const s = url.searchParams.get('s') || '';
      if (!await verifyUrl(u, s, ctx.env.IMG_SECRET)) {
        return new Response('bad signature', { status: 403 });
      }
      let target;
      try { target = new URL(u); } catch { return new Response('bad url', { status: 400 }); }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return new Response('bad scheme', { status: 400 });
      }
      /* `return await`, not `return`: a bare returned promise escapes the
         try/catch below and surfaces as a 500 instead of a handled 502. */
      return await ctx.fetchImage(target.toString(), IMG_TTL);
    }

    /* ------------------------------------------------------- /api/boosts */
    if (path === '/api/boosts') {
      const { live, byMint } = await activeBoosts(ctx.store);
      return json({
        ok: true,
        tiers: Object.values(TIERS),
        treasury: ctx.env.TREASURY_WALLET || null,
        active: [...byMint.values()].sort((a, b) => b.spentUsd - a.spentUsd),
        count: live.length,
      });
    }

    /* -------------------------------------------------- /api/boost/order */
    if (path === '/api/boost/order' && req.method === 'POST') {
      /* Generous on purpose: quoting is stateless and costs nothing now, and
         mobile traffic shares IPs behind carrier NAT — a tight limit would
         block real buyers long before it inconvenienced anyone abusive. */
      const limited = rateLimit(req, 'order', 30, 600_000);
      if (limited) return limited;

      /* Never quote a price we cannot honour. Without KV a paid boost cannot be
         stored, and without an RPC a payment cannot be verified — in both cases
         the buyer's money would arrive and nothing would happen. Refusing the
         sale is the only honest option, and misconfiguration is exactly when
         this matters, so it is checked per order rather than assumed at boot. */
      if (!ctx.env.TREASURY_WALLET) {
        return json({ ok: false, error: 'boosts are not open yet — no treasury wallet configured' }, 503);
      }
      if (!ctx.store.available) {
        return json({ ok: false, error: 'boosts are temporarily closed — storage is not configured' }, 503);
      }
      if (!ctx.env.SOLANA_RPC) {
        return json({ ok: false, error: 'boosts are temporarily closed — no Solana RPC configured' }, 503);
      }
      const body = await req.json().catch(() => ({}));
      if (!isCA(body.mint)) {
        return json({ ok: false, error: 'that is not a valid contract address' }, 400);
      }
      /* One canonical spelling of the identifier, since EVM addresses arrive
         checksummed from one source and lowercase from another. */
      const caId = isEvmAddr(body.mint) ? body.mint.toLowerCase() : body.mint;

      /* Look in whichever feed the token would actually appear on. A
         bonding-curve token is as boostable as a graduated one, and a Base or
         Robinhood contract is as boostable as either — the payment is in SOL
         to a Solana treasury regardless of where the token lives. */
      const FEEDS = isEvmAddr(caId) ? ['base', 'robinhood'] : ['pumpfun', 'bonding'];
      let snap = null, tok = null;
      for (const f of FEEDS) {
        const cand = await snapshot(ctx, f).catch(() => null);
        const hit = cand?.tokens.find(t => (t.addr || t.mint) === caId);
        if (hit) { snap = cand; tok = hit; break; }
        if (!snap) snap = cand;
      }
      /* Not in either ranked feed — ask pump.fun directly. The feeds carry the
         top 300, so a smaller coin is invisible to them, and that is precisely
         the token whose community turns up wanting to be seen. A boost pulls it
         onto the map (see /api/tokens, which re-adds paid tokens that are not in
         the feed), so this sells something real.

         Still not a free-for-all: the address has to resolve to a token that
         actually trades somewhere. */
      /* A feed hit that cannot name its own chain is resolved rather than
         guessed: the chain ends up in a payment record and a wrong one there is
         a wrong number, not a cosmetic label. */
      if (tok && !tok.chain && isEvmAddr(caId)) {
        const live = await resolveAnyToken(caId, ctx.env.IMG_SECRET);
        if (live && live.chain) tok = { ...tok, chain: live.chain };
      }
      if (!tok) {
        tok = await resolveAnyToken(caId, ctx.env.IMG_SECRET);
        if (!tok) {
          return json({
            ok: false,
            error: 'no token found with that contract address',
          }, 404);
        }
      }

      /* Inventory cap. Gold is worth exactly what the traffic is worth, so
         over-selling destroys the thing being sold — CLAUDE.md treats the ~25%
         ceiling as non-negotiable. Refuse the sale that would breach it rather
         than discovering it afterwards in the smoke test. */
      if (snap) {
        const { byMint } = await activeBoosts(ctx.store);
        const onScreen = visibleSet(snap.tokens, byMint);
        const projected = applyBoosts(onScreen.map(t => ({ ...t })), byMint);
        const target = projected.find(t => (t.addr || t.mint) === caId);
        /* Project through the same pooled curve the map will actually use —
           adding the tier's headline multiplier here would over-estimate the
           new gold and refuse sales that are in fact within the cap. */
        if (target) {
          const cur = byMint.get(body.mint);
          target.boost = bonusFromSpend((cur ? cur.liveUsd : 0) + tierOf(body.tier).usd);
        }
        if (goldShare(projected) > GOLD_CAP) {
          return json({
            ok: false,
            error: 'boost slots are full right now — too much of the map is already gold. Try again as current boosts decay.',
            goldShare: goldShare(projected),
          }, 503);
        }
      }

      /* amounts already in flight — the new quote must not collide with one */
      const inFlight = (await listPending(ctx.store)).map(o => o.lamports);

      /* An unknown or malformed code is dropped rather than rejected: a bad
         referral must never stop somebody buying. */
      const refCode = isCode(body.ref) && await getAffiliate(ctx.store, body.ref) ? body.ref : '';

      const order = await createOrder({
        taken: inFlight,
        ref: refCode,
        mint: caId,
        /* Which chain the advertised token lives on. The payment is SOL to a
           Solana treasury either way; this only decides how the identifier is
           validated and how the bubble is later re-added. */
        chain: tok?.chain || (isEvmAddr(caId) ? '' : 'solana'),
        /* identity is ours, resolved server-side — never whatever the client sent.
           Carried on the signed order so a token bought from outside the ranked
           feed still renders with its real art and name once it goes gold. */
        sym: tok?.sym || '',
        name: tok?.name || '',
        img: tok?.img || '',
        mcap: tok?.mcap || 0,
        /* which feed this bubble lives in, so a paid boost is re-added to the
           right map if the token later drops out of it */
        grad: tok ? !!tok.grad : true,
        tierId: body.tier,
        solPrice: (snap?.sol > 0 ? snap.sol : await solPriceNow(ctx)),
        treasury: ctx.env.TREASURY_WALLET,
      });

      /* Quote the actual result, not the headline multiplier. Boosts pool and
         the curve flattens, so the tenth buyer on a token genuinely gets less
         than the first — which is only fair if they can see it before paying. */
      const { byMint: liveNow } = await activeBoosts(ctx.store);
      const already = liveNow.get(body.mint);
      const beforeUsd = already ? already.liveUsd : 0;
      const before = bonusFromSpend(beforeUsd);
      const after = bonusFromSpend(beforeUsd + order.usd);
      order.projection = {
        from: +(1 + before).toFixed(2),
        to: +(1 + after).toFixed(2),
        gain: +(after - before).toFixed(3),
        stackedOn: already ? already.count : 0,
      };

      /* Refuse to sell something that would visibly do nothing. */
      if (order.projection.gain < 0.05) {
        return json({
          ok: false,
          error: `${tok?.sym || 'this token'} is already boosted to the maximum size. Boosts decay, so this frees up over the next hours.`,
          projection: order.projection,
        }, 409);
      }

      /* Remember it server-side so the payment can be reconciled even if this
         tab never comes back — which is the normal case on mobile, where the
         wallet takes over the screen. */
      await addPending(ctx.store, order);

      const token = await signOrder(order, ctx.env.IMG_SECRET);
      return json({ ok: true, order, token });
    }

    /* ------------------------------------------------- /api/boost/status */
    if (path === '/api/boost/status') {
      /* Polling is cheap now that the treasury scan is shared and cached, so
         this only exists to stop a runaway client. */
      const limited = rateLimit(req, 'status', 90, 60_000);
      if (limited) return limited;

      const order = await readOrder(url.searchParams.get('t') || '', ctx.env.IMG_SECRET);
      /* A missing or edited order is indistinguishable from a forged one, and
         both get the same answer: this is not an order we issued. */
      if (!order) return json({ ok: false, error: 'unknown or tampered order' }, 400);

      /* If it is already paid for, say so without touching the chain. */
      const { live } = await activeBoosts(ctx.store);
      const already = live.find(b => b.id === order.id);
      if (already) return json({ ok: true, status: 'paid', order, boost: already });

      const rpcUrl = ctx.env.SOLANA_RPC;
      if (!rpcUrl) return json({ ok: false, error: 'no Solana RPC configured' }, 503);

      /* Quotes stop being offered after 30 minutes, but money that arrives late
         is still money: keep checking for a day so a slow payment activates
         instead of stranding. Only the quote expires, never the payment. */
      const late = Date.now() > order.expiresAt;
      if (Date.now() > order.createdAt + 864e5) {
        return json({ ok: true, status: 'expired', order });
      }

      let payment = null;
      try { payment = await findPayment(rpcUrl, order); }
      catch (e) { return json({ ok: true, status: 'pending', note: 'rpc: ' + e.message, order }); }

      if (!payment) return json({ ok: true, status: late ? 'expired' : 'pending', order });

      /* Commission is decided here, at confirmation, from the code signed into
         the order and the wallet that actually paid — never from the client and
         never recomputed later. */
      payment.ref = await resolveReferral(ctx.store, {
        code: order.ref, usd: order.usd, payer: payment.payer,
      });
      const boost = await activateBoost(ctx.store, order, payment);
      return json({ ok: true, status: 'paid', order, boost });
    }

    /* -------------------------------------------------- /api/boost/sweep */
    /* Reconciles arriving payments against pending orders. Called on a timer,
       and callable by anyone — it grants nothing that the chain has not already
       paid for, so there is nothing to protect. It is what makes a payment
       survive the buyer closing the tab. */
    /* Called by cron. Enriches the next slice of stock symbols with their
       monthly and yearly change; see src/stockwin.mjs for why it is gradual. */
    if (path === '/api/stocks/windows') {
      try {
        const snap = await snapshot(ctx, sourceOf('stocks'));
        const syms = (snap.tokens || []).map(t => t.sym).filter(Boolean);
        return json({ ok: true, ...(await refreshWindows(ctx.store, syms)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* ------------------------------------------------------------ console */
    /* No link points here and there is no default path. With ADMIN_PATH or
       ADMIN_PASS unset this block does not exist, and the URL 404s like any
       other unknown one — a 401 would confirm that something is here. */
    if (adminEnabled(ctx.env)) {
      const root = adminPath(ctx.env);

      if (path === root) {
        return new Response(adminPage(root), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex, nofollow, noarchive',
          },
        });
      }

      if (path === root + '/api' && req.method === 'POST') {
        /* Throttle guessing, not use.

           The first version counted every request to this endpoint, which locked
           the operator out of their own console in seconds: the panel refetches
           the overview on load and again after every change, so eight requests
           per ten minutes is a handful of clicks. Wrong. What needs slowing down
           is somebody trying passwords, and a request that carries the right one
           is not that.

           So the password is checked first and only a *failure* costs an
           attempt. Eight per ten minutes still applies to guessing, because the
           password here is short and human-chosen. The counter is per-isolate
           and in memory, so treat it as a speed bump — the secret path is what
           keeps the door from being found at all. */
        /* Checked before the password so a spent budget costs nothing to
           reject, and so an attacker cannot keep the door open by guessing. */
        if (await lockedOut(ctx.store, req)) {
          return json({ ok: false, error: 'too many attempts, wait 10 minutes' }, 429);
        }

        if (!await authed(req, ctx.env)) {
          await noteFailure(ctx.store, req);
          return json({ ok: false, error: 'no' }, 401);
        }
        /* A right answer wipes the slate: two typos should never strand the
           one person who is supposed to be here. */
        await clearFailures(ctx.store, req);

        /* A separate, generous ceiling on authenticated use, so a runaway loop
           in the page cannot hammer KV — never low enough to interrupt a
           person clicking around. */
        const busy = rateLimit(req, 'adminuse', 240, 60_000);
        if (busy) return busy;

        let body = {};
        try { body = await req.json(); } catch { /* empty body is a bad action */ }
        const action = String(body.action || '');

        const readAds = async () => (await ctx.store.get('ads')) || [];
        const readBoosts = async () => (await ctx.store.get('boosts')) || [];

        if (action === 'overview') {
          const all = await readBoosts();
          const { live } = await activeBoosts(ctx.store);
          /* House boosts are the operator's own slot and were never paid for.
             Counting them as revenue would be inventing income. */
          const paid = all.filter(b => !b.house);
          const revenueUsd = paid.reduce((a, b) => a + (Number(b.usd) || 0), 0);

          let traffic = { viewsToday: 0, visitorsToday: 0, views7d: 0, visitors7d: 0 };
          try {
            const st = await statsSummary(ctx.store, 7);
            const days = (st && st.days) || [];
            traffic = {
              viewsToday: (st.today && st.today.views) || 0,
              visitorsToday: (st.today && st.today.visitors) || 0,
              views7d: days.reduce((a, d) => a + (d.views || 0), 0),
              visitors7d: days.reduce((a, d) => a + (d.visitors || 0), 0),
            };
          } catch { /* stats are a nice-to-have, not a reason to fail */ }

          const feeds = [];
          for (const id of ['pumpfun', 'majors', 'stocks', 'robinhood', 'base']) {
            try {
              const snap = await snapshot(ctx, sourceOf(id));
              const toks = snap.tokens || [];
              feeds.push({
                id, tokens: toks.length,
                solid: toks.filter(t => t.solid).length,
                age: Date.now() - (snap.ts || Date.now()),
              });
            } catch { feeds.push({ id, tokens: 0, solid: 0, age: null }); }
          }

          let seeds = { base: [], robinhood: [] };
          try { seeds.base = (await baseCache(ctx.store)).seeds || []; } catch {}
          try { seeds.robinhood = (await rhRegistry(ctx.store)).seeds || []; } catch {}

          let xbot = { configured: !!xCreds(ctx.env), postedToday: 0, would: null };
          try {
            const st = (await ctx.store.get(XBOT_KEY)) || {};
            xbot.postedToday = st.count || 0;
          } catch {}

          return json({
            ok: true,
            money: {
              revenueUsd,
              paidCount: paid.length,
              liveCount: live.length,
              treasury: ctx.env.TREASURY_WALLET || '',
            },
            traffic, feeds,
            ads: await readAds(),
            boosts: all.slice(-40).reverse(),
            seeds, xbot,
          });
        }

        if (action === 'ad.add') {
          const title = String(body.title || '').trim().slice(0, 24);
          const url = String(body.url || '').trim();
          if (!title) return json({ ok: false, error: 'title required' }, 400);
          if (url && !/^https:\/\//i.test(url)) {
            return json({ ok: false, error: 'url must be https' }, 400);
          }
          const img = String(body.img || '').trim();
          if (img && !/^https:\/\//i.test(img)) {
            return json({ ok: false, error: 'image must be https' }, 400);
          }
          const ads = (await readAds()).filter(a => (a.title || '').toUpperCase() !== title.toUpperCase());
          ads.push({ title, sub: String(body.sub || 'sponsored').slice(0, 40), img, url });
          await ctx.store.put('ads', ads.slice(0, 4));
          return json({ ok: true });
        }

        if (action === 'ad.remove') {
          const t = String(body.title || '').toUpperCase();
          const ads = (await readAds()).filter(a => (a.title || '').toUpperCase() !== t);
          await ctx.store.put('ads', ads);
          return json({ ok: true });
        }

        if (action === 'boost.house') {
          const id = String(body.mint || '').trim();
          const chain = String(body.chain || '').trim();
          const evm = /^0x[0-9a-f]{40}$/i.test(id);
          if (!evm && !isMint(id)) return json({ ok: false, error: 'not a mint or contract' }, 400);
          if (evm && chain !== 'base' && chain !== 'robinhood') {
            return json({ ok: false, error: 'contract needs a chain' }, 400);
          }

          /* Identity comes from the chain rather than from the form, so a house
             slot cannot be labelled as a token it is not. */
          let sym = '', name = '', img = '', mcap = 0;
          if (evm) {
            const r = await fetch('https://api.dexscreener.com/tokens/v1/' + chain + '/' + id.toLowerCase(),
              { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
            const arr = r.ok ? await r.json() : [];
            const best = (Array.isArray(arr) ? arr : []).sort((a, b) =>
              ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
            if (!best) return json({ ok: false, error: 'no pool for that contract' }, 404);
            sym = String((best.baseToken && best.baseToken.symbol) || '').slice(0, 12);
            name = String((best.baseToken && best.baseToken.name) || sym).slice(0, 48);
            img = (best.info && best.info.imageUrl) || '';
            mcap = Number(best.marketCap) || Number(best.fdv) || 0;
          } else {
            const t = await fetchCoin(id, ctx.env.IMG_SECRET);
            if (!t) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);
            sym = t.sym; name = t.name; img = t.rawImg || ''; mcap = t.mcap;
          }

          const key = evm ? id.toLowerCase() : id;
          const all = await readBoosts();
          const usd = Math.max(1, Math.min(10_000, Number(body.usd) || 400));
          const next = all.filter(b => b.mint !== key);
          next.push({
            mint: key, sym, name, img, mcap,
            ...(evm ? { chain } : {}),
            usd, spentUsd: usd, tier: 'house', mult: 0,
            at: Date.now(), until: Date.now() + 100 * 365 * 864e5,
            house: true,
          });
          await ctx.store.put('boosts', next);
          return json({ ok: true, sym });
        }

        if (action === 'boost.remove') {
          const mint = String(body.mint || '').trim();
          const all = await readBoosts();
          await ctx.store.put('boosts', all.filter(b => b.mint !== mint));
          return json({ ok: true });
        }

        if (action === 'seed.add' || action === 'seed.remove') {
          const chain = String(body.chain || '');
          const addr = String(body.addr || '').trim().toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ ok: false, error: 'not an address' }, 400);
          if (chain !== 'base' && chain !== 'robinhood') {
            return json({ ok: false, error: 'unknown chain' }, 400);
          }
          if (action === 'seed.add') {
            const r = chain === 'base' ? await baseSeed(ctx.store, [addr])
                                       : await rhSeed(ctx.store, [addr]);
            return json({ ok: true, ...r });
          }
          if (chain === 'base') {
            const c = await baseCache(ctx.store);
            await ctx.store.put('basechain', { ...c, seeds: (c.seeds || []).filter(a => a !== addr) });
          } else {
            const r = await rhRegistry(ctx.store);
            await ctx.store.put('rhchain', { ...r, seeds: (r.seeds || []).filter(a => a !== addr) });
          }
          return json({ ok: true });
        }

        return json({ ok: false, error: 'unknown action' }, 400);
      }
    }

    /* Called by cron. Aggregates DefiLlama's DEX and fee overviews down to a
       few KB; the raw responses are ~6MB together and have no business inside a
       map build. See src/flows.mjs. */
    if (path === '/api/flows/refresh') {
      try {
        return json({ ok: true, ...(await refreshFlows(ctx.store)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Refreshes the Base token list at most once a day and
       prices one slice of it; see src/basechain.mjs. */
    if (path === '/api/base/sweep') {
      try {
        const uni = await refreshUniverse(ctx.store);
        const swept = await baseSweep(ctx.store);
        return json({ ok: true, ...uni, ...swept });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Widens the Robinhood Chain registry by one tick's worth;
       see src/rhchain.mjs for why the list has to be accumulated at all. */
    if (path === '/api/robinhood/discover') {
      try {
        return json({ ok: true, ...(await discover(ctx.store)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Rebuilds every majors long-window in one pass, at most
       once a day; see src/cryptowin.mjs for why this one needs no warm-up. */
    if (path === '/api/majors/windows') {
      try {
        const snap = await snapshot(ctx, sourceOf('majors'));
        const syms = (snap.tokens || []).map(t => t.sym).filter(Boolean);
        return json({ ok: true, ...(await refreshCryptoWin(ctx.store, syms)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Whether the X poster is live, and what it has done. Booleans and
       timestamps only — never the credentials, and never the account. */
    /* What the poster would say if it ran right now, without posting it.
       The content has to be judgeable before anybody hands it credentials. */
    if (path === '/api/xbot/preview') {
      const limited = rateLimit(req, 'xpreview', 20, 60_000);
      if (limited) return limited;
      const feed = async (src) => {
        try { return (await snapshot(ctx, sourceOf(src))).tokens || []; } catch { return []; }
      };
      const [pumpfun, majors, stocks] = await Promise.all(
        [feed('pumpfun'), feed('majors'), feed('stocks')]);
      const st = (await ctx.store.get(XBOT_KEY)) || { recent: {} };
      const post = buildPost({ pumpfun, majors, stocks }, ctx.env, st, Date.now(), url.origin);
      if (!post) return json({ ok: true, would: null, why: 'nothing worth posting' });
      return json({
        ok: true,
        would: { kind: post.kind, text: post.text, chars: post.text.length,
                 card: url.origin + post.share },
      });
    }

    if (path === '/api/xbot/status') {
      const st = (await ctx.store.get(XBOT_KEY)) || {};
      return json({
        ok: true,
        configured: !!xCreds(ctx.env),
        postedToday: st.count || 0,
        lastPostAt: st.lastAt || 0,
        onCooldown: Object.keys(st.recent || {}).length,
      });
    }

    if (path === '/api/boost/sweep') {
      if (!ctx.env.SOLANA_RPC || !ctx.env.TREASURY_WALLET) {
        return json({ ok: false, error: 'payments are not configured' }, 503);
      }
      const limited = rateLimit(req, 'sweep', 20, 60_000);
      if (limited) return limited;

      const activated = await sweepPayments(ctx.store, ctx.env.SOLANA_RPC, ctx.env.TREASURY_WALLET,
        args => resolveReferral(ctx.store, args));
      const pending = await listPending(ctx.store);
      return json({
        ok: true,
        activated: activated.map(b => ({ sym: b.sym, mint: b.mint, tier: b.tier, sig: b.sig })),
        stillPending: pending.length,
      });
    }

    /* ----------------------------------------------------- /api/affiliate */
    /* An affiliate's own statement. Built from the same public boost ledger, so
       what they see and what anyone can audit cannot disagree — which is the
       only reason to trust a commission number you did not compute yourself.
       The code is not a secret: it is in every link they share. */
    if (path === '/api/affiliate') {
      const limited = rateLimit(req, 'affiliate', 60, 60_000);
      if (limited) return limited;

      const code = (url.searchParams.get('code') || '').toLowerCase();
      if (!isCode(code)) return json({ ok: false, error: 'bad code' }, 400);
      const st = await statement(ctx.store, code);
      if (!st) return json({ ok: false, error: 'unknown affiliate code' }, 404);
      return json({ ok: true, ...st });
    }

    /* ------------------------------------------------ /api/boost/history */
    /* Public ledger. Every boost ever sold, with the transaction that paid for
       it, so anyone can check on-chain that the gold on this map was bought and
       not handed out. Being auditable is the point — publish it. */
    if (path === '/api/boost/history') {
      const all = (await ctx.store.get('boosts')) || [];
      const now = Date.now();
      return json({
        ok: true,
        count: all.length,
        treasury: ctx.env.TREASURY_WALLET || null,
        boosts: all
          .slice(-200)
          .reverse()
          .map(b => ({
            sym: b.sym, mint: b.mint, tier: b.tier, mult: b.mult,
            usd: b.usd, sol: b.sol,
            sig: b.sig,
            explorer: 'https://solscan.io/tx/' + b.sig,
            startedAt: b.startedAt, until: b.until,
            active: b.until > now,
          })),
      });
    }

    /* ---------------------------------------------------------- /api/ads */
    /* House ads live in KV so a slot can be sold without a deploy. */
    if (path === '/api/ads') {
      const raw = (await ctx.store.get('ads')) || [];
      /* Ad art goes through the signed proxy for the same reason token art
         does: the page is served img-src 'self', so any upstream URL renders as
         a broken image. A sold slot showing no logo is worse than an empty one,
         because the empty slot is at least an advert for the inventory. */
      const ads = [];
      for (const a of raw) {
        let img = a.img || '';
        if (img && ctx.env.IMG_SECRET && !img.startsWith('/api/img?')) {
          try {
            img = '/api/img?u=' + encodeURIComponent(img) +
                  '&s=' + await signUrl(img, ctx.env.IMG_SECRET);
          } catch { img = ''; }
        }
        ads.push({ ...a, img });
      }
      return json({ ok: true, ads, contact: ctx.env.AD_CONTACT || '' });
    }

    /* ------------------------------------------------------- /api/health */
    if (path === '/api/health') {
      return json({
        ok: true,
        cachedAt: cacheFor('graduated').at,
        cachedTokens: cacheFor('graduated').data?.count || 0,
        lastError: cacheFor('graduated').err,
        modes: [...caches.keys()],
        treasury: !!ctx.env.TREASURY_WALLET,
        rpc: !!ctx.env.SOLANA_RPC,
        kv: !!ctx.store.available,
        imgSecret: !!ctx.env.IMG_SECRET,
        /* the one line that answers "why is nobody able to buy a boost?" */
        boostsOpen: !!(ctx.env.TREASURY_WALLET && ctx.env.SOLANA_RPC && ctx.store.available),
      });
    }

    return null;   // not an API route — the adapter serves static files
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
}
