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

async function jget(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { accept: 'application/json', 'user-agent': UA },
    });
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
    chain: 'cg', ttl: 120_000, enrich: false, boostable: false, quality: 'major',
    fetch: () => coingeckoMarkets(1, 250),
  },
};

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
