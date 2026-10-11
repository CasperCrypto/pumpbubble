/* ==========================================================================
   pumpbubble.fun — Callers: who on pump.fun calls winners, measured.

   A pump.fun callout is a public call on a coin the caller holds, pushed to
   their followers (one per account every six hours). pump.fun ranks callers
   itself, behind a login. This ranks them in the open, from what is public:

   - `GET frontend-api-v3.pump.fun/home-feed` — pump.fun's ranked feed, ~150
     live calls, each with the caller's *own position* in the coin: tokens
     still held, their value, realized and total PnL. That is the part nobody
     else shows: whether the caller is still in what they called.
   - `GET …/home-feed/new` — the 25 newest calls. Measured 2026-09-30: 25
     calls in 36 seconds, about forty a minute.
   - `GET …/users/<wallet>/callout-stats` — per caller, per day, week and
     month: how many calls, the share that reached 1.2×, 1.5× and 2×, the
     average and median multiple at the peak, and time to peak. A burst of
     forty answered in 2.4 s without complaint.
   - `GET …/callout/list/<wallet>` would give every call, but a burst of forty
     drew 429 with `Retry-After: 584`, and the lockout outlived the burst by
     minutes. So per-caller polling is off the table and the two feeds are
     the stream; the stats endpoint supplies the record.

   Measured, not believed:

   - **Peak is what a perfect seller got; now is what a follower who held
     has.** TIGRINO peaked 19.7× after its call and sat at 0.31× — whoever
     followed and did not sell lost 69%. Both are shown, never only the peak.
   - **The ranking is the 2× hit rate, at the lower edge of its 95% Wilson
     interval,** with a minimum number of calls per window. A caller who went
     3 for 3 has shown less than one who went 20 for 30, and an average
     multiple is one moonshot: a trader this week averaged 3.0× over 24 calls
     on a median of 1.76×.
   - **Whether the caller still holds** comes from their own position in the
     feed, as of when it was read — "sold" is a measurement, not a verdict.

   No keys, no login, nothing stored about anyone that pump.fun does not
   publish itself. The watcher that drives this is the CallersDO in
   worker/index.js; everything here is plain and testable without it.
   ========================================================================== */

import { clean, isMint } from './core.mjs';

const API = 'https://frontend-api-v3.pump.fun';
export const FEED = API + '/home-feed';
export const FEED_NEW = API + '/home-feed/new';
export const COINS = API + '/coins-v2/mints';
export const LB = API + '/pnl-leaderboard';
export const statsUrl = w => API + '/users/' + encodeURIComponent(w) + '/callout-stats';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';

export const WINDOWS = { daily: '24 hours', weekly: '7 days', monthly: '30 days' };
export const MIN_CALLS = { daily: 2, weekly: 5, monthly: 10 };
export const KEEP_MS = 72 * 3600_000;        // calls kept at all
export const LIVE_MS = 48 * 3600_000;        // calls in the live table
export const MAX_CALLS = 1200;
export const MAX_CALLERS = 2500;
export const SAVE_CALLERS = 1000;            // callers written to storage (see toJSON)
export const STATS_TTL = 60 * 60_000;        // a caller's record, refreshed hourly
export const STATS_PER_TICK = 6;
export const STATS_WARM = 15;                // per tick until this many have a record
export const WARM_UNTIL = 150;
export const TOP_N = 20;                     // callers whose new calls are alerts
export const ALERT_MAX_AGE = 15 * 60_000;    // a call older than this is news, not an alert
/* A call from the "new" feed is kept only from somebody with a record; the
   ranked feed is pump.fun's own selection and is kept whole. */
export const KEEP_NEW_MIN_CALLS = 8;
/* what earns a call a row in the live table: a caller whose calls reach 2×
   this often, or a call this many people have already looked at */
export const LIVE_MIN_HIT = 0.25;
export const LIVE_MIN_VIEWS = 1000;

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const fin = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const pos = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
const httpsOnly = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,400}$/i.test(u)) ? u : '';
export const legalX = s => /^[A-Za-z0-9_]{1,15}$/.test(String(s || '')) ? String(s) : '';

