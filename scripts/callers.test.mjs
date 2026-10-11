/* ==========================================================================
   Callers — who on pump.fun calls winners, measured.

       node scripts/callers.test.mjs

   What is pinned:
     - a feed row is a call only when it is the caller's own (not a quote),
       on Solana, with a real timestamp and addresses;
     - the same call seen again updates the market and the caller's
       position, never duplicates;
     - the newest-calls feed keeps only callers with a record;
     - "sold", "trimmed", "holding" read off the caller's own position;
     - the ranking is the 2× hit rate at the lower edge of its Wilson
       interval, so 3 for 3 does not beat 20 for 30, with a minimum sample;
     - an alert is sent once, only for a top caller, only while it is fresh;
     - one watcher tick stays far inside a Worker's fifty subrequests and
       stops asking the stats endpoint the moment it says 429.
   ========================================================================== */

import { CallerBook, shapeCall, shapeStats, holdStatus, nowMultiple, wilson, pollOnce,
  FEED, FEED_NEW, COINS, MIN_CALLS, KEEP_NEW_MIN_CALLS, ALERT_MAX_AGE, STATS_TTL } from '../src/callers.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const addr = (seed, tail = 'x') => (B58[seed % 50] + B58[Math.floor(seed / 50) % 50]).padEnd(40, tail) + 'pump';
const NOW = Date.parse('2026-09-30T12:00:00Z');
const row = ({ id = 'c1', mint = addr(1), wallet = addr(2, 'W'), sym = 'CAT', at = NOW - 60_000, kind = 'callout',
  chain = 'solana', mcapCall = 100_000, mcapNow = 150_000, mult = 1.5, peak = 2.1, held = 1000, heldUsd = 50, realized = 0,
  calls = 12, name = 'caller' } = {}) => ({
  coinMint: mint, coinName: sym + ' coin', symbol: sym, coinImage: 'https://ipfs.io/ipfs/Qm' + id, marketCap: mcapNow, chain,
  position: {
    userName: name, walletAddress: wallet, profileImage: 'https://pump.fun/a.png', xUsername: 'caller_x', isVerified: true,
    accountKind: 'person', totalCallouts: calls, amountHeld: held, valueUsd: heldUsd, pnlUsd: 20, realizedPnlUsd: realized,
    costBasisUsd: 30, contentKind: kind,
    callout: { calloutId: id, calledOutAtMcap: mcapCall, multiple: mult, maxMultiplier: peak, maxMultiplierAt: null,
      calloutTimestamp: new Date(at).toISOString(), thesis: 'next <b>100x</b>', viewCount: 900, likes: 4, replyCount: 2 },
  },
});
const stats = (n, twoX, med = 1.8) => ({
  daily: { totalCallouts: Math.min(n, 3), twoXPercent: twoX, onePointFiveXPercent: 70, averageMultiple: 3, medianMultiple: med, averageTimeToPeakMs: 3_600_000,
    distribution: [{ min: 1, max: 2, count: 1 }, { min: 5, max: 10, count: 2 }, { min: 20, max: null, count: 0 }] },
  weekly: { totalCallouts: n, twoXPercent: twoX, onePointFiveXPercent: 70, averageMultiple: 3, medianMultiple: med, averageTimeToPeakMs: 3_600_000,
    distribution: [{ min: 1, max: 2, count: 1 }, { min: 20, max: null, count: 1 }] },
  monthly: { totalCallouts: n * 3, twoXPercent: twoX, onePointFiveXPercent: 70, averageMultiple: 3, medianMultiple: med, averageTimeToPeakMs: 3_600_000, distribution: [] },
});

