/* ==========================================================================
   pumpbubble.fun — Cloudflare Worker (production)

   Three jobs:
     1. read pump.fun server-side (the browser cannot: 403 on Origin)
     2. cache token art at the edge so IPFS never touches the render loop
     3. hold the paid layer — boost orders, Solana Pay verification, ad slots

   Static files are served by Workers Assets; anything under /api is ours.
   ========================================================================== */

import { handle } from '../src/api.mjs';
import { histToJSON, histFromJSON, pruneHistory } from '../src/core.mjs';
import { flush as flushStats } from '../src/stats.mjs';
import { tick as xbotTick } from '../src/xbot.mjs';

/* Per-isolate memory. Cloudflare recycles isolates freely, so this is a cache,
   never the source of truth — KV holds anything that must survive. */
let HIST = null;
let histDirtyAt = 0;
const HIST_SAVE_EVERY = 5 * 60 * 1000;

function makeStore(env) {
  const kv = env.BUBBLE_KV;
  return {
    /* No binding means boosts cannot be persisted, so the API refuses to sell
       one rather than taking money it cannot honour. */
    available: !!kv,
    async get(key) {
      if (!kv) return null;
      return await kv.get(key, 'json');
    },
    async put(key, value, opts = {}) {
      if (!kv) return;
      const o = {};
      if (opts.ttlSec) o.expirationTtl = Math.max(60, opts.ttlSec);
      await kv.put(key, JSON.stringify(value), o);
    },
  };
}

async function loadHist(env) {
  if (HIST) return HIST;
  HIST = new Map();
  try {
    const kv = env.BUBBLE_KV;
    if (kv) {
      const saved = await kv.get('hist', 'json');
      if (saved) { HIST = histFromJSON(saved); pruneHistory(HIST); }
    }
  } catch { /* history is an optimisation; losing it only dulls the colours */ }
  return HIST;
}

async function saveHist(env) {
  try {
    const kv = env.BUBBLE_KV;
    if (!kv || !HIST) return;
    pruneHistory(HIST);
    await kv.put('hist', JSON.stringify(histToJSON(HIST)));
    histDirtyAt = Date.now();
  } catch { /* non-fatal */ }
}

/* Edge-cached image proxy. Token art is immutable, so one fetch per image per
   colo serves everybody after that. */
function imageFetcher(execCtx) {
  return async (target, ttl) => {
    const cacheKey = new Request(target, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'user-agent': 'pumpbubble.fun/1.0' },
        signal: AbortSignal.timeout(8000),
        cf: { cacheTtl: ttl, cacheEverything: true },
      });
    } catch {
      return new Response('upstream unreachable', { status: 502 });
    }
    if (!upstream.ok) return new Response('upstream ' + upstream.status, { status: 502 });

    const type = upstream.headers.get('content-type') || 'image/png';
    if (!/^image\//i.test(type)) return new Response('not an image', { status: 415 });

    const res = new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': `public, max-age=${ttl}, immutable`,
        'access-control-allow-origin': '*',
        'x-pb-cache': 'miss',
      },
    });
    execCtx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  };
}

/* The image proxy needs a signing secret that every isolate agrees on. If none
   was configured, images vanish entirely and nothing says why — which is a poor
   trade for a value nobody has to choose. Generate one, keep it in KV, and let
   every isolate load the same one. A configured IMG_SECRET always wins. */
let SECRET = null;

async function imgSecret(env) {
  if (env.IMG_SECRET) return env.IMG_SECRET;
  if (SECRET) return SECRET;
  const kv = env.BUBBLE_KV;
  if (!kv) return 'unconfigured-image-secret';
  try {
    SECRET = await kv.get('img_secret');
    if (!SECRET) {
      SECRET = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
      await kv.put('img_secret', SECRET);
    }
  } catch {
    SECRET = SECRET || 'unconfigured-image-secret';
  }
  return SECRET;
}

async function makeCtx(env, execCtx) {
  /* env is a frozen binding object, so hand the API a copy carrying the
     resolved secret rather than trying to write back onto it */
  env = { ...env, IMG_SECRET: await imgSecret(env) };
  return {
    env,
    store: makeStore(env),
    hist: await loadHist(env),
    fetchImage: imageFetcher(execCtx),
    /* lets counting flush after the response is sent, off the critical path */
    waitUntil: p => execCtx.waitUntil(p),
    onSnapshot() {
      /* Persist history occasionally: ~288 KV writes/day, inside the free tier. */
      if (Date.now() - histDirtyAt > HIST_SAVE_EVERY) {
        histDirtyAt = Date.now();
        execCtx.waitUntil(saveHist(env));
      }
    },
  };
}

