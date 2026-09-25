/* ==========================================================================
   The bot's list and the mass DM.

       node scripts/audience.test.mjs

   The list counts each person once, forgets anyone who unsubscribes or
   blocks the bot, and a send walks the whole list in batches — resuming
   where it stopped, never twice to the same person, one send at a time.
   The sponsored DM carries only the token and is marked as sponsored.
   ========================================================================== */

import { Audience, memoryStorage, BATCH, sponsoredDm } from '../src/audience.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

console.log('\nthe list');
{
  const a = new Audience(memoryStorage());
  await a.add(5, 'start'); await a.add(5, 'shop'); await a.add(7, 'v');
  is('each person counts once', await a.count(), 2);
  is('a repeat Start writes nothing', (await a.add(7)).added, false);
  await a.remove(5);
  is('unsubscribe removes them', await a.count(), 1);
  is('removing twice is harmless', (await a.remove(5)).removed, false);
  is('nonsense ids are refused', (await a.add('x')).ok, false);
}

console.log('\nthe send');
{
  const a = new Audience(memoryStorage());
  const N = BATCH * 2 + 7;
  for (let i = 1; i <= N; i++) await a.add(i);
  is('an empty message is refused', (await a.start({ html: '  ' })).ok, false);
  const started = await a.start({ html: 'hi', buttons: [] });
  is('a send starts', started.ok, true);
  is('only one send at a time', (await a.start({ html: 'again' })).ok, false);
  const got = [];
  const send = async id => { got.push(id); return id === 3 ? 'gone' : id === 4 ? 'fail' : 'ok'; };
  let ticks = 0, r;
  do { r = await a.step(send); ticks++; } while (r.more && ticks < 10);
  is('everyone got it', got.length, N);
  is('nobody got it twice', new Set(got).size, N);
  is('in batches', ticks, 3);
  const j = await a.job();
  is('the job is done', j.status, 'done');
  is('sent is counted', j.sent, N - 2);
  is('a blocked account is counted and forgotten', j.gone === 1 && (await a.count()) === N - 1, true);
  is('a failure is counted, not forgotten', j.failed, 1);
  is('a finished send allows the next', (await a.start({ html: 'next' })).ok, true);
  await a.cancel();
  is('cancel stops it', (await a.job()).status, 'cancelled');
  is('a cancelled send does no more', (await a.step(send)).more, false);
}

console.log('\nthe fan-out queue');
{
  const a = new Audience(memoryStorage());
  for (let i = 1; i <= 30; i++) await a.add(i);
  const uids = Array.from({ length: BATCH + 5 }, (_, i) => i + 1);
  is('a message for many is queued, not sent inline', (await a.enqueue({ uids: [...uids, 3], html: 'entry' })).queued, uids.length);
  const got = [];
  const send = async (id, html) => { got.push(id + ':' + html); return id === 2 ? 'gone' : 'ok'; };
  let r = await a.drain(send);
  is('one batch per tick', got.length, BATCH);
  is('more to come', r.more, true);
  r = await a.drain(send);
  is('everyone once', got.length, uids.length);
  is('the queue empties', r.more, false);
  is('a blocked account is forgotten', await a.count(), 29);
  is('nothing to queue is refused', (await a.enqueue({ uids: [], html: 'x' })).ok, false);
}

console.log('\nsponsored');
{
  const { html, buttons } = sponsoredDm({ title: '$<b>X</b>', name: '<script>' }, { chart: 'https://dexscreener.com/solana/x', bubble: 'https://pumpbubble.fun/s/x' });
  is('marked as sponsored', html.startsWith('📣 <b>Sponsored</b>'), true);
  is('the token’s strings are escaped', html.includes('<script>') || html.includes('$<b>X</b>'), false);
  is('buttons go to the token’s own pages', buttons[0].map(b => b.url).join(' '), 'https://dexscreener.com/solana/x https://pumpbubble.fun/s/x');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
