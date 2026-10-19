/* ==========================================================================
   The Compute tab's map: its data (src/computemap.mjs) and the scripts that
   build its static files.

       node scripts/computemap.test.mjs

   What is pinned:
     - an Akash provider's own text cannot reach the page as markup: the host
       is its URL's hostname, region and country are cleaned, models must look
       like model names, and a provider with no real position is left off;
     - power is in US dollars per kWh, by ISO code; a US state's industrial
       price wins over the country's; wholesale is only what is left, and is
       always labelled wholesale;
     - a country with nothing known has no power price — never a guess;
     - the cheapest GPU hour costs only models whose power draw is published;
     - the build scripts: a ring across the date line is cut, not drawn across
       the map; Eurostat's EL and UK become GR and GB; a semester is converted
       at its own average rate; a wholesale month in the file's last, cut-off
       month is not averaged in; the grid's newest year wins.
   ========================================================================== */

import { akashSites, powerAt, countryData, cheapGpus, mapPayload, kwhPerHour, ccOf } from '../src/computemap.mjs';
import { POWER } from '../src/powerprices.mjs';
import { WHOLESALE } from '../src/wholesale.mjs';
import { GRID } from '../src/gridmix.mjs';
import { METROS, PROJECTS } from '../src/datacenters.mjs';
import { splitDateline, compact } from './world-map.mjs';
import { isoOf, semesterRate } from './power-prices.mjs';
import { monthlyMeans, lastYearUsd } from './wholesale-prices.mjs';
import { latest } from './grid-mix.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };

console.log('\nAkash providers');
{
  const raw = [
    { isOnline: true, hostUri: 'https://provider.h100.ams.val.akash.pub:8443', ipLat: '51.5', ipLon: '-0.12', ipCountryCode: 'gb', ipCountry: 'United Kingdom', ipRegion: 'England',
      stats: { gpu: { total: 37, available: 5 } }, gpuModels: [{ model: 'H100' }, { model: 'h100' }, { model: '<img src=x>' }], uptime7d: 0.9987, isAudited: true },
    { isOnline: true, hostUri: 'javascript:alert(1)', ipLat: 30.27, ipLon: -97.74, ipCountryCode: 'US', ipCountry: 'United States', ipRegion: 'Texas<script>', stats: { gpu: { total: 2, available: 0 } } },
    { isOnline: true, hostUri: 'https://x.example', ipLat: 0, ipLon: 0, ipCountryCode: 'US' },
    { isOnline: true, hostUri: 'https://y.example', ipLat: 'nope', ipLon: 10 },
    { isOnline: false, hostUri: 'https://z.example', ipLat: 10, ipLon: 10 },
  ];
  const s = akashSites(raw);
  ok('offline, unplaced and 0,0 providers are left off', s.length === 2, String(s.length));
  ok('the biggest first', s[0].gpus === 37);
  ok('the host is the hostname of its URL', s[0].host === 'provider.h100.ams.val.akash.pub');
  ok('a URL that is not one gives no host', s[1].host === '');
  ok('models are model names, once each', s[0].models.join() === 'h100', s[0].models.join());
  ok('free text loses its markup characters', !/[<>]/.test(s[1].region) && s[1].region.startsWith('Texas'));
  ok('ISO codes as given, upper case', s[0].cc === 'GB' && ccOf('xx') === 'XX' && ccOf('nope') === '');
  ok('uptime as a percentage', s[0].up7d === 99.9);
  ok('a US provider knows its state only when the region is a state', s[1].st === '');
  const tx = akashSites([{ isOnline: true, ipLat: 30, ipLon: -97, ipCountryCode: 'US', ipRegion: 'Texas', stats: { gpu: { total: 1 } } }]);
  ok('…and Texas is TX', tx[0].st === 'TX');
}

console.log('\npower');
{
  const tx = powerAt('US', 'TX');
  ok('a US state\'s own industrial price', tx && tx.kind === 'industrial' && tx.usd === POWER.states.TX && tx.usd < 1);
  ok('the country\'s when the state is unknown', powerAt('US', '').usd === POWER.countries.US.usd);
  ok('Europe is industrial, in dollars, by ISO code', powerAt('DE').kind === 'industrial' && powerAt('GR') && !powerAt('EL') && powerAt('DE').usd > 0.05 && powerAt('DE').usd < 0.5);
  ok('wholesale only where no industrial price exists', powerAt('JP').kind === 'wholesale' && powerAt('JP').usd === WHOLESALE.JP.usd);
  ok('nothing known is nothing, not a guess', powerAt('CN') === null && powerAt('ZZ') === null);
  const c = countryData();
  ok('a country carries both kinds when it has both, apart', c.DE.ind > 0 && c.DE.whl === undefined && c.JP.whl > 0 && c.JP.ind === undefined);
  ok('periods are said in words', /^H[12] 20\d\d$/.test(c.DE.indP) && /^[A-Z][a-z]{2} 20\d\d – [A-Z][a-z]{2} 20\d\d$/.test(c.JP.whlP), c.DE.indP + ' / ' + c.JP.whlP);
  ok('the grid for countries with no price too', c.CN && c.CN.co2 > 0 && c.CN.ind === undefined);
  ok('every price is dollars per kWh, not cents or euros', Object.values(POWER.countries).every(x => x.usd > 0.02 && x.usd < 0.6) && Object.values(WHOLESALE).every(x => x.usd > 0.005 && x.usd < 0.6));
  ok('the grid data covers the world', Object.keys(GRID).length > 150);
}

