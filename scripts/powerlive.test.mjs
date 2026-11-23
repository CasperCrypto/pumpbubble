/* Power prices that refresh themselves (src/powerlive.mjs) and how the map
   uses them (src/computemap.mjs). No network: every upstream is faked. */
import {
  zoneAverage, zonesDue, dayAheadStep, dayAheadByCountry, usable, PowerKeeper,
  ALL_ZONES, DA_EVERY_MS, buildPower,
} from '../src/powerlive.mjs';
import { setLivePower, countryData, powerAt, mapPayload } from '../src/computemap.mjs';
import { POWER } from '../src/powerprices.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const NOW = Date.parse('2026-11-19T12:00:00Z');
const week = (eur, n = 672) => ({ unit: 'EUR / MWh', price: Array(n).fill(eur), unix_seconds: Array.from({ length: n }, (_, i) => NOW / 1000 - (n - i) * 900) });
const res = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });

console.log('one zone');
ok(zoneAverage(week(100)).eurMwh === 100, 'a week of prices averages');
ok(zoneAverage({ unit: 'EUR / MWh', price: [1, 2, 3], unix_seconds: [] }) === null, 'under a day of prices is no average');
ok(zoneAverage({ ...week(100), unit: 'USD / MWh' }) === null, 'a unit it does not expect is refused, not converted');
ok(zoneAverage({ ...week(100), price: [...Array(100).fill(null), ...Array(200).fill(50)] }).eurMwh === 50, 'missing quarter-hours are skipped, not zero');

console.log('pacing');
ok(zonesDue({}, NOW).length === 5, 'five zones a step');
const fresh = Object.fromEntries(ALL_ZONES.map(z => [z, { at: NOW - 1000, eurMwh: 1 }]));
ok(zonesDue({ zones: fresh }, NOW).length === 0, 'nothing is due while every zone is fresh');
fresh.FR = { at: NOW - DA_EVERY_MS - 1, eurMwh: 1 }; fresh.ES = { at: NOW - DA_EVERY_MS - 999, eurMwh: 1 };
ok(zonesDue({ zones: fresh }, NOW).join() === 'ES,FR', 'the stalest go first');

const asked = [];
let calls = 0;
const fakeEc = async url => { asked.push(new URL(url).searchParams.get('bzn')); calls++; return calls === 3 ? res(429, {}) : res(200, week(80)); };
const st = await dayAheadStep({}, fakeEc, NOW, { gap: 0 });
ok(asked.length === 3 && Object.values(st.zones).filter(z => z.eurMwh).length === 2, 'a 429 stops the step; what was read is kept');
ok(/429/.test(st.error), 'and says so');
const st2 = await dayAheadStep({ zones: { AT: { eurMwh: 90, at: 0, to: '2026-11-01' } } }, async () => res(200, { unit: 'EUR / MWh', price: [] }), NOW, { gap: 0, per: 1 });
ok(st2.zones.AT.eurMwh === 90 && st2.zones.AT.at === NOW, 'an empty answer keeps the last good figure and is not asked again at once');

console.log('by country');
const zones = { 'DE-LU': { eurMwh: 200, at: NOW, to: '2026-11-19' }, NO1: { eurMwh: 100, at: NOW, to: '2026-11-19' }, NO2: { eurMwh: 300, at: NOW, to: '2026-11-18' },
  FR: { eurMwh: 50, at: NOW - 11 * 86400_000, to: '2026-11-08' } };
const by = dayAheadByCountry({ zones }, 1.1, NOW);
ok(Math.abs(by.DE.usd - 0.22) < 1e-9 && by.LU.usd === by.DE.usd, 'euros per MWh to dollars per kWh; Luxembourg shares Germany\'s zone');
ok(by.NO.usd === 0.22 && by.NO.lo === 0.11 && by.NO.hi === 0.33 && by.NO.zones === 2 && by.NO.of === 5, 'several zones: their mean and the range, and how many were read');
ok(!by.FR, 'a figure older than ten days is not used');
ok(Object.keys(dayAheadByCountry({ zones }, 0, NOW)).length === 0, 'no dollar rate, no conversion');

