/* ==========================================================================
   pumpbubble.fun — who counts as smart money, by wallet

   The same boards the Smart money tab is built from — pump.fun's PnL
   leaderboards re-ranked by realized profit, daily, weekly and monthly — as a
   wallet → trader lookup, so a buy alert can say *who* just bought when the
   buyer is one of them. No buy bot has this: it turns a feed of anonymous
   buys into a feed a trader watches.

   Read through a ten-minute per-isolate cache: three calls to a list pump.fun
   itself refreshes every few minutes. Each wallet keeps its best standing —
   the period where it ranks highest — because "#3 this week" is the claim
   worth printing, not "#71 this month".
   ========================================================================== */

import { board, shapeTrader } from './traders.mjs';

const TTL = 10 * 60_000;
const WORD = { daily: 'today', weekly: 'this week', monthly: 'this month' };
let mem = { at: 0, v: new Map() };

export async function smartWallets(now = Date.now()) {
  if (mem.v.size && now - mem.at < TTL) return mem.v;
  const out = new Map();
  for (const period of ['daily', 'weekly', 'monthly']) {
    let b;
    try { b = await board(period, 'realized'); } catch { continue; }
    (b.entries || []).forEach((e, i) => {
      const t = shapeTrader(e, period);
      if (!t) return;
      const rank = +e.rank || i + 1;
      const cur = out.get(t.wallet);
      if (cur && cur.rank <= rank) return;
      out.set(t.wallet, { wallet: t.wallet, name: t.sym, xh: t.xh || '', rank, period, when: WORD[period], realized: t.realized });
    });
  }
  /* a failed refresh keeps the last good list rather than forgetting everyone */
  if (out.size || !mem.v.size) mem = { at: now, v: out };
  else mem.at = now - TTL + 60_000;
  return mem.v;
}

/* The ones the Helius webhook watches: the best-ranked hundred, not all three
   hundred. These wallets trade all day and every transaction is a billed
   webhook delivery on the same webhook as every group's buy alerts — running
   the plan out of credits would silence the buybot everywhere. */
/* Ten, not a hundred. Every transaction of every watched wallet is a Helius
   delivery, and every delivery is a Worker request. Measured from the
   account's analytics: the site ran ~7,700 requests a day before the bot,
   56,000–80,000 a day once the top hundred were on the webhook, and 356,000
   on 2026-09-30 — a memecoin frenzy, 371,067 of them to /tg/trade in six
   hours — which put every route behind Cloudflare 1027 on the free plan's
   100,000 a day. Ten of the best by profit banked keep the feature and fit
   a frenzy day; more can come back with Workers Paid. */
export const SMART_WATCH = 10;
export function topSmart(map, n = SMART_WATCH) {
  return new Map([...(map || new Map()).entries()].sort((a, b) => a[1].rank - b[1].rank).slice(0, n));
}

/* What a follower of the top traders hears about: a new position of a
   meaningful size, or a full exit — not every add and trim, which from a
   hundred busy wallets is thousands of messages a day. */
export const SMART_MIN_SOL = 1;
export const smartSignal = s => s && s.sol >= SMART_MIN_SOL && ((s.side === 'buy' && s.newHolder) || (s.side === 'sell' && s.closed));

export function _setSmartForTests(list) {
  mem = { at: Date.now(), v: new Map((list || []).map(t => [t.wallet, t])) };
}