/* Lower bound of the 95% Wilson score interval for k successes in n. */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const p = Math.min(1, Math.max(0, k / n)), z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/* --------------------------------------------------------------- shapes */
export function shapeCaller(p) {
  if (!p || !isMint(String(p.walletAddress || ''))) return null;
  const wallet = String(p.walletAddress);
  return {
    wallet,
    name: clean(p.userName || '', 20) || wallet.slice(0, 4) + '…' + wallet.slice(-4),
    xh: legalX(p.xUsername),
    avatar: httpsOnly(p.profileImage),
    verified: !!p.isVerified,
    calls: num(p.totalCallouts),
    person: p.accountKind ? p.accountKind === 'person' : true,
  };
}

/* One feed row → one call. Quotes (somebody reposting another's call) are
   not calls of their own; only Solana coins, which is what Buy can swap. */
export function shapeCall(x, now = Date.now(), src = 'feed') {
  const p = x && x.position, co = p && p.callout;
  if (!co || !co.calloutId || !p || (p.contentKind && p.contentKind !== 'callout')) return null;
  if (!isMint(String(x.coinMint || '')) || !isMint(String(p.walletAddress || ''))) return null;
  if (x.chain && x.chain !== 'solana') return null;
  const at = Date.parse(co.calloutTimestamp);
  if (!Number.isFinite(at)) return null;
  const peakAt = Date.parse(co.maxMultiplierAt);
  return {
    id: String(co.calloutId).slice(0, 64),
    mint: String(x.coinMint),
    sym: clean(x.symbol || '', 12) || '?',
    name: clean(x.coinName || '', 48),
    rawImg: httpsOnly(x.coinImage),
    wallet: String(p.walletAddress),
    at,
    mcapAtCall: num(co.calledOutAtMcap),
    mcapNow: num(x.marketCap), mcapAt: now,
    multiple: pos(co.multiple),
    peak: pos(co.maxMultiplier),
    peakAt: Number.isFinite(peakAt) ? peakAt : 0,
    thesis: clean(co.thesis || '', 180),
    views: num(co.viewCount), likes: num(co.likes),
    replies: num(co.replyCount) || num(co.commentCount),
    held: fin(p.amountHeld), heldUsd: fin(p.valueUsd),
    pnlUsd: fin(p.pnlUsd), realizedUsd: fin(p.realizedPnlUsd), costUsd: fin(p.costBasisUsd),
    seenAt: now, src,
  };
}

/* The caller's record, as pump.fun computes it. `best` is the highest bucket
   of the distribution that has a call in it: "5–10×", "20×+". */
export function shapeStats(j) {
  const out = {};
  for (const w of Object.keys(WINDOWS)) {
    const s = j && j[w];
    if (!s || typeof s !== 'object') continue;
    let best = '';
    for (const b of Array.isArray(s.distribution) ? s.distribution : []) {
      if (num(b && b.count) > 0) best = b.max == null ? num(b.min) + '×+' : num(b.min) + '–' + num(b.max) + '×';
    }
    out[w] = {
      n: num(s.totalCallouts),
      hit2: Math.min(1, num(s.twoXPercent) / 100),
      hit15: Math.min(1, num(s.onePointFiveXPercent) / 100),
      avg: fin(s.averageMultiple), med: fin(s.medianMultiple),
      ttpMs: fin(s.averageTimeToPeakMs),
      best,
    };
  }
  return out;
}

/* What the caller did with their own call, from their position in the feed. */
export function holdStatus(c) {
  if (!c || c.held == null) return '';
  if (!(c.held > 0) || (c.heldUsd != null && c.heldUsd < 1)) return 'sold';
  if (c.realizedUsd != null && c.realizedUsd > 0) return 'trimmed';
  return 'holding';
}

/* The multiple a follower who bought at the call and held would have now. */
export function nowMultiple(c) {
  if (c && c.mcapAtCall > 0 && c.mcapNow > 0) return c.mcapNow / c.mcapAtCall;
  return c ? c.multiple : null;
}

