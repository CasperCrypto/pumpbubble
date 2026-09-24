/* ==========================================================================
   pumpbubble.fun — pump.fun's own Trending list

   pump.fun's screener has a column called Trending. Its rows come from

     frontend-api-v3.pump.fun/coins/great-coins?topK=50

   which was found by reading the bundle, not by guessing: the screener's
   fetcher is `_({offset,limit})` → `GET /coins/great-coins` with
   `topK = offset + limit`, paged to fifty. Called without `topK` it answers
   five — the five rows pump.fun badges HOT — and that default sent the first
   version of this file to the wrong endpoint. `boards/movers` is a different
   view (🌟 Movers on Explore), and drawing it under the word Trending put
   OnlyFees and GIGAJEAN where pump.fun showed Backpack and STONK.

   The list is Solana-first with a few Pons (Robinhood Chain) and BSC rows,
   and it carries no volume, no price change, no holders. Two more calls
   fill those:

   - `swap-api.pump.fun/v1/coins/market-activity/batch` — per window: volume,
     buys, sells, **distinct buyers and sellers**, price change. Fifty
     addresses a call, so the whole list is one request.
   - `advanced-indexer.pump.fun/boards/movers` — holders, top-ten share,
     deployer holding, transactions in the last five minutes, KOL count, for
     whichever trending coins also sit on that board (most of the top do).
     Best effort; a miss leaves those fields null.

   None of these rows goes through scoreQuality(): the list carries no
   liquidity, and unknown liquidity there means `thin`, which would mark every
   row unbacked for want of a field rather than for a bad value. Flags are
   computed here from what *is* measured, and a trending coin that our own
   pump.fun feed also carries borrows that feed's liquidity and art.

   Every figure shown is one of theirs or one derived from theirs by division.
   ========================================================================== */

import { clean, fastImage, signUrl, isMint, isEvmAddr,
         ONEWAY_SELL_SHARE, ONEWAY_MIN_TXNS, MAX_COPIES } from './core.mjs';
import { fetchActivity } from './activity.mjs';

export const GREAT = 'https://frontend-api-v3.pump.fun/coins/great-coins?topK=50';
export const BOARD = 'https://advanced-indexer.pump.fun/boards/movers?tier=web&surface=WEB&platform=WEB&limit=150';
export { ACTIVITY } from './activity.mjs';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';

/* pump.fun writes the chain two ways — CAIP-2 with a genesis hash on the
   coin objects, `solana:mainnet` on the board. Both are Solana. */
const EVM_CHAINS = {
  'eip155:4663': 'robinhood',
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:56': 'bsc',
  'eip155:999': 'hyperevm',
};
export function chainOf(id, addr) {
  const c = String(id || '');
  if (c.startsWith('solana:')) return 'solana';
  if (EVM_CHAINS[c]) return EVM_CHAINS[c];
  if (!c && isMint(addr)) return 'solana';
  return '';
}

/* pump.fun badges its first five HOT; the list itself goes to fifty. */
export const HOT_RANKS = 5;
/* Size on this tab comes from rank, not market cap, so a small cap does not
   shrink a bubble — the floor only keeps out literal dust. */
export const MIN_MCAP = 1_000;
/* Informational flags, from measurements the movers board carries. */
export const DEV_WARN = 10;      // % of supply the deployer still holds
export const TOP10_WARN = 50;    // % held by the ten largest wallets

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;

async function jget(url, ms = 12000) {
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(url.split('/').slice(2, 3)[0] + ' ' + r.status);
  return r.json();
}

export async function fetchGreat() {
  const j = await jget(GREAT);
  const arr = Array.isArray(j) ? j : [];
  if (!arr.length) throw new Error('great-coins empty');
  return arr;
}

/* The movers board, keyed by address, as extras only. */
export async function fetchMoversIndex() {
  try {
    const j = await jget(BOARD);
    const m = new Map();
    for (const e of (j && j.entries) || []) if (e && e.m) m.set(String(e.m), e);
    return m;
  } catch { return new Map(); }
}

/* fetchActivity moved to src/activity.mjs — core.mjs needs it too. */
export { fetchActivity };

/* One great-coins row → one map token.

   `c` is pump.fun's coin object, `act` its market activity (or undefined),
   `x` its movers-board entry (or undefined), `rank` its 1-based position,
   `copies` how many rows share the ticker. */
