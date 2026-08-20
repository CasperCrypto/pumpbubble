/* ==========================================================================
   pumpbubble.fun — local dev server
   Serves index.html and the same API the Worker serves, so the whole thing
   runs with `npm run dev` and no cloud account at all.

       node server/dev.mjs           → http://localhost:8787

   Storage is a Map: boosts and orders vanish on restart. That is fine for
   development; production state lives in Cloudflare KV.
   ========================================================================== */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/api.mjs';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = +(process.env.PORT || 8787);

/* --------------------------------------------------------------- store */
const mem = new Map();
const store = {
  available: true,                     // a Map is always there; KV may not be
  async get(k) { const v = mem.get(k); return v === undefined ? null : v; },
  async put(k, v) { mem.set(k, v); },
};

/* Seed a house ad so the rail is never empty in dev. */
mem.set('ads', [
  { id: 'house-1', title: 'YOUR TOKEN HERE', sub: 'ad slot open', url: 'mailto:ads@pumpbubble.fun', img: '' },
]);

/* A half-filled .env is worse than an empty one: a placeholder left in place
   would be used as a URL and every payment check would fail for a reason that
   looks nothing like "you forgot to paste the key". Treat it as unset. */
const real = v => (v && !/REPLACE_ME|change-me/i.test(v) ? v : '');

const env = {
  IMG_SECRET: real(process.env.IMG_SECRET) || 'dev-secret-not-for-production',
  TREASURY_WALLET: real(process.env.TREASURY_WALLET) || '6k8T4fXq5vt3asVnywaHgfw4ApRexGHupbUU8e3TsW1C',
  SOLANA_RPC: real(process.env.SOLANA_RPC) || 'https://api.mainnet-beta.solana.com',
  AD_CONTACT: real(process.env.AD_CONTACT) || 'https://t.me/casper_crypto',
};
const usingPublicRpc = !real(process.env.SOLANA_RPC);

const ctx = {
  env, store,
  hist: new Map(),
  /* Dev has no edge cache; the browser cache is enough to keep the map smooth.
     Some IPFS gateways stall for many seconds, so cap the wait and let the
     front end fall back to its letter avatar. */
  async fetchImage(target, ttl) {
    let r;
    try {
      r = await fetch(target, {
        headers: { 'user-agent': 'pumpbubble.fun/1.0' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return new Response('upstream unreachable', { status: 502 });
    }
    if (!r.ok) return new Response('upstream ' + r.status, { status: 502 });
    return new Response(r.body, {
      status: 200,
      headers: {
        'content-type': r.headers.get('content-type') || 'image/png',
        'cache-control': `public, max-age=${ttl}, immutable`,
        'access-control-allow-origin': '*',
      },
    });
  },
};

/* ---------------------------------------------------------- static files */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  /* keep the resolved path inside ROOT */
  const abs = normalize(join(ROOT, rel));
  if (!abs.startsWith(normalize(ROOT))) { res.writeHead(403).end('forbidden'); return; }
  /* config files like _headers are directives, not content — Cloudflare hides
     them and so do we */
  if (/[\\/]_/.test(abs.slice(normalize(ROOT).length - 1))) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

/* ------------------------------------------------------------------ serve */
const server = createServer(async (req, res) => {
  const url = 'http://' + (req.headers.host || 'localhost') + req.url;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });

  let out;
  try {
    out = await handle(request, ctx);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    return;
  }

  if (!out) return serveStatic(new URL(url).pathname, res);

  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (!out.body) return res.end();

  /* A proxied image that stalls past its timeout aborts mid-stream. That
     surfaces as an 'error' event on the Readable, which is fatal to the
     process if nobody is listening — one slow IPFS gateway would take the
     whole server down. Drop the response instead. */
  const stream = Readable.fromWeb(out.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

server.listen(PORT, () => {
  console.log(`pumpbubble dev  →  http://localhost:${PORT}`);
  console.log(`  api           →  http://localhost:${PORT}/api/tokens`);
  if (!env.TREASURY_WALLET) {
    console.log('  note: TREASURY_WALLET unset — boost checkout returns 503 (map still runs)');
  } else {
    console.log(`  treasury      →  ${env.TREASURY_WALLET.slice(0, 8)}…`);
  }
  console.log(usingPublicRpc
    ? '  rpc           →  public endpoint (slow, rate-limited). Put your Helius URL in .env'
    : '  rpc           →  custom endpoint configured ✓');
});
