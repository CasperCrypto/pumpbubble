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

console.log('\nwho is on the list, for the console');
{
  const a = new Audience(memoryStorage());
  await a.add(30, 'start', { name: 'Ann', user: 'ann_trades' });
  await a.add(10, 'v', { name: 'Bob‮ evil', user: 'no spaces allowed' });
  await a.add(20, 'chat');
  const fresh = await a.list({ newest: true });
  is('the newest come first', fresh.rows.map(r => r.id).join(','), '20,10,30');
  is('a name is kept with the record', fresh.rows[2].name + ' @' + fresh.rows[2].user, 'Ann @ann_trades');
  is('a direction override is stripped from a name', fresh.rows[1].name, 'Bob evil');
  is('a username that is not a Telegram handle is not kept', fresh.rows[1].user, undefined);
  is('where they came from is kept', fresh.rows[1].src, 'v');
  await a.add(20, 'start', { name: 'Cy', user: 'cy_' + 'x'.repeat(3) });
  is('somebody who started before names were kept gets one on their next message', (await a.list({ newest: true })).rows[0].name, 'Cy');
  is('a repeat Start still adds nobody', await a.count(), 3);
  is('the id-ordered page', (await a.list({ limit: 2 })).rows.map(r => r.id).join(','), '10,20');
  is('and the page after it', (await a.list({ limit: 2, after: '20' })).rows.map(r => r.id).join(','), '30');
  is('a full page says where the next starts', (await a.list({ limit: 2 })).next, '20');
  await a.remove(10);
  is('someone who left is not listed', (await a.list({ newest: true })).rows.map(r => r.id).join(','), '20,30');
}

console.log('\ngroups the bot met');
{
  const a = new Audience(memoryStorage());
  is('a private chat is not a group', (await a.seenGroup({ id: 42, title: 'me' })).ok, false);
  await a.seenGroup({ id: -1001, title: 'Pons Army', username: 'ponsarmy', type: 'supergroup', status: 'administrator', by: 7, byName: 'Ann', byUser: 'ann_trades' });
  await new Promise(r => setTimeout(r, 5));
  await a.seenGroup({ id: -1002, title: 'Quiet one', type: 'group', status: 'member', by: 8 });
  const g = await a.groups();
  is('both are remembered, newest first', g.map(x => x.id).join(','), '-1002,-1001');
  is('with who added the bot', g[1].byUser, 'ann_trades');
  await a.seenGroup({ id: -1001, status: 'left' });
  const left = (await a.groups()).find(x => x.id === -1001);
  is('a removal keeps the record, marked', left.status + ' ' + (left.leftAt > 0), 'left true');
  is('and keeps who added it and its name', left.byUser + ' ' + left.title, 'ann_trades Pons Army');
  await a.seenGroup({ id: -1001, title: 'Pons Army', status: 'member', by: 9 });
  const back = (await a.groups()).find(x => x.id === -1001);
  is('added again: a new date and nobody marked as gone', (back.leftAt === 0) + ' ' + back.by, 'true 9');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
