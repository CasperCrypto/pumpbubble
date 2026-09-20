/* ==========================================================================
   pumpbubble.fun — pump.fun's own trending board

   pump.fun's Explore page ranks what is moving right now across pump.fun,
   Raydium LaunchLab and Pons on Robinhood Chain, and the endpoint behind it
   answers without a session:

     advanced-indexer.pump.fun/boards/movers?limit=150

   That is the list a pump.fun user calls "trending", and it is a better
   answer to the question than our computed heat was for these chains — theirs
   is built from the trade stream (transactions in the last five minutes,
   holders, KOLs, buys against sells) which we do not have, and it is not paid
   placement. So for pump.fun and Robinhood Chain the Trending tab now shows
   *their* order, labelled as theirs. Our heat still ranks Base and the wider
   market, which the board does not cover, and steps in for everything if the
   board is down.

   A second endpoint fills the one thing the board leaves out — price change —
   and gives back far more than that:

     swap-api.pump.fun/v1/coins/market-activity/batch   (POST, ≤50 addresses)

   per window: numBuys, numSells, **numBuyers, numSellers**, numUsers,
   priceChangePercent. Distinct buyers is the signal that separates a market
   from nine wallets trading with themselves — the thing this project could
   not get after pump.fun removed its /trades endpoint. It is on every card
   now.

   What the board does not carry is liquidity, so none of these rows goes
   through scoreQuality(): unknown liquidity there means `thin`, which would
   mark every one of them unbacked for want of a field rather than for a bad
   value. Flags are computed here from what *is* measured — buys against
   sells, tickers shared across the board, age, dev holding, top-ten
   concentration — and a token from the board with a real DexScreener pool in
   our own pump.fun feed borrows that liquidity.

   Every figure shown is one of theirs or one derived from theirs by division.
   Nothing is nudged.
   ========================================================================== */

import { clean, fastImage, signUrl, isMint, isEvmAddr,
         ONEWAY_SELL_SHARE, ONEWAY_MIN_TXNS, MAX_COPIES } from './core.mjs';

export const BOARD = 'https://advanced-indexer.pump.fun/boards/movers?tier=web&surface=WEB&platform=WEB&limit=150';
export const ACTIVITY = 'https://swap-api.pump.fun/v1/coins/market-activity/batch';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';

/* CAIP-2 chain ids pump.fun uses → the names this map uses. Robinhood Chain
   is 4663; Pons, its launchpad, is a quarter of the board. */
const CHAINS = {
  'solana:mainnet': 'solana',
  'eip155:4663': 'robinhood',
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:56': 'bsc',
  'eip155:999': 'hyperevm',
};

/* Below this a bubble is a dot with no room for a label; pump.fun shows
   tokens down to $3K on a list, which a map cannot. */
export const MIN_MCAP = 5_000;
/* Enough of the board to fill a map, few enough that the tail is real. */
export const KEEP = 100;
/* Informational flags, from measurements the board carries. */
export const DEV_WARN = 10;      // % of supply the deployer still holds
export const TOP10_WARN = 50;    // % held by the ten largest wallets

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;