console.log('\nreading a feed row');
{
  const c = shapeCall(row(), NOW, 'feed');
  is('a call is read', c && c.id, 'c1');
  is('its thesis is cleaned of markup', /[<>]/.test(c.thesis), false);
  is('a quote is not a call of its own', shapeCall(row({ kind: 'quote' }), NOW), null);
  is('another chain is left out', shapeCall(row({ chain: 'bsc' }), NOW), null);
  is('a bad timestamp is left out', shapeCall({ ...row(), position: { ...row().position, callout: { ...row().position.callout, calloutTimestamp: 'soon' } } }, NOW), null);
  is('a bad mint is left out', shapeCall(row({ mint: 'not-a-mint' }), NOW), null);
  is('a follower who held has mcap now over mcap at the call', +nowMultiple(c).toFixed(2), 1.5);
  is('without a call-time mcap it falls back to pump.fun\'s multiple', nowMultiple({ mcapAtCall: 0, mcapNow: 5, multiple: 1.7 }), 1.7);
  is('holding', holdStatus(c), 'holding');
  is('nothing left is sold', holdStatus(shapeCall(row({ held: 0, heldUsd: 0 }), NOW)), 'sold');
  is('a dollar of dust is sold', holdStatus(shapeCall(row({ held: 10, heldUsd: 0.4 }), NOW)), 'sold');
  is('banked some and still in is trimmed', holdStatus(shapeCall(row({ realized: 120 }), NOW)), 'trimmed');
  const s = shapeStats(stats(20, 65));
  is('the 2× rate is a fraction', s.weekly.hit2, 0.65);
  is('the best bucket is named', s.weekly.best, '20×+');
  is('and a bounded one too', s.daily.best, '5–10×');
}

console.log('\nthe book');
{
  const b = new CallerBook();
  b.ingest({ coins: [row(), row({ id: 'c2', mint: addr(3) })] }, NOW, 'feed');
  is('two calls', b.calls.size, 2);
  b.ingest({ coins: [row({ mcapNow: 300_000, peak: 3.2, held: 0, heldUsd: 0 })] }, NOW + 60_000, 'feed');
  is('seen again, not duplicated', b.calls.size, 2);
  const c1 = b.calls.get('c1');
  is('the market moves', c1.mcapNow, 300_000);
  is('the peak only rises', c1.peak, 3.2);
  is('the caller\'s position moves', holdStatus(c1), 'sold');
  b.ingest({ coins: [row({ id: 'n1', wallet: addr(9, 'N'), calls: 1 })] }, NOW, 'new');
  is('a first-time caller from the new feed is not kept', b.calls.has('n1'), false);
  b.ingest({ coins: [row({ id: 'n2', wallet: addr(10, 'N'), calls: KEEP_NEW_MIN_CALLS })] }, NOW, 'new');
  is('one with a record is', b.calls.has('n2'), true);
  b.ingest({ coins: [row({ id: 'old', at: NOW - 80 * 3600_000 })] }, NOW, 'feed');
  is('a call older than three days is not kept', b.calls.has('old'), false);
  const back = CallerBook.from(JSON.parse(JSON.stringify(b.toJSON(NOW))));
  is('the book survives a save and a restart', back.calls.size, b.calls.size);
}

