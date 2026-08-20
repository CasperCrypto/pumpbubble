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
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },

  /* Cron keeps a warm snapshot and a persisted history even with no traffic,
     so the first visitor of the day does not wait on a cold fetch. */
  async scheduled(event, env, execCtx) {
    const ctx = await makeCtx(env, execCtx);
    execCtx.waitUntil((async () => {
      try {
        await handle(new Request('https://pumpbubble.fun/api/tokens'), ctx);
        await saveHist(env);
      } catch { /* next tick will retry */ }
    })());
  },
};
