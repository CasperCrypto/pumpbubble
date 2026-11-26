/* ==========================================================================
   Trader lookup: trading against callout rewards, for any pump.fun account.

       node scripts/traderlookup.test.mjs

   Pinned with a fake pump.fun shaped like the real answers (2026-11-26):

     - a username finds people, an exact match first, an @ is ignored;
     - only the same window is compared — 7 and 30 days, and all time —
       never a day, whose payout round has not paid yet;
     - losing money trading while paid for calls reads "callouts";
     - a side pump.fun did not answer is null, never zero, never a verdict;
     - a Cloudflare challenge fails the lookup as a refusal, nothing invented.
   ========================================================================== */

import {
  searchPeople, lookupTrader, shapeTrading, shapeCallouts, compare, verdict, headline,
  cleanQuery, _clearTraderCache, defaultHttp,
} from '../src/traderlookup.mjs';
import { _resetPumpGate } from '../src/pumpgate.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const NET = 'HmUt3Jn46j7c7ANdURmEyjSRj8i3Em6MhjQUi37PZ219';
const SLING = '5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij';
const person = (w, name, followers, x = null) => ({ address: w, canonical_svm_wallet: w, username: name, followers, x_username: x, kind: 'person', is_banned: false, profile_image: 'https://socialimages.pump.fun/p/' + name });
const win = (realized, unrealized, total, spend, from = 1782864000) => ({
  from, pnl: { usd: total }, realizedPnl: { usd: realized }, unrealizedPnl: { usd: unrealized }, totalBuySpend: { usd: spend },
});
const calls = (paid1, paid2, n, extra = {}) => ({ totalCallouts: n, twoXPercent: 39, medianMultiple: 1.65, averageMultiple: 4.18,
  paidV1Usd: paid1, paidV2Usd: paid2, tailCohort24h: 5886, tailPnl24hUsd: -16253.26, tailUniqueBuyers: 4195, tailVolumeUsd: 202879, ...extra });

