/* ==========================================================================
   pumpbubble.fun — HTTP API, shared by the Worker and the local dev server.
   Written against web-standard Request/Response, which Node 22 and Workers
   both provide, so there is exactly one implementation of every route.
   ========================================================================== */

import { buildSnapshot, verifyUrl, isMint, fetchCoin } from './core.mjs';
import { embedConfig, safeAccent } from './embed.mjs';
import { resolveReferral, statement, getAffiliate, isCode } from './affiliates.mjs';
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

/* graduated is the default: it is what "the pump.fun market" means to most
   people, and bonding-curve tokens have their own tab rather than being mixed in */
const MODES = {
  /* Sorted by market cap: for graduated tokens that is the ranking everyone
     means by "the pump.fun market". */
  graduated: { complete: true, sort: 'market_cap' },

  /* Sorted by last trade, NOT market cap. Ranking live curves by size surfaces
     abandoned ones — measured, the by-mcap bonding feed had a median age of 104
     days and almost nothing trading. By last trade it is 50/50 traded inside a
     minute, median age 12 minutes, which is what a bonding board should show. */
  bonding: { complete: false, sort: 'last_trade_timestamp' },

  all: { complete: undefined, sort: 'market_cap' },
};

async function snapshot(ctx, mode = 'graduated', force = false) {
  const cache = cacheFor(mode);
  const now = Date.now();
  if (!force && cache.data && now - cache.at < SNAPSHOT_TTL) return cache.data;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const snap = await buildSnapshot({
        hist: ctx.hist,
        secret: ctx.env.IMG_SECRET,
        pages: 6,
        complete: (MODES[mode] || MODES.graduated).complete,
        sort: (MODES[mode] || MODES.graduated).sort,
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

      const mode = MODES[url.searchParams.get('mode')] ? url.searchParams.get('mode') : 'graduated';
      const snap = await snapshot(ctx, mode);
      const { byMint } = await activeBoosts(ctx.store);
      const tokens = applyBoosts(snap.tokens.map(t => ({ ...t })), byMint);

      /* A boosted token that dropped out of the pump.fun feed is re-added so a
         paid bubble never disappears before its time is up. */
      const have = new Set(tokens.map(t => t.mint));
      for (const [mint, b] of byMint) {
        if (have.has(mint)) continue;
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
          img: b.img || '', mcap: b.mcap || 0, vol: 0,
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
        enriched: snap.enriched,
        withArt: snap.withArt,
        signed: snap.signed,
        mode,
        solid: snap.solid,
        goldShare: goldShare(visibleSet(tokens, byMint)),
        stale: Date.now() - snap.ts > SNAPSHOT_TTL * 3,
        tokens,
      });
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
      for (const mode of ['graduated', 'bonding']) {
        const c = cacheFor(mode);
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
      let snap = await snapshot(ctx, 'graduated').catch(() => null);
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
        solPrice: snap?.sol || 0,
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
      const ads = (await ctx.store.get('ads')) || [];
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
