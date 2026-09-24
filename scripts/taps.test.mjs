/* ==========================================================================
   Tap wars — the arena's rules.

       node scripts/taps.test.mjs

   What is pinned here is the contract the tab makes with a community: taps
   decay by halves, thresholds are floors and rank decides, being out-tapped
   loses the slot and says so, and one address cannot out-tap a crowd.
   ========================================================================== */

import { Arena, decayed, HALF_LIFE_MS, AD_MIN, GOLD_MIN, AD_SLOTS, GOLD_SLOTS, KEEP,
         TAP_MAX_PER_REQ, IP_PER_10S, IP_PER_DAY, ADD_PER_IP_DAY, MAX_TOKENS } from '../src/taps.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const T0 = 1_800_000_000_000;
const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const MINT = i => 'M' + B58[i % 50] + B58[Math.floor(i / 50) % 50] + 'x'.repeat(29) + 'pump';   // 36 base58 chars
const tok = (i, o = {}) => ({ mint: MINT(i), chain: 'solana', sym: 'T' + i, name: 'Token ' + i, img: '', mcap: 1000 * i, ...o });

/* Tap `n` from as many addresses as it takes, so per-IP caps do not get in
   the way of testing the ranking. */
function crowd(a, key, n, now, seed = 0) {
  let left = n, ipn = seed;
  while (left > 0) {
    const ip = '10.0.' + Math.floor(ipn / 250) + '.' + (ipn % 250);
    const r = a.tap(key, Math.min(TAP_MAX_PER_REQ, left), ip, now);
    if (!r.ok) throw new Error(r.error);
    left -= r.counted;
    if (r.counted < Math.min(TAP_MAX_PER_REQ, left + r.counted)) ipn++;
  }
}

console.log('\ndecay');
{
  is('a score halves after one half-life', decayed(1000, T0, T0 + HALF_LIFE_MS), 500);
  is('quarters after two', decayed(1000, T0, T0 + 2 * HALF_LIFE_MS), 250);
  is('nothing decays before it is written', decayed(1000, T0, T0 - 5000), 1000);
  is('zero stays zero', decayed(0, T0, T0 + 1), 0);
}

console.log('\nadd');
{
  const a = new Arena();
  const r = a.add(tok(1), '1.1.1.1', T0);
  is('adds a resolved token', r.ok && r.row.sym, 'T1');
  is('starts at zero taps', r.row.taps, 0);
  is('adding it again returns the row, not an error', a.add(tok(1), '2.2.2.2', T0).existed, true);
  is('refuses junk', a.add({ mint: 'nope' }, '1.1.1.1', T0).ok, false);
  is('refuses nothing', a.add(null, '1.1.1.1', T0).ok, false);
  for (let i = 2; i <= ADD_PER_IP_DAY; i++) a.add(tok(i), '1.1.1.1', T0);
  is('one address adds ' + ADD_PER_IP_DAY + ' a day', a.add(tok(99), '1.1.1.1', T0).ok, false);
  is('…and is fine the next day', a.add(tok(99), '1.1.1.1', T0 + 864e5 + 1).ok, true);
  const evm = a.add({ addr: '0x181f9463b85c8d40ce9ed4eb64b42fdde7824ff5', chain: 'robinhood', sym: 'FN', name: 'Factory New' }, '3.3.3.3', T0);
  is('an EVM contract keys by address', evm.key, '0x181f9463b85c8d40ce9ed4eb64b42fdde7824ff5');
}

console.log('\ntap — caps');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  const k = MINT(1);
  is('a batch is capped at ' + TAP_MAX_PER_REQ, a.tap(k, 500, '9.9.9.9', T0).counted, TAP_MAX_PER_REQ);
  is('…and the page is told', a.tap(k, 500, '9.9.9.8', T0).limited, true);
  is('zero taps is refused', a.tap(k, 0, '9.9.9.9', T0).ok, false);
  is('an unknown token is refused', a.tap(MINT(77), 5, '9.9.9.9', T0).ok, false);
  /* ten-second window */
  let got = 0;
  for (let i = 0; i < 10; i++) got += a.tap(k, 50, '5.5.5.5', T0 + i * 100).counted;
  is('one address gets ' + IP_PER_10S + ' in ten seconds', got, IP_PER_10S);
  is('…then nothing', a.tap(k, 10, '5.5.5.5', T0 + 2000).counted, 0);
  is('…until the window moves', a.tap(k, 10, '5.5.5.5', T0 + 10_001).counted, 10);
  /* day */
  const b = new Arena();
  b.add(tok(1), '1.1.1.1', T0);
  let day = 0;
  for (let i = 0; i < 40; i++) day += b.tap(k, 50, '6.6.6.6', T0 + i * 11_000).counted;
  is('one address gets ' + IP_PER_DAY + ' a day', day, IP_PER_DAY);
  is('…and the reply says what is left', b.tap(k, 1, '6.6.6.6', T0 + 40 * 11_000).left, 0);
  is('…another address is unaffected', b.tap(k, 10, '7.7.7.7', T0 + 40 * 11_000).counted, 10);
}

