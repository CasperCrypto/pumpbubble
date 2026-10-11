/* ==========================================================================
   pumpbubble.fun — KOLs: who pump.fun pays to call, and whether following
   them paid.

   pump.fun pays callers "callout rewards" in USDC (launched August 2026).
   Who earned what is public, and so is each caller's record, but they live
   on three endpoints that nobody joins:

   - `GET frontend-api-v3.pump.fun/payouts/leaderboard` — the confirmed-payout
     board: top 500, paged (`page`, `pageSize` ≤ 200), all-time or a rolling
     `period` of 1d / 1w / 1m. Each row: username, avatar, verified, the
     wallets, total paid in USDC, number of payouts, last paid. Measured
     2026-10-11: chairman $310,013 over 60 payouts at #1; 30 requests a minute.
   - `GET …/users/<wallet>` — the profile: pump.fun followers (Yennii56:
     92,122), following, the X handle.
   - `GET …/callout/list/<wallet>?limit=100` — the last hundred calls: market
     cap at the call, the multiple now, the peak multiple. 60 a minute.

   What the board says that pump.fun's does not: **paid is not good.** The
   payouts board ranks by money received; the record says what a follower got.
   Peak is what a perfect seller got; "now" is what a follower who bought at
   the call and held has today — both are shown, never only the peak (the
   same rule as the Calls tab). And the market cap a caller calls at is how
   much room a follower has: the earliest analysis of these rewards found 80%
   of the top earners calling coins under $100k.

   Polled by the CallersDO, beside the calls (worker/index.js): the payout
   boards every half hour, then a few KOLs' records each tick, each refreshed
   every six hours. Nothing is stored that pump.fun does not publish itself.
   ========================================================================== */

import { clean, isMint } from './core.mjs';
import { legalX } from './callers.mjs';

const API = 'https://frontend-api-v3.pump.fun';
export const PAYOUTS = API + '/payouts/leaderboard';
export const listUrl = w => API + '/callout/list/' + encodeURIComponent(w) + '?limit=100';
export const userUrl = w => API + '/users/' + encodeURIComponent(w);

/* our window id → pump.fun's `period` (absent = all-time) */
export const KOL_PERIODS = { all: '', '1m': '1m', '1w': '1w', '1d': '1d' };
export const PAY_SIZE = 100;
export const PAY_EVERY = 30 * 60_000;
export const HIST_TTL = 6 * 3600_000;
export const PROFILE_TTL = 12 * 3600_000;
export const KOL_PER_TICK = 2;          // KOLs refreshed per tick, two requests each
export const KOL_WARM = 5;              // while most have no record yet
export const KOL_MAX = 300;             // people kept (the union of the four boards)

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const posNum = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
const httpsOnly = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,400}$/i.test(u)) ? u : '';

