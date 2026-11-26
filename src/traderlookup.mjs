/* ==========================================================================
   pumpbubble.fun — any pump.fun account: does it make its money trading, or
   from what pump.fun pays it for callouts?

   Asked for as "search any trader — slingoorio, netvyxe — and see whether
   they make money trading or from callouts". The boards could only answer it
   for the hundred people on them; this answers it for anyone with a pump.fun
   account, from four public reads (found in pump.fun's own API contract,
   2026-11-26), each through the challenge gate like every pump.fun call:

   - `GET /users/search-v2?searchTerm=` — people by username, pump.fun's own
     search and its order. Fuzzy: "slingoorio" finds slingoor first.
   - `GET /users/<wallet>` — the profile: username, followers, X handle.
   - `GET /portfolio-summary?user=<wallet>&periods=1d,1w,1m,all` — pump.fun's
     PnL for the account's main wallet, Solana and EVM merged: realized
     (banked), unrealized (open bags), total, and what was spent on buys, for
     the trailing day, week and month, and "all" — which starts at pump.fun's
     PnL data floor, 1 July 2026, not at the account's first trade.
   - `GET /users/<wallet>/callout-stats` — the callout record per window, and
     `paidV1Usd + paidV2Usd`: confirmed USDC rewards, summed over every wallet
     the person owns. Checked: netvyxe's all-time pair sums to $108,623.26,
     the payout board's figure to the cent. It also carries what the people
     who bought *through* the calls made ("tailers"), at 1 h, 4 h and 24 h.

   **Only the same window is compared.** callout-stats' weekly and monthly are
   the rolling 7 and 30 days, as portfolio-summary's 1w and 1m are. Its daily
   window carries no payout (today's round has not paid), so a day is shown
   but never compared. All time is rewards ever against trading since 1 July,
   and the page says so beside it.

   Nothing is inferred: a window either side could not read is null, and a
   null is never a zero, a loss or a verdict.
   ========================================================================== */

import { clean, isMint } from './core.mjs';
import { legalX } from './callers.mjs';
import { pumpFetch } from './pumpgate.mjs';

const API = 'https://frontend-api-v3.pump.fun';
export const searchUrl = q => API + '/users/search-v2?searchTerm=' + encodeURIComponent(q) + '&limit=8';
export const userUrl = w => API + '/users/' + encodeURIComponent(w);
export const summaryUrl = w => API + '/portfolio-summary?user=' + encodeURIComponent(w) + '&period=all&periods=1d,1w,1m,all';
export const statsUrl = w => API + '/users/' + encodeURIComponent(w) + '/callout-stats';

/* our window → pump.fun's: portfolio-summary period, callout-stats key */
export const WINDOWS = [
  { id: 'd1', label: '24 hours', pnl: '1d', calls: 'daily', compare: false },
  { id: 'w1', label: '7 days', pnl: '1w', calls: 'weekly', compare: true },
  { id: 'm1', label: '30 days', pnl: '1m', calls: 'monthly', compare: true },
  { id: 'all', label: 'All time', pnl: 'all', calls: 'allTime', compare: true },
];

export const LOOKUP_TTL = 5 * 60_000;
/* pump.fun computes an account's PnL on the first ask and caches it: measured
   for slingoor, ~7 s cold and 0.2 s after. The other reads are quick. */
export const READ_MS = { profile: 10_000, trading: 25_000, callouts: 12_000, search: 10_000 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';

/* GET a pump.fun URL as JSON, through the challenge gate, with its own
   deadline. A refusal by the gate keeps its `challenge` flag. */
export function defaultHttp(fetcher = fetch) {
  return {
    async get(url, ms = 10_000) {
      const r = await pumpFetch(url, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(ms),
      }, fetcher);
      if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; throw e; }
      return r.json();
    },
  };
}
export const SEARCH_TTL = 5 * 60_000;
const CACHE_MAX = 400;

/* A number pump.fun sent, or null. Never 0 for "missing". */
const n = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const usd = o => (o && typeof o === 'object') ? n(o.usd) : null;
const httpsOnly = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,400}$/i.test(u)) ? u : '';
const short = w => w.slice(0, 4) + '…' + w.slice(-4);

/* A search term somebody typed: a wallet, or a username-shaped string.
   pump.fun usernames are letters, digits and underscores; a leading @ is
   dropped because people paste X handles. */
export function cleanQuery(q) {
  const s = String(q || '').trim().replace(/^@+/, '').slice(0, 44);
  if (isMint(s)) return s;
  const u = s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  return u.length >= 2 ? u : '';
}

