/* ==========================================================================
   pumpbubble.fun — HTTP API, shared by the Worker and the local dev server.
   Written against web-standard Request/Response, which Node 22 and Workers
   both provide, so there is exactly one implementation of every route.
   ========================================================================== */

import { buildSnapshot, verifyUrl, isMint } from './core.mjs';
import {
  TIERS, tierOf, createOrder, signOrder, readOrder, findPayment,
  activeBoosts, activateBoost, applyBoosts, goldShare, ORDER_TTL_MS,
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
const cache = { at: 0, data: null, inflight: null, err: null };

async function snapshot(ctx, force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < SNAPSHOT_TTL) return cache.data;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const snap = await buildSnapshot({
        hist: ctx.hist,
        secret: ctx.env.IMG_SECRET,
        pages: 6,
      });
      cache.data = snap; cache.at = Date.now(); cache.err = null;
      ctx.onSnapshot?.(snap);
      return snap;
    } catch (e) {
      cache.err = String(e && e.message || e);
      /* Stale data beats an empty map — the front end shows the age. */
      if (cache.data && Date.now() - cache.at < STALE_OK) return cache.data;
      throw e;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

/* =============================================================== routes */
export async function handle(req, ctx) {
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

  try {
    /* ------------------------------------------------------- /api/tokens */
    if (path === '/api/tokens') {
      const limited = rateLimit(req, 'tokens', 180, 60_000);
      if (limited) return limited;

      const snap = await snapshot(ctx);
      const { byMint } = await activeBoosts(ctx.store);
      const tokens = applyBoosts(snap.tokens.map(t => ({ ...t })), byMint);

      /* A boosted token that dropped out of the pump.fun feed is re-added so a
         paid bubble never disappears before its time is up. */
      const have = new Set(tokens.map(t => t.mint));
      for (const [mint, b] of byMint) {
        if (have.has(mint)) continue;
        tokens.push({
          id: mint, mint, sym: b.sym || mint.slice(0, 4), name: b.sym || 'boosted',
          img: '', mcap: 0, vol: 0, pc: { m5: 0, h1: 0, h6: 0, h24: 0 },
          grad: true, boost: b.bonus, boostUsd: b.spentUsd, boostUntil: b.until,
        });
      }

      return json({
        ok: true,
        ts: snap.ts,
        age: Date.now() - snap.ts,
        sol: snap.sol,
        source: snap.source,
        enriched: snap.enriched,
        goldShare: goldShare(visibleSet(tokens, byMint)),
        stale: Date.now() - snap.ts > SNAPSHOT_TTL * 3,
        tokens,
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

      if (!ctx.env.TREASURY_WALLET) {
        return json({ ok: false, error: 'boosts are not open yet — no treasury wallet configured' }, 503);
      }
      const body = await req.json().catch(() => ({}));
      if (!isMint(body.mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);

      const snap = await snapshot(ctx).catch(() => null);
      const tok = snap?.tokens.find(t => t.mint === body.mint);
      /* Only sell a boost on a token that is actually on the map. Otherwise a
         quote could be raised against any mint on Solana, and the payment would
         buy a bubble nobody can see. */
      if (snap && !tok) {
        return json({ ok: false, error: 'that token is not on the map right now' }, 404);
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
        if (target) target.boost = (target.boost || 0) + (tierOf(body.tier).mult - 1);
        if (goldShare(projected) > GOLD_CAP) {
          return json({
            ok: false,
            error: 'boost slots are full right now — too much of the map is already gold. Try again as current boosts decay.',
            goldShare: goldShare(projected),
          }, 503);
        }
      }

      const order = await createOrder({
        mint: body.mint,
        /* the symbol is ours, from pump.fun — never whatever the client sent */
        sym: tok?.sym || '',
        tierId: body.tier,
        solPrice: snap?.sol || 0,
        treasury: ctx.env.TREASURY_WALLET,
      });
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

      const boost = await activateBoost(ctx.store, order, payment);
      return json({ ok: true, status: 'paid', order, boost });
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
      const ads = (await ctx.store.get('ads')) || [];
      return json({ ok: true, ads, contact: ctx.env.AD_CONTACT || '' });
    }

    /* ------------------------------------------------------- /api/health */
    if (path === '/api/health') {
      return json({
        ok: true,
        cachedAt: cache.at,
        cachedTokens: cache.data?.count || 0,
        lastError: cache.err,
        treasury: !!ctx.env.TREASURY_WALLET,
        rpc: !!ctx.env.SOLANA_RPC,
      });
    }

    return null;   // not an API route — the adapter serves static files
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
}
