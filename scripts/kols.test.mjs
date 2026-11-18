/* ==========================================================================
   KOLs — who pump.fun pays to call, and whether following them paid.

       node scripts/kols.test.mjs

   What is pinned:
     - a payout row keeps its Solana wallet even when pump.fun lists an EVM
       one first, and is dropped only when it names nobody;
     - the last hundred calls become medians, averages and shares that a
       single moonshot cannot fake (median vs average), perp calls left out,
       a call with no peak yet still counted where it can be;
     - an empty payout answer never replaces a board;
     - records are fetched coldest-first, best-paid first, and not again for
       six hours; a 429 stops the tick and backs off;
     - one tick stays inside its request budget, board tick or not;
     - the board joins followers and records onto pump.fun's own order.
   ========================================================================== */

import { KolBook, shapePayout, shapeProfile, shapeHistory, pollKols, withKols, median, boardSummary, spearman, tradingOf, paidWallets,
  PAYOUTS, listUrl, userUrl, KOL_PERIODS, KOL_PER_TICK, KOL_WARM, HIST_TTL, PAY_EVERY } from '../src/kols.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const near = (n, got, want, eps = 1e-9) => (got != null && Math.abs(got - want) < eps ? ok(n) : no(n, `got ${got}, want ${want}`));

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const sol = i => (B58[i % 50] + B58[Math.floor(i / 50) % 50]).padEnd(43, 'k') + 'Z';
const NOW = Date.parse('2026-10-11T12:00:00Z');

const entry = (i, extra = {}) => ({
  rank: i + 1, userId: 'u-' + i, username: 'kol' + i, profileImageUrl: 'https://socialimages.pump.fun/p/' + i + '.png',
  isVerified: i % 2 === 0, walletAddress: sol(i), wallets: [sol(i)], totalPaidUsdc: 300000 - i * 1000, payoutCount: 60 - i,
  lastPaidAt: '2026-10-10T15:11:30.114Z', ...extra,
});

console.log('\nshapes');
{
  const r = shapePayout(entry(0, { walletAddress: '0x826fc54012f74c0cd7bccc5a6b964686322201ca', wallets: ['0x826fc54012f74c0cd7bccc5a6b964686322201ca', sol(7)] }));
  is('an EVM-first row keeps its Solana wallet', r.wallet, sol(7));
  is('paid and payouts carried', [r.paid, r.payouts, r.rank], [300000, 60, 1]);
  is('avatar must be https', shapePayout(entry(1, { profileImageUrl: 'javascript:alert(1)' })).avatar, '');
  is('a row naming nobody is dropped', shapePayout({ rank: 3, totalPaidUsdc: 5 }), null);
  is('a row with only an EVM wallet is kept, without a record to read', shapePayout(entry(2, { walletAddress: '0xabc', wallets: [] })).wallet, '');
  is('negative paid is not a payout', shapePayout(entry(3, { totalPaidUsdc: -5 })).paid, 0);

  const p = shapeProfile({ followers: 92122, following: 27, x_username: 'Yennii56', kind: 'person', is_banned: false });
  is('profile: followers, handle', [p.followers, p.xh, p.person], [92122, 'Yennii56', true]);
  is('an illegal X handle is not printed', shapeProfile({ followers: 5, x_username: 'not a handle!' }).xh, '');
  is('zero followers is zero, not unknown', shapeProfile({ followers: 0 }).followers, 0);
  is('missing followers is unknown', shapeProfile({}).followers, null);
}

console.log('\nthe last hundred calls');
{
  const calls = [
    { marketCap: 50_000, maxMultiplier: 1.2, multiple: 0.4, createdAt: NOW - 5e6 },
    { marketCap: 80_000, maxMultiplier: 2.0, multiple: 0.9, createdAt: NOW - 4e6 },
    { marketCap: 200_000, maxMultiplier: 2.5, multiple: 1.5, createdAt: NOW - 3e6 },
    { marketCap: 1_000_000, maxMultiplier: 3.0, multiple: 1.1, createdAt: NOW - 2e6 },
    { marketCap: 4_000_000, maxMultiplier: 41.3, multiple: 0.2, createdAt: NOW - 1e6 },   // the moonshot
    { marketCap: 0, maxMultiplier: 9, multiple: 9, perp: { side: 'long' }, createdAt: NOW },   // a perp call
  ];
  const h = shapeHistory({ callouts: calls });
  is('perp calls are left out', h.n, 5);
  near('average market cap at the call', h.avgMcap, (50_000 + 80_000 + 200_000 + 1_000_000 + 4_000_000) / 5);
  near('share under $100k', h.under100k, 2 / 5);
  near('median peak ignores the moonshot', h.medPeak, 2.5);
  near('the average does not', h.avgPeak, (1.2 + 2 + 2.5 + 3 + 41.3) / 5);
  near('2× hit rate counts 2.0 as a hit', h.hit2, 4 / 5);
  near('median now — what a holder has', h.medNow, 0.9);
  near('share above the call price now', h.inProfit, 2 / 5);
  is('span of the calls', [h.firstAt, h.lastAt], [NOW - 5e6, NOW - 1e6]);
  is('no calls is a record of nothing, not zeros', shapeHistory({ callouts: [] }), { n: 0 });
  is('a malformed answer is nothing', shapeHistory(null), { n: 0 });
  const missing = shapeHistory({ callouts: [{ marketCap: 10_000 }, { marketCap: 20_000, maxMultiplier: 3, multiple: 2 }] });
  is('a call with no peak yet counts toward size, not toward the multiples', [missing.n, missing.medPeak, missing.hit2], [2, 3, 1]);
  is('median of an even list', median([1, 2, 3, 10]), 2.5);
  is('median of nothing', median([]), null);
}