export default {
  async fetch(request, env, execCtx) {
    const ctx = await makeCtx(env, execCtx);

    const res = await handle(request, ctx);
    if (res) return res;

    /* Not an API route → static assets. */
    if (!env.ASSETS) return new Response('not found', { status: 404 });

    /* /embed serves the same page, with headers that permit framing.
       The site-wide policy is frame-ancestors 'none' and X-Frame-Options DENY,
       which is right for a page showing a payment address and wrong for the one
       route whose entire purpose is to be put in somebody else's iframe. The
       exception is scoped to this path only, and set here rather than in
       _headers because the worker runs first and this must not depend on which
       rule the asset layer decides wins. */
    const p = new URL(request.url).pathname.replace(/\/+$/, '');

    /* /market is rendered on the server: the coin table, the summary line and
       the structured data are injected into the static shell before it is sent.
       A crawler that runs no JavaScript still gets the whole market as text,
       which is the entire point of the page. */
    if (p === '/market' || p === '/board') {
      /* Ask the asset layer for '/market', not '/market.html'. An explicit
         .html request is normalised into a 307 back to the extensionless path —
         which now re-enters the worker, because run_worker_first names /market,
         and loops. Same trap as /embed, where fetching '/index.html' redirected
         to '/'. env.ASSETS.fetch bypasses the worker, so this resolves to the
         file without recursing. */
      const shell = new URL(request.url);
      shell.pathname = p;
      shell.search = '';
      const res = await env.ASSETS.fetch(new Request(shell, { headers: request.headers }));
      if (!res.ok) return res;
      try {
        const html = await res.text();
        const api = p === '/board' ? '/api/board' : '/api/market';
        const data = await handle(new Request('https://pumpbubble.fun' + api), ctx);
        const j = data ? await data.json() : null;
        const body = j?.ok
          ? html
              .replace('<!--MARKET_SUMMARY-->', j.summary)
              .replace('<!--MARKET_TABLE-->', j.table)
              .replace('<!--MARKET_JSONLD-->', j.jsonld || '')
              .replace('<!--BOARD_SUMMARY-->', j.summary)
              .replace('<!--BOARD_TABLE-->', j.table)
              .replace('<!--BOARD_JSONLD-->', j.jsonld || '')
              .replace(/<!--UPDATED-->/g, new Date(j.ts).toISOString())
          : html;
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            /* the numbers age, the page does not need to be re-rendered per hit */
            'cache-control': 'public, max-age=60, s-maxage=60',
          },
        });
      } catch {
        return res;   // fall back to the shell rather than an error page
      }
    }

    if (p === '/embed') {
      /* Ask for '/', not '/index.html'. Workers Assets normalises an explicit
         index.html into a 307 back to the directory root — which lands on the
         main page, and that page is served frame-ancestors 'none'. The embed
         then refuses to frame with headers that look correct in isolation. */
      const page = new URL(request.url);
      page.pathname = '/';
      const res = await env.ASSETS.fetch(new Request(page, request));
      const h = new Headers(res.headers);
      h.delete('x-frame-options');
      h.set('content-security-policy',
        "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *");
      /* an embed is a widget, not a document to be indexed on its own */
      h.set('x-robots-tag', 'noindex');
      h.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(res.body, { status: res.status, headers: h });
    }

    return env.ASSETS.fetch(request);
  },

  /* Cron keeps a warm snapshot and a persisted history even with no traffic,
     so the first visitor of the day does not wait on a cold fetch. */
  async scheduled(event, env, execCtx) {
    const ctx = await makeCtx(env, execCtx);
    execCtx.waitUntil((async () => {
      try {
        await handle(new Request('https://pumpbubble.fun/api/tokens'), ctx);
        /* Keep the whole-market feed warm too. /market renders from it, and a
           cold CoinGecko fetch is several seconds — which a crawler counts
           against the page and a visitor simply waits through. */
        await handle(new Request('https://pumpbubble.fun/api/tokens?source=majors'), ctx);
        /* Reconcile payments whose buyer never came back to the tab. Without
           this a correct payment can sit unclaimed indefinitely — which is
           exactly what happened in production before the sweep existed. */
        await handle(new Request('https://pumpbubble.fun/api/boost/sweep'), ctx);
        /* One slice of stock long-windows per tick. The whole universe warms up
           over roughly half an hour and then only refreshes daily. */
        await handle(new Request('https://pumpbubble.fun/api/stocks/windows'), ctx);
        await handle(new Request('https://pumpbubble.fun/api/majors/windows'), ctx);
        /* One tick's worth of Robinhood Chain discovery. The chain has no
           endpoint that ranks it, so the list is widened a little at a time. */
        await handle(new Request('https://pumpbubble.fun/api/robinhood/discover'), ctx);
        /* One slice of Base pricing, and the token list once a day. */
        await handle(new Request('https://pumpbubble.fun/api/base/sweep'), ctx);
        /* Chain and launchpad flows, rebuilt every twenty minutes. */
        await handle(new Request('https://pumpbubble.fun/api/flows/refresh'), ctx);
        /* Telegram buybot: registers its webhook once TG_BOT_TOKEN exists. A
           no-op without the token and a one-call check with it. */
        await handle(new Request('https://pumpbubble.fun/api/tg/ensure'), ctx);
        /* Marketing. Silent unless four X secrets are set, and rate-limited
           inside itself rather than by how often this fires. */
        await xbotTick(env, makeStore(env), async () => {
          /* Only reached once the poster has decided it is actually going to
             post, so this is three cached snapshot reads a day, not per tick. */
          const feed = async (src) => {
            try {
              const r = await handle(new Request(
                'https://pumpbubble.fun/api/tokens?source=' + src), ctx);
              const j = await r.json();
              return (j && j.tokens) || [];
            } catch { return []; }
          };
          const [pumpfun, majors, stocks] = await Promise.all(
            [feed('pumpfun'), feed('majors'), feed('stocks')]);
          return { pumpfun, majors, stocks };
        });
        await saveHist(env);
        await flushStats(makeStore(env));
      } catch { /* next tick will retry */ }
    })());
  },
};
