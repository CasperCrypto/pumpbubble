/* ==========================================================================
   Traders — pump.fun's leaderboard, ranked by what was banked.

       node scripts/traders.test.mjs

   The one rule that matters: the ranking and the size are REALIZED profit.
   pump.fun's own board sorts by realized plus unrealized, and on the day this
   was built its daily #1 showed +$1.1M with $0 realized. Everything else here
   is the translation of a row into a bubble without inventing anything.
   ========================================================================== */

import { shapeTrader, tradersFor, PERIODS } from '../src/traders.mjs';
import { buildBubbleSvg } from '../src/bubblecard.mjs';
import { pumpOptimizerUrl } from '../src/share.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const W = '4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo';
/* a leaderboard row as pump.fun returns it — cooker's, the day it was built */
const row = (o = {}) => ({
  rank: 1, walletAddress: W, pnlSol: -300, pnlUsd: -37073, pnlPercent: -2.44, buySpendSol: 1500,
  lastRefreshedAtMs: 1790261335666, realizedPnlSol: 470, realizedPnlUsd: 58700,
  unrealizedPnlSol: -770, unrealizedPnlUsd: -95772, positionsCount: 86,
  topPositions: [{ mint: 'PONSmint', symbol: 'PONS', imageUri: 'https://x/a.png' }, { mint: 'm2', symbol: 'GROK' }],
  username: 'cooker', profileImage: 'https://socialimages.pump.fun/profile-images/a.png',
  xUsername: 'CookerFlips', isVerified: true, ...o,
});

console.log('\nsize is realized profit');
{
  const t = shapeTrader(row(), 'daily', 0);
  is('mcap — the field that sizes a bubble — is realized', t.mcap, 58700);
  is('…not the total', t.mcap === t.total, false);
  is('realized is carried as itself', t.realized, 58700);
  is('a row with nothing realized is not on a board of what was banked', shapeTrader(row({ realizedPnlUsd: 0 }), 'daily'), null);
  is('a realized loss is not either', shapeTrader(row({ realizedPnlUsd: -500 }), 'daily'), null);
  is('a missing realized figure is not zero, it is no row', shapeTrader(row({ realizedPnlUsd: null }), 'daily'), null);
  /* pump.fun's #1 on the day: paper only */
  is('+$1.1M of paper with $0 realized does not get on the map', shapeTrader(row({ pnlUsd: 1109137, realizedPnlUsd: 0, unrealizedPnlUsd: 1109137 }), 'daily'), null);
}

console.log('\ncolour is the total, in the tab’s own window');
{
  const d = shapeTrader(row(), 'daily');
  is('daily fills h24', d.pc.h24, -2.44);
  is('…and no other window', [d.pc.m5, d.pc.h1, d.pc.h6, d.pc.d7, d.pc.d30, d.pc.y1].every(v => v === null), true);
  is('weekly fills d7', shapeTrader(row(), 'weekly').pc.d7, -2.44);
  is('monthly fills d30', shapeTrader(row(), 'monthly').pc.d30, -2.44);
  is('banked but underwater is negative overall', d.total < 0 && d.realized > 0, true);
  is('open positions carried with their sign', d.unrealized, -95772);
  is('the three periods map to the three tf pills', Object.values(PERIODS).join(','), 'h24,d7,d30');
}

console.log('\na trader is not a token');
{
  const t = shapeTrader(row(), 'daily');
  is('kind', t.kind, 'trader');
  is('no mint, so no Boost or Buy button', t.mint, '');
  is('no addr either', t.addr, '');
  is('the wallet is kept for the profile link', t.wallet, W);
  is('id cannot collide with a token id', t.id, 'trader:' + W);
  is('the X handle is not called `x` — that is a bubble’s position', 'x' in t, false);
  is('…it is xh', t.xh, 'CookerFlips');
  is('top positions keep ticker and mint', t.top.map(p => p.sym).join(','), 'PONS,GROK');
  is('…but not unsigned art the page could not show', t.top.some(p => 'img' in p), false);
}

