/* ==========================================================================
   pumpbubble.fun — first-party traffic counting

   Why not Plausible, GA, or Cloudflare's own beacon: the CSP on this site is
   `script-src 'self'` and `connect-src 'self'`, so every one of them would be
   blocked by the browser. Allowing them means punching a hole in the policy
   that also protects a page displaying a payment address — a poor trade for a
   pageview counter.

   Counting in the worker instead costs nothing, cannot be blocked by an ad
   blocker, needs no cookie banner, and is measured where the request actually
   arrives rather than where a script managed to run.

   It is also a sales tool. outbid.lol publishes "1,148,120 visitors since
   launch" on its own board, and that number is doing work: nobody bids for
   attention without evidence the attention exists. So this is built to be shown
   publicly, not just read in a dashboard.

   Privacy: no cookies, no fingerprinting, no third party. The visitor hash is
   SHA-256 over IP + day + a rotating salt, truncated — enough to count the same
   person once a day, useless for identifying them, and the raw IP is never
   written anywhere.
   ========================================================================== */

const DAY = () => new Date().toISOString().slice(0, 10);

/* Per-isolate accumulator. Cloudflare runs many isolates, so these are partial
   counts that get merged into KV on flush — additive for views, set-union for
   visitors, which is why both stay correct across isolates. */
let buf = null;
const fresh = () => ({ day: DAY(), views: 0, paths: {}, refs: {}, seen: new Set() });
const bufFor = () => {
  if (!buf || buf.day !== DAY()) buf = fresh();
  return buf;
};

let lastFlush = 0;
const FLUSH_EVERY = 3 * 60 * 1000;
/* A day's visitor set is stored whole. Past this it stops being worth the
   bytes, and the count is reported as a floor rather than silently wrong. */
const MAX_SEEN = 50_000;

const enc = new TextEncoder();
async function visitorHash(ip, salt) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(ip + '|' + DAY() + '|' + salt));
  /* 6 bytes is ~281 trillion buckets: collisions are irrelevant at any traffic
     level this site will see, and it keeps the stored set small. */
  return [...new Uint8Array(d).slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Only real page reads are counted. API polls would swamp the number — the map
   refetches every 15 seconds — and an inflated figure shown to a bidder is a
   lie that costs more than it gains. */
const COUNTED = /^\/(|market|board|partners|affiliate\.html)$/;

export function shouldCount(path, method) {
  return method === 'GET' && COUNTED.test(path.replace(/\/+$/, '') || '/');
}

export async function record(req, path, salt) {
  const b = bufFor();
  b.views++;
  const key = (path.replace(/\/+$/, '') || '/');
  b.paths[key] = (b.paths[key] || 0) + 1;

  /* Referrer host only. The full URL can carry search terms and personal
     query strings, and the host is all that answers "where is traffic from". */
  const ref = req.headers.get('referer') || '';
  if (ref) {
    try {
      const h = new URL(ref).host.replace(/^www\./, '');
      if (h && !/pumpbubble\.fun$/.test(h)) b.refs[h] = (b.refs[h] || 0) + 1;
    } catch { /* malformed referer: ignore */ }
  }

  const ip = req.headers.get('cf-connecting-ip') || '';
  if (ip && b.seen.size < MAX_SEEN) {
    try { b.seen.add(await visitorHash(ip, salt)); } catch { /* counting is best-effort */ }
  }
}

export function dueForFlush() {
  return Date.now() - lastFlush > FLUSH_EVERY && buf && buf.views > 0;
}

/* Merge this isolate's partial counts into the shared record. Views add;
   visitors union, which is what makes the daily number right rather than
   multiplied by however many isolates served the traffic. */
export async function flush(store) {
  const b = buf;
  if (!b || !b.views) return null;
  buf = fresh();
  lastFlush = Date.now();

  const dayKey = 'stats:' + b.day;
  try {
    const prev = (await store.get(dayKey)) || { views: 0, paths: {}, refs: {}, seen: [] };
    const seen = new Set(prev.seen || []);
    for (const h of b.seen) { if (seen.size < MAX_SEEN) seen.add(h); }

    const merged = {
      day: b.day,
      views: (prev.views || 0) + b.views,
      paths: { ...prev.paths },
      refs: { ...prev.refs },
      seen: [...seen],
    };
    for (const [k, v] of Object.entries(b.paths)) merged.paths[k] = (merged.paths[k] || 0) + v;
    for (const [k, v] of Object.entries(b.refs)) merged.refs[k] = (merged.refs[k] || 0) + v;
    await store.put(dayKey, merged, { ttlSec: 100 * 24 * 3600 });

    /* A running total, so "since launch" survives the daily records expiring. */
    const total = (await store.get('stats:total')) || { views: 0, since: b.day };
    total.views = (total.views || 0) + b.views;
    total.since = total.since || b.day;
    await store.put('stats:total', total);
    return merged;
  } catch {
    return null;   // losing a counter is never worth failing a request over
  }
}

/* What the public endpoint and the pages show. */
export async function summary(store, days = 7) {
  const today = DAY();
  const out = { today: { views: 0, visitors: 0 }, days: [], top: [], refs: [], total: 0, since: today };

  try {
    const total = await store.get('stats:total');
    if (total) { out.total = total.views || 0; out.since = total.since || today; }

    const refs = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const rec = await store.get('stats:' + d);
      const views = rec?.views || 0;
      const visitors = (rec?.seen || []).length;
      out.days.unshift({ day: d, views, visitors });
      if (i === 0) {
        out.today = { views, visitors };
        out.top = Object.entries(rec?.paths || {})
          .sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([path, n]) => ({ path, views: n }));
      }
      for (const [h, n] of Object.entries(rec?.refs || {})) refs[h] = (refs[h] || 0) + n;
    }
    out.refs = Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([host, n]) => ({ host, views: n }));
  } catch { /* an empty summary is better than an error page */ }

  /* Fold in this isolate's unflushed counts. Without this the totals include
     live traffic while the per-page and referrer breakdowns do not, so for the
     first few minutes after a flush the page split contradicts the total. */
  if (buf && buf.day === today) {
    out.today.views += buf.views;
    out.total += buf.views;

    const paths = Object.fromEntries(out.top.map(p => [p.path, p.views]));
    for (const [k, v] of Object.entries(buf.paths)) paths[k] = (paths[k] || 0) + v;
    out.top = Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([path, views]) => ({ path, views }));

    const refs = Object.fromEntries(out.refs.map(r => [r.host, r.views]));
    for (const [k, v] of Object.entries(buf.refs)) refs[k] = (refs[k] || 0) + v;
    out.refs = Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([host, views]) => ({ host, views }));
  }
  return out;
}
