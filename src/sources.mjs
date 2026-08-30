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
async function coingeckoMarkets(pages = 2, perPage = 100) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const rows = await jget(
      `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${perPage}&page=${p}&price_change_percentage=1h%2C24h`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) {
      if (!c || !c.id) continue;
      out.push({
        id: 'cg:' + c.id,
        mint: '',                                  // not on Solana: cannot be boosted
        addr: c.id,
        chain: 'cg',
        sym: String(c.symbol || '?').toUpperCase().slice(0, 12),
        name: String(c.name || c.symbol || '').slice(0, 48),
        rawImg: fastImage(c.image || ''),
        img: '',
        mcap: num(c.market_cap),
        vol: num(c.total_volume),
        /* Majors trade across every venue at once, so no single pool's depth
           describes them. Leave liquidity unset rather than invent it — the
           quality scoring is told to skip these instead. */
        liq: 0,
        price: num(c.current_price),
        pc: {
          m5: 0,
          h1: num(c.price_change_percentage_1h_in_currency),
          h6: 0,
          h24: num(c.price_change_percentage_24h),
        },
        rank: num(c.market_cap_rank),
        created: 0,
        lastTrade: 0,
        grad: true,
        boost: 0,
      });
    }
  }
  if (!out.length) throw new Error('coingecko returned nothing');
  return out;
}

/* ================================================================ registry */
/* `ttl` is the snapshot cache lifetime. `enrich` says whether DexScreener
   should be asked for art and change data — pointless for CoinGecko, which
   already carries both, and essential for GeckoTerminal pools, which carry
   neither. `boostable` says whether a bubble here can be sold. */
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
    chain: 'cg', ttl: 300_000, shared: true, enrich: false, boostable: false, quality: 'major',
    fetch: () => coingeckoMarkets(1, 250),
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

async function nasdaqStocks(limit = 300) {
  const j = await jget(NASDAQ + '?tableonly=true&limit=6000&offset=0&download=true', 15000);
  const rows = (j && j.data && (j.data.rows || (j.data.table && j.data.table.rows))) || [];

  return rows
    .map(r => {
      const mcap = money(r.marketCap);
      const pct = parseFloat(String(r.pctchange || '').replace('%', ''));
      const sym = String(r.symbol || '').trim().toUpperCase();
      if (!sym || !(mcap > 0)) return null;
      return {
        id: 'stock:' + sym,
        mint: '',                       // no chain, so nothing to boost against
        sym,
        name: String(r.name || sym).replace(/\s+(Common Stock|Class [A-Z].*)$/i, '').slice(0, 48),
        /* Logos come from a symbol-keyed CDN, so no per-company lookup is
           needed. A miss renders as initials like any other missing art. */
        rawImg: 'https://assets.parqet.com/logos/symbol/' + encodeURIComponent(sym) + '?format=png',
        img: '',
        mcap,
        ath: 0,
        vol: money(r.volume),
        price: money(r.lastsale),
        /* A daily percentage is the only change this feed carries. Copying it
           into 5m and 1h would be inventing numbers, so those stay zero and the
           front end shows the 24h axis for this source. */
        pc: { m5: 0, h1: 0, h6: 0, h24: Number.isFinite(pct) ? pct : 0 },
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
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit);
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
