/* ==========================================================================
   pumpbubble.fun — Wallet X-ray: what a wallet's own swaps say about it.

   Runs in the visitor's browser (public/wallet.html) and in the tests. Every
   number is computed from the wallet's own transactions, read from a public
   Solana RPC, parsed by the same parseWalletSwaps() the Telegram bot uses
   (./solbuy.mjs): the wallet signed, SOL went one way and exactly one token
   the other. Token-for-token routes are left out rather than guessed.

   What it can and cannot say, stated on the page:
   - it sees the last N transactions only, so a position bought before that
     window has no known cost — its sells are counted as "bought earlier" and
     left out of realized profit instead of being counted as pure gain;
   - cost is the average price paid in the window (average-cost method);
   - a position is "closed" once at least 99% of what was bought in the
     window has been sold; win rate is over closed positions only;
   - fees are already inside the SOL each swap moved (the parser nets the
     network fee only where the wallet paid it as signer).
   ========================================================================== */

export const CLOSED_AT = 0.99;     // share of window-bought tokens sold to call a position closed
export const QUICK_FLIP_S = 120;   // a round trip shorter than this is a quick flip

const median = xs => {
  const a = xs.filter(x => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/* swaps: parseWalletSwaps() output, any order. */
export function positions(swaps) {
  const by = new Map();
  for (const s of [...swaps].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0) || (a.slot || 0) - (b.slot || 0))) {
    if (!s || !s.mint || (s.side !== 'buy' && s.side !== 'sell')) continue;
    let p = by.get(s.mint);
    if (!p) by.set(s.mint, (p = { mint: s.mint, buys: 0, sells: 0, boughtSol: 0, soldSol: 0, boughtTok: 0, soldTok: 0,
      held: 0, cost: 0, realized: 0, earlierSol: 0, firstBuy: 0, lastSell: 0, lastAt: 0 }));
    p.lastAt = Math.max(p.lastAt, s.blockTime || 0);
    if (s.side === 'buy') {
      p.buys++; p.boughtSol += s.sol; p.boughtTok += s.tokens;
      p.held += s.tokens; p.cost += s.sol;
      if (!p.firstBuy) p.firstBuy = s.blockTime || 0;
    } else {
      p.sells++; p.soldSol += s.sol; p.soldTok += s.tokens; p.lastSell = s.blockTime || 0;
      /* only what was bought in the window has a known cost */
      const known = Math.min(s.tokens, p.held);
      if (known > 0 && p.held > 0) {
        const avg = p.cost / p.held;
        const solForKnown = s.sol * (known / s.tokens);
        p.realized += solForKnown - avg * known;
        p.cost -= avg * known;
        p.held -= known;
      }
      if (s.tokens > known) p.earlierSol += s.sol * ((s.tokens - known) / s.tokens);
    }
  }
  for (const p of by.values()) {
    p.closed = p.boughtTok > 0 && p.soldTok >= p.boughtTok * CLOSED_AT;
    p.holdS = p.closed && p.firstBuy && p.lastSell ? Math.max(0, p.lastSell - p.firstBuy) : null;
    if (p.held < p.boughtTok * (1 - CLOSED_AT)) p.held = 0;   // dust left after a full exit
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* The summary the page leads with. */
export function summarize(swaps, { txRead = 0, from = 0, to = 0 } = {}) {
  const ps = positions(swaps);
  const closed = ps.filter(p => p.closed);
  const wins = closed.filter(p => p.realized > 0);
  const holds = closed.map(p => p.holdS).filter(x => x != null);
  const realized = ps.reduce((s, p) => s + p.realized, 0);
  const best = ps.reduce((b, p) => (!b || p.realized > b.realized ? p : b), null);
  const worst = ps.reduce((b, p) => (!b || p.realized < b.realized ? p : b), null);
  return {
    swaps: swaps.length, txRead, from, to,
    tokens: ps.length,
    buys: swaps.filter(s => s.side === 'buy').length,
    sells: swaps.filter(s => s.side === 'sell').length,
    spentSol: ps.reduce((s, p) => s + p.boughtSol, 0),
    receivedSol: ps.reduce((s, p) => s + p.soldSol, 0),
    realizedSol: realized,
    earlierSol: ps.reduce((s, p) => s + p.earlierSol, 0),
    closed: closed.length,
    wins: wins.length,
    winRate: closed.length ? wins.length / closed.length : null,
    medHoldS: median(holds),
    quickFlips: holds.filter(h => h < QUICK_FLIP_S).length,
    open: ps.filter(p => p.held > 0).length,
    best: best && best.realized > 0 ? { mint: best.mint, sol: best.realized } : null,
    worst: worst && worst.realized < 0 ? { mint: worst.mint, sol: worst.realized } : null,
    positions: ps,
  };
}

/* A wallet address, or nothing. */
export const isWallet = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

/* "4m", "3.2h", "2.1d" */
export function holdLabel(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + 'h';
  return (s / 86400).toFixed(1) + 'd';
}