export async function fetchMovers() {
  const r = await fetch(BOARD, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('movers ' + r.status);
  const j = await r.json();
  const e = j && Array.isArray(j.entries) ? j.entries : [];
  if (!e.length) throw new Error('movers empty');
  return e;
}

/* Fifty addresses a call, calls in parallel. A window the API did not answer
   for is absent, not zero. */
export async function fetchActivity(addresses) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 50) chunks.push(addresses.slice(i, i + 50));
  await Promise.all(chunks.map(async chunk => {
    try {
      const r = await fetch(ACTIVITY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({
          addresses: chunk,
          intervals: ['5m', '1h', '6h', '24h'],
          metrics: ['numTxs', 'volumeUSD', 'numBuys', 'numSells', 'numBuyers', 'numSellers', 'numUsers', 'priceChangePercent'],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) out.set(k, v);
    } catch { /* this chunk stays unenriched */ }
  }));
  return out;
}

function chainOf(e) {
  const c = CHAINS[e.c];
  if (c) return c;
  /* Three rows a fetch arrive with no chain at all; a base58 mint is Solana. */
  if (!e.c && isMint(e.m)) return 'solana';
  return '';
}

/* One board row → one map token. `act` is that row's market-activity, or
   undefined. `copies` is how many board rows share the ticker. */
export function shapeMover(e, act, rank, copies = 1, now = Date.now()) {
  const chain = chainOf(e);
  const addr = String(e.m || '');
  if (!chain || !(isMint(addr) || isEvmAddr(addr))) return null;
  const evm = isEvmAddr(addr);
  const mcap = num(e.mc);
  if (mcap < MIN_MCAP) return null;

  const a5 = act && act['5m'], a1 = act && act['1h'], a6 = act && act['6h'], a24 = act && act['24h'];
  const vol = num(a24 && a24.volumeUSD) || num(e.vUsd24h) || num(e.vUsd);

  /* Buys and sells: the activity endpoint's 24h counts, else the board's
     lifetime counts. Distinct buyers only exist on the former. */
  const buys = a24 ? num(a24.numBuys) : num(e.bc);
  const sells = a24 ? num(a24.numSells) : num(e.sc);
  const n = buys + sells;
  const txns = n ? {
    buys, sells, n, sellShare: sells / n,
    buyers: a24 ? pick(a24.numBuyers) : null,
    sellers: a24 ? pick(a24.numSellers) : null,
    users: a24 ? pick(a24.numUsers) : null,
    window: a24 ? '24h' : 'all',
  } : null;

  const ageS = num(e.age);
  const ageH = ageS > 0 ? ageS / 3600 : null;
  const top10 = pick(e.t10), dev = pick(e.dh);

  const flags = [];
  if (txns && txns.n >= ONEWAY_MIN_TXNS && txns.sellShare < ONEWAY_SELL_SHARE) flags.push('oneway');
  if (copies > MAX_COPIES) flags.push('copycat');
  if (ageH != null && ageH < 24) flags.push('new');
  if (dev != null && dev >= DEV_WARN) flags.push('dev');
  if (top10 != null && top10 >= TOP10_WARN) flags.push('top10');

  return {
    id: evm ? chain + ':' + addr.toLowerCase() : addr,
    chain,
    mint: evm ? '' : addr,
    addr: evm ? addr.toLowerCase() : '',
    sym: clean(e.t, 12) || '?',
    name: clean(e.n || e.t, 48) || 'unknown',
    rawImg: fastImage(typeof e.i === 'string' ? e.i : ''),
    img: '',
    mcap,
    vol,
    volH1: num(a1 && a1.volumeUSD) || num(e.vUsd1h),
    ath: num(e.ath),
    liq: 0,
    price: 0,
    created: ageS > 0 ? now - ageS * 1000 : 0,
    lastTrade: num(e.tx5) > 0 ? now : 0,
    grad: num(e.p) >= 100,
    ageH,
    pc: {
      m5: a5 ? pick(a5.priceChangePercent) : null,
      h1: a1 ? pick(a1.priceChangePercent) : null,
      h6: a6 ? pick(a6.priceChangePercent) : null,
      h24: a24 ? pick(a24.priceChangePercent) : null,
      d7: null, d30: null, y1: null,
    },
    txns,
    holders: pick(e.nh),
    top10,
    dev,
    kol: pick(e.kol),
    tx5: pick(e.tx5),
    bundled: pick(e.bo),
    program: typeof e.pg === 'string' ? e.pg.slice(0, 24) : '',
    twitter: '',
    copies,
    flags,
    /* One-way is the one measurement that takes a token off this tab. The
       rest are warnings on the card. */
    solid: !flags.includes('oneway'),
    rank,
    via: 'pump',
    from: chain === 'robinhood' ? 'robinhood' : 'pumpfun',
    boost: 0,
  };
}

/* The board as map tokens, in pump.fun's order, with art signed for the
   proxy and liquidity borrowed from our own feeds where we have it.

   `known` is a Map keyed by mint/addr → token from the pump.fun and Robinhood
   feeds, used only to fill `liq`, `img` and `twitter`. */
export async function pumpTrending({ secret, known = new Map() } = {}) {
  const entries = await fetchMovers();
  const addrs = entries.map(e => String(e.m || '')).filter(a => isMint(a) || isEvmAddr(a));
  const act = await fetchActivity(addrs);

  const copies = new Map();
  for (const e of entries) {
    const k = String(e.t || '').toUpperCase();
    if (k) copies.set(k, (copies.get(k) || 0) + 1);
  }

  const out = [];
  const seen = new Set();
  const now = Date.now();
  for (let i = 0; i < entries.length && out.length < KEEP; i++) {
    const e = entries[i];
    const t = shapeMover(e, act.get(String(e.m || '')), i + 1, copies.get(String(e.t || '').toUpperCase()) || 1, now);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);

    const k = known.get(t.addr || t.mint);
    if (k) {
      if (k.liq > 0) { t.liq = k.liq; t.mcLiq = t.mcap / k.liq; }
      if (k.img) t.img = k.img;
      if (k.twitter) t.twitter = k.twitter;
    }
    if (!t.img && t.rawImg && secret) {
      try {
        t.img = '/api/img?u=' + encodeURIComponent(t.rawImg) + '&s=' + await signUrl(t.rawImg, secret);
      } catch { t.img = ''; }
    }
    delete t.rawImg;
    out.push(t);
  }
  return out;
}