console.log('industrial');
ok(usable({ countries: { ...POWER.countries }, states: { ...POWER.states } }, POWER), 'a read as complete as the baked file is used');
const thin = { countries: { US: { usd: 0.09 } }, states: { TX: 0.07 } };
ok(!usable(thin, POWER), 'a half-answer never replaces it');
const es = { updated: 'x', dimension: { geo: { category: { index: { FR: 0, EL: 1, EU27_2020: 2 }, label: {} } }, time: { category: { index: { '2026-S1': 0 } } } }, value: { 0: 0.08, 1: 0.1, 2: 0.12 } };
const eia = '<table><tr><th>State</th><th>a</th><th>b</th><th>c</th><th>d</th><th>Aug 2026 YTD</th></tr><tr><td>Texas</td><td>1</td><td>1</td><td>1</td><td>1</td><td>6.5</td></tr><tr><td>U.S. Total</td><td>1</td><td>1</td><td>1</td><td>1</td><td>9.1</td></tr></table>';
const b = buildPower({ es, eia, fx: { usdPerEur: 1.1, date: '2026-11-18' }, monthly: { '2026-01': 1.2, '2026-02': 1.2 }, today: '2026-11-19' });
ok(b.countries.GR && b.countries.FR.usd === 0.096 && !b.countries.EU, 'Eurostat: semester rate, ISO codes, aggregates dropped');
const es2 = { dimension: { geo: { category: { index: { FR: 0, HR: 1, GE: 2 }, label: {} } }, time: { category: { index: { '2024-S2': 0, '2026-S1': 1 } } } },
  value: { 0: 0.2, 1: 0.2, 2: 0.15, 3: 0.12, 4: 0.07, 5: 0 } };
const b2 = buildPower({ es, es2, eia, fx: { usdPerEur: 1.1, date: '2026-11-18' }, monthly: { '2026-01': 1.2, '2026-02': 1.2 }, today: '2026-11-19' });
ok(b2.countries.HR && b2.countries.HR.band === '20–70 GWh/yr' && b2.countries.HR.usd === 0.144, 'a country missing from the main band takes the 20–70 GWh band, labelled');
ok(b2.countries.FR.usd === 0.096 && !b2.countries.FR.band, 'the main band always wins where it has a figure');
ok(!b2.countries.GE, 'a fallback figure two years old is not used');
ok(b.countries.US.usd === 0.091 && b.states.TX === 0.065 && b.usdPerEur === 1.1, 'EIA by state, and the rate is kept for day-ahead');

console.log('the keeper');
const store = new Map();
const S = { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); } };
let n = 0;
const keeper = new PowerKeeper(S, async () => { n++; throw new Error('offline'); });
const first = await keeper.current(NOW);
ok(first && keeper.pending, 'answers at once and refreshes behind');
await keeper.pending;
ok(/offline/.test(keeper.mem.indError) && n > 0, 'a failed read is recorded, nothing invented');
const before = n;
await keeper.current(NOW + 60_000);
ok(!keeper.pending || n === before, 'a failed industrial read waits an hour before it is tried again');

console.log('the map');
setLivePower(null);
ok(powerAt('DE').usd === POWER.countries.DE.usd, 'no live read: the baked prices');
const ind = { ...POWER, countries: { ...POWER.countries, DE: { usd: 0.2, period: '2026-S2', src: 'eurostat' } }, usPeriod: 'August 2026 YTD', usdPerEur: 1.1 };
const p = mapPayload({ sites: { sites: [], power: { ind, da: { zones } } }, now: NOW });
ok(powerAt('DE').usd === 0.2 && p.asOf.us === 'August 2026 YTD' && p.asOf.live, 'a usable live read replaces the baked one');
ok(p.countries.DE.ind === 0.2 && Math.abs(p.countries.DE.whl - 0.22) < 1e-9 && p.countries.DE.whlLive === 1, 'the card gets industrial and the week\'s day-ahead');
ok(p.countries.NO.whlLo === 0.11 && p.countries.NO.whlHi === 0.33, 'a several-zone country carries its range');
mapPayload({ sites: { sites: [], power: { ind: thin, da: { zones } } }, now: NOW });
ok(powerAt('DE').usd === POWER.countries.DE.usd, 'an incomplete live read leaves the baked prices in place');
setLivePower(null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