console.log('\nranking');
{
  is('3 for 3 has shown less than 20 for 30', wilson(3, 3) < wilson(20, 30), true);
  is('nothing from nothing', wilson(0, 0), 0);
  const b = new CallerBook();
  const A = addr(20, 'A'), Bw = addr(21, 'B'), C = addr(22, 'C'), D = addr(23, 'D');
  b.ingest({ coins: [row({ id: 'a', wallet: A, name: 'lucky' }), row({ id: 'b', wallet: Bw, name: 'steady' }),
    row({ id: 'c', wallet: C, name: 'thin' }), row({ id: 'd', wallet: D, name: 'dumper', held: 0, heldUsd: 0 })] }, NOW, 'feed');
  b.applyStats(A, stats(5, 100), NOW);      // 5 for 5
  b.applyStats(Bw, stats(40, 80), NOW);     // 32 for 40: more shown than 5 for 5
  b.applyStats(C, stats(MIN_CALLS.weekly - 1, 100), NOW);
  b.applyStats(D, stats(30, 50), NOW);
  const board = b.board('weekly', NOW);
  is('steady outranks lucky', board[0].name, 'steady');
  is('a caller under the minimum is not ranked', board.some(r => r.name === 'thin'), false);
  is('ranks are numbered', board.map(r => r.rank).join(','), '1,2,3');
  is('what the caller did with the call is on the row', board.find(r => r.name === 'dumper').recent.length, 1);
  const live = b.live(NOW);
  is('the live table carries the caller\'s rank', live.find(c => c.id === 'b').caller.rank, 1);
  is('and the caller\'s own position', live.find(c => c.id === 'd').status, 'sold');
  is('newest first', live[0].at >= live[live.length - 1].at, true);
  is('a caller without a record is not in the live table', live.some(c => c.id === 'c'), false);
  b.ingest({ coins: [row({ id: 'v', wallet: addr(24, 'V'), name: 'watched' })] }, NOW, 'feed');
  b.calls.get('v').views = 5000;
  is('unless enough people are already watching the call', b.live(NOW).some(c => c.id === 'v'), true);
}

console.log('\nalerts');
{
  const b = new CallerBook();
  const TOPW = addr(30, 'T'), LOW = addr(31, 'L');
  b.ingest({ coins: [row({ id: 't1', wallet: TOPW, at: NOW - 60_000 }), row({ id: 'l1', wallet: LOW, at: NOW - 60_000 }),
    row({ id: 't0', wallet: TOPW, at: NOW - ALERT_MAX_AGE - 60_000 })] }, NOW, 'feed');
  b.applyStats(TOPW, stats(30, 80), NOW);
  const first = b.alerts(NOW, 1);
  is('a fresh call from a top caller is an alert', first.map(a => a.call.id).join(','), 't1');
  is('it carries the caller\'s standing', first[0].caller.rank, 1);
  is('the same call is never alerted twice', b.alerts(NOW, 1).length, 0);
  is('a stale call was let go, not held back', b.alerted.has('t0'), true);
}

console.log('\nthe watcher');
{
  const b = new CallerBook();
  const W1 = addr(40, 'S');
  b.ingest({ coins: [row({ id: 's1', wallet: W1, calls: 30 })] }, NOW, 'feed');
  const asked = [];
  let statsAnswer = 'ok';
  const http = {
    get: async url => {
      asked.push(url);
      if (url === FEED_NEW) return { coins: [row({ id: 's2', wallet: W1, calls: 30 })] };
      if (url === FEED) return { coins: [] };
      if (url.includes('pnl-leaderboard')) return { entries: [{ walletAddress: addr(41, 'P'), username: 'banker', rank: 1, realizedPnlUsd: 50_000 }] };
      if (url.includes('callout-stats')) {
        if (statsAnswer === '429') { const e = new Error('429'); e.status = 429; throw e; }
        return stats(30, 60);
      }
      throw new Error('unexpected ' + url);
    },
    post: async (url, body) => { asked.push(url); return (body.mints || []).map(m => ({ mint: m, usd_market_cap: 999_999, symbol: 'X' })); },
  };
  let r = await pollOnce(b, NOW, http);
  is('tick 1 reads both feeds', asked.includes(FEED_NEW) && asked.includes(FEED), true);
  is('and seeds the PnL boards', b.callers.has(addr(41, 'P')), true);
  is('and fetches records', r.stats > 0, true);
  is('one tick is well inside fifty subrequests', asked.length <= 20, true);
  is('a board caller is asked for first', asked.find(u => u.includes('callout-stats')).includes(addr(41, 'P')), true);
  asked.length = 0;
  await pollOnce(b, NOW + 20_000, http);
  is('a minute has not passed: the ranked feed waits', asked.includes(FEED), false);
  is('the boards wait half an hour', asked.some(u => u.includes('pnl-leaderboard')), false);
  asked.length = 0;
  statsAnswer = '429';
  for (const p of b.callers.values()) p.statsAt = 0;
  r = await pollOnce(b, NOW + 60_000, http);
  is('a 429 stops the stats for the tick', asked.filter(u => u.includes('callout-stats')).length, 1);
  is('and for ten minutes after', b.needStats(NOW + 5 * 60_000).length, 0);
  is('a caller that failed is retried later, not never', b.callers.get(addr(41, 'P')).statsAt < NOW + 60_000, true);
  asked.length = 0;
  statsAnswer = 'ok';
  b.backoff = 0;
  await pollOnce(b, NOW + 10 * 60_000, http);
  is('market caps refresh every few minutes', asked.includes(COINS), true);
  is('which moves "now"', b.calls.get('s1').mcapNow, 999_999);
  is('the record expires hourly', b.needStats(NOW + 10 * 60_000 + STATS_TTL + 1).length > 0, true);
}