export function median(xs) {
  const a = xs.filter(x => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const mean = xs => { const a = xs.filter(x => Number.isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

/* A payout row. The Solana wallet is the one the record lives under; a row
   whose listed wallet is EVM gets its Solana one from `wallets`. */
export function shapePayout(e) {
  if (!e || typeof e !== 'object') return null;
  const ws = [e.walletAddress, ...(Array.isArray(e.wallets) ? e.wallets : [])].map(String);
  const wallet = ws.find(w => isMint(w)) || '';
  const name = clean(e.username || '', 24);
  if (!name && !wallet) return null;
  return {
    rank: num(e.rank),
    userId: String(e.userId || '').slice(0, 64),
    wallet,
    name: name || wallet.slice(0, 4) + '…' + wallet.slice(-4),
    avatar: httpsOnly(e.profileImageUrl),
    verified: !!e.isVerified,
    paid: Math.max(0, num(e.totalPaidUsdc)),
    payouts: num(e.payoutCount),
    lastPaidAt: Date.parse(e.lastPaidAt) || 0,
  };
}

export function shapeProfile(j) {
  if (!j || typeof j !== 'object') return null;
  return {
    followers: posNum(j.followers) || (j.followers === 0 ? 0 : null),
    following: posNum(j.following) || 0,
    xh: legalX(j.x_username),
    person: j.kind ? j.kind === 'person' : true,
    banned: !!j.is_banned,
  };
}

/* The last hundred calls → the numbers the board shows. Perp calls carry no
   market cap and are left out; a call with no peak yet is still a call. */
export function shapeHistory(j) {
  const calls = (j && Array.isArray(j.callouts) ? j.callouts : []).filter(c => c && !c.perp);
  if (!calls.length) return { n: 0 };
  const mcaps = calls.map(c => num(c.marketCap)).filter(x => x > 0);
  const peaks = calls.map(c => posNum(c.maxMultiplier)).filter(x => x != null);
  const nows = calls.map(c => posNum(c.multiple)).filter(x => x != null);
  const ats = calls.map(c => num(c.createdAt)).filter(x => x > 0);
  return {
    n: calls.length,
    avgMcap: mean(mcaps), medMcap: median(mcaps),
    under100k: mcaps.length ? mcaps.filter(x => x < 100_000).length / mcaps.length : null,
    medPeak: median(peaks), avgPeak: mean(peaks),
    hit2: peaks.length ? peaks.filter(x => x >= 2).length / peaks.length : null,
    medNow: median(nows),
    inProfit: nows.length ? nows.filter(x => x >= 1).length / nows.length : null,
    firstAt: ats.length ? Math.min(...ats) : 0, lastAt: ats.length ? Math.max(...ats) : 0,
  };
}

export class KolBook {
  constructor() {
    this.boards = {};          // period → { at, total, rows: [payout] }
    this.people = new Map();   // wallet → { profile, profileAt, hist, histAt, failAt }
    this.due = 0;              // next payout-board refresh
    this.backoff = 0;
    this.polls = { lastOk: 0, lastError: '', errors: 0 };
  }
  static from(saved) {
    const k = new KolBook();
    if (saved && typeof saved === 'object') {
      if (saved.boards && typeof saved.boards === 'object') k.boards = saved.boards;
      for (const p of saved.people || []) if (p && p.wallet) k.people.set(p.wallet, p);
      k.due = num(saved.due);
    }
    return k;
  }
  toJSON() {
    return { boards: this.boards, people: [...this.people.values()], due: this.due };
  }

  applyPayouts(period, json, now = Date.now()) {
    const rows = (json && Array.isArray(json.entries) ? json.entries : []).map(shapePayout).filter(Boolean);
    if (!rows.length) return 0;          // an empty answer never replaces a board
    this.boards[period] = { at: now, total: num(json.totalEarners), rows };
    for (const r of rows) if (r.wallet && !this.people.has(r.wallet)) this.people.set(r.wallet, { wallet: r.wallet });
    this.prune();
    return rows.length;
  }

  /* everyone on any board, most-paid first, so the top of the all-time board
     has its record before anyone else */
  wanted() {
    const best = new Map();
    for (const b of Object.values(this.boards)) {
      for (const r of b.rows || []) if (r.wallet) best.set(r.wallet, Math.min(best.get(r.wallet) || 1e9, r.rank || 1e9));
    }
    return best;
  }
  prune() {
    if (this.people.size <= KOL_MAX) return;
    const want = this.wanted();
    const keep = [...this.people.values()].sort((a, b) => (want.get(a.wallet) || 1e9) - (want.get(b.wallet) || 1e9)).slice(0, KOL_MAX);
    this.people = new Map(keep.map(p => [p.wallet, p]));
  }
  needed(now = Date.now(), n = KOL_PER_TICK) {
    if (now < this.backoff) return [];
    const want = this.wanted();
    const due = [];
    for (const [w, rank] of want) {
      const p = this.people.get(w) || { wallet: w };
      if (p.failAt && now - p.failAt < 15 * 60_000) continue;
      const stale = !p.histAt || now - p.histAt > HIST_TTL || !p.profileAt || now - p.profileAt > PROFILE_TTL;
      if (stale) due.push({ w, rank, cold: !p.histAt });
    }
    due.sort((a, b) => (b.cold ? 1 : 0) - (a.cold ? 1 : 0) || a.rank - b.rank);
    return due.slice(0, n).map(d => d.w);
  }
  person(w) {
    if (!this.people.has(w)) this.people.set(w, { wallet: w });
    return this.people.get(w);
  }
  applyHistory(w, json, now = Date.now()) { const p = this.person(w); p.hist = shapeHistory(json); p.histAt = now; p.failAt = 0; }
  applyProfile(w, json, now = Date.now()) { const p = this.person(w); const s = shapeProfile(json); if (s) { p.profile = s; p.profileAt = now; } }
  failed(w, now = Date.now(), status = 0) {
    this.person(w).failAt = now;
    if (status === 429) this.backoff = now + 10 * 60_000;
  }

  /* The board as the page reads it: pump.fun's order (money received), with
     each KOL's followers and record joined on. */
  board(period = 'all') {
    const b = this.boards[period] || this.boards.all;
    if (!b) return { rows: [], at: 0, total: 0 };
    const rows = (b.rows || []).map(r => {
      const p = (r.wallet && this.people.get(r.wallet)) || {};
      const h = p.hist || null, f = p.profile || null;
      return {
        ...r,
        xh: f ? f.xh : '',
        followers: f ? f.followers : null,
        n: h ? h.n : null,
        avgMcap: h ? h.avgMcap : null, medMcap: h ? h.medMcap : null, under100k: h ? h.under100k : null,
        medPeak: h ? h.medPeak : null, avgPeak: h ? h.avgPeak : null, hit2: h ? h.hit2 : null,
        medNow: h ? h.medNow : null, inProfit: h ? h.inProfit : null,
        firstAt: h ? h.firstAt : 0, lastAt: h ? h.lastAt : 0,
        perPayout: r.payouts ? r.paid / r.payouts : null,
      };
    });
    return { rows, at: b.at, total: b.total };
  }

  status(now = Date.now()) {
    let withHist = 0, withProfile = 0;
    for (const p of this.people.values()) { if (p.hist) withHist++; if (p.profile) withProfile++; }
    return {
      boards: Object.fromEntries(Object.entries(this.boards).map(([k, v]) => [k, (v.rows || []).length])),
      people: this.people.size, withHist, withProfile, ...this.polls, backoff: Math.max(0, this.backoff - now),
    };
  }
}

/* One tick's KOL work: the four boards when due, then a few KOLs' records.
   A tick that read the boards reads only KOL_PER_TICK people, so no tick
   passes 4 + 2×KOL_PER_TICK or 2×KOL_WARM requests — beside the calls' own
   twenty-odd and the alerts, inside the fifty an invocation may make. */
export async function pollKols(kb, now = Date.now(), http) {
  const out = { boards: 0, people: 0, errors: [] };
  const note = (what, e) => { out.errors.push(what + ': ' + String((e && e.message) || e).slice(0, 80)); };
  const boardTick = now >= kb.due && now >= kb.backoff;
  if (boardTick) {
    kb.due = now + PAY_EVERY;
    for (const [id, period] of Object.entries(KOL_PERIODS)) {
      try {
        const j = await http.get(PAYOUTS + '?page=0&pageSize=' + PAY_SIZE + (period ? '&period=' + period : ''));
        if (kb.applyPayouts(id, j, now)) out.boards++;
      } catch (e) { note('payouts', e); if (e && e.status === 429) { kb.backoff = now + 10 * 60_000; break; } }
    }
  }
  let withHist = 0;
  for (const p of kb.people.values()) if (p.hist) withHist++;
  const n = !boardTick && withHist < Math.min(60, kb.people.size) ? KOL_WARM : KOL_PER_TICK;
  for (const w of kb.needed(now, n)) {
    try {
      const p = kb.person(w);
      if (!p.histAt || now - p.histAt > HIST_TTL) kb.applyHistory(w, await http.get(listUrl(w)), now);
      if (!p.profileAt || now - p.profileAt > PROFILE_TTL) kb.applyProfile(w, await http.get(userUrl(w)), now);
      out.people++;
    } catch (e) {
      kb.failed(w, now, e && e.status);
      note('kol', e);
      if (e && e.status === 429) break;
    }
  }
  if (!out.errors.length) kb.polls.lastOk = now;
  else { kb.polls.errors++; kb.polls.lastError = out.errors[0]; }
  return out;
}

/* The dev server and the tests: the callers' in-memory watcher with the KOL
   book beside it, as the CallersDO holds both. */
export function withKols(callers, http) {
  const kb = new KolBook();
  return async (op, b = {}) => {
    const now = Date.now();
    if (op === 'kols') {
      const period = KOL_PERIODS[b.period] !== undefined ? b.period : 'all';
      return { ok: true, period, ...kb.board(period), status: kb.status(now) };
    }
    if (op === 'tick') { try { await pollKols(kb, now, http); } catch { /* the next tick */ } }
    return callers(op, b);
  };
}
