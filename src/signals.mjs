/* ==========================================================================
   pumpbubble.fun — Signals

   Asked for (2026-11-22) as "a feature around AI, crypto, stocks, data, so
   traders can trade and get information better". A trader opening a map of
   three hundred bubbles wants to know which of them is doing something *now*:
   which one's last hour is several times busier than its day, which one just
   broke out or fell through the floor, where the buyers outnumber the sellers,
   and what the most profitable wallets on pump.fun are sitting in.

   Every one of those is already measured on a feed the site builds anyway, so
   Signals is composed rather than fetched — like Trending — from the warm
   copies of pump.fun, Base, the wider crypto market, US stocks and Smart
   money. Nothing here predicts, smooths or extrapolates. A signal is a
   threshold crossed by a measured number, and the row says which number and
   by how much: "last hour 4.2× its daily pace", "+38% in 1h on $410K traded",
   "68% of 2,140 trades were buys". If a window was not measured, no signal is
   raised from it — absent is not zero, here as everywhere.

   Thresholds are per asset class for the same reason the X poster's are: a
   memecoin up 15% in an hour is a Tuesday, a listed company up 7% in a day is
   news.
   ========================================================================== */

export const SIG_SOURCES = ['pumpfun', 'base', 'majors', 'stocks', 'smart'];

/* class → thresholds. `h1` / `h24` are percentage moves; `vol` the 24h dollar
   volume below which a move is a handful of wallets, not a market. */
export const RULES = {
  memecoin: { up1: 15, down1: -20, up24: null, down24: null, vol: 50_000, mcap: 30_000, surge: 3, surgeVol: 5_000 },
  base:     { up1: 10, down1: -15, up24: null, down24: null, vol: 50_000, mcap: 100_000, surge: 3, surgeVol: 5_000 },
  major:    { up1: 4,  down1: -5,  up24: 12, down24: -12, vol: 1_000_000, mcap: 50_000_000, surge: null, surgeVol: 0 },
  stock:    { up1: null, down1: null, up24: 7, down24: -7, vol: 0, mcap: 2_000_000_000, surge: null, surgeVol: 0 },
};
const CLASS_OF = { pumpfun: 'memecoin', smart: 'memecoin', base: 'base', majors: 'major', stocks: 'stock' };

/* Buy pressure: share of trades that were buys, from enough trades to mean
   something. Capped below the one-way line (core's ONEWAY_SELL_SHARE): a coin
   nobody can sell is not "buy pressure", and the feeds already flag it. */
export const PRESSURE_MIN_TXNS = 400;
export const PRESSURE_BUY = 0.62;
export const PRESSURE_SELL = 0.40;

/* Smart money: how many of pump.fun's top traders by realized profit hold it. */
export const SMART_MIN = 5;

/* Flags that disqualify a row: the same ones Trending refuses. */
const BAD = ['copycat', 'thin', 'oneway', 'banned'];

/* A dollar token held by top traders is cash, not a position, and its moves
   are noise around a peg. */
export const STABLE = /^(USDT|USDC|USD1|USDG|USDS|USDE|PYUSD|FDUSD|DAI|TUSD|EURC|USDH|USX|SUSD|USDB|RLUSD)$/i;

/* Above this a major's or a company's move is a relisting, a redenomination
   or a feed's glitch far more often than a market — the same upper bound
   Trending applies (src/trending.mjs MAX_MOVE), tighter for listed assets. A
   memecoin's hour is allowed further. */
const MAX_MOVE = { memecoin: 1000, base: 1000, major: 300, stock: 150 };

export const MAX_ROWS = 80;

