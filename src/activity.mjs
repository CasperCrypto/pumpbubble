/* ==========================================================================
   pumpbubble.fun — pump.fun's own market activity

   `swap-api.pump.fun/v1/coins/market-activity/batch`: per coin and window,
   volume, buys, sells, distinct buyers and sellers, and price change. Fifty
   addresses a call. First found for the Trending tab (src/pumptrend.mjs).

   It lives in its own module because core.mjs now needs it too — as the
   fallback when DexScreener refuses the Worker — and core importing
   pumptrend, which imports core, is a cycle waiting to bite.

   A window the API did not answer for is absent, not zero.
   ========================================================================== */

export const ACTIVITY = 'https://swap-api.pump.fun/v1/coins/market-activity/batch';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';

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
