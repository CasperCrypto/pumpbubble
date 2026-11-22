/* ==========================================================================
   pumpbubble.fun — pump.fun's own market activity

   `swap-api.pump.fun/v1/coins/market-activity/batch`: per coin and window,
   volume, buys, sells, distinct buyers and sellers, and price change. Fifty
   addresses a call. First found for the Trending tab (src/pumptrend.mjs).

   It lives in its own module because core.mjs now needs it too — as the
   fallback when DexScreener refuses the Worker — and core importing
   pumptrend, which imports core, is a cycle waiting to bite.

   A window the API did not answer for is absent, not zero.

   **pump.fun retired the endpoint** (found 2026-11-22: `Cannot POST
   /v1/coins/market-activity/batch`, 404, while the rest of frontend-api-v3
   answered again). Every caller lost its prices at once and said nothing:
   Trending drew pump.fun's whole list grey with a dash on every window, and
   Smart money went empty, because a holding with no volume is dropped. So a
   Solana mint pump.fun does not answer for is asked of Jupiter's token search
   and its stats shaped into the same per-window record — Jupiter's own
   measurements, never mixed into one of pump.fun's windows. Jupiter has no
   distinct buyers and sellers, so those stay null; `numUsers` is its distinct
   traders. The row also carries `jup` (liquidity, holders, audit) for callers
   that can use it.
   ========================================================================== */

import { pumpFetch } from './pumpgate.mjs';
import { jupByMint } from './jupfeed.mjs';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fin = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

/* What answered, for /api/health. */
export const activityStatus = { pumpOk: 0, pumpMiss: 0, jupFilled: 0, lastError: '' };

/* One Jupiter token row → pump.fun's market-activity shape. */
export function jupActivity(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {};
  for (const [w, key] of [['5m', 'stats5m'], ['1h', 'stats1h'], ['6h', 'stats6h'], ['24h', 'stats24h']]) {
    const s = j[key];
    if (!s || typeof s !== 'object') continue;
    const buys = fin(s.numBuys), sells = fin(s.numSells);
    out[w] = {
      volumeUSD: (fin(s.buyVolume) || 0) + (fin(s.sellVolume) || 0),
      numBuys: buys, numSells: sells,
      numTxs: buys != null && sells != null ? buys + sells : null,
      numBuyers: null, numSellers: null,
      numUsers: fin(s.numTraders),
      priceChangePercent: fin(s.priceChange),
    };
  }
  if (!Object.keys(out).length) return null;
  const a = (j.audit && typeof j.audit === 'object') ? j.audit : {};
  out.jup = {
    liq: fin(j.liquidity) || 0,
    mcap: fin(j.mcap) || fin(j.fdv) || 0,
    price: fin(j.usdPrice) || 0,
    holders: fin(j.holderCount),
    topHold: fin(a.topHoldersPercentage),
    dev: fin(a.devBalancePercentage),
    organic: ['low', 'medium', 'high'].includes(j.organicScoreLabel) ? j.organicScoreLabel : '',
  };
  return out;
}

export const ACTIVITY = 'https://swap-api.pump.fun/v1/coins/market-activity/batch';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';

export async function fetchActivity(addresses, { fallback = true, jup = jupByMint } = {}) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 50) chunks.push(addresses.slice(i, i + 50));
  await Promise.all(chunks.map(async chunk => {
    try {
      const r = await pumpFetch(ACTIVITY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({
          addresses: chunk,
          intervals: ['5m', '1h', '6h', '24h'],
          metrics: ['numTxs', 'volumeUSD', 'numBuys', 'numSells', 'numBuyers', 'numSellers', 'numUsers', 'priceChangePercent'],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { activityStatus.lastError = 'pump.fun activity ' + r.status; return; }
      const j = await r.json();
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) if (v && typeof v === 'object') out.set(k, v);
    } catch (e) { activityStatus.lastError = String((e && e.message) || e).slice(0, 100); }
  }));
  activityStatus.pumpOk += out.size;
  const miss = addresses.filter(a => !out.has(a) && MINT_RE.test(String(a)));
  activityStatus.pumpMiss += miss.length;
  if (fallback && miss.length) {
    try {
      const got = await jup(miss.slice(0, 200));
      for (const k of miss) {
        const a = jupActivity(got.get(k));
        if (a) { out.set(k, a); activityStatus.jupFilled++; }
      }
    } catch (e) { activityStatus.lastError = 'jupiter ' + String((e && e.message) || e).slice(0, 90); }
  }
  return out;
}