export function shapeCoin(c, act, x, rank, copies = 1, now = Date.now()) {
  const addr = String(c.mint || '');
  const chain = chainOf(c.chain_id, addr);
  if (!chain || !(isMint(addr) || isEvmAddr(addr))) return null;
  const evm = isEvmAddr(addr);
  const mcap = num(c.usd_market_cap) || num(c.market_cap_usd);
  if (mcap < MIN_MCAP) return null;

  const a5 = act && act['5m'], a1 = act && act['1h'], a6 = act && act['6h'], a24 = act && act['24h'];
  const vol = num(a24 && a24.volumeUSD) || (x ? num(x.vUsd24h) || num(x.vUsd) : 0);

  /* Buys and sells: the activity endpoint's 24h counts, else the board's
     lifetime counts. Distinct buyers only exist on the former. */
  const buys = a24 ? num(a24.numBuys) : (x ? num(x.bc) : 0);
  const sells = a24 ? num(a24.numSells) : (x ? num(x.sc) : 0);
  const n = buys + sells;
  const txns = n ? {
    buys, sells, n, sellShare: sells / n,
    buyers: a24 ? pick(a24.numBuyers) : null,
    sellers: a24 ? pick(a24.numSellers) : null,
    users: a24 ? pick(a24.numUsers) : null,
    window: a24 ? '24h' : 'all',
  } : null;

  const created = num(c.created_timestamp);
  const ageH = created > 0 ? (now - created) / 36e5 : null;
  const top10 = x ? pick(x.t10) : null;
  const dev = x ? pick(x.dh) : null;

  const flags = [];
  if (txns && txns.n >= ONEWAY_MIN_TXNS && txns.sellShare < ONEWAY_SELL_SHARE) flags.push('oneway');
  if (copies > MAX_COPIES) flags.push('copycat');
  if (ageH != null && ageH < 24) flags.push('new');
  if (dev != null && dev >= DEV_WARN) flags.push('dev');
  if (top10 != null && top10 >= TOP10_WARN) flags.push('top10');
  if (c.is_banned) flags.push('banned');

  return {
    id: evm ? chain + ':' + addr.toLowerCase() : addr,
    chain,
    mint: evm ? '' : addr,
    addr: evm ? addr.toLowerCase() : '',
    sym: clean(c.symbol, 12) || '?',
    name: clean(c.name || c.symbol, 48) || 'unknown',
    rawImg: fastImage(typeof c.image_uri === 'string' ? c.image_uri : ''),
    img: '',
    mcap,
    vol,
    volH1: num(a1 && a1.volumeUSD) || (x ? num(x.vUsd1h) : 0),
    ath: num(c.ath_market_cap) > 0 && num(c.usd_market_cap) > 0 && num(c.market_cap) > 0
      /* ath is quoted in SOL like market_cap; scale by the USD/SOL ratio the row itself gives */
      ? num(c.ath_market_cap) * (num(c.usd_market_cap) / num(c.market_cap)) : 0,
    liq: 0,
    price: 0,
    created,
    lastTrade: num(c.last_trade_timestamp),
    grad: c.complete !== false,
    ageH,
    pc: {
      m5: a5 ? pick(a5.priceChangePercent) : null,
      h1: a1 ? pick(a1.priceChangePercent) : null,
      h6: a6 ? pick(a6.priceChangePercent) : null,
      h24: a24 ? pick(a24.priceChangePercent) : null,
      d7: null, d30: null, y1: null,
    },
    txns,
    holders: x ? pick(x.nh) : null,
    top10,
    dev,
    kol: x ? pick(x.kol) : null,
    tx5: x ? pick(x.tx5) : null,
    program: clean(String(c.protocol || c.program || ''), 24),
    verified: !!c.verified,
    pumpBoost: !!(c.boost_mode && c.boost_mode !== 'NONE'),
    twitter: '',
    website: typeof c.website === 'string' && /^https?:\/\//.test(c.website) ? c.website.slice(0, 200) : '',
    copies,
    flags,
    /* One-way is the one measurement that takes a token off this tab. The
       rest are warnings on the card. */
    solid: !flags.includes('oneway') && !c.is_banned,
    rank,
    pumpHot: rank <= HOT_RANKS,
    via: 'pump',
    from: chain === 'solana' ? 'pumpfun' : chain,
    boost: 0,
  };
}

/* The list as map tokens, in pump.fun's order, with art signed for the
   proxy and liquidity borrowed from our own feeds where we have it.

   `known` is a Map keyed by mint/addr → token from the pump.fun and Robinhood
   feeds, used only to fill `liq`, `img` and `twitter`. */
export async function pumpTrending({ secret, known = new Map() } = {}) {
  const coins = await fetchGreat();
  const addrs = coins.map(c => String(c.mint || '')).filter(a => isMint(a) || isEvmAddr(a));
  const [act, movers] = await Promise.all([fetchActivity(addrs), fetchMoversIndex()]);

  const copies = new Map();
  for (const c of coins) {
    const k = String(c.symbol || '').toUpperCase();
    if (k) copies.set(k, (copies.get(k) || 0) + 1);
  }

  const out = [];
  const seen = new Set();
  const now = Date.now();
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i];
    const a = String(c.mint || '');
    const t = shapeCoin(c, act.get(a), movers.get(a), i + 1, copies.get(String(c.symbol || '').toUpperCase()) || 1, now);
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