/* -------------------------------------------------------------- the book */
export class CallerBook {
  constructor() {
    this.calls = new Map();     // callout id → call
    this.callers = new Map();   // wallet → caller, with stats
    this.alerted = new Set();   // callout ids already considered for an alert
    this.backoff = 0;           // stats endpoint quiet until
    this.polls = { ticks: 0, lastOk: 0, lastError: '', errors: 0 };
  }
  static from(saved) {
    const b = new CallerBook();
    if (saved && typeof saved === 'object') {
      for (const c of saved.calls || []) if (c && c.id) b.calls.set(c.id, c);
      for (const p of saved.callers || []) if (p && p.wallet) b.callers.set(p.wallet, p);
      for (const id of saved.alerted || []) b.alerted.add(id);
      /* the schedule too: an object recycled between ticks must not refetch
         the PnL boards on every one of them */
      if (saved.due && typeof saved.due === 'object') b.due = { feed: +saved.due.feed || 0, board: +saved.due.board || 0, coins: +saved.due.coins || 0 };
    }
    return b;
  }
  /* Saved as one value, and a SQLite-backed object's value tops out at 2 MB:
     the callers kept are the ones with a record first, at most SAVE_CALLERS. */
  toJSON(now = Date.now()) {
    const keep = [...this.callers.values()]
      .filter(p => p.stats || p.board || now - (p.seenAt || 0) < 7 * 86_400_000)
      .sort((a, b) => (b.board ? 2 : 0) + (b.stats ? 1 : 0) - (a.board ? 2 : 0) - (a.stats ? 1 : 0) || (b.seenAt || 0) - (a.seenAt || 0))
      .slice(0, SAVE_CALLERS);
    return {
      calls: [...this.calls.values()].filter(c => now - c.at < LIVE_MS),
      callers: keep,
      alerted: [...this.alerted].slice(-1500),
      due: this.due || null,
    };
  }

  keepFromNew(who) {
    const p = this.callers.get(who.wallet);
    return who.calls >= KEEP_NEW_MIN_CALLS || !!(p && (p.board || (p.stats && p.stats.weekly && p.stats.weekly.n >= MIN_CALLS.weekly)));
  }

  ingest(json, now = Date.now(), src = 'feed') {
    const rows = json && Array.isArray(json.coins) ? json.coins : [];
    const fresh = [];
    for (const x of rows) {
      const who = shapeCaller(x && x.position);
      if (!who) continue;
      const cur = this.callers.get(who.wallet);
      this.callers.set(who.wallet, {
        ...(cur || {}), ...who, calls: Math.max(who.calls, (cur && cur.calls) || 0), seenAt: now,
      });
      const c = shapeCall(x, now, src);
      if (!c) continue;
      const old = this.calls.get(c.id);
      if (old) {
        /* the call is the same; the market and the caller's position move */
        this.calls.set(c.id, {
          ...old,
          mcapNow: c.mcapNow || old.mcapNow, mcapAt: c.mcapNow ? now : old.mcapAt,
          multiple: c.multiple || old.multiple,
          peak: Math.max(c.peak || 0, old.peak || 0) || null,
          peakAt: c.peakAt || old.peakAt,
          views: Math.max(c.views, old.views || 0), likes: Math.max(c.likes, old.likes || 0),
          replies: Math.max(c.replies, old.replies || 0),
          held: c.held, heldUsd: c.heldUsd, pnlUsd: c.pnlUsd, realizedUsd: c.realizedUsd, costUsd: c.costUsd,
          seenAt: now, src: old.src === 'feed' || src === 'feed' ? 'feed' : 'new',
          sym: c.sym !== '?' ? c.sym : old.sym, name: c.name || old.name, rawImg: c.rawImg || old.rawImg,
        });
        continue;
      }
      if (now - c.at > KEEP_MS) continue;
      if (src === 'new' && !this.keepFromNew(who)) continue;
      this.calls.set(c.id, c);
      fresh.push(c.id);
    }
    this.prune(now);
    return { added: fresh.length, fresh, seen: rows.length };
  }

