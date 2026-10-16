/* ==========================================================================
   The keys that must save, kept in a Durable Object (src/dostore.mjs).

       node scripts/dostore.test.mjs

   What is pinned:
     - the bot's keys and the ones money buys go to the object, the rest to KV;
     - a key the object has never been given is read from KV, so nothing had
       to be moved by hand;
     - once the object holds a key it is the truth, a deletion (null) included,
       and an expired one reads as null rather than KV's older copy;
     - reads are cloned (callers push into what they read) and kept 30 s;
     - with KV over its daily limit, /setup's writes still land;
     - a write that cannot reach the object throws instead of going to KV.
   ========================================================================== */

import { objectStore, StoreDO, inObject } from '../src/dostore.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };

/* a KV that can be switched to "over the daily limit" */
const kv = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  let full = false, reads = 0;
  return {
    available: true, m,
    fill() { full = true; },
    get reads() { return reads; },
    async get(k) { reads++; return m.has(k) ? structuredClone(m.get(k)) : null; },
    async put(k, v) { if (full) throw new Error('KV put() limit exceeded for the day.'); m.set(k, structuredClone(v)); },
  };
};
/* the object, driven through its real fetch handler over an in-memory storage */
const object = () => {
  const data = new Map();
  const storage = { get: async k => data.get(k), put: async (k, v) => { data.set(k, structuredClone(v)); }, list: async () => new Map(data) };
  const o = new StoreDO({ storage });
  let calls = 0, down = false;
  const call = async body => {
    calls++;
    if (down) throw new Error('object unreachable');
    const r = await o.fetch(new Request('https://store/', { method: 'POST', body: JSON.stringify(body) }));
    if (!r.ok) throw new Error('store ' + r.status);
    return r.json();
  };
  return { call, data, get calls() { return calls; }, down(v = true) { down = v; } };
};

console.log('\nwhich keys');
{
  ok('the bot\'s keys', inObject('tg:group:-100') && inObject('tg:mints') && inObject('tg:users'));
  ok('what money buys', ['boosts', 'pending', 'ads', 'alertads', 'dmads', 'bids', 'hidden', 'welcomed'].every(inObject));
  ok('feed copies and history stay in KV', !inObject('snap:trending') && !inObject('hist') && !inObject('basechain'));
}

console.log('\nreading and writing');
{
  let t = 1000;
  const base = kv({ 'tg:group:-1': { mint: 'OLD' }, 'snap:x': { ts: 1 } });
  const ob = object();
  const s = objectStore(base, ob.call, { now: () => t });
  ok('a key the object never had is KV\'s', (await s.get('tg:group:-1')).mint === 'OLD');
  ok('other keys never touch the object', (await s.get('snap:x')).ts === 1 && ob.calls === 1);

  base.fill();
  await s.put('tg:group:-1', { mint: 'NEW' });
  ok('with KV over its daily limit, the bot still saves', ob.data.get('tg:group:-1').v.mint === 'NEW');
  ok('and KV was not written', base.m.get('tg:group:-1').mint === 'OLD');
  ok('the same isolate reads its own write', (await s.get('tg:group:-1')).mint === 'NEW');
  let threw = '';
  try { await s.put('snap:x', { ts: 2 }); } catch (e) { threw = e.message; }
  ok('a KV key still fails the KV way', /limit exceeded/.test(threw));

  const other = objectStore(base, ob.call, { now: () => t });
  ok('another isolate reads the object, not KV', (await other.get('tg:group:-1')).mint === 'NEW');

  const list = await s.get('tg:group:-1');
  list.mint = 'MUTATED';
  ok('a read is a copy: changing it changes nothing', (await s.get('tg:group:-1')).mint === 'NEW');

  await s.put('tg:mint:abc', null);
  ok('null is a deletion, not "ask KV"', (await other.get('tg:mint:abc')) === null);
  base.m.set('tg:mint:zzz', ['stale']);
  await s.put('tg:mint:zzz', null);
  ok('a deleted key does not come back from KV', (await objectStore(base, ob.call, { now: () => t }).get('tg:mint:zzz')) === null);
}

console.log('\nthe cache and the clock');
{
  let t = 0;
  const ob = object();
  const s = objectStore(kv(), ob.call, { now: () => t });
  await s.put('boosts', [1]);
  const before = ob.calls;
  await s.get('boosts'); await s.get('boosts');
  ok('reads are kept 30 s', ob.calls === before);
  t = 31_000;
  await s.get('boosts');
  ok('and re-read after', ob.calls === before + 1);

  const real = Date.now;
  await s.put('pending', [{ id: 1 }], { ttlSec: 60 });
  Date.now = () => real() + 120_000;
  try { ok('an expired key reads as null', (await objectStore(kv({ pending: ['old'] }), ob.call).get('pending')) === null); }
  finally { Date.now = real; }
}

console.log('\nwhen the object is out of reach');
{
  const base = kv({ 'tg:groups': [-1] });
  const ob = object();
  ob.down();
  const s = objectStore(base, ob.call);
  ok('a read falls back to KV', (await s.get('tg:groups'))[0] === -1);
  let threw = false;
  try { await s.put('tg:groups', [-1, -2]); } catch { threw = true; }
  ok('a write throws rather than going to KV', threw && base.m.get('tg:groups').length === 1);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