/* One person row, from search-v2 or /users/<wallet>. */
export function shapePerson(j) {
  if (!j || typeof j !== 'object') return null;
  const wallet = [j.canonical_svm_wallet, j.address].map(String).find(isMint) || '';
  if (!wallet) return null;
  const name = clean(j.username || '', 24);
  return {
    wallet,
    name: name || short(wallet),
    hasName: !!name,
    avatar: httpsOnly(j.profile_image),
    followers: n(j.followers),
    xh: legalX(j.x_username),
    person: j.kind ? j.kind === 'person' : true,
    banned: !!j.is_banned,
  };
}

/* pump.fun's order, with an exact username match lifted to the top —
   somebody who typed the whole name means that account. */
export function shapePeople(rows, q = '') {
  const list = (Array.isArray(rows) ? rows : []).map(shapePerson).filter(p => p && p.person);
  const want = String(q).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const p of list) { if (!seen.has(p.wallet)) { seen.add(p.wallet); out.push(p); } }
  const i = out.findIndex(p => p.hasName && p.name.toLowerCase() === want);
  if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out.slice(0, 6);
}

/* pump.fun's PnL for each window, in dollars. */
export function shapeTrading(sum) {
  if (!sum || typeof sum !== 'object') return null;
  const win = sum.windows && typeof sum.windows === 'object' ? sum.windows : { all: sum };
  const out = {};
  let any = false;
  for (const w of WINDOWS) {
    const x = win[w.pnl];
    if (!x || typeof x !== 'object') { out[w.id] = null; continue; }
    const row = {
      realized: usd(x.realizedPnl),
      unrealized: usd(x.unrealizedPnl),
      total: usd(x.pnl),
      spent: usd(x.totalBuySpend),
      from: n(x.from) ? n(x.from) * 1000 : null,
      tokens: n(x.tokenCount),
    };
    if (row.realized == null && row.total == null) { out[w.id] = null; continue; }
    out[w.id] = row; any = true;
  }
  return any ? out : null;
}

/* The callout record and the rewards, for each window. `paid` is null where
   pump.fun did not compute it (the open daily round, a user barred from
   rewards, a failed payout read) — never 0 for that. */
export function shapeCallouts(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  let any = false;
  const one = x => {
    if (!x || typeof x !== 'object') return null;
    const v1 = n(x.paidV1Usd), v2 = n(x.paidV2Usd);
    return {
      paid: v1 == null && v2 == null ? null : (v1 || 0) + (v2 || 0),
      calls: n(x.totalCallouts),
      hit2: n(x.twoXPercent),
      medPeak: n(x.medianMultiple),
      avgPeak: n(x.averageMultiple),
      /* the people who bought through these calls, and how that went for them */
      tailers: n(x.tailCohort24h),
      tailPnl24h: n(x.tailPnl24hUsd),
      tailBuyers: n(x.tailUniqueBuyers),
      tailVol: n(x.tailVolumeUsd),
    };
  };
  /* A window that is present is an answer, zeros included: someone who never
     called reads "paid $0", which is a verdict ("trading only"). Only an
     answer with no window at all (callout-stats fails open to {}) is no record. */
  for (const w of WINDOWS) {
    const r = one(st[w.calls]);
    out[w.id] = r;
    if (r) any = true;
  }
  const lr = one(st.lastRound);
  out.lastRound = lr ? { ...lr, startsAt: Date.parse(st.lastRound.startsAt) || null, endsAt: Date.parse(st.lastRound.endsAt) || null } : null;
  return any ? out : null;
}

/* Which earned more in one window, from what was measured on both sides.
   Losing money trading while being paid for calls is "callouts"; nothing
   earned either way is "neither". A side that could not be read is null. */
export function verdict(trade, paid) {
  if (trade == null || paid == null) return null;
  if (paid <= 0 && trade <= 0) return 'neither';
  return paid > Math.max(trade, 0) ? 'callouts' : 'trading';
}

export function compare(trading, callouts) {
  const out = {};
  for (const w of WINDOWS) {
    if (!w.compare) continue;
    const trade = trading && trading[w.id] ? trading[w.id].realized : null;
    const paid = callouts && callouts[w.id] ? callouts[w.id].paid : null;
    const v = verdict(trade, paid);
    const earned = (paid > 0 ? paid : 0) + (trade > 0 ? trade : 0);
    out[w.id] = {
      trade, paid, more: v,
      /* share of what was earned that came from callouts (0..1), where both sides are known */
      calloutShare: v && earned > 0 ? (paid > 0 ? paid : 0) / earned : null,
      net: trade != null && paid != null ? trade + paid : null,
    };
  }
  return out;
}

/* One line saying it, for the headline and the ready post. Uses the widest
   window that was measured on both sides. */
