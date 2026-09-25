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

export function _setSmartForTests(list) {
  mem = { at: Date.now(), v: new Map((list || []).map(t => [t.wallet, t])) };
}