const fin = v => v != null && v !== '' && Number.isFinite(+v);
const pct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1) + '%';
export function usd(v) {
  const a = Math.abs(+v || 0);
  if (a >= 1e12) return '$' + (a / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (a / 1e3).toFixed(1) + 'K';
  return '$' + a.toFixed(0);
}

/* Every signal one token raises, strongest first. Each is
   { type, dir: 'up'|'down'|'flat', why, score } — `score` only orders rows
   against each other; it is never shown as a number. */
export function signalsFor(t, from) {
  const cls = CLASS_OF[from] || 'memecoin';
  const r = RULES[cls];
  if (!t || t.solid === false) return [];
  if ((t.flags || []).some(f => BAD.includes(f))) return [];
  if (STABLE.test(String(t.sym || '').trim())) return [];
  const cap = MAX_MOVE[cls];
  const p0 = t.pc || {};
  if (['h1', 'h24'].some(w => fin(p0[w]) && Math.abs(+p0[w]) > cap)) return [];
  const mcap = +t.mcap || 0, vol = +t.vol || 0;
  if (mcap < r.mcap) return [];
  const pc = t.pc || {};
  const out = [];

  /* volume surge: the last hour against the day's average hour */
  if (r.surge && fin(t.volH1) && vol >= r.vol && +t.volH1 >= r.surgeVol) {
    const pace = (+t.volH1) / (vol / 24);
    if (pace >= r.surge) {
      out.push({ type: 'surge', dir: fin(pc.h1) ? (pc.h1 >= 0 ? 'up' : 'down') : 'flat',
        why: 'Volume surge: last hour ' + pace.toFixed(1) + '× its daily pace (' + usd(t.volH1) + ' in 1h)',
        score: Math.min(pace, 12) / r.surge });
    }
  }

  /* breakout / breakdown, on the shortest window the class measures */
  const short = r.up1 != null && fin(pc.h1) ? ['h1', +pc.h1, r.up1, r.down1, '1h']
    : r.up24 != null && fin(pc.h24) ? ['h24', +pc.h24, r.up24, r.down24, '24h'] : null;
  if (short && vol >= r.vol) {
    const [, v, up, down, label] = short;
    const traded = vol ? ' on ' + usd(vol) + ' traded' : '';
    if (v >= up) out.push({ type: 'breakout', dir: 'up', why: 'Breakout: ' + pct(v) + ' in ' + label + traded, score: Math.min(v / up, 10) });
    else if (v <= down) out.push({ type: 'breakdown', dir: 'down', why: 'Sharp drop: ' + pct(v) + ' in ' + label + traded, score: Math.min(v / down, 10) });
  }
  /* majors also carry a day: a big daily move with a quiet hour still counts */
  if (cls === 'major' && fin(pc.h24) && !out.some(s => s.type === 'breakout' || s.type === 'breakdown')) {
    const v = +pc.h24;
    if (v >= r.up24) out.push({ type: 'breakout', dir: 'up', why: 'Breakout: ' + pct(v) + ' in 24h', score: Math.min(v / r.up24, 10) * 0.8 });
    else if (v <= r.down24) out.push({ type: 'breakdown', dir: 'down', why: 'Sharp drop: ' + pct(v) + ' in 24h', score: Math.min(v / r.down24, 10) * 0.8 });
  }

  /* buy or sell pressure, from counted trades */
  const tx = t.txns;
  if (tx && fin(tx.buys) && fin(tx.sells)) {
    const n = (+tx.buys) + (+tx.sells);
    if (n >= PRESSURE_MIN_TXNS) {
      const b = (+tx.buys) / n;
      if (b >= PRESSURE_BUY) out.push({ type: 'pressure', dir: 'up',
        why: 'Buy pressure: ' + Math.round(b * 100) + '% of ' + n.toLocaleString('en-US') + ' trades were buys', score: (b - 0.5) * 10 });
      else if (b <= PRESSURE_SELL) out.push({ type: 'pressure', dir: 'down',
        why: 'Sell pressure: ' + Math.round((1 - b) * 100) + '% of ' + n.toLocaleString('en-US') + ' trades were sells', score: (0.5 - b) * 10 });
    }
  }

  /* where the most profitable wallets are sitting */
  if (from === 'smart' && (+t.smartN || 0) >= SMART_MIN) {
    out.push({ type: 'smart', dir: fin(pc.h1) ? (pc.h1 >= 0 ? 'up' : 'down') : 'flat',
      why: 'Held by ' + t.smartN + ' of pump.fun’s top traders by realized profit', score: 0.6 + (+t.smartN) / 10 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/* All feeds → one ranked list of tokens, each carrying its signals.
   `feeds` is [{ id, tokens }]. A token on two feeds (a pump.fun coin that
   top traders hold) is one row with both feeds' signals. */
export function buildSignals(feeds, limit = MAX_ROWS) {
  const by = new Map();
  for (const f of feeds || []) {
    for (const t of (f && f.tokens) || []) {
      const key = t.addr || t.mint || t.id;
      if (!key) continue;
      const sigs = signalsFor(t, f.id);
      if (!sigs.length) continue;
      const cur = by.get(key);
      if (!cur) {
        by.set(key, { ...t, from: t.from || f.id, signals: sigs });
      } else {
        for (const s of sigs) if (!cur.signals.some(x => x.type === s.type)) cur.signals.push(s);
        cur.signals.sort((a, b) => b.score - a.score);
        if (f.id === 'smart' && t.smartN) { cur.smartN = t.smartN; cur.smartWho = t.smartWho; }
      }
    }
  }
  const rows = [...by.values()];
  /* a token raising two different signals outranks one raising one */
  const rank = t => t.signals[0].score + 0.6 * (t.signals.length - 1);
  rows.sort((a, b) => rank(b) - rank(a));
  return rows.slice(0, limit).map(t => ({
    ...t,
    sig: t.signals[0].type,
    sigDir: t.signals[0].dir,
    heat: rank(t),
  }));
}

/* Counts by type and direction, for the summary line and the brief. */
export function signalStats(rows) {
  const s = { total: rows.length, up: 0, down: 0, byType: {} };
  for (const r of rows) {
    if (r.sigDir === 'up') s.up++; else if (r.sigDir === 'down') s.down++;
    for (const g of r.signals || []) s.byType[g.type] = (s.byType[g.type] || 0) + 1;
  }
  return s;
}

/* The facts an AI brief may use — nothing else reaches the model. Short
   numbers, every one copied from a row, so the brief can only restate what
   the table already shows. */
export function briefFacts(rows, extra = {}) {
  return {
    asOf: new Date(extra.now || Date.now()).toISOString().slice(0, 16) + 'Z',
    stats: signalStats(rows),
    market: extra.market || null,
    top: rows.slice(0, 18).map(r => ({
      sym: r.sym, feed: r.from, chain: r.chain || '',
      mcap: usd(r.mcap), vol24: r.vol ? usd(r.vol) : null,
      h1: fin(r.pc && r.pc.h1) ? +(+r.pc.h1).toFixed(1) : null,
      h24: fin(r.pc && r.pc.h24) ? +(+r.pc.h24).toFixed(1) : null,
      signals: r.signals.map(s => s.why),
    })),
  };
}
