/* ==========================================================================
   The pump.fun feed when pump.fun refuses servers.

       node scripts/jupfeed.test.mjs

   Since 2026-11-13 every pump.fun host answers servers with a Cloudflare
   managed challenge. Pinned here:

     - the challenge is recognised (403 + cf-mitigated, or an HTML 403) and
       pump.fun is then left alone for ten minutes, not asked on every build;
     - an ordinary 403 (a JSON one) is not mistaken for the challenge;
     - the feed then comes from Jupiter, kept to pump.fun's own launches and
       to the stage asked for, and says so (`feedVia`);
     - Jupiter's numbers are its own and null where it has none — never 0;
     - a Jupiter-priced token is not re-asked of DexScreener;
     - a Solana token DexScreener cannot price is priced by Jupiter, pool
       included, so it is judged by its liquidity rather than turnover;
     - a single coin resolves through Jupiter when pump.fun refuses;
     - the audit flags are stated and never take a bubble off the map; the
       deployer's launch count is not one (it describes launch tooling).
   ========================================================================== */

import { pumpFetch, pumpPaused, pumpStatus, isChallenge, _resetPumpGate, PUMP_PAUSE_MS } from '../src/pumpgate.mjs';
import { normalizeJup, fetchPumpFeed, feedVia, enrich, fetchCoin, scoreQuality, _resetFeedMem, _dexMemForTests } from '../src/core.mjs';
import { jupRows, paced } from '../src/jupfeed.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const mint = (i, tail = 'pump') => 'J' + B58[i % 50] + B58[Math.floor(i / 50) % 50] + 'q'.repeat(33) + tail;

