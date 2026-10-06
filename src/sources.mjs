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

import { tradersFor } from './traders.mjs';
import { smartMoney } from './smartmoney.mjs';
import { normalizeCoin, fetchPumpCoins, fastImage, clean, txnsOf } from './core.mjs';
import { loadRegistry, discover, priceAll, prune } from './rhchain.mjs';
import { baseTokens } from './basechain.mjs';
import { chainTokens, padTokens, predictionTokens, casinoTokens } from './flows.mjs';

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
        /* CoinCap's icon set, by ticker: CoinPaprika's own logo host answers
           403 to everyone since 2026-10 (the tab had no art at all). CoinCap
           covers 170 of the top 250; what it lacks is mostly wrapped and
           staked versions, which get a letter rather than a borrowed logo. */
        rawImg: /^[A-Za-z0-9.]{1,12}$/.test(String(c.symbol))
          ? 'https://assets.coincap.io/assets/icons/' + encodeURIComponent(String(c.symbol).toLowerCase()) + '@2x.png' : '',
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


/* ------------------------------------------------------------ Robinhood Chain */
/* Robinhood Chain went live on 1 July 2026 and Pons is its pump.fun.

   The first version of this ranked the chain by Blockscout's market cap and
   produced a map of bridged assets: LINK, thirty-three holders and barely used
   here, sat on top at $9B, while ROBINCAT — thirteen thousand holders, trading
   hard — came back with a null market cap and was dropped. Blockscout only
   prices what its own feed covers, which is the opposite of the set worth
   showing.

   So the ranking authority is DexScreener, which knows exactly which tokens
   have a pool and what they are worth. What DexScreener does not offer is a
   chain-wide listing, so the *addresses* are accumulated in KV a few per tick
   (src/rhchain.mjs) and this prices whatever has been found so far.

   Nothing without a pool survives: a market cap for a token nobody can trade
   is a number with nothing behind it. */

async function robinhoodTokens(store, limit = 220) {
  if (!store) return [];

  let reg = await loadRegistry(store);
  /* First run on a cold namespace: discover once inline rather than serve an
     empty map until the next cron tick. */
  if (!reg.addrs.length) {
    try { await discover(store); reg = await loadRegistry(store); } catch { return []; }
  }
  if (!reg.addrs.length) return [];

  /* Seeds first: a hand-added token is in the map even if discovery has not
     reached it and even if the address cap is full. */
  const addrs = [...new Set([...(reg.seeds || []), ...reg.addrs])];
  const priced = await priceAll(addrs);
  const rows = [];

  for (const [addr, p] of priced) {
    const sym = clean(p.baseToken && p.baseToken.symbol, 12);
    const mcap = num(p.marketCap) || num(p.fdv);
    if (!sym || !(mcap > 0)) continue;

    const pc = p.priceChange || {};
    rows.push({
      id: 'rh:' + addr,
      mint: '',                        // no Solana mint; the contract is the id
      chain: 'robinhood',
      addr,
      sym,
      name: clean((p.baseToken && p.baseToken.name) || sym, 48) || sym,
      rawImg: (p.info && typeof p.info.imageUrl === 'string') ? p.info.imageUrl : '',
      img: '',
      mcap,
      ath: 0,
      vol: num(p.volume && p.volume.h24),
      liq: num(p.liquidity && p.liquidity.usd),
      price: num(p.priceUsd),
      created: num(p.pairCreatedAt),
      txns: txnsOf(p),
      volH1: num(p.volume && p.volume.h1),
      /* Absent stays absent. DexScreener omits a window entirely when nothing
         traded in it, and a zero there would claim the price held still. */
      pc: {
        m5: pick(pc.m5), h1: pick(pc.h1), h6: pick(pc.h6), h24: pick(pc.h24),
        d7: null, d30: null, y1: null,
      },
    });
  }

  /* Forty-four tokens on this chain call themselves ROBINCAT and thirty call
     themselves ROBIN. Keeping them all and letting the copy-count heuristic
     sort it out hid the real ones: PONS, with $6.7M of liquidity behind it,
     was flagged as a copycat swarm and vanished off the chain's own map.

     So one survivor per ticker, chosen by pool depth, and the count of what it
     replaced is kept. The market-cap-to-liquidity test then still runs over the
     survivors, which is what catches bridged LINK — $54.7bn of claimed market
     cap against $243 of liquidity. */
  const byTicker = new Map();
  for (const t of rows) {
    const k = t.sym.toUpperCase();
    const prev = byTicker.get(k);
    if (!prev) { byTicker.set(k, { ...t, copies: 1 }); continue; }
    const copies = prev.copies + 1;
    byTicker.set(k, t.liq > prev.liq ? { ...t, copies } : { ...prev, copies });
  }

  /* Addresses that never priced are dead weight against the registry cap. */
  try { await prune(store, priced); } catch { /* not worth failing a map over */ }

  return [...byTicker.values()].sort((x, y) => y.mcap - x.mcap).slice(0, limit);
}

