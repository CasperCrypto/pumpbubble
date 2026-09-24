/* ==========================================================================
   pumpbubble.fun — Traders: pump.fun's leaderboard, ranked by what was banked

   pump.fun publishes its trader leaderboard at

     frontend-api-v3.pump.fun/pnl-leaderboard?period=<daily|weekly|monthly>
                                             &sort=<combined|realized|unrealized>
                                             &limit=100

   (found by hooking the leaderboard page's own fetch and switching its 1W tab;
   the page is server-rendered, so nothing shows in the network log on a cold
   load). The page sorts by `combined` — realized plus unrealized — and that
   is the whole reason this tab exists: on the day it was built, pump.fun's
   daily #1 showed +$1.1M with **$0 realized**, and its weekly #1 showed
   +$1.31M with **−$31,848 realized**. The top of pump.fun's board is paper.

   So this tab ranks by `realized`: profit on what was actually sold for more
   than it cost. Size is realized profit. Colour is the *total* (realized plus
   what the open positions are worth now), which is the part that tells a
   story — @CookerFlips banked +$58,707 in a day while sitting on −$79,435 of
   open bags, and draws as a large red bubble. Both numbers are pump.fun's
   own; nothing here is computed except a sign and a sum they already give.

   Everyone on the list is a pump.fun profile that opted into the leaderboard
   (pump.fun only ranks users who have made a public callout), so nothing is
   published here that pump.fun does not publish itself. There is no losers
   ordering on the endpoint, and none is built: a "biggest losers" board of
   named people is a different thing from a leaderboard they entered.
   ========================================================================== */

import { clean } from './core.mjs';

export const LB = 'https://frontend-api-v3.pump.fun/pnl-leaderboard';
export const PERIODS = { daily: 'h24', weekly: 'd7', monthly: 'd30' };
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';
const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };

export async function board(period, sort) {
  const r = await fetch(`${LB}?period=${period}&sort=${sort}&limit=100`, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('pnl-leaderboard ' + r.status);
  const j = await r.json();
  if (!j || !Array.isArray(j.entries)) throw new Error('pnl-leaderboard: no entries');
  return j;
}

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const httpsOnly = u => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u.slice(0, 400) : '';

/* One leaderboard row → one map bubble. `pumpRank` is where the same wallet
   sits on pump.fun's own (combined) board, or 0 if it is not in their top 100. */
export function shapeTrader(e, period, pumpRank = 0) {
  if (!e || !WALLET.test(String(e.walletAddress || ''))) return null;
  const realized = num(e.realizedPnlUsd);
  /* A board of what was banked has no place for a loss: a row with nothing
     realized was only on the list because the list ran out. */
  if (realized == null || realized <= 0) return null;
  const unrealized = num(e.unrealizedPnlUsd);
  const total = num(e.pnlUsd);
  const tf = PERIODS[period];
  const wallet = String(e.walletAddress);
  const name = clean(e.username || '', 20) || wallet.slice(0, 4) + '…' + wallet.slice(-4);
  return {
    id: 'trader:' + wallet,
    kind: 'trader',
    /* No mint, no addr: a trader is not a token, and the card's Boost and Buy
       buttons key off those two fields to decide whether to show. */
    mint: '', addr: '',
    wallet,
    sym: name,
    name: e.xUsername ? '@' + clean(e.xUsername, 30) : name,
    xh: e.xUsername ? clean(e.xUsername, 30) : '',
    verified: !!e.isVerified,
    rawImg: httpsOnly(e.profileImage),
    img: '',
    /* the field that sizes a bubble everywhere else on the map */
    mcap: realized,
    realized,
    unrealized,
    total,
    totalPct: num(e.pnlPercent),
    buySpendSol: num(e.buySpendSol),
    positions: num(e.positionsCount),
    top: (Array.isArray(e.topPositions) ? e.topPositions : []).slice(0, 3).map(p => ({
      sym: clean(p && p.symbol, 12), mint: clean(p && p.mint, 60),
    })).filter(p => p.sym),
    rank: +e.rank || 0,
    pumpRank,
    refreshedAt: num(e.lastRefreshedAtMs),
    period,
    /* Colour is the total, in the window the tab is showing — green if the
       trader is up overall, red if the open bags outweigh what was banked. */
    pc: { m5: null, h1: null, h6: null, h24: null, d7: null, d30: null, y1: null,
          [tf]: num(e.pnlPercent) },
    vol: 0, liq: 0, price: 0, grad: true, solid: true, flags: [], copies: 1,
  };
}

/* Both boards for a period: realized for the ranking, combined only to say
   where each trader sits on pump.fun's own list. The second call failing is
   not an error — the tab still works, it just cannot make the comparison. */
export async function tradersFor(period) {
  if (!PERIODS[period]) throw new Error('unknown period');
  const [real, comb] = await Promise.allSettled([board(period, 'realized'), board(period, 'combined')]);
  if (real.status !== 'fulfilled') throw real.reason;
  const pumpRank = new Map();
  if (comb.status === 'fulfilled') {
    for (const e of comb.value.entries) if (e && e.walletAddress) pumpRank.set(String(e.walletAddress), +e.rank || 0);
  }
  const out = [];
  for (const e of real.value.entries) {
    const t = shapeTrader(e, period, pumpRank.get(String(e && e.walletAddress)) || 0);
    if (t) out.push(t);
  }
  return out;
}
