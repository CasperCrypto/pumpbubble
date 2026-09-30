/* ==========================================================================
   DexScreener enrichment under refusal.

       node scripts/enrich.test.mjs

   The pump.fun tab showed five bubbles with 295 hidden because DexScreener
   refused the Worker (429 on every request, from Cloudflare's shared egress)
   and every token was left with no liquidity. What is pinned here:

     - an answer is reused for a minute instead of re-asked every build;
     - a failed request falls back to the last good answer for fifteen;
     - a token DexScreener never answered is filled from pump.fun's own
       market activity, with liquidity marked unknown, not zero;
     - without liquidity, turnover decides whether a cap is backed;
     - nothing is ever made up where no source answered.
   ========================================================================== */

import { enrich, scoreQuality, pumpCoin, fetchCoin, _dexMemForTests, _actMemForTests } from '../src/core.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const mint = i => 'E' + B58[i % 50] + B58[Math.floor(i / 50) % 50] + 'x'.repeat(33) + 'pump';
const pair = (m, o = {}) => ({
  baseToken: { address: m, symbol: 'T' }, liquidity: { usd: 50_000 }, volume: { h24: 120_000, h1: 5000 },
  priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 }, priceUsd: '0.01', txns: { h24: { buys: 100, sells: 90 } }, ...o,
});
const toks = n => Array.from({ length: n }, (_, i) => ({ mint: mint(i), pc: {} }));

/* pump.fun's market activity for any mint, as its batch endpoint returns it */
const activity = () => ({
  '5m': { priceChangePercent: 0.5, volumeUSD: 900, numBuys: 9, numSells: 8 },
  '1h': { priceChangePercent: 2.5, volumeUSD: 9_000, numBuys: 90, numSells: 80 },
  '6h': { priceChangePercent: -3, volumeUSD: 40_000, numBuys: 400, numSells: 390 },
  '24h': { priceChangePercent: 12.5, volumeUSD: 150_000, numBuys: 1500, numSells: 1400 },
});

const real = globalThis.fetch;
let calls = 0, pumpCalls = 0, mode = 'ok', pumpMode = 'ok';
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('swap-api.pump.fun')) {
    pumpCalls++;
    if (pumpMode === 'refuse') return new Response('{}', { status: 429 });
    const { addresses } = JSON.parse(opts.body);
    return new Response(JSON.stringify(Object.fromEntries(addresses.map(a => [a, activity()]))), { status: 201 });
  }
  calls++;
  if (mode === 'refuse') return new Response('{"error":"rate limited"}', { status: 429 });
  const list = String(url).split('/').pop().split(',');
  /* mints starting E1 have no pair on DexScreener */
  const body = list.filter(m => !m.startsWith('E1')).map(m => pair(m));
  return new Response(JSON.stringify(body), { status: 200 });
};

