/* Launchpads, chains and prediction markets: the week and month moves are
   period against period, never DefiLlama's one-day-against-one-day change_7d. */
import { padsFrom, chainsFrom, predictionFrom } from '../src/flows.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const pump = {
  name: 'pump.fun', slug: 'pump.fun', category: 'Launchpad', chains: ['Solana'],
  total24h: 1719235, total7d: 9409551, total14dto7d: 8630372, total30d: 44925631, total60dto30d: 62426395,
  totalAllTime: 1337333661, change_1d: 22.73, change_7d: 32.77, change_1m: -22.2,
  change_7dover7d: 9.03, change_30dover30d: -28.03,
};
const noOver = { ...pump, name: 'Flap', slug: 'flap', change_7dover7d: undefined, change_30dover30d: null };
const dust = { ...pump, name: 'Dust', slug: 'dust', total24h: 7 };
const dexs = { protocols: [{ slug: 'pump.fun', total24h: 127788157, category: 'Launchpad' }] };

const pads = padsFrom({ protocols: [pump, noOver, dust] }, dexs);
const p = pads.find(r => r.sym === 'pump.fun'), f = pads.find(r => r.sym === 'Flap');
ok(p.change7d === 9.03, 'week is the last 7 days against the 7 before, not one day against one day (' + p.change7d + ')');
ok(p.change30d === -28.03, 'month is the last 30 days against the 30 before');
ok(Math.abs(f.change7d - 9.03) < 0.01, 'missing change_7dover7d is computed from total7d / total14dto7d');
ok(Math.abs(f.change30d - -28.03) < 0.01, 'missing change_30dover30d is computed from the two 30-day totals');
ok(p.traded24h === 127788157 && f.traded24h === null, 'volume traded joins by slug; absent is null');
ok(p.fees30d === 44925631 && p.feesAll === 1337333661, '30d and all-time fees carried');
ok(!pads.some(r => r.sym === 'Dust'), 'under $1,000 a day is not on the map');
ok(padsFrom({ protocols: [{ ...pump, total7d: 0, total14dto7d: 0, change_7dover7d: null }] }, null)[0].change7d === null,
  'no week reported and no totals is null, not zero');

const ch = chainsFrom({ protocols: [{ ...pump, breakdown24h: { solana: { 'pump.fun': 100 } } }] });
ok(ch[0].change7d === 9.03 && ch[0].change30d === null, 'a chain gets week over week, and no month');

const pm = predictionFrom({ protocols: [{ ...pump, name: 'Kalshi', slug: 'kalshi', category: 'Prediction Market' }] }, null);
ok(pm[0].change7d === 9.03 && pm[0].change30d === -28.03, 'prediction markets: week and month over the period before');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