export const SOURCES = {
  pumpfun: {
    id: 'pumpfun', label: 'pump.fun', group: 'Solana launchpads',
    chain: 'solana', ttl: 10_000, enrich: true, boostable: true, quality: 'memecoin',
    /* DexScreener covers ~98% of graduated pump.fun mints, so a build that
       enriched under a quarter of them is a refused pass, not a market. */
    minEnrich: 0.25,
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
    id: 'majors', label: 'Crypto', group: 'Crypto',
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
  /* Where trading is happening, by chain. Sized by 24h DEX volume rather than
     TVL: TVL is money parked, volume is money moving, and the question is where
     it is flowing. See src/flows.mjs. */
  chains: {
    id: 'chains', label: 'Chains', group: 'Flows',
    chain: 'mixed', ttl: 300_000, shared: true, enrich: false,
    boostable: false, quality: 'major',
    fetch: store => chainTokens(store),
  },

  /* Which launchpad is actually busy, by 24h fees. A launchpad holds nothing,
     so DefiLlama reports pump.fun and Pons at $0 TVL; what it does is take
     fees, and those are published. */
  pads: {
    id: 'pads', label: 'Launchpads', group: 'Flows',
    chain: 'mixed', ttl: 300_000, shared: true, enrich: false,
    boostable: false, quality: 'major',
    fetch: store => padTokens(store),
  },

  /* Prediction markets by 24h volume wagered — Kalshi, Polymarket and the
     rest. See src/flows.mjs. */
  prediction: {
    id: 'prediction', label: 'Prediction', group: 'Flows',
    chain: 'mixed', ttl: 300_000, shared: true, enrich: false,
    boostable: false, quality: 'major',
    fetch: store => predictionTokens(store),
  },

  /* On-chain casinos by bankroll. Not Stake, Shuffle or BC.Game — they are
     off-chain and publish nothing. See src/flows.mjs. */
  casinos: {
    id: 'casinos', label: 'Casinos', group: 'Flows',
    chain: 'mixed', ttl: 300_000, shared: true, enrich: false,
    boostable: false, quality: 'major',
    fetch: store => casinoTokens(store),
  },

  /* Trending, across every chain at once. Composed from the other feeds in
     api.mjs rather than fetched — see src/trending.mjs for what "trending"
     is defined as, and why it had to be defined rather than fetched. */
  /* Tap wars. Composed in api.mjs from the arena (a Durable Object in
     production, memory in dev) — see src/taps.mjs. A short lifetime because
     the tab is live by definition: the count on a bubble is what people are
     doing to it right now. */
  taps: {
    id: 'taps', label: 'Tap wars', group: 'Tap wars',
    chain: 'mixed', ttl: 5_000, enrich: false, boostable: true, quality: 'major',
    fetch: () => [],
  },
  /* Traders: pump.fun's PnL leaderboard ranked by what was realized, not by
     paper — see src/traders.mjs. One source per period because the period is
     the query, and the tab's timeframe pill picks between them. Not `shared`:
     three feeds refreshed through KV would spend ~860 of the 1,000 free
     writes a day on a list pump.fun itself only refreshes every few minutes. */
  /* Smart money: tokens held by pump.fun's top traders by realized profit —
     see src/smartmoney.mjs. Five minutes: the boards refresh every few, and a
     build is three board calls plus coin and activity batches. Not shared,
     for the same KV reason as Traders. Colour is the ordinary 1H/24H move. */
  smart: {
    id: 'smart', label: 'Smart money', group: 'Traders',
    chain: 'mixed', ttl: 300_000, enrich: false, boostable: true, quality: 'major', history: false,
    fetch: () => smartMoney(),
  },
  /* the same, for one board's traders — the Smart money board tabs */
  'smart-daily': {
    id: 'smart-daily', label: 'Smart money', group: 'Traders',
    chain: 'mixed', ttl: 300_000, enrich: false, boostable: true, quality: 'major', history: false,
    fetch: () => smartMoney(['daily']),
  },
  'smart-weekly': {
    id: 'smart-weekly', label: 'Smart money', group: 'Traders',
    chain: 'mixed', ttl: 300_000, enrich: false, boostable: true, quality: 'major', history: false,
    fetch: () => smartMoney(['weekly']),
  },
  'smart-monthly': {
    id: 'smart-monthly', label: 'Smart money', group: 'Traders',
    chain: 'mixed', ttl: 300_000, enrich: false, boostable: true, quality: 'major', history: false,
    fetch: () => smartMoney(['monthly']),
  },
  /* Callers: pump.fun's callouts, measured — src/callers.mjs. Composed in
     api.mjs from the CallersDO, which does the polling on its own clock; the
     lifetime here only bounds how stale one isolate's copy may be. */
  calls: {
    id: 'calls', label: 'Live calls', group: 'Callers',
    chain: 'mixed', ttl: 20_000, enrich: false, boostable: true, quality: 'major', history: false,
    fetch: () => [],
  },
  /* Insiders: what Congress, the White House and CEOs trade — src/insiders.mjs.
     Read by the InsidersDO on its own clock; this lifetime only bounds how
     stale one isolate's copy may be. */
  insiders: {
    id: 'insiders', label: 'Insiders', group: 'Insiders',
    chain: 'mixed', ttl: 120_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => [],
  },
  'callers-daily': {
    id: 'callers-daily', label: 'Top callers', group: 'Callers',
    chain: 'mixed', ttl: 60_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => [],
  },
  'callers-weekly': {
    id: 'callers-weekly', label: 'Top callers', group: 'Callers',
    chain: 'mixed', ttl: 60_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => [],
  },
  'callers-monthly': {
    id: 'callers-monthly', label: 'Top callers', group: 'Callers',
    chain: 'mixed', ttl: 60_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => [],
  },
  'traders-daily': {
    id: 'traders-daily', label: 'Traders', group: 'Traders',
    chain: 'mixed', ttl: 120_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => tradersFor('daily'),
  },
  'traders-weekly': {
    id: 'traders-weekly', label: 'Traders', group: 'Traders',
    chain: 'mixed', ttl: 180_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => tradersFor('weekly'),
  },
  'traders-monthly': {
    id: 'traders-monthly', label: 'Traders', group: 'Traders',
    chain: 'mixed', ttl: 300_000, enrich: false, boostable: false, quality: 'major', history: false,
    fetch: () => tradersFor('monthly'),
  },
  trending: {
    id: 'trending', label: 'Trending', group: 'Trending',
    chain: 'mixed', ttl: 60_000, shared: true, enrich: false,
    boostable: true, quality: 'major',
    /* Never called: snapshot() composes this one. Present so the source is a
       normal entry everywhere else — tabs, deep links, the ranked card. */
    fetch: () => [],
  },

  /* Base. The universe comes from a maintained token list rather than from
     searching, which is what keeps the clone swarms out; see src/basechain.mjs.
     Reads a cache the cron fills, so a build is one KV read. */
  base: {
    id: 'base', label: 'Base', group: 'Base',
    chain: 'base', ttl: 120_000, shared: true, enrich: false,
    boostable: false, quality: 'memecoin',
    fetch: store => baseTokens(store, 220),
  },

  /* Robinhood Chain, home of the Pons launchpad. Not boostable for the same
     reason stocks are not: a boost is paid in SOL against a Solana mint, and
     an ERC-20 on an L2 does not have one. */
  robinhood: {
    id: 'robinhood', label: 'Robinhood', group: 'Robinhood Chain',
    /* Two minutes. A build is four Blockscout pages plus seven DexScreener
       batches, and shared through KV so cold isolates do not each pay it. */
    /* enrich is off: DexScreener already supplied every number here, so the
       generic pass would repeat the same requests to answer the same thing. */
    chain: 'robinhood', ttl: 180_000, shared: true, enrich: false,
    /* memecoin, not major: this chain is thin pools and copied tickers, which
       is what that scoring is for. */
    boostable: false, quality: 'memecoin',
    fetch: store => robinhoodTokens(store, 220),
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