try {
  console.log('\nreuse');
  {
    _dexMemForTests().clear(); _actMemForTests().clear();
    calls = 0; pumpCalls = 0;
    const a = toks(60);
    const hitA = await enrich(a);
    is('first pass asks DexScreener', calls, 2);
    is('…and pump.fun once, for the mints DexScreener has no pair for', pumpCalls, 1);
    is('…and enriches every token one way or the other', hitA, 60);
    calls = 0; pumpCalls = 0;
    const b = toks(60);
    const hitB = await enrich(b);
    is('a second pass within a minute asks DexScreener nothing', calls, 0);
    is('…and pump.fun nothing', pumpCalls, 0);
    is('…and enriches the same tokens', hitB, hitA);
    is('…with the same numbers', b[5].liq, a[5].liq);
  }

  console.log('\nrefused');
  {
    mode = 'refuse';
    const mem = _dexMemForTests();
    for (const v of mem.values()) v.at -= 5 * 60_000;       // stale, inside the fallback window
    calls = 0;
    const c = toks(60);
    const hitC = await enrich(c);
    is('stale answers are re-asked', calls > 0, true);
    is('a refused pass falls back to the last good answer', hitC > 0, true);
    is('…with liquidity, so nothing is scored unbacked for want of it', c[5].liq, 50_000);

    mem.clear(); _actMemForTests().clear();
    const e = toks(30);
    const hitE = await enrich(e);
    is('never answered by DexScreener: pump.fun’s own activity fills it', hitE, 30);
    is('…the colour, from pump.fun', e[0].pc.h24, 12.5);
    is('…the volume, from pump.fun', e[0].vol, 150_000);
    is('…buys and sells, from pump.fun', e[0].txns.buys + '/' + e[0].txns.sells, '1500/1400');
    is('…and liquidity marked unknown, not zero', e[0].liqUnknown === true && !e[0].liq, true);

    mem.clear(); _actMemForTests().clear();
    pumpMode = 'refuse';
    const f = toks(30);
    is('both refused, nothing remembered: no data, not zero-filled data', await enrich(f), 0);
    is('…the window stays null', f[0].pc.h24 === undefined || f[0].pc.h24 === null, true);
    mode = 'ok'; pumpMode = 'ok';
  }

  console.log('\nquality without liquidity: turnover decides');
  {
    const tk = (sym, i, mcap, vol) => ({ sym, mint: mint(i), mcap, vol, liqUnknown: true, grad: true, pc: {}, created: 0, lastTrade: Date.now() });
    const realCap = tk('FART', 1, 168_000_000, 12_000_000);
    const paper = tk('AROS', 2, 4_100_000_000, 40_000);
    const dead = tk('ZERO', 3, 900_000, 0);
    scoreQuality([realCap, paper, dead], 150, 'memecoin');
    is('a big cap that trades is backed', realCap.flags.includes('thin'), false);
    is('a $4B cap trading $40k a day is paper', paper.flags.includes('thin'), true);
    is('no volume at all is paper', dead.flags.includes('thin'), true);
  }

  console.log('\n"no pair" is an answer too');
  {
    _dexMemForTests().clear(); _actMemForTests().clear();
    await enrich(toks(60));
    calls = 0; pumpCalls = 0;
    await enrich(toks(60));
    is('mints without a pair are not re-asked every build', calls + pumpCalls, 0);
  }
} finally { globalThis.fetch = real; }

/* One coin by mint. pump.fun retired GET /coins/<mint> (404 "Cannot GET"),
   and every single-token lookup — boost box, /setup, Tap wars adds — failed
   as "no token found" for anything not in a warm feed. Pinned: the retired
   route is never asked, v2 is, v3 catches a v2 failure, and a record for some
   other mint is not accepted as this one. */
{
  const M = mint(7);
  const coin = { mint: M, symbol: 'UDR', name: 'United', usd_market_cap: 5e8, complete: true, image_uri: '' };
  const asked = [];
  const route = (fail = {}) => async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/coins/' + M)) return new Response('{"message":"Cannot GET"}', { status: 404 });
    for (const v of ['v2', 'v3']) {
      if (u.includes('/coins-' + v + '/')) {
        if (fail[v] === 'down') return new Response('', { status: 503 });
        if (fail[v] === 'other') return new Response(JSON.stringify({ ...coin, mint: mint(8) }), { status: 200 });
        return new Response(JSON.stringify(coin), { status: 200 });
      }
    }
    return new Response('[]', { status: 200 });   // enrichment calls: nothing to add
  };
  try {
    globalThis.fetch = route();
    let c = await pumpCoin(M);
    is('a coin resolves through /coins-v2/', c && c.symbol, 'UDR');
    is('the retired /coins/<mint> is never asked', asked.some(u => u.includes('/coins/' + M)), false);
    is('v2 answered, so v3 was not asked', asked.some(u => u.includes('/coins-v3/')), false);

    asked.length = 0; globalThis.fetch = route({ v2: 'down' });
    c = await pumpCoin(M);
    is('v3 answers when v2 is down', c && c.symbol, 'UDR');

    asked.length = 0; globalThis.fetch = route({ v2: 'other', v3: 'other' });
    is('a record for another mint is refused', await pumpCoin(M), null);

    globalThis.fetch = route({ v2: 'down', v3: 'down' });
    is('both down is null, not a throw', await pumpCoin(M), null);
    is('not a mint, not asked', await pumpCoin('0xabc'), null);

    globalThis.fetch = route();
    const t = await fetchCoin(M, '');
    is('fetchCoin builds the token from it', t && t.sym, 'UDR');
    is('with its market cap', t && t.mcap, 5e8);
  } finally { globalThis.fetch = real; }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