console.log('\nthe book');
{
  const kb = new KolBook();
  is('an empty answer does not create a board', kb.applyPayouts('all', { entries: [] }, NOW), 0);
  kb.applyPayouts('all', { entries: [0, 1, 2, 3].map(i => entry(i)), totalEarners: 812 }, NOW);
  is('an empty answer never replaces a board', (kb.applyPayouts('all', { entries: [] }, NOW + 1), kb.boards.all.rows.length), 4);
  is('total earners kept', kb.boards.all.total, 812);
  is('everyone on the board is someone to read', kb.people.size, 4);
  is('the best paid are read first', kb.needed(NOW, 2), [sol(0), sol(1)]);
  kb.applyHistory(sol(0), { callouts: [{ marketCap: 1e6, maxMultiplier: 3, multiple: 1.2 }] }, NOW);
  kb.applyProfile(sol(0), { followers: 118253, x_username: 'chairman' }, NOW);
  is('a KOL with a fresh record is not asked again', kb.needed(NOW + 1000, 4).includes(sol(0)), false);
  is('cold before stale: nobody without a record waits behind a refresh', kb.needed(NOW + HIST_TTL + 1, 1), [sol(1)]);
  kb.failed(sol(1), NOW);
  is('a failed KOL waits a quarter of an hour', kb.needed(NOW + 60_000, 4).includes(sol(1)), false);
  kb.failed(sol(2), NOW, 429);
  is('a 429 pauses every read', kb.needed(NOW + 60_000, 4), []);

  const b = kb.board('all');
  is('the board keeps pump.fun’s order', b.rows.map(r => r.rank), [1, 2, 3, 4]);
  is('followers and handle joined', [b.rows[0].followers, b.rows[0].xh], [118253, 'chairman']);
  is('the record joined', [b.rows[0].n, b.rows[0].medPeak, b.rows[0].medNow], [1, 3, 1.2]);
  is('no record yet is null, not zero', [b.rows[1].medNow, b.rows[1].followers], [null, null]);
  near('paid per payout', b.rows[0].perPayout, 300000 / 60);
  is('a period with no board yet falls back to all-time', kb.board('1w').rows.length, 4);

  const back = KolBook.from(JSON.parse(JSON.stringify(kb.toJSON())));
  is('a saved book reads back', [back.board('all').rows[0].followers, back.people.size], [118253, 4]);
}

console.log('\nthe tick');
{
  const asked = [];
  const http = (fail = {}) => ({ get: async url => {
    asked.push(url);
    for (const [frag, status] of Object.entries(fail)) if (url.includes(frag)) { const e = new Error(String(status)); e.status = status; throw e; }
    if (url.startsWith(PAYOUTS)) return { entries: Array.from({ length: 40 }, (_, i) => entry(i)), totalEarners: 500 };
    if (url.includes('/callout/list/')) return { callouts: [{ marketCap: 2e5, maxMultiplier: 2.2, multiple: 0.8 }] };
    if (url.includes('/users/')) return { followers: 1000 };
    return {};
  } });

  const kb = new KolBook();
  let out = await pollKols(kb, NOW, http());
  is('the first tick reads all four boards', asked.filter(u => u.startsWith(PAYOUTS)).length, Object.keys(KOL_PERIODS).length);
  ok('each period asked by name', asked.some(u => u.includes('period=1w')) && !asked[0].includes('period=') ? '' : 'missing');
  is('a board tick reads only the slow number of KOLs', out.people, KOL_PER_TICK);
  ok('a board tick stays inside its budget', asked.length <= 4 + 2 * KOL_PER_TICK ? `${asked.length} requests` : (no('budget', asked.length), ''));
  asked.length = 0;
  out = await pollKols(kb, NOW + 30_000, http());
  is('the boards wait half an hour', asked.filter(u => u.startsWith(PAYOUTS)).length, 0);
  is('a cold book warms faster', out.people, KOL_WARM);
  is('two requests per KOL: record and profile', asked.length, 2 * KOL_WARM);
  ok('record from the list endpoint', asked.includes(listUrl(sol(KOL_PER_TICK))) ? '' : 'missing');
  ok('followers from the profile endpoint', asked.includes(userUrl(sol(KOL_PER_TICK))) ? '' : 'missing');
  asked.length = 0;
  out = await pollKols(kb, NOW + 60_000, http({ '/callout/list/': 429 }));
  is('a 429 stops the tick at once', asked.length, 1);
  is('and backs off', kb.needed(NOW + 90_000, 3), []);
  asked.length = 0;
  await pollKols(kb, NOW + PAY_EVERY + 1, http({ [PAYOUTS]: 429 }));
  is('a refused board read stops at the first of the four', asked.filter(u => u.startsWith(PAYOUTS)).length, 1);

  const kb2 = new KolBook();
  await pollKols(kb2, NOW, http({ 'period=1d': 500 }));
  is('one board failing keeps the others', Object.keys(kb2.boards).sort(), ['1m', '1w', 'all']);
}