  prune(now = Date.now()) {
    for (const [id, c] of this.calls) if (now - c.at > KEEP_MS) this.calls.delete(id);
    if (this.calls.size > MAX_CALLS) {
      const keep = [...this.calls.values()].sort((a, b) => b.at - a.at).slice(0, MAX_CALLS);
      this.calls = new Map(keep.map(c => [c.id, c]));
    }
    if (this.callers.size > MAX_CALLERS) {
      const keep = [...this.callers.values()]
        .sort((a, b) => (b.board ? 1 : 0) - (a.board ? 1 : 0) || (b.seenAt || 0) - (a.seenAt || 0))
        .slice(0, MAX_CALLERS);
      this.callers = new Map(keep.map(p => [p.wallet, p]));
    }
    if (this.alerted.size > 3000) this.alerted = new Set([...this.alerted].slice(-1500));
  }

  /* pump.fun's PnL boards: everyone on them made a call, and they are the
     callers with a measured record of banking. Seeded so their stats are
     fetched before they happen to call again. */
  seedBoard(entries, period, now = Date.now()) {
    for (const e of entries || []) {
      if (!e || !isMint(String(e.walletAddress || ''))) continue;
      const w = String(e.walletAddress);
      const cur = this.callers.get(w) || {
        wallet: w, name: clean(e.username || '', 20) || w.slice(0, 4) + '…' + w.slice(-4),
        xh: legalX(e.xUsername), avatar: httpsOnly(e.profileImage), verified: !!e.isVerified, calls: 0, seenAt: 0,
      };
      cur.board = { ...(cur.board || {}), [period]: { rank: num(e.rank), realized: num(e.realizedPnlUsd), at: now } };
      this.callers.set(w, cur);
    }
  }

  needStats(now = Date.now(), n = STATS_PER_TICK) {
    if (now < this.backoff) return [];
    const due = [];
    for (const p of this.callers.values()) {
      if (p.statsAt && now - p.statsAt < STATS_TTL) continue;
      if (!p.board && (p.calls || 0) < 3) continue;   // one call is not a record
      due.push(p);
    }
    due.sort((a, b) => (b.board ? 1 : 0) - (a.board ? 1 : 0) || (b.calls || 0) - (a.calls || 0) || (b.seenAt || 0) - (a.seenAt || 0));
    return due.slice(0, n).map(p => p.wallet);
  }
  applyStats(wallet, json, now = Date.now()) {
    const p = this.callers.get(wallet);
    if (!p) return false;
    p.stats = shapeStats(json);
    p.statsAt = now;
    return true;
  }
  statsFailed(wallet, now = Date.now(), status = 0) {
    const p = this.callers.get(wallet);
    if (p) p.statsAt = now - STATS_TTL + 10 * 60_000;   // try again in ten minutes
    if (status === 429) this.backoff = now + 10 * 60_000;
  }

  /* market caps for the calls on screen, from pump.fun's coin batch */
  staleMints(now = Date.now(), n = 100) {
    const by = new Map();
    for (const c of this.calls.values()) {
      if (now - c.at > LIVE_MS || now - (c.mcapAt || 0) < 3 * 60_000) continue;
      if (!by.has(c.mint) || by.get(c.mint) < c.at) by.set(c.mint, c.at);
    }
    return [...by].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
  }
  applyCoins(list, now = Date.now()) {
    const by = new Map();
    for (const coin of Array.isArray(list) ? list : []) if (coin && coin.mint) by.set(String(coin.mint), coin);
    let n = 0;
    for (const c of this.calls.values()) {
      const coin = by.get(c.mint);
      if (!coin) continue;
      const mc = num(coin.usd_market_cap);
      if (mc > 0) { c.mcapNow = mc; c.mcapAt = now; n++; }
      if (c.sym === '?' && coin.symbol) c.sym = clean(coin.symbol, 12) || c.sym;
      if (!c.name && coin.name) c.name = clean(coin.name, 48);
      if (!c.rawImg) c.rawImg = httpsOnly(coin.image_uri);
      const m = nowMultiple(c);
      if (m && (!c.peak || m > c.peak)) c.peak = m;
    }
    return n;
  }