console.log('\nsaving — the object is recycled between ticks, so what is saved is all there is');
{
  const b = new CallerBook();
  b.due = { feed: NOW, board: NOW, coins: NOW - 5 };
  const back = CallerBook.from(JSON.parse(JSON.stringify(b.toJSON(NOW))));
  is('the schedule survives a save', JSON.stringify(back.due), JSON.stringify({ feed: NOW, board: NOW, coins: NOW - 5 }));
  is('an old save without a schedule still loads', CallerBook.from({ calls: [], callers: [] }).due, undefined);

  /* a full book: every call kept and every caller with a three-window record */
  const full = new CallerBook();
  const stats = { totalCallouts: 40, twoXPercent: 37.5, onePointFiveXPercent: 55, averageMultiple: 3.1, medianMultiple: 1.8,
    averageTimeToPeakMs: 3_600_000, distribution: [{ min: 1, max: 2, count: 20 }, { min: 2, max: 5, count: 15 }, { min: 20, max: null, count: 5 }] };
  for (let i = 0; i < 2500; i++) {
    const w = addr(i, String.fromCharCode(97 + (i % 26)));
    full.callers.set(w, { wallet: w + i, name: 'caller' + i, xh: 'handle' + i, avatar: 'https://pump.mypinata.cloud/ipfs/bafkreihurb5i3zehb33kbczkmhtzy53hbsrdvq4mtjxmlg3vzptxaslyiq',
      verified: true, calls: 77, seenAt: NOW - i * 1000, stats: i < 1800 ? shapeStats({ daily: stats, weekly: stats, monthly: stats }) : undefined,
      statsAt: NOW, board: i < 300 ? { weekly: { rank: i + 1, realized: 12345.67, at: NOW } } : undefined });
  }
  for (let i = 0; i < 1200; i++) {
    full.calls.set('c' + i, { id: 'c' + i, mint: addr(i, 'm'), sym: 'TOKEN' + i, name: 'A token with a long name ' + i,
      rawImg: 'https://ipfs.io/ipfs/bafybeibwqtgrrykgejgpyuc25daspisdfhqdbxklgkgcpxnu7yzwmi2fse', wallet: addr(i), at: NOW - i * 60_000,
      mcapAtCall: 35554, mcapNow: 59093.91, mcapAt: NOW, multiple: 1.6874, peak: 2.1944, peakAt: NOW, thesis: 'x'.repeat(180),
      views: 2827, likes: 6, replies: 2, held: 26733712.81, heldUsd: 1590.83, pnlUsd: 908.13, realizedUsd: 0, costUsd: 682.7, seenAt: NOW, src: 'feed' });
  }
  const saved = full.toJSON(NOW);
  const bytes = new TextEncoder().encode(JSON.stringify(saved)).length;
  ok('a full book fits one storage value (2 MB) with room to spare', bytes < 1.6 * 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : (no('size', bytes), ''));
  is('at most SAVE_CALLERS callers are written', saved.callers.length, 1000);
  ok('callers with a record are written first', saved.callers.every(p => p.stats || p.board) ? '' : (no('priority'), ''));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
