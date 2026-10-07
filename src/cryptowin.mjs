/* ==========================================================================
   pumpbubble.fun — monthly and yearly change for the whole-market view

   CoinPaprika supplies the majors universe and publishes 1h, 24h and 7d. It
   exposes 30d and 1y fields too, but returns zero for every coin on the free
   tier, which is worse than absent: zero is a claim the coin did not move.

   Three candidates answered from Cloudflare's egress; several did not. Binance
   403s a Worker while answering a laptop from the same code — a reminder that
   an upstream is only usable if it is tested from where it will actually run.
   Bybit answers but lists barely half the universe. DefiLlama answers, covers
   effectively all of it, and takes many coins per request.

   That last property decides it. The windows for the entire map cost twelve
   requests once a day, rather than one request per coin forever, so this needs
   no progressive warm-up at all — unlike src/stockwin.mjs, which does, because
   Yahoo will only discuss one symbol at a time.

   DefiLlama is keyed by CoinGecko id, which this feed does not carry. The map
   is built offline and committed (see scripts/cgmap.mjs) because CoinGecko's
   list endpoint rate-limits Cloudflare. Every entry in it was verified against
   a live price, which rejected eleven ticker collisions — TON matched a
   tokenized AT&T stock quoting 1854% off. A wrong price is far worse than a
   missing one: absence renders grey and reads as "no data", while a confident
   wrong number is indistinguishable from a real move.
   ========================================================================== */

import CGMAP from './cgmap.mjs';

const LLAMA = 'https://coins.llama.fi/prices/';

/* Sixty ids per URL. Verified against the live endpoint; the limit is URL
   length rather than a documented cap. */
const CHUNK = 60;

const DAY = 86400000;
const FRESH_MS = 24 * 60 * 60 * 1000;

/* How far a returned price may sit from the date asked for. DefiLlama answers
   with the nearest point it holds and reports its timestamp, so a coin that did
   not exist a year ago comes back dated to its listing. Without this check that
   price would silently become a twelve-month return measured over five months. */
const ANCHOR_SLACK = 10 * DAY;

export const KEY = 'cryptowin';

async function batch(kind, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK).map(x => 'coingecko:' + x).join(',');
    const r = await fetch(LLAMA + kind + '/' + part, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('llama ' + r.status);
    const j = await r.json();
    for (const [k, v] of Object.entries((j && j.coins) || {})) {
      if (v && v.price > 0) out.set(k.replace(/^coingecko:/, ''), v);
    }
  }
  return out;
}

export async function loadWindows(store) {
  try { return (await store.get(KEY)) || {}; } catch { return {}; }
}

/* Rebuild every window in one pass, at most once a day. Returns counts so cron
   reports work done rather than silence — a bare zero here once hid an upstream
   block behind a success response for a full warm-up run. */
export async function refreshWindows(store, symbols, force = false, extra = {}) {
  const rec = await loadWindows(store);
  /* `extra` maps symbols cgmap does not carry (the Compute tab's tokens) to
     their CoinGecko ids, and is consulted first */
  const pairs = symbols.map(s => [s, extra[s] || CGMAP[s]]).filter(([, id]) => id);
  const ids = [...new Set(pairs.map(([, id]) => id))];
  /* Fresh means read within the day *and* every id asked about now was asked
     about then, so a newly added coin does not wait a day for its windows.
     A record from before `tried` existed counts as covering everything. */
  const tried = new Set(rec.tried || []);
  const covered = !rec.tried || ids.every(id => tried.has(id));
  if (!force && rec.at && (Date.now() - rec.at) < FRESH_MS && covered) {
    return { refreshed: 0, known: Object.keys(rec.w || {}).length, fresh: true };
  }

  if (!ids.length) return { refreshed: 0, known: 0, unmapped: symbols.length };

  const t30 = Date.now() - 30 * DAY;
  const t365 = Date.now() - 365 * DAY;

  let now, m, y;
  try {
    /* Current from the same source as the history, deliberately. Mixing
       CoinPaprika's spot with DefiLlama's history would fold the gap between
       two venues into every reported return. */
    now = await batch('current', ids);
    m = await batch('historical/' + Math.floor(t30 / 1000), ids);
    y = await batch('historical/' + Math.floor(t365 / 1000), ids);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { refreshed: 0, known: Object.keys(rec.w || {}).length,
             failed: true, why: /^llama \d+$/.test(msg) ? msg : (e && e.name) || 'error' };
  }

  const anchored = (hit, target) => {
    if (!hit || !(hit.price > 0)) return null;
    const at = Number(hit.timestamp) * 1000;
    if (!Number.isFinite(at) || Math.abs(at - target) > ANCHOR_SLACK) return null;
    return hit.price;
  };

  const w = {};
  let n = 0;
  for (const [sym, id] of pairs) {
    const cur = now.get(id);
    if (!cur || !(cur.price > 0)) continue;
    const a30 = anchored(m.get(id), t30);
    const a365 = anchored(y.get(id), t365);
    if (a30 == null && a365 == null) continue;
    w[sym] = {
      d30: a30 == null ? null : ((cur.price - a30) / a30) * 100,
      y1: a365 == null ? null : ((cur.price - a365) / a365) * 100,
    };
    n++;
  }

  const next = { at: Date.now(), w, tried: ids };
  try { await store.put(KEY, next); } catch { /* next tick retries */ }
  return { refreshed: n, known: n, mapped: ids.length, universe: symbols.length };
}

/* Fold what is cached into a freshly fetched universe. Absent stays null, so an
   unmapped coin keeps rendering grey for these two windows while its 1h, 24h
   and 7d continue to come from CoinPaprika. */
export function applyWindows(tokens, rec) {
  const w = (rec && rec.w) || {};
  for (const t of tokens) {
    const e = w[t.sym];
    if (!e) continue;
    t.pc.d30 = Number.isFinite(e.d30) ? e.d30 : null;
    t.pc.y1 = Number.isFinite(e.y1) ? e.y1 : null;
  }
  return tokens;
}
