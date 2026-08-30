/* ==========================================================================
   pumpbubble.fun — where the bubbles come from

   The map started as pump.fun only and now also carries the wider market, so
   each feed is an adapter behind one interface rather than a branch inside the
   fetcher. Adding a source should mean writing a fetch function, not editing
   the pipeline.

   Two things vary per source and both matter:

   - **Rate limits.** pump.fun's own API has been generous. CoinGecko's free
     tier is not, so each source declares its own cache TTL and slow-moving
     feeds are cached far longer. Bitcoin's market cap does not need refreshing
     every ten seconds, and the whole market arrives in one request.

   - **Boostability.** A boost is paid in SOL against a Solana mint. Bitcoin has
     no mint, so majors cannot be boosted and the API has to say so rather than
     quoting a price it cannot deliver.
   ========================================================================== */

import { normalizeCoin, fetchPumpCoins, fastImage } from './core.mjs';

const CG = 'https://api.coingecko.com/api/v3';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
/* Distinguishes "no data" from "no movement". A coin listed last week has no
   one-year change, and drawing that as 0% is a lie the map would tell on every
   single new listing. */
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;

/* CoinGecko rate-limits by IP, and Cloudflare's egress addresses are shared
   across every Worker on the platform — so an unauthenticated call competes
   with the whole platform for one bucket and gets 429 regardless of how little
   we ask for. Measured: 200 from a laptop, 429 from the worker, same second.
   A free demo key moves us into our own quota and is the actual fix. */
let CG_KEY = '';
export function setCoingeckoKey(k) { CG_KEY = k || ''; }

