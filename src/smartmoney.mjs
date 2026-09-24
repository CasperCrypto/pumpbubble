/* ==========================================================================
   pumpbubble.fun — Smart money: what pump.fun's best traders are holding

   Every bubble is a token, sized by **how many of pump.fun's top traders by
   realized profit hold it right now**. The traders come from the same
   leaderboard as the Traders tab (src/traders.mjs) — the daily, weekly and
   monthly realized boards together, up to 300 people, each counted once —
   and what they hold comes from the `topPositions` pump.fun lists on every
   row. Market data comes from pump.fun too: `coins-v2/mints` for the coins
   themselves, market activity for price change and volume.

   It is the honest version of "spot gems early": nothing here predicts
   anything. It shows where people with a measured record of banking profit
   currently have money.

   **Verified before it was built, because the claim depends on it.** A top
   position could have meant "what they made money on" — sold, gone — which
   would be the opposite signal. Checked against pump.fun's own per-wallet
   PnL (`profile-api.pump.fun/v2/pnl/token/<wallet>/<mint>`, `amount_held`):
   15 of 18 sampled were still held, and the other three were Robinhood
   Chain tokens that endpoint does not cover. They are open positions.

   Why all three boards at once, rather than the timeframe pill choosing one
   as on Traders: the price change available is at most 24 hours, so letting
   1W pick the weekly board would have coloured bubbles by a week's move we
   never measured. Combined, the pills keep their ordinary meaning — and one
   day's board alone was 255 positions across 228 tokens, almost no overlap;
   three boards make "held by several of them" happen.

   Dust is dropped: a trader's "top positions" include tokens named `test`
   and `4` with nothing traded. A token needs real volume and a market cap.
   ========================================================================== */

import { clean, fastImage, isMint, isEvmAddr } from './core.mjs';
import { board } from './traders.mjs';
import { fetchActivity } from './activity.mjs';

const COINS = 'https://frontend-api-v3.pump.fun/coins-v2/mints';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';
/* pump.fun's chain ids on topPositions */
const CHAIN_ID = { 1399811149: 'solana', 4663: 'robinhood', 56: 'bsc', 8453: 'base', 1: 'ethereum' };

export const MIN_VOL = 5_000;      // 24h, USD — below this it is a wallet's leftovers, not a position
export const MIN_MCAP = 10_000;
export const MAX_TOKENS = 90;
/* Market cap over a day's volume. Wrapped majors on Solana carry the whole
   underlying coin's cap — wrapped ETH read $324B and put the header's
   "tracked cap" at $348B — while trading a sliver of it. The same bar the
   pump.fun tab uses when liquidity is unknown: past it, the cap is not a
   number worth drawing, and a wrapped major is not what this tab is for. */
export const MAX_CAP_TO_VOL = 2000;

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;

/* Coin records for many mints at once — symbol, name, art, market cap. */
export async function fetchCoins(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const r = await fetch(COINS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({ mints: chunk }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const arr = await r.json();
      for (const c of Array.isArray(arr) ? arr : []) if (c && c.mint) out.set(String(c.mint), c);
    } catch { /* this chunk has no coin records */ }
  }
  return out;
}

/* The traders, each once: a wallet on the daily and the monthly board is one
   person. Their best realized figure is kept, for the tie-break and the card. */
export function tradersFrom(boards) {
  const byWallet = new Map();
  for (const [period, b] of boards) {
    for (const e of (b && b.entries) || []) {
      const w = String((e && e.walletAddress) || '');
      if (!isMint(w)) continue;
      const realized = num(e.realizedPnlUsd);
      if (!(realized > 0)) continue;
      const cur = byWallet.get(w);
      const who = {
        wallet: w,
        name: clean(e.username || '', 20) || w.slice(0, 4) + '…' + w.slice(-4),
        xh: /^[A-Za-z0-9_]{1,15}$/.test(e.xUsername || '') ? e.xUsername : '',
        realized, period,
        positions: (Array.isArray(e.topPositions) ? e.topPositions : []).map(p => ({
          mint: String((p && p.mint) || ''), chain: CHAIN_ID[p && p.chainId] || '',
          sym: clean(p && p.symbol, 12), img: typeof (p && p.imageUri) === 'string' ? p.imageUri : '',
        })).filter(p => p.mint && p.chain),
      };
      if (!cur || realized > cur.realized) {
        /* keep the positions from every board the trader appears on */
        if (cur) for (const p of cur.positions) if (!who.positions.some(q => q.mint === p.mint)) who.positions.push(p);
        byWallet.set(w, who);
      } else {
        for (const p of who.positions) if (!cur.positions.some(q => q.mint === p.mint)) cur.positions.push(p);
      }
    }
  }
  return [...byWallet.values()];
}

