/* ==========================================================================
   pumpbubble.fun — monthly and yearly change for stocks

   The Nasdaq screener that supplies the stocks universe publishes a daily move
   and nothing longer, which is backwards for this asset class: an hourly tick on
   Apple is noise, and the twelve-month line is the story. Nothing free and
   keyless returns long windows for hundreds of symbols in one request — Yahoo's
   batch quote endpoint wants a crumb, and its screener only serves predefined
   lists rather than the top of the market.

   Yahoo's chart endpoint does answer, keylessly and accurately, but one symbol
   at a time. Three hundred of those in a single request would exceed a Worker's
   subrequest budget several times over.

   So it is filled in gradually. Each cron tick enriches a slice, oldest first,
   and the results live in KV until they age out. The map is never blocked on
   this: a symbol with no entry yet reports null and renders grey, exactly like
   any other window with no data behind it, and fills in on a later pass.
   ========================================================================== */

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/* Per cron tick. Well inside a Worker's subrequest allowance with room for the
   snapshot builds sharing the same invocation. */
export const PER_TICK = 30;

/* Recomputed daily. A yearly return does not move enough between two cron ticks
   to be worth a request, and this is what keeps the whole set inside the
   budget once it is warm. */
const FRESH_MS = 24 * 60 * 60 * 1000;

export const KEY = 'stockwin';

/* Daily closes for a year, then the close nearest each anchor date.

   Selecting by index looked simpler and was wrong: Yahoo returns two bars for
   the month in progress, both equal to the current price, so "the previous
   monthly close" was today compared against today and every stock reported a
   flat month. Anchoring on dates is immune to how many bars a range happens to
   contain.

   Computed here rather than read from a field, too. Yahoo publishes
   fiftyDayAverageChangePercent, but that is the price against its own moving
   average — a different quantity from a one-month return, and labelling it as
   one would be a number we made up. */
async function windowsFor(symbol) {
  const r = await fetch(YAHOO + encodeURIComponent(symbol) + '?range=1y&interval=1d', {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();

  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const rawClose = (res && res.indicators && res.indicators.quote
    && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const stamps = (res && res.timestamp) || [];
  const now = res && res.meta && res.meta.regularMarketPrice;
  if (!(now > 0) || !stamps.length) return null;

  /* Pair each close with its day, dropping the gaps Yahoo leaves for holidays. */
  const series = [];
  for (let i = 0; i < stamps.length; i++) {
    if (rawClose[i] != null) series.push({ t: stamps[i] * 1000, c: rawClose[i] });
  }
  if (series.length < 2) return null;

  /* The last close at or before an anchor. Markets are shut at weekends, so
     "thirty days ago" frequently is not a trading day. */
  const closeAt = (targetMs) => {
    let found = null;
    for (const p of series) { if (p.t <= targetMs) found = p; else break; }
    return found ? found.c : null;
  };
  const pct = (from) => (from > 0 ? ((now - from) / from) * 100 : null);

  const DAY = 86400000;
  const monthAgo = closeAt(Date.now() - 30 * DAY);
  const oldest = series[0];
  /* Only claim a year when there is close to a year of history behind it: a
     stock listed in March has no twelve-month return, and inventing one from
     five months of data is the same lie in a smaller font. */
  const hasYear = (Date.now() - oldest.t) > 330 * DAY;

  return {
    d30: monthAgo ? pct(monthAgo) : null,
    y1: hasYear ? pct(oldest.c) : null,
    at: Date.now(),
  };
}

export async function loadWindows(store) {
  try { return (await store.get(KEY)) || {}; } catch { return {}; }
}

/* Enrich the next slice. Returns how many were refreshed, so the cron can say
   so rather than reporting silent success. */
export async function refreshWindows(store, symbols, limit = PER_TICK) {
  const have = await loadWindows(store);
  const now = Date.now();

  /* Stalest first, so the set converges instead of one end starving. Anything
     still fresh is skipped entirely. */
  const due = symbols
    .filter(s => !have[s] || (now - (have[s].at || 0)) > FRESH_MS)
    .sort((a, b) => ((have[a] && have[a].at) || 0) - ((have[b] && have[b].at) || 0))
    .slice(0, limit);

  if (!due.length) return { refreshed: 0, known: Object.keys(have).length };

  const got = await Promise.all(due.map(async sym => {
    try { return [sym, await windowsFor(sym)]; } catch { return [sym, null]; }
  }));

  let n = 0;
  for (const [sym, w] of got) {
    if (!w) continue;
    have[sym] = w;
    n++;
  }

  /* Bounded: the universe is 300 symbols and this should never grow past it,
     but a delisting would otherwise leave an entry behind forever. */
  const live = new Set(symbols);
  for (const k of Object.keys(have)) if (!live.has(k)) delete have[k];

  try { await store.put(KEY, have); } catch { /* next tick retries */ }
  return { refreshed: n, known: Object.keys(have).length };
}

/* Fold what is cached into a freshly fetched universe. Absent stays null. */
export function applyWindows(tokens, windows) {
  for (const t of tokens) {
    const w = windows[t.sym];
    if (!w) continue;
    t.pc.d30 = Number.isFinite(w.d30) ? w.d30 : null;
    t.pc.y1 = Number.isFinite(w.y1) ? w.y1 : null;
  }
  return tokens;
}