async function jget(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const headers = { accept: 'application/json', 'user-agent': UA };
  if (CG_KEY && url.startsWith(CG)) headers['x-cg-demo-api-key'] = CG_KEY;
  try {
    const r = await fetch(url, { signal: c.signal, headers });
    if (!r.ok) throw new Error(r.status + ' ' + url.slice(0, 80));
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- CoinGecko */
/* The wider market: everything ranked by real market cap, art included. */
/* CoinPaprika rather than CoinGecko.

   CoinGecko's free tier rate-limits by IP, and Cloudflare's egress addresses
   are shared across every Worker on the platform, so an unauthenticated call
   competes with the whole platform for one bucket. Measured repeatedly: 200
   from a laptop, 429 from the Worker, same second. The documented fix is a demo
   key, which is not available here, so the dependency goes instead.

   CoinPaprika needs no key, returns 2,000 coins in one request, and publishes
   1h, 24h and 7d. It also publishes 30d and 1y fields — but they are zero for
   every coin on the free tier, which is why those windows are not offered
   anywhere in this product rather than being drawn as a flat line. */
const PAPRIKA = 'https://api.coinpaprika.com/v1/tickers?quotes=USD';

async function paprikaMarkets(limit = 250) {
  const rows = await jget(PAPRIKA, 15000);
  if (!Array.isArray(rows)) return [];

  return rows
    .map(c => {
      const q = (c.quotes && c.quotes.USD) || {};
      const mcap = num(q.market_cap);
      if (!mcap || !c.symbol) return null;
      return {
        id: 'cg:' + c.id,
        mint: '',
        sym: String(c.symbol).toUpperCase().slice(0, 12),
        name: String(c.name || c.symbol).slice(0, 48),
        rawImg: 'https://static.coinpaprika.com/coin/' + encodeURIComponent(c.id) + '/logo.png',
        img: '',
        mcap,
        ath: 0,
        vol: num(q.volume_24h),
        price: num(q.price),
        pc: {
          m5: 0,
          h1: num(q.percent_change_1h),
          h6: num(q.percent_change_6h),
          h24: num(q.percent_change_24h),
          /* 7d is real here. 30d and 1y come back as zero for every coin on the
             free tier, so they are reported as absent rather than as no
             movement — the map greys those out instead of painting them flat. */
          d7: pick(q.percent_change_7d),
          d30: null,
          y1: null,
        },
        grad: true, liveStream: false, pumpBoost: false,
        created: 0, lastTrade: Date.now(), nsfw: false, banned: false,
        liq: 0, curveSol: 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit);
}

export const SOURCES = {
  pumpfun: {
    id: 'pumpfun', label: 'pump.fun', group: 'Solana launchpads',
    chain: 'solana', ttl: 10_000, enrich: true, boostable: true, quality: 'memecoin',
    fetch: () => fetchPumpCoins({ pages: 6, sort: 'market_cap', complete: true }),
  },
  bonding: {
    id: 'bonding', label: 'pump.fun bonding', group: 'Solana launchpads',
    chain: 'solana', ttl: 10_000, enrich: true, boostable: true, quality: 'memecoin',
    fetch: () => fetchPumpCoins({ pages: 6, sort: 'last_trade_timestamp', complete: false }),
  },
  /* The wider market. Deliberately a longer TTL: Bitcoin's market cap does not
     move enough in ten seconds to be worth a request, and the budget is better
     spent on the feeds that do. */
  majors: {
    id: 'majors', label: 'Whole market', group: 'Whole market',
    /* Five minutes, and shared through KV. Per-isolate caching meant every
       cold isolate fetched independently, multiplying our request count by the
       number of isolates Cloudflare happens to be running. Market caps of this
       size do not move meaningfully in five minutes. */
    chain: 'cg', ttl: 180_000, shared: true, enrich: false, boostable: false, quality: 'major',
    fetch: () => paprikaMarkets(250),
  },
  /* Listed companies. Not boostable for the same reason majors are not: a boost
     is paid in SOL against a Solana mint, and Apple does not have one. */
  stocks: {
    id: 'stocks', label: 'Stocks', group: 'Stocks',
    /* Ten minutes. A market cap in the hundreds of billions does not move
       enough in ten seconds to be worth a 6,000-row response, and the feed is
       shared through KV so cold isolates do not each fetch their own. */
    chain: 'stock', ttl: 600_000, shared: true, enrich: false,
    boostable: false, quality: 'major',
    fetch: () => nasdaqStocks(300),
  },
};

/* --------------------------------------------------------------- stocks */
/* Nasdaq's own screener returns every listed company in one request, with no
   key and no quota: symbol, name, last sale, percent change, market cap,
   sector and industry. That last pair is why this source is worth more than a
   price feed — a sector is a category the map can be filtered by, which is
   what makes "show me defence" or "show me AI" a thing you can click.

   Everything else free either wants a key, caps at a few hundred calls a day,
   or answers one symbol per request, which is 100 round trips for one screen.
   Yahoo's batch quote endpoint now returns 401 without a crumb; its chart
   endpoint still works but carries no market cap, and market cap is what sizes
   a bubble. */
const NASDAQ = 'https://api.nasdaq.com/api/screener/stocks';

const money = v => {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* One company, one bubble.

   Every share class in this feed reports the WHOLE company's market cap, not
   its own slice. Alphabet arrives four times — Class A, Class C and two
   depositary lines — at $4,239B, $4,193B, $601B and $596B, so a map drawing all
   four shows $9.6 trillion of a $4.2 trillion company and inflates the tracked
   total with it. Berkshire does the same across A and B.

   Grouping is by the company name with its class qualifier removed, keeping the
   largest listing: that is the primary line, and the one whose figure is the
   company's real market cap. */
function companyKey(name) {
  /* Cut at the first qualifier rather than stripping each one with its own
     pattern. A chain of strips has to fire in the right order, and every added
     variant is another chance for one to miss — which is what happened:
     "Common Stock" was removed while "Class A" survived, so Alphabet's two
     lines kept different keys and both stayed on the map. */
  const cut = String(name || '').split(
    /\s+(?:Class|Common|Capital|Ordinary|Depositary|American|Series|Non-Voting)\s/i)[0];
  return cut.replace(/[.,-\s]+$/, '').trim().toLowerCase();
}

/* Instruments whose market-cap field cannot be trusted.

   A depositary line quotes the parent's capitalisation against a fractional
   share, so its price and its cap describe different things. SPCX is the sharp
   case: "Space Exploration Technologies Corp" priced at $141.50 with a claimed
   $1,921B cap implies about 13.6 billion shares, roughly seven times any public
   estimate of SpaceX. The house rule is that a screener never shows a number it
   made up, and a number this feed cannot substantiate is the same thing —
   somebody would check, and be right. */
const UNTRUSTED = /depositary|ADR|preferred|warrant|rights?|units?|tracking/i;

async function nasdaqStocks(limit = 300) {
  const j = await jget(NASDAQ + '?tableonly=true&limit=6000&offset=0&download=true', 15000);
  const rows = (j && j.data && (j.data.rows || (j.data.table && j.data.table.rows))) || [];

  const out = rows
    .map(r => {
      const mcap = money(r.marketCap);
      const pct = parseFloat(String(r.pctchange || '').replace('%', ''));
      const sym = String(r.symbol || '').trim().toUpperCase();
      const rawName = String(r.name || sym);
      if (!sym || !(mcap > 0)) return null;
      if (UNTRUSTED.test(rawName)) return null;
      return {
        id: 'stock:' + sym,
        mint: '',                       // no chain, so nothing to boost against
        sym,
        name: rawName.replace(/\s+(Common Stock|Capital Stock|Class [A-Z].*)$/i, '').slice(0, 48),
        companyKey: companyKey(rawName),
        /* Logos come from a symbol-keyed CDN, so no per-company lookup is
           needed. A miss renders as initials like any other missing art. */
        rawImg: 'https://assets.parqet.com/logos/symbol/' + encodeURIComponent(sym) + '?format=png',
        img: '',
        mcap,
        ath: 0,
        vol: money(r.volume),
        price: money(r.lastsale),
        /* A daily percentage is the only change this feed carries. The shorter
           windows are null, not zero: zero is a claim that the stock has not
           moved this hour, which is a statement about the company rather than
           about our data, and it painted 300 bubbles flat green on the 1h tab. */
        pc: {
          m5: null, h1: null, h6: null,
          h24: Number.isFinite(pct) ? pct : null,
          d7: null, d30: null, y1: null,
        },
        sector: String(r.sector || '').slice(0, 40),
        industry: String(r.industry || '').slice(0, 60),
        country: String(r.country || '').slice(0, 40),
        ipoYear: num(r.ipoyear),
        grad: true, liveStream: false, pumpBoost: false,
        created: 0, lastTrade: Date.now(), nsfw: false, banned: false,
        liq: 0, curveSol: 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mcap - a.mcap);

  const best = new Map();
  for (const t of out) {
    const key = t.companyKey;
    const prev = best.get(key);
    if (!prev || t.mcap > prev.mcap) best.set(key, t);
  }
  return [...best.values()]
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit)
    .map(t => { delete t.companyKey; return t; });
}

export const DEFAULT_SOURCE = 'pumpfun';

export function sourceOf(id) {
  return SOURCES[id] || SOURCES[DEFAULT_SOURCE];
}

/* What the front end needs to draw the picker, without shipping the fetchers. */
export function publicSources() {
  return Object.values(SOURCES).map(s => ({
    id: s.id, label: s.label, group: s.group, chain: s.chain, boostable: s.boostable,
  }));
}
