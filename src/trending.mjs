/* ==========================================================================
   pumpbubble.fun — Trending

   "Trending" needs a definition before it needs a tab, or it becomes whatever
   number happened to be sortable. Everything that publishes a ready-made
   trending list is closed to us: GeckoTerminal's `/trending_pools` ranks every
   chain properly and 429s Cloudflare on every request, and DexScreener's boost
   endpoints rank *paid promotion*, which is an advertising slot wearing the
   word trending.

   So it is computed, from two things already measured for every token on every
   feed:

     **turnover** — 24h volume divided by market cap. How much of the thing
     actually changed hands today. A $700k token doing $1.9M of volume has
     turned over 2.5×; a $9bn token doing $50M has turned over 0.006×. This is
     the part that says people are trading it *right now*, and it is why the
     tab is not simply the largest caps again.

     **movement** — the 24h change. Turnover alone puts stablecoins and wrapped
     assets on top: RLUSD turns over 1.0× a day and has never moved, and WETH
     on Robinhood Chain turns over 5× while tracking ETH to the decimal. A
     token has to have gone somewhere.

   Multiplied, not added, so both have to be true. Neither number is invented —
   they are the same volume and change the map already draws.

   The tab spans every chain at once, which is the part nobody else can copy:
   pump.fun, Base, Robinhood Chain and the wider market ranked against each
   other on the same scale.
   ========================================================================== */

/* Gates, in the same spirit as the X poster's: these decide what we put our
   name to, not what the map is allowed to show. */
const MIN_MCAP = 100_000;
const MIN_VOL = 50_000;

/* Below this a token has not moved; above it the number stops adding
   information and starts letting one fresh mint own the tab. */
const MIN_MOVE = 3;
const MOVE_CAP = 300;

export const TREND_SOURCES = ['pumpfun', 'base', 'robinhood', 'majors'];

/* How many bubbles catch fire. Kept small: if everything is on fire, nothing
   is, and each flame costs real frame budget. */
export const HOT_COUNT = 12;

/* 0 means "not trending", so the caller never has to special-case a reason. */
export function heat(t) {
  if (!t || !t.solid) return 0;
  const mcap = Number(t.mcap) || 0;
  const vol = Number(t.vol) || 0;
  if (mcap < MIN_MCAP || vol < MIN_VOL) return 0;

  const raw = t.pc ? t.pc.h24 : null;
  /* Absent is not zero. A token whose 24h change was never measured cannot be
     ranked on how far it moved. */
  if (raw == null || !Number.isFinite(Number(raw))) return 0;

  const move = Math.abs(Number(raw));
  if (move < MIN_MOVE) return 0;

  const turnover = vol / mcap;
  return turnover * (1 + Math.min(move, MOVE_CAP) / 100);
}

/* Merge several feeds into one ranked list.

   `feeds` is [{ id, tokens }]. Each token keeps a `from` so the card can say
   which chain it came from — on a cross-chain tab that is the first thing
   somebody wants to know. */
export function buildTrending(feeds, limit = 120) {
  const seen = new Set();
  const rows = [];

  for (const f of feeds || []) {
    for (const t of (f.tokens || [])) {
      const h = heat(t);
      if (h <= 0) continue;
      /* The same token can appear on two feeds — a Base token that is also in
         the wider market, say. First one wins; they carry the same numbers. */
      const key = t.addr || t.mint || t.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...t, from: f.id, heat: h });
    }
  }

  rows.sort((a, b) => b.heat - a.heat);
  const out = rows.slice(0, limit);
  /* Only the top few burn. */
  for (let i = 0; i < out.length; i++) out[i].hot = i < HOT_COUNT;
  return out;
}