const challenge = () => new Response('<!DOCTYPE html><title>Just a moment...</title>', {
  status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' } });

/* a Jupiter v2 row, as /tokens/v2/* returns it */
const jrow = (i, o = {}) => ({
  id: mint(i), name: 'Coin ' + i, symbol: 'C' + i, icon: 'https://ipfs.io/ipfs/Qm' + i, decimals: 6,
  launchpad: 'pump.fun', graduatedPool: 'Pool' + i, holderCount: 1000 + i,
  mcap: 1e6 * (i + 1), fdv: 1e6 * (i + 1), usdPrice: 0.001, liquidity: 80_000,
  stats5m: { priceChange: 0.5, buyVolume: 100, sellVolume: 50, numBuys: 3, numSells: 2 },
  stats1h: { priceChange: -1.5, buyVolume: 2000, sellVolume: 1000 },
  stats24h: { priceChange: 12, buyVolume: 60_000, sellVolume: 40_000, numBuys: 600, numSells: 500, numTraders: 220,
    buyOrganicVolume: 3000, sellOrganicVolume: 2000 },
  firstPool: { createdAt: '2026-01-01T00:00:00Z' },
  audit: { topHoldersPercentage: 30, devBalancePercentage: 1.2, devMints: 3 },
  organicScoreLabel: 'medium',
  ...o,
});

const real = globalThis.fetch;
try {
  console.log('\nthe gate');
  {
    _resetPumpGate();
    is('a challenge is a challenge', isChallenge(challenge()), true);
    is('a JSON 403 is not', isChallenge(new Response('{"error":"banned"}', { status: 403, headers: { 'content-type': 'application/json' } })), false);
    let sent = 0;
    const http = async () => { sent++; return challenge(); };
    let threw = null;
    try { await pumpFetch('https://frontend-api-v3.pump.fun/coins?offset=0', {}, http, 1000); } catch (e) { threw = e; }
    is('a challenged request throws', !!threw, true);
    is('…with status 403', threw && threw.status, 403);
    is('…and pauses pump.fun', pumpPaused(1000 + 60_000), true);
    threw = null;
    try { await pumpFetch('https://swap-api.pump.fun/v1/x', {}, http, 2000); } catch (e) { threw = e; }
    is('while paused nothing is sent, on any pump.fun host', sent, 1);
    is('…and it still throws', !!threw, true);
    is('…and is counted', pumpStatus.skipped, 1);
    is('the pause ends', pumpPaused(1000 + PUMP_PAUSE_MS + 1), false);
    await pumpFetch('https://api.dexscreener.com/x', {}, async () => new Response('[]'), 3000);
    is('other hosts pass straight through while paused', sent, 1);
    const r = await pumpFetch('https://frontend-api-v3.pump.fun/coins', {}, async () => new Response('[]', { status: 200 }), 1000 + PUMP_PAUSE_MS + 5);
    is('one request after the pause checks again', r.status, 200);
    is('…and a 200 lifts it', pumpStatus.blocked, false);
    _resetPumpGate();
  }

  console.log('\na Jupiter row');
  {
    const t = normalizeJup(jrow(1));
    is('id and mint are the mint', t.id === mint(1) && t.mint === mint(1), true);
    is('market cap', t.mcap, 2e6);
    is('24h change', t.pc.h24, 12);
    is('1h change', t.pc.h1, -1.5);
    is('volume is buys plus sells', t.vol, 100_000);
    is('liquidity is measured, not unknown', t.liq === 80_000 && !t.liqUnknown, true);
    is('graduated from the pool', t.grad, true);
    is('holders', t.holders, 1001);
    is('trades', t.txns.buys + '/' + t.txns.sells, '600/500');
    is('arrives priced', t.priced, true);
    const bare = normalizeJup(jrow(2, { stats6h: undefined, stats24h: { buyVolume: 10 } }));
    is('a window Jupiter did not send is null, not 0', bare.pc.h6, null);
    is('…nor one with no priceChange in it', bare.pc.h24, null);
    is('a hostile ticker is cleaned', normalizeJup(jrow(3, { symbol: '<img src=x>' })).sym.includes('<'), false);
    is('an http: icon is dropped', normalizeJup(jrow(4, { icon: 'javascript:alert(1)' })).rawImg, '');
    is('a non-mint id is refused', normalizeJup(jrow(5, { id: '0xabc' })), null);
  }

  console.log('\nthe feed, pump.fun refusing');
  {
    _resetPumpGate(); _resetFeedMem();
    let pumpAsked = 0, jupAsked = 0;
    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('pump.fun')) { pumpAsked++; return challenge(); }
      if (u.includes('jup.ag')) {
        jupAsked++;
        return new Response(JSON.stringify([
          jrow(1), jrow(2), jrow(3, { graduatedPool: undefined }),          // one still on its curve
          jrow(4, { launchpad: 'letsbonk.fun' }),                           // somebody else's launch
          jrow(5, { mcap: 0, fdv: 0 }),                                     // nothing to draw
        ]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
    const g = await fetchPumpFeed({ complete: true }, { seed: [] });
    is('pump.fun asked once per page, then paused', pumpAsked <= 6 && pumpAsked >= 1, true);
    is('the feed comes from Jupiter', feedVia.pumpfun, 'jupiter');
    is('…and says why', /challenge|refuses/.test(feedVia.error), true);
    is('only pump.fun launches, graduated, with a cap', g.map(t => t.sym).join(','), 'C2,C1');
    const before = pumpAsked;
    _resetFeedMem();
    const b = await fetchPumpFeed({ complete: false }, { seed: [] });
    is('the next build does not knock on pump.fun again', pumpAsked, before);
    is('the bonding stage is its own', b.map(t => t.sym).join(','), 'C3');
    const asked = jupAsked;
    await fetchPumpFeed({ complete: true }, { seed: [] });
    is('Jupiter rows are kept a few seconds, not re-asked every build', jupAsked, asked);

    _resetFeedMem();
    globalThis.fetch = async url => String(url).includes('pump.fun') ? challenge() : new Response('nope', { status: 503 });
    let threw = null;
    try { await fetchPumpFeed({ complete: true }, { seed: [] }); } catch (e) { threw = e; }
    is('both down is an error, never an empty map passed off as data', !!threw, true);
    _resetPumpGate(); _resetFeedMem();
  }

  console.log('\nenrichment');
  {
    _dexMemForTests().clear();
    let dex = 0, jup = 0;
    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('jup.ag')) {
        jup++;
        const q = decodeURIComponent(u.split('query=')[1] || '').split(',');
        return new Response(JSON.stringify(q.map((m, i) => jrow(i, { id: m }))), { status: 200 });
      }
      if (u.includes('dexscreener')) { dex++; return new Response('[]', { status: 200 }); }   // no pair for anything
      return challenge();
    };
    const pre = normalizeJup(jrow(9));
    const plain = { mint: mint(20, 'abcd'), pc: {} };
    const hit = await enrich([pre, plain]);
    is('both count as enriched', hit, 2);
    is('the priced token was not sent to DexScreener', dex, 1);
    is('the other one was priced by Jupiter', plain.pc.h24, 12);
    is('…with its pool, not marked unknown', plain.liq === 80_000 && !plain.liqUnknown, true);
    is('…and its holders', plain.holders, 1000);
    is('…in one Jupiter call', jup, 1);
  }

  console.log('\none coin');
  {
    const M = mint(30);
    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('pump.fun')) return challenge();
      if (u.includes('jup.ag')) return new Response(JSON.stringify([jrow(30, { graduatedPool: undefined, symbol: 'CURVE' })]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    _resetPumpGate();
    const t = await fetchCoin(M, '');
    is('resolves through Jupiter while pump.fun refuses', t && t.sym, 'CURVE');
    is('…a bonding-curve coin, which DexScreener would not have', t && t.grad, false);
    _resetPumpGate();
  }

  console.log('\naudit flags');
  {
    const a = normalizeJup(jrow(1, { audit: { topHoldersPercentage: 72, devBalancePercentage: 14, devMints: 4590 } }));
    const b = normalizeJup(jrow(2));
    scoreQuality([a, b], 150, 'memecoin');
    is('a deployer holding 14% is stated', a.flags.includes('dev'), true);
    is('top holders at 72% are stated', a.flags.includes('tophold'), true);
    is('a deployer address with 4,590 launches is not a statement about the coin', a.flags.includes('serial'), false);
    is('…and none of them takes the bubble away', a.solid, true);
    is('ordinary numbers raise nothing', b.flags.filter(f => ['dev', 'tophold'].includes(f)).length, 0);
  }

  console.log('\npacing');
  {
    const at = [];
    const t0 = Date.now();
    await paced(Array.from({ length: 6 }, () => async () => { at.push(Date.now() - t0); }), { burst: 4, gap: 120 });
    is('four go at once', at.slice(0, 4).every(x => x < 100), true);
    is('the rest wait for the next second', at.slice(4).every(x => x >= 110), true);
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    is('empty lists are an answer', (await jupRows({ lists: ['recent'], gap: 0 })).length, 0);
    globalThis.fetch = async () => new Response('', { status: 429 });
    let threw = null;
    try { await jupRows({ lists: ['recent'], gap: 0 }); } catch (e) { threw = e; }
    is('no list answering is an error', !!threw, true);
  }
} finally { globalThis.fetch = real; }

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