/* Token → who holds it. */
export function holdings(traders) {
  const byMint = new Map();
  for (const t of traders) {
    for (const p of t.positions) {
      const k = p.chain === 'solana' ? p.mint : p.chain + ':' + p.mint.toLowerCase();
      const cur = byMint.get(k) || { key: k, mint: p.mint, chain: p.chain, sym: p.sym, img: p.img, holders: [] };
      if (!cur.holders.some(h => h.wallet === t.wallet)) cur.holders.push({ wallet: t.wallet, name: t.name, xh: t.xh, realized: t.realized });
      byMint.set(k, cur);
    }
  }
  for (const h of byMint.values()) h.holders.sort((a, b) => b.realized - a.realized);
  return [...byMint.values()];
}

/* The score that sizes a bubble: how many top traders hold it, first; what
   those traders have banked between them breaks ties, on a log scale so one
   whale cannot outweigh a second holder. */
export function scoreOf(h) {
  const banked = h.holders.reduce((s, x) => s + x.realized, 0);
  return h.holders.length * 10 + Math.log10(1 + banked);
}

/* One holding + its coin record + its market activity → a map token. */
export function shapeHolding(h, coin, act) {
  const evm = h.chain !== 'solana';
  const addr = h.mint;
  if (!(evm ? isEvmAddr(addr) : isMint(addr))) return null;
  const a24 = act && act['24h'], a1 = act && act['1h'], a5 = act && act['5m'], a6 = act && act['6h'];
  const vol = num(a24 && a24.volumeUSD);
  const mcap = num(coin && coin.usd_market_cap);
  if (vol < MIN_VOL || mcap < MIN_MCAP) return null;
  if (mcap / vol > MAX_CAP_TO_VOL) return null;
  if (coin && coin.is_banned) return null;
  const buys = num(a24 && a24.numBuys), sells = num(a24 && a24.numSells), n = buys + sells;
  const banked = h.holders.reduce((s, x) => s + x.realized, 0);
  return {
    id: evm ? h.chain + ':' + addr.toLowerCase() : addr,
    chain: h.chain,
    mint: evm ? '' : addr,
    addr: evm ? addr.toLowerCase() : '',
    sym: clean((coin && coin.symbol) || h.sym, 12) || '?',
    name: clean((coin && coin.name) || h.sym, 48) || 'unknown',
    rawImg: fastImage((coin && typeof coin.image_uri === 'string' && coin.image_uri) || h.img || ''),
    img: '',
    mcap, vol,
    volH1: num(a1 && a1.volumeUSD),
    liq: 0, price: 0,
    created: num(coin && coin.created_timestamp),
    grad: !coin || coin.complete !== false,
    pc: { m5: pick(a5 && a5.priceChangePercent), h1: pick(a1 && a1.priceChangePercent),
          h6: pick(a6 && a6.priceChangePercent), h24: pick(a24 && a24.priceChangePercent),
          d7: null, d30: null, y1: null },
    txns: n ? { buys, sells, n, sellShare: sells / n } : null,
    smartN: h.holders.length,
    smartBanked: banked,
    smartWho: h.holders.slice(0, 6).map(x => ({ name: x.name, xh: x.xh, realized: Math.round(x.realized) })),
    heat: scoreOf(h),
    via: 'smart',
    solid: true, flags: [], copies: 1, boost: 0,
  };
}

export async function smartMoney() {
  const got = await Promise.allSettled(['daily', 'weekly', 'monthly'].map(p => board(p, 'realized').then(b => [p, b])));
  const boards = got.filter(g => g.status === 'fulfilled').map(g => g.value);
  if (!boards.length) throw new Error('pnl-leaderboard: no board answered');

  const traders = tradersFrom(boards);
  const held = holdings(traders).sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 220);

  const mints = held.map(h => h.mint);
  const [coins, act] = await Promise.all([fetchCoins(mints), fetchActivity(mints)]);

  const out = [];
  for (const h of held) {
    const t = shapeHolding(h, coins.get(h.mint) || coins.get(h.mint.toLowerCase()), act.get(h.mint) || act.get(h.mint.toLowerCase()));
    if (t) out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}