const ANSWERS = {
  [`/users/search-v2`]: [person('FmbNoEBzUv3LWRTfKRBtowovv8onYqBr7hphiv3nGSFL', 'dingoorio', 1162), person(SLING, 'slingoor', 225274),
    { ...person('5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzia', 'squad', 1), kind: 'group' }],
  [`/users/${NET}`]: person(NET, 'netvyxe', 36430, 'netvyxe'),
  [`/users/${SLING}`]: person(SLING, 'slingoor', 225274),
  [`/portfolio-summary?user=${NET}`]: { windows: { '1d': win(374, 384, 599, 2710), '1w': win(56, -309, 10583, 11905), '1m': win(-12913, -2755, 960, 219003), all: win(155369, -7544, 164453, 1052424) } },
  [`/portfolio-summary?user=${SLING}`]: { windows: { '1d': win(2018, 58399, 60417, 23392), '1w': win(-10252, 56084, 45832, 203539), '1m': win(-8709124, 20487, -8688637, 2819355), all: win(-2455561, 30509, -2425052, 14702467) } },
  [`/users/${NET}/callout-stats`]: { daily: calls(null, null, 7), weekly: calls(415.12, 18.64, 31), monthly: calls(22037.19, 50.72, 238), allTime: calls(108572.54, 50.72, 1253), lastRound: { ...calls(110.32, 8.66, 7), startsAt: '2026-11-24T20:21:04.833Z', endsAt: '2026-11-25T18:45:58.866Z' } },
  [`/users/${SLING}/callout-stats`]: { daily: calls(null, null, 17), weekly: calls(215.1, 0.65, 70), monthly: calls(222691.07, 772.94, 317), allTime: calls(643005.88, 772.94, 1728) },
};
let mode = 'ok', calls_ = 0;
const http = {
  async get(url) {
    calls_++;
    const path = url.replace('https://frontend-api-v3.pump.fun', '');
    if (mode === 'challenge') throw Object.assign(new Error('pump.fun refuses servers'), { status: 403, challenge: true });
    if (mode === 'nosummary' && path.startsWith('/portfolio-summary')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    /* longest first: /users/<w>/callout-stats must not answer as /users/<w> */
    const key = Object.keys(ANSWERS).sort((a, b) => b.length - a.length).find(k => path.startsWith(k));
    if (!key) throw Object.assign(new Error('404'), { status: 404 });
    return ANSWERS[key];
  },
};

console.log('\nsearch');
{
  is('a leading @ is dropped', cleanQuery('@netvyxe'), 'netvyxe');
  is('one letter is not a search', cleanQuery('a'), '');
  is('markup is not a username', cleanQuery('<img src=x>'), 'imgsrcx');
  _clearTraderCache();
  const p = await searchPeople('slingoor', http);
  is('an exact username leads, ahead of pump.fun\'s order', p[0] && p[0].name, 'slingoor');
  is('squads are not people', p.some(x => x.name === 'squad'), false);
  is('followers carried', p[0].followers, 225274);
  const n0 = calls_;
  await searchPeople('slingoor', http);
  is('asked again within five minutes: no second request', calls_, n0);
  const w = await searchPeople(NET, http);
  is('a wallet resolves to its own profile', w[0] && w[0].name, 'netvyxe');
  const unknown = await searchPeople('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', http);
  is('a wallet with no profile is still offered, by address', unknown.length === 1 && unknown[0].hasName, false);
}

console.log('\nverdict');
{
  is('lost trading, paid for calls: callouts', verdict(-2455561, 643779), 'callouts');
  is('banked more trading than paid: trading', verdict(155369, 108623), 'trading');
  is('paid more than banked: callouts', verdict(56, 434), 'callouts');
  is('nothing either way: neither', verdict(-50, 0), 'neither');
  is('trading unknown: no verdict', verdict(null, 100), null);
  is('rewards unknown: no verdict', verdict(100, null), null);
}

console.log('\nlookup');
{
  _clearTraderCache(); mode = 'ok';
  const r = await lookupTrader(NET, http);
  is('all time: netvyxe banked more trading', r.compare.all.more, 'trading');
  is('the rewards are both pots', Math.round(r.compare.all.paid * 100) / 100, 108623.26);
  is('30 days: lost trading, paid for calls', r.compare.m1.more, 'callouts');
  is('a day is never compared', 'd1' in r.compare, false);
  is('but its trading is shown', r.trading.d1.realized, 374);
  is('and its unpaid round is null, not 0', r.callouts.d1.paid, null);
  is('what followers made, from pump.fun', r.callouts.all.tailPnl24h, -16253.26);
  is('callout share of what was earned', Math.round(r.compare.all.calloutShare * 100), 41);
  ok('headline says it', r.headline && r.headline.text);
  const s = await lookupTrader(SLING, http);
  is('slingoor: callouts, all time', s.compare.all.more, 'callouts');
  is('net of both, all time', Math.round(s.compare.all.net), Math.round(-2455561 + 643005.88 + 772.94));
  is('headline says lost', /lost \$2,455,561 trading/.test(s.headline.text), true);
}

console.log('\nwhen a side does not answer');
{
  _clearTraderCache(); mode = 'nosummary';
  const r = await lookupTrader(NET, http);
  is('the deadline is named, so the page asks again', r.errors.trading, 'timeout');
  is('no trading figure is invented', r.trading, null);
  is('so no verdict either', r.compare.all.more, null);
  is('the rewards still show', Math.round(r.compare.all.paid), 108623);
  _clearTraderCache(); mode = 'challenge';
  let threw = null;
  try { await lookupTrader(NET, http); } catch (e) { threw = e; }
  is('a challenge fails the lookup as a refusal', !!(threw && threw.challenge), true);
  mode = 'ok';
}

console.log('\nshapes');
{
  is('no windows, no trading', shapeTrading({}), null);
  is('a callout-stats that failed open ({}) is no record', shapeCallouts({}), null);
  is('a barred user\'s rewards are null', shapeCallouts({ allTime: calls(null, null, 5) }).all.paid, null);
  const never = shapeCallouts({ weekly: calls(0, 0, 0), monthly: calls(0, 0, 0), allTime: calls(0, 0, 0) });
  is('never called: a measured $0, not no record', never && never.all.paid, 0);
  is('so a trader who never called reads trading', compare({ all: { realized: 5000 } }, never).all.more, 'trading');
  const c = compare(null, shapeCallouts({ allTime: calls(10, 0, 5) }));
  is('compare with no trading', c.all.more, null);
  is('no headline without a verdict', headline('x', c), null);
}

console.log('\nthe challenge gate');
{
  _resetPumpGate();
  const blocked = defaultHttp(async () => new Response('<html>Just a moment…</html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }));
  let e = null;
  try { await blocked.get('https://frontend-api-v3.pump.fun/users/x'); } catch (x) { e = x; }
  is('a real fetch through the gate reports the challenge', !!(e && e.challenge), true);
  _resetPumpGate();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