export function headline(name, cmp, fmt = v => '$' + Math.round(Math.abs(v)).toLocaleString('en-US')) {
  for (const id of ['all', 'm1', 'w1']) {
    const c = cmp && cmp[id];
    if (!c || !c.more) continue;
    const win = WINDOWS.find(w => w.id === id);
    const span = id === 'all' ? 'since 1 Jul' : 'in ' + win.label;
    const tradeTxt = c.trade < 0 ? 'lost ' + fmt(c.trade) + ' trading' : 'banked ' + fmt(c.trade) + ' trading';
    const paidTxt = 'was paid ' + fmt(c.paid) + ' for callouts';
    const lead = c.more === 'callouts' ? name + ' makes more from callouts than trading'
      : c.more === 'trading' ? name + ' makes more from trading than callouts'
      : name + ' made nothing from either';
    return { window: id, more: c.more, text: lead + ': ' + tradeTxt + ' and ' + paidTxt + ' ' + span + '.' };
  }
  return null;
}

/* ---------------------------------------------------------------- reads */
const cache = new Map();
function cached(key, ttl, now) {
  const c = cache.get(key);
  return c && now - c.at < ttl ? c.v : undefined;
}
function remember(key, v, now) {
  if (cache.size > CACHE_MAX) for (const [k, c] of cache) if (now - c.at > LOOKUP_TTL) cache.delete(k);
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, { at: now, v });
}
export function _clearTraderCache() { cache.clear(); }

/* People matching a term. A wallet resolves to its own profile; a wallet with
   no pump.fun profile is still offered, by address, since it may still trade. */
export async function searchPeople(q, http = defaultHttp(), now = Date.now()) {
  const term = cleanQuery(q);
  if (!term) return [];
  const key = 's:' + term.toLowerCase();
  const hit = cached(key, SEARCH_TTL, now);
  if (hit) return hit;
  let people;
  if (isMint(term)) {
    try { const p = shapePerson(await http.get(userUrl(term), READ_MS.profile)); people = p ? [p] : []; }
    catch (e) {
      if (e && e.challenge) throw e;
      people = [];
    }
    if (!people.length) people = [{ wallet: term, name: short(term), hasName: false, avatar: '', followers: null, xh: '', person: true, banned: false }];
  } else {
    people = shapePeople(await http.get(searchUrl(term), READ_MS.search), term);
  }
  remember(key, people, now);
  return people;
}

/* Everything for one wallet. Each read may fail alone; the answer says which
   did. Only a refusal by pump.fun itself (the challenge) fails the whole
   lookup, because then none of it can be read. */
export async function lookupTrader(wallet, http = defaultHttp(), now = Date.now()) {
  if (!isMint(wallet)) throw Object.assign(new Error('not a Solana wallet'), { status: 400 });
  const key = 'w:' + wallet;
  const hit = cached(key, LOOKUP_TTL, now);
  if (hit) return hit;
  const [pr, sr, cr] = await Promise.allSettled([
    http.get(userUrl(wallet), READ_MS.profile),
    http.get(summaryUrl(wallet), READ_MS.trading),
    http.get(statsUrl(wallet), READ_MS.callouts),
  ]);
  const challenge = [pr, sr, cr].find(r => r.status === 'rejected' && r.reason && r.reason.challenge);
  if (challenge) throw challenge.reason;
  const errors = {};
  /* a deadline is its own reason: the page asks again, pump.fun having cached it by then */
  const why = r => {
    const e = r.reason || {};
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || /abort|timeout/i.test(String(e.message))) return 'timeout';
    return String(e.status || e.message || 'failed').slice(0, 60);
  };
  if (pr.status === 'rejected') errors.profile = why(pr);
  if (sr.status === 'rejected') errors.trading = why(sr);
  if (cr.status === 'rejected') errors.callouts = why(cr);
  const profile = (pr.status === 'fulfilled' && shapePerson(pr.value))
    || { wallet, name: short(wallet), hasName: false, avatar: '', followers: null, xh: '', person: true, banned: false };
  const trading = sr.status === 'fulfilled' ? shapeTrading(sr.value) : null;
  const callouts = cr.status === 'fulfilled' ? shapeCallouts(cr.value) : null;
  const cmp = compare(trading, callouts);
  const out = {
    wallet, profile, trading, callouts, compare: cmp,
    headline: headline(profile.hasName ? profile.name : short(wallet), cmp),
    windows: WINDOWS.map(({ id, label, compare: c }) => ({ id, label, compare: c })),
    errors, at: now,
  };
  /* a lookup where nothing answered is not worth keeping for five minutes */
  if (trading || callouts) remember(key, out, now);
  return out;
}
