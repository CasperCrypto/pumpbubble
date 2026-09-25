/* ==========================================================================
   Paid ads and the bot's shop.

       node scripts/ads.test.mjs

   Ads ride the boost order machinery, so what needs its own test is what is
   new: the queue (a full slot sells tomorrow instead of refusing), activation
   (idempotent on the payment, lands in the list its slot is served from, the
   link is the token's own page), and the pending record keeping `kind` — the
   field whose absence swept closed-tab bids in as zero-hour boosts.
   ========================================================================== */

import { adSchedule, activateAd, addPending, listPending, createOrder, AD_TIERS, activateBoost } from '../src/boosts.mjs';
import { shopKeyboard } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const H = 3600e3, NOW = Date.now();
const memStore = () => { const m = new Map(); return { available: true, get: async k => m.has(k) ? JSON.parse(m.get(k)) : null, put: async (k, v) => { m.set(k, JSON.stringify(v)); } }; };
const MINT = '7V4vYUApSWg1CWBHSxaEWZ8irJAU4q8pPmpZS3mJpump';
const TREASURY = '6k8T4fXq5vt3asVnywaHgfw4ApRexGHupbUU8e3TsW1C';

console.log('\nqueue');
{
  is('an empty slot starts now', adSchedule([], NOW, 24 * H, 1), NOW);
  const one = [{ from: NOW - H, until: NOW + 5 * H }];
  is('a full single slot starts when the current ad ends', adSchedule(one, NOW, 24 * H, 1), NOW + 5 * H);
  is('with room for four, it starts now', adSchedule(one, NOW, 24 * H, 4), NOW);
  const chain = [{ from: NOW - H, until: NOW + 5 * H }, { from: NOW + 5 * H, until: NOW + 29 * H }];
  is('a queued ad is respected: the next starts after it', adSchedule(chain, NOW, 24 * H, 1), NOW + 29 * H);
  is('ended ads do not count', adSchedule([{ from: NOW - 48 * H, until: NOW - H }], NOW, 24 * H, 1), NOW);
}

console.log('\npermanent console ads');
{
  const four = [1, 2, 3, 4].map(i => ({ title: 'S' + i, until: 0 }));
  is('four ads "until removed" fill the rail', adSchedule(four, NOW, 24 * H, 4), Infinity);
  is('three leave a slot now', adSchedule(four.slice(1), NOW, 24 * H, 4), NOW);
  const store = memStore();
  await store.put('ads', four);
  const o = await createOrder({ mint: MINT, sym: 'POK', tierId: 'rail', kind: 'ad', solPrice: 150, treasury: TREASURY });
  const a = await activateAd(store, o, { signature: 'sx', received: 1 });
  is('paid anyway while full: it runs now rather than never', a.from <= Date.now() && Number.isFinite(a.until), true);
}

console.log('\nactivation');
{
  const store = memStore();
  const order = await createOrder({ mint: MINT, sym: 'POK', name: 'Pokmart', tierId: 'alert', kind: 'ad', solPrice: 150, treasury: TREASURY });
  is('an ad order is priced from its slot', order.usd, AD_TIERS.alert.usd);
  is('and lasts its hours', order.hours, 24);
  is('an ad has no size', order.mult, 0);
  let threw = false;
  try { await createOrder({ mint: MINT, tierId: 'whale', kind: 'ad', solPrice: 150, treasury: TREASURY }); } catch { threw = true; }
  is('a boost tier is not an ad slot', threw, true);
  order.notify = 42;
  await addPending(store, order);
  const pend = (await listPending(store))[0];
  is('the pending record keeps its kind', pend.kind, 'ad');
  is('and who to tell', pend.notify, 42);
  const pay = { signature: 'sig1', received: order.amountSol, payer: 'W' };
  const a = await activateBoost(store, pend, pay);
  is('activation routes an ad to the ad list', a.kind, 'ad');
  is('the alert slot fills the alert list', ((await store.get('alertads')) || []).length, 1);
  is('the link is the token’s own page', a.url, 'https://pumpbubble.fun/s/' + MINT);
  is('the title is the ticker', a.title, '$POK');
  is('it notifies the buyer', a.notify, 42);
  await activateBoost(store, pend, pay);
  is('the same payment never buys two ads', ((await store.get('alertads')) || []).length, 1);
  const o2 = await createOrder({ mint: MINT, sym: 'POK', tierId: 'alert', kind: 'ad', solPrice: 150, treasury: TREASURY });
  const b = await activateAd(store, o2, { signature: 'sig2', received: 1 });
  is('a second alert ad queues behind the first', b.from, a.until);
  const evm = await createOrder({ mint: '0x' + 'ab'.repeat(20), chain: 'base', sym: 'B', tierId: 'rail', kind: 'ad', solPrice: 150, treasury: TREASURY });
  const r = await activateAd(store, evm, { signature: 'sig3', received: 1 });
  is('an EVM rail ad links to its chart', r.url, 'https://dexscreener.com/base/0x' + 'ab'.repeat(20));
  is('rail ads land in the rail list', ((await store.get('ads')) || []).length, 1);
}

console.log('\nthe DM blast');
{
  const store = memStore();
  const o = await createOrder({ mint: MINT, sym: 'POK', name: 'Pokmart', tierId: 'dm', kind: 'ad', solPrice: 150, treasury: TREASURY });
  is('a DM blast is priced from its tier', o.usd, AD_TIERS.dm.usd);
  const d = await activateAd(store, o, { signature: 's9', received: 1.3, payer: 'P' });
  is('a paid DM waits for review', d.status, 'review');
  is('in its own list', ((await store.get('dmads')) || []).length, 1);
  is('never in the alert line', ((await store.get('alertads')) || []).length, 0);
}

console.log('\nbids survive the sweep now');
{
  const store = memStore();
  await addPending(store, { id: 'ord_bid', kind: 'bid', mint: MINT, lamports: 1, createdAt: NOW, expiresAt: NOW + H });
  is('a pending bid is still a bid', (await listPending(store))[0].kind, 'bid');
}

console.log('\nshop buttons');
{
  const sol = shopKeyboard(MINT).flat(), evm = shopKeyboard('0x' + 'ab'.repeat(20)).flat();
  const enc = new TextEncoder();
  is('three boosts, two ad slots and the DM blast', sol.length, 6);
  is('every button fits Telegram’s 64 bytes, Solana', sol.every(b => enc.encode(b.callback_data).length <= 64), true);
  is('and EVM', evm.every(b => enc.encode(b.callback_data).length <= 64), true);
  is('ads first when asked for ads', shopKeyboard(MINT, 'ad')[0][0].callback_data.startsWith('buy:a:'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