console.log('\nwhat a stranger controls');
{
  is('a hostile username is cleaned', shapeTrader(row({ username: '<img src=x onerror=alert(1)>' }), 'daily').sym.includes('<'), false);
  is('no username falls back to the wallet', shapeTrader(row({ username: '' }), 'daily').sym, '4ugD…ocwo');
  is('a non-https avatar is dropped', shapeTrader(row({ profileImage: 'javascript:alert(1)' }), 'daily').rawImg, '');
  is('a bad wallet is no row', shapeTrader(row({ walletAddress: 'nope' }), 'daily'), null);
  is('nothing at all is no row', shapeTrader(null, 'daily'), null);
}

console.log('\nboth boards, joined');
{
  const realizedBoard = { entries: [row(), row({ rank: 2, walletAddress: 'EGB6v3y5oS7Whv4KHYp8ksL2wRfqdfAF5Dbqq8kHXsZH', username: 'b', realizedPnlUsd: 20000 })] };
  const combinedBoard = { entries: [{ rank: 7, walletAddress: 'EGB6v3y5oS7Whv4KHYp8ksL2wRfqdfAF5Dbqq8kHXsZH' }] };
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async u => {
    seen.push(String(u));
    const body = String(u).includes('sort=realized') ? realizedBoard : combinedBoard;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const t = await tradersFor('daily');
    is('asks for the realized board', seen.some(u => u.includes('sort=realized')), true);
    is('…in the period asked for', seen.every(u => u.includes('period=daily')), true);
    is('keeps realized order', t.map(x => x.sym).join(','), 'cooker,b');
    is('pump.fun’s own rank joined where it exists', t[1].pumpRank, 7);
    is('…and 0 where the trader is not on it', t[0].pumpRank, 0);

    globalThis.fetch = async u => String(u).includes('sort=realized')
      ? new Response(JSON.stringify(realizedBoard), { status: 200 })
      : new Response('{"error":"access_denied"}', { status: 403 });
    const t2 = await tradersFor('daily');
    is('the comparison board failing does not fail the tab', t2.length, 2);

    globalThis.fetch = async () => new Response('{"error":"access_denied"}', { status: 403 });
    let threw = '';
    try { await tradersFor('daily'); } catch (e) { threw = e.message; }
    is('the realized board failing is an error the snapshot can fall back on', threw, 'pnl-leaderboard 403');

    threw = '';
    try { await tradersFor('yearly'); } catch (e) { threw = e.message; }
    is('an unknown period is refused', threw, 'unknown period');
  } finally { globalThis.fetch = real; }
}

console.log('\nthe share card says money, not a percentage');
{
  const rows = ['a', 'b', 'c', 'd'].map((n, i) => ({ sym: n, title: '@' + n, label: '+$' + (50 - i) + 'K', up: i !== 1, pct: null }));
  const svg = buildBubbleSvg({ rows, seed: 9 });
  is('a row with a label but no percentage is drawn', (svg.match(/url\(#gb\d+\)/g) || []).length, 4);
  is('the label is the money', svg.includes('+$50K'), true);
  is('the title replaces the $ticker', svg.includes('@a') && !svg.includes('$a<'), true);
  is('underwater is drawn red even with a + label', svg.includes('#e8364d'), true);
}

console.log('\navatars the rasteriser can read');
{
  const av = 'https://socialimages.pump.fun/profile-images/5ae8d034/267fd4ff';
  is('pump.fun art goes through pump.fun’s own optimizer', pumpOptimizerUrl(av),
    'https://pump.fun/_next/image?url=' + encodeURIComponent(av) + '&w=256&q=75');
  is('...any pump.fun subdomain', pumpOptimizerUrl('https://images.pump.fun/x.webp').startsWith('https://pump.fun/_next/image'), true);
  is('...but nobody else’s art', pumpOptimizerUrl('https://axiomtrading.sfo3.cdn.digitaloceanspaces.com/a.webp'), '');
  is('a lookalike host is not pump.fun', pumpOptimizerUrl('https://evilpump.fun.example.com/a.webp'), '');
  is('http is not https', pumpOptimizerUrl('http://socialimages.pump.fun/a'), '');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