  /* ------------------------------------------------------------ reading */
  board(win = 'weekly', now = Date.now()) {
    const min = MIN_CALLS[win] || MIN_CALLS.weekly;
    const since = now - ({ daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 }[win] || 7 * 86_400_000);
    const mine = new Map();
    for (const c of this.calls.values()) {
      if (c.at < since) continue;
      if (!mine.has(c.wallet)) mine.set(c.wallet, []);
      mine.get(c.wallet).push(c);
    }
    const rows = [];
    for (const p of this.callers.values()) {
      const s = p.stats && p.stats[win];
      if (!s || s.n < min) continue;
      const seen = (mine.get(p.wallet) || []).sort((a, b) => b.at - a.at);
      const judged = seen.filter(c => holdStatus(c));
      const sold = judged.filter(c => holdStatus(c) === 'sold').length;
      const banked = Math.max(0, ...Object.values(p.board || {}).map(b => num(b.realized)));
      rows.push({
        wallet: p.wallet, name: p.name, xh: p.xh || '', avatar: p.avatar || '', verified: !!p.verified,
        n: s.n, hit2: s.hit2, hit15: s.hit15, med: s.med, avg: s.avg, ttpMs: s.ttpMs, best: s.best,
        score: wilson(Math.round(s.hit2 * s.n), s.n),
        banked: banked || null,
        seenCalls: seen.length,
        soldOf: judged.length >= 3 ? { sold, of: judged.length } : null,
        recent: seen.slice(0, 3).map(c => ({ sym: c.sym, mint: c.mint, at: c.at, now: nowMultiple(c), peak: c.peak })),
        lastAt: seen.length ? seen[0].at : 0,
      });
    }
    rows.sort((a, b) => b.score - a.score || (b.med || 0) - (a.med || 0) || b.n - a.n);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows.slice(0, 100);
  }

  /* The live table is calls worth reading: from a caller with a record (enough
     calls this week, a fair share of them reaching 2×), or a call enough people
     are already watching. The raw stream is forty calls a minute, most from
     accounts with generated names and no record — measured on the first run:
     the newest four were ArrowWellServer, TideMintPapyrus, ShrubCampAction. */
  live(now = Date.now(), limit = 150) {
    const ranks = new Map(this.board('weekly', now).map(r => [r.wallet, r]));
    const out = [];
    for (const c of this.calls.values()) {
      if (now - c.at > LIVE_MS) continue;
      const p = this.callers.get(c.wallet) || {};
      const r = ranks.get(c.wallet);
      const w = p.stats && p.stats.weekly;
      const proven = !!r || !!(w && w.n >= MIN_CALLS.weekly && w.hit2 >= LIVE_MIN_HIT);
      if (!proven && !(c.views >= LIVE_MIN_VIEWS)) continue;
      out.push({
        ...c,
        now: nowMultiple(c),
        status: holdStatus(c),
        proven,
        caller: {
          wallet: c.wallet, name: p.name || c.wallet.slice(0, 4) + '…', xh: p.xh || '', avatar: p.avatar || '',
          verified: !!p.verified, rank: r ? r.rank : 0,
          hit2: w ? w.hit2 : null, n: w ? w.n : null, calls: p.calls || 0,
        },
      });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, limit);
  }

  /* New calls from the week's top callers, each considered once. A call that
     is already old when first seen (a restart, a caller who just entered the
     top) is marked and let go: it is news by then, not an alert. */
  alerts(now = Date.now(), topN = TOP_N) {
    const top = new Map(this.board('weekly', now).slice(0, topN).map(r => [r.wallet, r]));
    const out = [];
    for (const c of this.calls.values()) {
      if (this.alerted.has(c.id) || !top.has(c.wallet)) continue;
      this.alerted.add(c.id);
      if (now - c.at > ALERT_MAX_AGE) continue;
      out.push({ call: c, caller: top.get(c.wallet) });
    }
    return out.sort((a, b) => a.call.at - b.call.at).slice(0, 10);
  }

