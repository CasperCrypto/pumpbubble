/* The Minerals layer's data (scripts/minerals.mjs → src/minerals.mjs), the
   marked sites, and the UK power reader (scripts/uk-power.mjs). */
import { parseCsv, usgsValue, decodeUsgs, decode1252, commodity, importReliance, controls, PICK } from './minerals.mjs';
import { latestQuarter } from './uk-power.mjs';
import { MINERALS } from '../src/minerals.mjs';
import { MINERAL_SITES } from '../src/mineralsites.mjs';
import { UK_POWER } from '../src/ukpower.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

console.log('reading USGS');
ok(usgsValue('270,000').v === 270000 && usgsValue('—').v === 0, 'numbers with commas; "—" is zero');
ok(usgsValue('NA') === null && usgsValue('W') === null && usgsValue('Large') === null, 'NA, withheld and words are unknown, never zero');
ok(usgsValue('>21,000,000').gt === true && usgsValue('>21,000,000').v === 21e6, 'a floor keeps its ">"');
ok(decode1252(Buffer.from([0x41, 0x97, 0x42])) === 'A—B', 'Windows-1252: 0x97 is an em dash');
ok(decodeUsgs(Buffer.from('﻿Country,X', 'utf8')) === 'Country,X', 'UTF-8 with a byte-order mark: the mark is dropped');
ok(decodeUsgs(Buffer.from([0x2d, 0x97, 0x2d])) === '-—-', 'not UTF-8: read as Windows-1252');
const rows = parseCsv('A,B,C\n1,"x, y","say ""hi"""\r\n2,,\n');
ok(rows.length === 2 && rows[0].B === 'x, y' && rows[0].C === 'say "hi"', 'CSV: quoted commas and doubled quotes');

const names = new Map([['china', 'CN'], ['japan', 'JP']]);
const ga = PICK.find(p => p.id === 'ga');
const row = (Country, Statistics_detail, Value, Year = '2025', Unit = 'kilograms') => ({ Commodity: 'Gallium', Section: 'World Production and Capacity', Country, Statistics_detail, Value, Year, Unit });
const c = commodity([
  row('China', 'Primary production', '900,000'), row('Japan', 'Primary production', '3,000'), row('Russia', 'Primary production', '6,000'),
  row('Other countries', 'Primary production', '—'), row('World total', 'Primary production: rounded', '900,000'),
  row('China', 'Primary production', '750,000', '2024'),
], ga, new Map([...names, ['russia', 'RU']]));
ok(c.prod.CN === 900 && c.prod.JP === 3, 'kilograms to tonnes, by ISO code');
ok(c.world === 900 && c.base === 909, 'shares divide by what the rows add up to when the rounded total is smaller');
ok(Math.round(c.prod.CN / c.base * 100) === 99, 'so China is 99% of gallium, not 100%');
const missing = new Set();
commodity([row('Atlantis', 'Primary production', '5')], ga, names, missing);
ok(missing.has('Atlantis'), 'a country name it cannot place is reported, not guessed');
ok(importReliance([{ Commodity: 'RARE EARTHS, compounds and metals', Net_Import_Reliance_pct_2025: '67', Major_Import_Sources_2021_24: 'China' }], 'ree').pct === 67, 'US import reliance by prefix');
ok(importReliance([{ Commodity: 'LITHIUM', Net_Import_Reliance_pct_2025: '>50' }], 'li').bound === '>', 'a bound keeps its sign');
const ctl = controls([{ Country: 'China', Control_Type: 'Export licensing requirement', Commodity_Year: 'Gallium (2023)', Data_source: 'javascript:alert(1)' }], names);
ok(ctl.CN.length === 1 && ctl.CN[0].src === '', 'export controls by country; a non-https source is dropped');

console.log('the generated file');
ok(MINERALS.list.length === PICK.length && MINERALS.list.length >= 18, MINERALS.list.length + ' minerals');
const ree = MINERALS.list.find(m => m.id === 'ree');
ok(ree.prod.CN > 0 && ree.prod.CN / ree.base > 0.6 && ree.prod.CN / ree.base < 0.8, 'China mines 60–80% of rare earths (USGS 2025: 69%)');
ok(ree.res.BR > ree.prod.BR * 100, 'Brazil: reserves far above what it mines — the gap the panel names');
const keysOk = MINERALS.list.every(m => Object.keys(m.prod).every(k => /^[A-Z]{2}$/.test(k)) && Object.values(m.prod).every(v => Number.isFinite(v) && v >= 0));
ok(keysOk, 'every country is an ISO code and every figure a non-negative number');
ok(MINERALS.list.every(m => m.base >= Object.values(m.prod).reduce((a, b) => a + b, 0) - 1e-6), 'no share can exceed 100%');
ok(MINERALS.list.every(m => m.stage === 'mined' || m.stage === 'produced'), 'each says whether it is mined or produced');
ok(MINERALS.controls.CN && MINERALS.controls.CN.some(x => /gallium/i.test(x.what)), 'China’s gallium export licensing is in the controls');

console.log('sites');
const ids = new Set(MINERALS.list.map(m => m.id));
ok(MINERAL_SITES.every(s => /^[A-Z]{2}$/.test(s.cc) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180), 'every site has a country and a position');
ok(MINERAL_SITES.every(s => s.m.length && s.m.every(id => ids.has(id))), 'every site lights minerals that exist');
ok(MINERAL_SITES.every(s => /^https:\/\//.test(s.src) && ['mine', 'plant', 'magnets'].includes(s.kind)), 'every site has a source and a kind');

console.log('UK power');
const sheet = [['Table 3.4.2'], ['Year', 'Quarter', 'Electricity: Very Small (Pence per kWh)', 'Electricity: Very Large (Pence per kWh)'],
  [2025, '4th', 36, 22.5], [2026, '1st', 35, 21.9], [2026, '2nd p', 38, 22.7], [2026, '3rd', 40, null]];
const q = latestQuarter(sheet);
ok(q.y === 2026 && q.q === 2 && q.pence === 22.7 && q.provisional, 'the newest quarter with a value, in the Very Large column, provisional noted');
ok(UK_POWER.usd > 0.1 && UK_POWER.usd < 0.6 && /^\d{4}-Q[1-4]$/.test(UK_POWER.period), 'the generated UK price is a plausible $/kWh with its quarter');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
