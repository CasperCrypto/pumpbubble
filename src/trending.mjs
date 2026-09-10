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

     **trades** — how many, because a million dollars of volume across forty
     transactions is a handful of wallets rather than a market.

     **recency** — the last hour against the day's average hour, which is what
     separates trending from traded-a-lot-yesterday. DexScreener's own ranking
     leans on this and it is the piece this was missing.

   Multiplied, not added, so both have to be true. Neither number is invented —
   they are the same volume and change the map already draws.

   The tab spans every chain at once, which is the part nobody else can copy:
   pump.fun, Base, Robinhood Chain and the wider market ranked against each
   other on the same scale.
   ========================================================================== */

/* Gates, in the same spirit as the X poster's: these decide what we put our
   name to, not what the map is allowed to show. Every other tab still shows
   everything; a tab that says Trending is making a claim, and the claim has to
   survive somebody clicking through to the token. */
const MIN_MCAP = 100_000;
const MIN_VOL = 50_000;

/* Below this a token has not moved. */
const MIN_MOVE = 3;

/* Above this it is not trending, it is launching. baton came through at +7340%
   on a token thirteen hours old: a real figure, and the shape of a mint pumping
   rather than a market moving. The X poster refuses the same thing for the same
   reason — posting those teaches people to scroll past us, and putting them on
   a tab labelled Trending does exactly as much damage. */
const MAX_MOVE = 1000;

/* Contribution is capped well below the refusal, so a genuine +900% does not
   flatten everything else on the tab. */
const MOVE_CAP = 300;

/* A market cap with nothing to sell into is not a market. Below this the pool
   cannot absorb a real order, whatever the cap says. */
const MIN_LIQ = 25_000;

/* Flags come from scoreQuality(), which is calibrated against live data rather
   than guessed at — a copied ticker, a cap the pool does not back, a token too
   young for a 24h number to mean anything. Any of them disqualifies. */
const BAD_FLAGS = ['copycat', 'thin', 'new', 'oneway'];

/* A token with thousands of trades is more alive than one with fifty, but the
   bonus tops out so trade count cannot simply buy the top of the tab. */
const TRADES_FULL = 5000;

/* The last hour against the day's average hour. 1.0 is steady; 5 means it is
   five times busier than its own daily pace, which is the difference between
   "trending" and "traded a lot yesterday". Capped because a token whose first
   hour of life is its whole history would otherwise dominate outright. */
const RECENCY_CAP = 6;

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
  if (move < MIN_MOVE || move > MAX_MOVE) return 0;

  /* Only where liquidity is actually measured. CoinPaprika publishes none, so
     requiring it would delete the whole majors category for missing data rather
     than for bad data — the same absent-is-not-zero mistake in reverse. Feeds
     that do report it (pump.fun, Base, Robinhood) are held to it, and a
     pump.fun token whose liquidity is unknown is already flagged `thin`. */
  const liq = Number(t.liq);
  if (Number.isFinite(liq) && liq > 0 && liq < MIN_LIQ) return 0;
  if ((t.flags || []).some(f => BAD_FLAGS.includes(f))) return 0;

  const turnover = vol / mcap;

  /* Both of these are neutral when the feed does not carry them — majors and
     stocks report neither, and scoring them as zero would delete the categories
     rather than rank them. */
  const n = (t.txns && t.txns.n) || 0;
  const trades = 1 + Math.min(n / TRADES_FULL, 1);

  const perHour = vol / 24;
  const h1 = Number(t.volH1);
  const recency = (Number.isFinite(h1) && h1 > 0 && perHour > 0)
    ? Math.min(h1 / perHour, RECENCY_CAP)
    : 1;

  return turnover * (1 + Math.min(move, MOVE_CAP) / 100) * trades * recency;
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