console.log('\nthe dev wrapper');
{
  const seen = [];
  const callers = async (op, b) => { seen.push(op); return { ok: true, from: 'callers' }; };
  const fn = withKols(callers, { get: async () => ({ entries: [entry(0)] }) });
  const r = await fn('kols', { period: 'nope' });
  is('an unknown period reads all-time', r.period, 'all');
  is('other ops go to the callers', (await fn('board')).from, 'callers');
  await fn('tick');
  is('a tick reaches the callers too', seen.includes('tick'), true);
  is('and fills the board', (await fn('kols', { period: 'all' })).rows.length, 1);
}

console.log('\nwhat the board adds up to');
{
  /* ten KOLs: pay rises as what holders kept falls */
  const rows = Array.from({ length: 10 }, (_, i) => ({ wallet: sol(100 + i), paid: (10 - i) * 1000, n: 50,
    medNow: 0.05 + i * 0.1, hit2: 0.7 - i * 0.03, histAt: NOW - i * 3600_000 }));
  const s = boardSummary(rows);
  is('paid is the sum', s.paid, 55000);
  is('the top ten is everyone here', s.top10Share, 1);
  is('every row has a record', s.withRecord, 10);
  near('holders down more than half: medNow under 0.5', s.holdersDownHalf, 0.5);
  near('holders down more than 80%: medNow under 0.2', s.holdersDown80, 0.2);
  near('pay against what holders kept: perfectly opposed', s.payVsHoldNow, -1);
  near('pay with the 2× rate: perfectly together', s.payVsHit2, 1);
  is('the records span what was read', s.recordsTo - s.recordsFrom, 9 * 3600_000);
  is('a short record is not a record', boardSummary([{ paid: 10, n: 3, medNow: 1 }]).withRecord, 0);
  is('nothing to correlate with under five', spearman([1, 2], [2, 1]), null);
  near('ties are averaged', spearman([1, 1, 2, 3, 4], [1, 1, 2, 3, 4]), 1);
}

console.log('\nKOLs who also bank trading');
{
  const W1 = sol(200), W2 = sol(201);
  const trading = new Map([[W2, { weekly: { rank: 4, realized: 12_000, at: NOW }, daily: { rank: 0 } }]]);
  const t = tradingOf(trading, { wallet: W1, wallets: [W1, W2] });
  is('found under the row’s second wallet', t && t.weekly.rank, 4);
  is('a zero rank is no rank', t && t.daily, undefined);
  is('nobody on the boards is null', tradingOf(trading, { wallet: sol(202), wallets: [] }), null);
  const e = { rank: 1, username: 'two', walletAddress: '0x' + 'a'.repeat(40), wallets: ['0x' + 'a'.repeat(40), W1, W2], totalPaidUsdc: 5, payoutCount: 1 };
  const r = shapePayout(e);
  is('a payout row keeps every Solana wallet', JSON.stringify(r.wallets), JSON.stringify([W1, W2]));
  const kb = new KolBook();
  kb.applyPayouts('all', { entries: [e] }, NOW);
  is('every paid wallet is known', [...paidWallets(kb)].sort().join(), [W1, W2].sort().join());
  const b = kb.board('all', trading);
  is('the board carries the trading join', b.rows[0].trading && b.rows[0].trading.weekly.realized, 12_000);
  is('…and its summary', b.summary && b.summary.alsoTraders, 1);
  is('a window with no board says it served all-time', kb.board('1w').period, 'all');
  is('…and the window it has, it names', kb.board('all').period, 'all');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