console.log('\nrank and awards');
{
  const a = new Arena();
  for (let i = 1; i <= 8; i++) a.add(tok(i), '1.1.1.' + i, T0);
  crowd(a, MINT(1), AD_MIN - 1, T0, 100);
  let st = a.state(T0);
  is('999 taps wins nothing', st.tokens[0].award, '');
  crowd(a, MINT(1), 1, T0, 200);
  st = a.state(T0);
  is('1000 taps and first: a rail slot', st.tokens[0].award, 'ad');
  is('…recorded as an event', st.events[0].kind + ':' + st.events[0].sym, 'ad:T1');
  crowd(a, MINT(2), GOLD_MIN, T0, 300);
  st = a.state(T0);
  is('5000 taps: gold', st.tokens[0].sym + ':' + st.tokens[0].award, 'T2:gold');
  is('the 1000-tap token still has its rail slot', st.tokens[1].award, 'ad');
  is('gold holders do not also take a rail slot', st.ad.some(r => r.key === MINT(2)), false);
  /* fill gold */
  crowd(a, MINT(3), GOLD_MIN + 10, T0, 400);
  crowd(a, MINT(4), GOLD_MIN + 20, T0, 500);
  crowd(a, MINT(5), GOLD_MIN + 30, T0, 600);
  st = a.state(T0);
  is('only ' + GOLD_SLOTS + ' golds', st.gold.length, GOLD_SLOTS);
  is('the fourth 5000+ token falls to a rail slot', st.tokens[3].sym + ':' + st.tokens[3].award, 'T2:ad');
  is('rail slots are ' + AD_SLOTS, st.ad.length, AD_SLOTS);
  is('…held by the next two: T2 and T1', st.ad.map(r => r.sym).join(','), 'T2,T1');
  crowd(a, MINT(7), AD_MIN + 5, T0, 650);
  st = a.state(T0);
  is('T1 is pushed out of the rail by a bigger tapper', st.tokens.find(r => r.sym === 'T1').award, '');
  is('…T7 has the slot', st.ad.map(r => r.sym).join(','), 'T2,T7');
  is('…and the loss is an event', st.events.some(e => e.kind === 'lost' && e.sym === 'T1'), true);
  is('…naming who took it', st.events.find(e => e.kind === 'ad' && e.sym === 'T7').from, 'T1');
  /* outbid gold */
  crowd(a, MINT(6), GOLD_MIN + 100, T0, 700);
  st = a.state(T0);
  const flip = st.events.find(e => e.kind === 'gold' && e.sym === 'T6');
  is('a bigger tapper takes gold', st.tokens[0].sym, 'T6');
  is('…and the event names who lost it', flip && flip.from, 'T3');
  is('rank is 1-based in tap order', st.tokens.map(r => r.rank).join(','), '1,2,3,4,5,6,7,8');
  is('held-since is set for holders', st.tokens[0].goldSince > 0, true);
  is('…and zero for the rest', st.tokens[7].goldSince, 0);
}

console.log('\ndecay in the arena');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  crowd(a, MINT(1), GOLD_MIN, T0, 100);
  is('gold today', a.state(T0).tokens[0].award, 'gold');
  is('half the taps tomorrow', a.state(T0 + HALF_LIFE_MS).tokens[0].taps, GOLD_MIN / 2);
  is('…so a rail slot, not gold', a.state(T0 + HALF_LIFE_MS).tokens[0].award, 'ad');
  const r = a.tap(MINT(1), 10, '2.2.2.2', T0 + HALF_LIFE_MS);
  is('a tap after decay adds to the decayed score', r.score, GOLD_MIN / 2 + 10);
  /* the 24-hour rule: nobody tapped it for a day, so it has left the arena */
  is('…and gone once nobody tapped it for a day', a.state(T0 + 3 * HALF_LIFE_MS).tokens.length, 0);
}