  status(now = Date.now()) {
    let withStats = 0;
    for (const p of this.callers.values()) if (p.stats) withStats++;
    return { calls: this.calls.size, callers: this.callers.size, withStats, ...this.polls, backoff: Math.max(0, this.backoff - now) };
  }
}

/* ----------------------------------------------------------- the watcher */
/* One tick, given something that can fetch. The newest calls every tick;
   the ranked feed every minute; the PnL boards every half hour; a few
   callers' records each tick; a coin batch for fresh market caps every three
   minutes. Scheduled by the clock, kept on the book, so a restart of the
   process runs each thing once rather than on every tick. At a 20-second
   tick that is about twelve requests at most — far inside the fifty a Worker
   invocation may make, and inside what each endpoint answered when probed. */
export const EVERY = { feed: 60_000, board: 30 * 60_000, coins: 3 * 60_000 };
export async function pollOnce(book, now = Date.now(), http = defaultHttp()) {
  const out = { new: 0, feed: 0, stats: 0, coins: 0, errors: [] };
  const note = (what, e) => { out.errors.push(what + ': ' + String((e && e.message) || e).slice(0, 80)); };
  const due = book.due || (book.due = { feed: 0, board: 0, coins: 0 });
  try { out.new = book.ingest(await http.get(FEED_NEW), now, 'new').added; } catch (e) { note('new', e); }
  if (now - due.feed >= EVERY.feed) {
    due.feed = now;
    try { out.feed = book.ingest(await http.get(FEED), now, 'feed').added; } catch (e) { note('feed', e); }
  }
  if (now - due.board >= EVERY.board) {
    due.board = now;
    for (const period of ['daily', 'weekly', 'monthly']) {
      try {
        const j = await http.get(LB + '?period=' + period + '&sort=realized&limit=100');
        book.seedBoard(j && j.entries, period, now);
      } catch (e) { note('board', e); }
    }
  }
  /* a cold book (a fresh deploy) warms up faster: the stats endpoint took a
     burst of forty without complaint, and fifteen is still a small tick */
  let withStats = 0;
  for (const p of book.callers.values()) if (p.stats) withStats++;
  for (const w of book.needStats(now, withStats < WARM_UNTIL ? STATS_WARM : STATS_PER_TICK)) {
    try { if (book.applyStats(w, await http.get(statsUrl(w)), now)) out.stats++; }
    catch (e) { book.statsFailed(w, now, e && e.status); note('stats', e); if (e && e.status === 429) break; }
  }
  if (now - due.coins >= EVERY.coins) {
    const mints = book.staleMints(now, 100);
    if (mints.length) {
      due.coins = now;
      try { out.coins = book.applyCoins(await http.post(COINS, { mints }), now); } catch (e) { note('coins', e); }
    }
  }
  book.polls.ticks++;
  if (!out.errors.length) book.polls.lastOk = now;
  else { book.polls.errors++; book.polls.lastError = out.errors[0]; }
  return out;
}

export function defaultHttp() {
  const call = async (url, init = {}) => {
    const r = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers || {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; throw e; }
    return r.json();
  };
  return {
    get: url => call(url),
    post: (url, body) => call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

/* The dev server and the tests: the same book, in memory, driven by hand. */
export function memoryCallers() {
  const book = new CallerBook();
  return async (op, b = {}) => {
    const now = Date.now();
    if (op === 'board') return { ok: true, window: b.window || 'weekly', rows: book.board(b.window || 'weekly', now) };
    if (op === 'live') return { ok: true, rows: book.live(now, b.limit || 150) };
    if (op === 'status') return { ok: true, ...book.status(now) };
    if (op === 'tick') { await pollOnce(book, now); return { ok: true }; }
    return { ok: true };
  };
}
