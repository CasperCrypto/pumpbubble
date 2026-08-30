/* ==========================================================================
   pumpbubble.fun — HTTP API, shared by the Worker and the local dev server.
   Written against web-standard Request/Response, which Node 22 and Workers
   both provide, so there is exactly one implementation of every route.
   ========================================================================== */

import { buildSnapshot, verifyUrl, isMint, fetchCoin, fetchSolPrice, signUrl } from './core.mjs';
import { embedConfig, safeAccent } from './embed.mjs';
import { buyConfig } from './refs.mjs';
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
        if (saved && Date.now() - saved.ts < ttl) {
          cache.data = saved; cache.at = Date.now(); cache.err = null;
          return saved;
        }
      } catch { /* KV miss is not an error, just a slower path */ }
    }

    try {
      const snap = await buildSnapshot({
        source: src,
        hist: ctx.hist,
        secret: ctx.env.IMG_SECRET,
      });
      cache.data = snap; cache.at = Date.now(); cache.err = null;
      if (src.shared) {
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
      const have = new Set(tokens.map(t => t.mint));
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
        tokens.push({
          id: mint, mint,
          sym: b.sym || mint.slice(0, 4), name: b.name || b.sym || 'boosted',
          img, mcap: b.mcap || 0, vol: 0,
          pc: { m5: 0, h1: 0, h6: 0, h24: 0 },
          grad: true, solid: true, flags: [], copies: 1,
          boost: b.bonus, boostUsd: b.spentUsd, boostUntil: b.until,
        });
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
      if (!isMint(mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);

      /* prefer a feed we already hold — free, and already image-signed */
      /* check every warm cache, whichever sources happen to be loaded */
      for (const [sid, c] of caches) {
        const mode = sid;
        const hit = c.data?.tokens.find(t => t.mint === mint);
        if (hit) return json({ ok: true, token: hit, from: mode });
      }

      const t = await fetchCoin(mint, ctx.env.IMG_SECRET);
      if (!t) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);
      return json({ ok: true, token: t, from: 'pump.fun' });
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
      if (!isMint(body.mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);

      /* A bonding-curve token is just as boostable as a graduated one, so look
         in whichever feed the buyer was actually looking at. */
      let snap = await snapshot(ctx, 'pumpfun').catch(() => null);
      let tok = snap?.tokens.find(t => t.mint === body.mint);
      if (!tok) {
        const bond = await snapshot(ctx, 'bonding').catch(() => null);
        const bondTok = bond?.tokens.find(t => t.mint === body.mint);
        if (bondTok) { snap = bond; tok = bondTok; }
      }
      /* Not in either ranked feed — ask pump.fun directly. The feeds carry the
         top 300, so a smaller coin is invisible to them, and that is precisely
         the token whose community turns up wanting to be seen. A boost pulls it
         onto the map (see /api/tokens, which re-adds paid tokens that are not in
         the feed), so this sells something real.

         Still not a free-for-all: the mint has to exist on pump.fun. */
      if (!tok) {
        tok = await fetchCoin(body.mint, ctx.env.IMG_SECRET);
        if (!tok) {
          return json({
            ok: false,
            error: 'no pump.fun token found with that contract address',
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
        const target = projected.find(t => t.mint === body.mint);
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
        mint: body.mint,
        /* identity is ours, from pump.fun — never whatever the client sent.
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