console.log('\nthe cheapest GPU hour');
{
  const sites = akashSites([
    { isOnline: true, ipLat: 30, ipLon: -97, ipCountryCode: 'US', ipRegion: 'Texas', stats: { gpu: { total: 8, available: 2 } }, gpuModels: [{ model: 'h100' }] },
    { isOnline: true, ipLat: 50, ipLon: 8, ipCountryCode: 'DE', stats: { gpu: { total: 8, available: 2 } }, gpuModels: [{ model: 'h100' }, { model: 'b300' }] },
  ]);
  const feed = { gpus: [{ id: 'h100', model: 'H100', usdPerHour: 2.7, fromUsdPerHour: 2.0, gpusFree: 4, gpusListed: 16 },
    { id: 'b300', model: 'B300', usdPerHour: 5, fromUsdPerHour: null }, { id: 'x', model: 'X', usdPerHour: null }] };
  const g = cheapGpus(feed, sites);
  ok('unpriced models are left out', g.length === 2);
  ok('cheapest first', g[0].id === 'h100');
  const h = g[0];
  ok('its power at the cheapest place offering it', h.power && h.power.cc === (POWER.states.TX < POWER.countries.DE.usd ? 'US' : 'DE'));
  ok('the hour of power is watts × 1.3 at that price', Math.abs(h.power.usd - Math.round(kwhPerHour('h100') * Math.min(POWER.states.TX, POWER.countries.DE.usd) * 1000) / 1000) < 1e-9);
  ok('a model with no published draw is not costed', g[1].power === null);
  ok('where it is offered', h.ccs.includes('US') && h.ccs.includes('DE'));
}

console.log('\nthe payload');
{
  const p = mapPayload({ sites: { at: 1, sites: [] }, feed: null });
  ok('static layers are always there', p.metros.length === METROS.length && p.projects.length === PROJECTS.length);
  ok('no providers is an empty list, not a failure', Array.isArray(p.sites) && p.sites.length === 0 && p.gpus.length === 0);
  ok('every place on the map has a position', [...METROS, ...PROJECTS].every(x => Math.abs(x.lat) <= 85 && Math.abs(x.lon) <= 180));
  ok('places use ISO codes', [...METROS, ...PROJECTS].every(x => /^[A-Z]{2}$/.test(x.cc) && x.cc !== 'UK' && x.cc !== 'EL'));
  ok('every megaproject names its source', PROJECTS.every(x => /^https:\/\//.test(x.src)));
}

console.log('\nthe build scripts');
{
  const fiji = [[178, -17], [179.9, -17.5], [-179.9, -17.4], [-179.5, -16.8], [179, -16.5], [178, -17]];
  const parts = splitDateline(fiji);
  ok('a ring across the date line is cut in two', parts.length === 2);
  ok('neither half jumps across the map', parts.every(h => h.every((p, i) => !i || Math.abs(p[0] - h[i - 1][0]) < 180)));
  ok('a ring that does not cross is left alone', splitDateline([[0, 0], [1, 0], [1, 1], [0, 0]]).length === 1);
  const c = compact([{ id: '276', name: 'Germany', rings: [[[5.9, 47.3], [15.0, 47.3], [15.0, 55.0], [5.9, 55.0], [5.9, 47.3]]] }, { id: '010', name: 'Antarctica', rings: [[[0, -80], [10, -80], [10, -70], [0, -80]]] }], { 276: 'DE' });
  ok('Antarctica is left out, codes come from the ISO table', c.length === 1 && c[0].a2 === 'DE');
  ok('Eurostat\'s EL and UK become GR and GB', isoOf('EL') === 'GR' && isoOf('UK') === 'GB' && isoOf('DE') === 'DE');
  ok('a semester at its own months\' rate', semesterRate({ '2026-01': 1, '2026-02': 1.2, '2026-03': 1.1, '2026-04': 1, '2026-05': 1, '2026-06': 1, '2026-07': 9 }, '2026-S1') === 1.05);
  ok('an unknown semester has no rate', semesterRate({}, '2026-S1') === null && semesterRate({}, 'nope') === null);
  const csv = 'Timestamp,A,B\n2025-01-01 00:00:00,10,20\n2025-01-02 00:00:00,30,0\n2025-02-01 00:00:00,40,40\n';
  const m = monthlyMeans([csv], '*');
  ok('zones averaged per hour, zeros left out', m['2025-01'] === (15 + 30) / 2 && m['2025-02'] === 40, JSON.stringify(m));
  const months = Object.fromEntries(Array.from({ length: 14 }, (_, i) => ['2024-' + String(i + 1).padStart(2, '0'), 100]).slice(0, 12).concat([['2025-01', 100], ['2025-02', 999]]));
  const rate = Object.fromEntries(Object.keys(months).map(k => [k, 1]));
  const r = lastYearUsd(months, false, rate, rate);
  ok('the last, cut-off month is not averaged in', r && r.to === '2025-01' && r.usd === 0.1, JSON.stringify(r));
  const gl = latest('entity,code,year,v\nPoland,POL,2023,600\nPoland,POL,2025,589.4\nWorld,,2025,450\n"Bonaire, Sint Eustatius",BES,2024,100\n');
  ok('the grid\'s newest year wins, aggregates are dropped', gl.POL.year === 2025 && gl.POL.v === 589.4 && !gl[''] && gl.BES.v === 100);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
