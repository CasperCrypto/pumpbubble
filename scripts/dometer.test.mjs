/* ==========================================================================
   How long each Durable Object is awake (src/dometer.mjs).

       node scripts/dometer.test.mjs

   What is pinned:
     - an alarm's and a request's wall time are summed per UTC day, apart;
     - the day rolls over at 00:00 UTC, when Cloudflare's allowance does;
     - /__busy answers the day so far and is not counted itself;
     - the total survives the object being recycled (it is saved), at most
       once per five minutes;
     - a failing alarm or request is still counted, and still fails;
     - a storage that refuses writes (the allowance is out) breaks nothing.
   ========================================================================== */

import { meterClass, addBusy, busyReport, GB } from '../src/dometer.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };

const DAY = Date.UTC(2026, 9, 17, 12, 0, 0);
let t = DAY;
const clock = () => t;
const storage = (refuse = false) => { const m = new Map(); return { m, get: async k => m.get(k), put: async (k, v) => { if (refuse) throw new Error('Exceeded allowed duration'); m.set(k, structuredClone(v)); } }; };

class Obj {
  constructor(state) { this.state = state; }
  async alarm() { t += 2000; }
  async fetch(req) { t += 50; if (new URL(req.url).pathname === '/boom') throw new Error('boom'); return new Response('ok'); }
}
meterClass(Obj, { now: clock });
const busy = async o => (await o.fetch(new Request('https://x/__busy'))).json();

console.log('\ncounting');
{
  const st = storage();
  const o = new Obj({ storage: st });
  await o.alarm(); await o.alarm();
  await o.fetch(new Request('https://x/a'));
  const b = await busy(o);
  ok('alarms and requests are counted apart', b.alarms === 2 && b.fetches === 1, JSON.stringify(b));
  ok('their wall time is summed', b.s === 4 && b.gbs === Math.round(4 * GB));
  ok('asking is not counted', (await busy(o)).fetches === 1);
  ok('the first count is saved at once', st.m.get('__busy') && st.m.get('__busy').alarms >= 1);

  let threw = false;
  try { await o.fetch(new Request('https://x/boom')); } catch { threw = true; }
  ok('a failing request still fails, and is counted', threw && (await busy(o)).fetches === 2);

  const again = new Obj({ storage: st });
  t += 301_000;
  await again.alarm();
  ok('a recycled object carries the day on', (await busy(again)).alarms >= 2);

  t = Date.UTC(2026, 9, 18, 0, 0, 5);
  ok('a new UTC day starts from nothing', (await busy(again)).s === 0);
  await again.alarm();
  ok('and counts again', (await busy(again)).alarms === 1);
}

console.log('\nwhen the allowance is out');
{
  const o = new Obj({ storage: storage(true) });
  await o.alarm();
  ok('a storage that refuses writes breaks nothing', (await busy(o)).alarms === 1);
}

console.log('\nthe sums');
{
  const b = addBusy(addBusy(null, 'alarm', 1500, DAY), 'fetch', 500, DAY);
  ok('a day of one alarm and one request', b.alarmMs === 1500 && b.fetchMs === 500 && b.day === '2026-10-17');
  ok('yesterday reads as nothing today', busyReport(b, DAY + 864e5).s === 0);
}
{
  meterClass(Obj, { now: clock });
  const o = new Obj({ storage: storage() });
  await o.alarm();
  ok('metering a class twice does not count twice', (await busy(o)).alarms === 1);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