console.log('\nkeeping a slot');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  a.add(tok(2), '1.1.1.2', T0);
  crowd(a, MINT(1), AD_MIN, T0, 100);
  is('won at the floor', a.state(T0).tokens[0].award, 'ad');
  /* a few minutes of decay takes it under 1,000 */
  const later = T0 + 10 * 60_000;
  is('…and kept just under it', a.state(later).tokens[0].award, 'ad');
  is('…no stutter in the event feed', a.state(later).events.filter(e => e.kind === 'lost').length, 0);
  const gone = T0 + HALF_LIFE_MS * 0.3;   // ~81% of the floor
  is('lost under ' + Math.round(KEEP * 100) + '% of the floor', a.state(gone).tokens[0].award, '');
  /* a bigger tapper still takes it at any count */
  const b = new Arena();
  b.add(tok(1), '1.1.1.1', T0); b.add(tok(2), '1.1.1.2', T0); b.add(tok(3), '1.1.1.3', T0);
  crowd(b, MINT(1), AD_MIN, T0, 100);
  b.state(T0);
  crowd(b, MINT(2), AD_MIN + 1, T0 + 60_000, 300);
  crowd(b, MINT(3), AD_MIN + 2, T0 + 60_000, 500);
  is('out-tapped by two, the holder is out', b.state(T0 + 60_000).tokens.find(r => r.sym === 'T1').award, '');
}

console.log('\nfull arena');
{
  const a = new Arena();
  for (let i = 0; i < MAX_TOKENS; i++) a.add(tok(i), '1.1.' + Math.floor(i / 4) + '.1', T0);
  is('full', a.state(T0).n, MAX_TOKENS);
  is('one more is refused while everything is fresh', a.add(tok(999), '8.8.8.8', T0).ok, false);
  crowd(a, MINT(3), 100, T0 + 3 * 864e5, 100);          // one token still alive
  const r = a.add(tok(999), '8.8.8.8', T0 + 3 * 864e5);
  is('three days later the idle ones make room', r.ok, true);
  is('…and the tapped one survived', !!a.tokens[MINT(3)], true);
}

console.log('\nround trip');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  crowd(a, MINT(1), 1234, T0, 100);
  a.state(T0);
  const b = Arena.from(JSON.parse(JSON.stringify(a.toJSON())));
  is('taps survive serialisation', b.state(T0).tokens[0].taps, 1234);
  is('awards survive serialisation', b.state(T0).tokens[0].award, 'ad');
  is('events survive serialisation', b.state(T0).events.length, 1);
}

console.log('\nthe 24-hour rule');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  a.add(tok(2), '1.1.1.2', T0);
  crowd(a, MINT(1), GOLD_MIN, T0, 100);
  is('a token tapped within the day stays', a.state(T0 + 20 * 36e5).tokens.some(r => r.sym === 'T1'), true);
  is('a token added and never tapped leaves after a day', a.state(T0 + 25 * 36e5).tokens.some(r => r.sym === 'T2'), false);
  is('…and so does gold nobody defends', a.state(T0 + 25 * 36e5).tokens.some(r => r.sym === 'T1'), false);
  is('…and says so in the feed', a.state(T0 + 25 * 36e5).events.some(e => e.kind === 'expired' && e.sym === 'T1'), true);

  const b = new Arena();
  b.add(tok(3), '1.1.1.3', T0);
  crowd(b, MINT(3), 50, T0, 100);
  crowd(b, MINT(3), 50, T0 + 23 * 36e5, 300);
  is('a tap resets the clock', b.state(T0 + 40 * 36e5).tokens.length, 1);

  const c = new Arena();
  is('the hours are the operator’s', c.config({ idleHours: 72 }).ok, true);
  c.add(tok(4), '1.1.1.4', T0);
  is('…a longer window keeps an idle token', c.state(T0 + 48 * 36e5).tokens.length, 1);
  is('…and nonsense is refused', c.config({ idleHours: 0 }).ok, false);
  is('…survives serialisation', Arena.from(JSON.parse(JSON.stringify(c.toJSON()))).cfg.idleHours, 72);
}

console.log('\nthe console');
{
  const a = new Arena();
  a.add(tok(1), '1.1.1.1', T0);
  crowd(a, MINT(1), AD_MIN + 10, T0, 100);
  is('reset takes the taps to zero', (a.reset(MINT(1), T0), a.state(T0).tokens[0].taps), 0);
  is('…and the slot with them', a.state(T0).tokens[0].award, '');
  is('remove takes it out', (a.remove(MINT(1)), a.state(T0).tokens.length), 0);
  is('removing what is not there says so', a.remove(MINT(9)).ok, false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
