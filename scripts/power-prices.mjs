/* ==========================================================================
   Builds src/powerprices.mjs — what electricity costs a big industrial
   buyer, by country (Europe) and by state (US), in US cents per kWh.

       node scripts/power-prices.mjs          # prints what it would write
       node scripts/power-prices.mjs --write

   Run it when a new half-year lands (Eurostat publishes each semester about
   four months after it ends; EIA every month). Three keyless sources:

   - Eurostat nrg_pc_205, non-household consumers, the 70–150 GWh/year band
     (the largest band most countries report — a data center's size), excluding
     VAT and other recoverable taxes, in EUR. Reuse with the source acknowledged.
     A 0 in that table is a confidential or missing value, never a price.
   - U.S. EIA, Electric Power Monthly table 5.6.B: average price to industrial
     customers by state, year to date. US government work, public domain.
   - The ECB's euro reference rate against the dollar, to put both in cents.

   Averages paid by industry, not what a given data center has contracted —
   the map says so. Nothing is filled in for a country no source covers.
   ========================================================================== */

import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0 (power-prices)';
const EUROSTAT = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_pc_205?format=JSON&lang=EN&nrg_cons=MWH70000-149999&tax=X_VAT&currency=EUR&unit=KWH&sinceTimePeriod=2024-S2';
const EIA = 'https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_b';
const ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata';
const OUT = new URL('../src/powerprices.mjs', import.meta.url);

import { US_STATES as STATES } from '../src/datacenters.mjs';
export { STATES };

/* Eurostat's JSON-stat: the newest semester with a real (non-zero) value per country */
export function eurostatPrices(j) {
  const geo = j.dimension.geo.category, time = j.dimension.time.category;
  const times = Object.entries(time.index).sort((a, b) => a[1] - b[1]).map(([t]) => t);
  const nt = times.length, out = {};
  for (const [g, gi] of Object.entries(geo.index)) {
    if (!/^[A-Z]{2}$/.test(g) || g === 'EA') continue;   // EU27_2020 and EA (the euro area) are aggregates
    for (let k = nt - 1; k >= 0; k--) {
      const v = j.value[gi * nt + k];
      if (typeof v === 'number' && v > 0) { out[g] = { eur: v, period: times[k], name: geo.label[g] }; break; }
    }
  }
  return out;
}

/* EIA's HTML table: the industrial column for the current year, by state */
export function eiaPrices(html) {
  const cell = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const head = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => cell(m[1]));
  const period = head.find(h => /\b20\d\d\b/.test(h)) || '';
  const out = {};
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(x => cell(x[1]));
    const code = c[0] === 'U.S. Total' ? 'US' : STATES[c[0]];
    const v = parseFloat(c[5]);
    if (code && Number.isFinite(v) && v > 0) out[code] = v;
  }
  return { period, cents: out };
}

export function ecbRate(j) {
  const s = Object.values(j.dataSets[0].series)[0].observations;
  const k = Object.keys(s).sort((a, b) => b - a)[0];
  const dates = j.structure.dimensions.observation[0].values;
  return { usdPerEur: s[k][0], date: dates[+k].id };
}

/* ECB monthly averages, dollars per euro: { '2026-01': 1.17, … } */
export function ecbMonthly(j) {
  const s = Object.values(j.dataSets[0].series)[0].observations;
  const dates = j.structure.dimensions.observation[0].values;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [dates[+k].id, v[0]]));
}
/* a semester's average rate: 2026-S1 is January to June */
export function semesterRate(monthly, period) {
  const m = /^(\d{4})-S([12])$/.exec(period || '');
  if (!m) return null;
  const months = Array.from({ length: 6 }, (_, i) => `${m[1]}-${String((m[2] === '1' ? 1 : 7) + i).padStart(2, '0')}`);
  const v = months.map(k => monthly[k]).filter(x => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
/* Eurostat writes Greece EL and the United Kingdom UK; the map uses ISO codes */
export const isoOf = cc => cc === 'EL' ? 'GR' : cc === 'UK' ? 'GB' : cc;

if (process.argv[1] && process.argv[1].endsWith('power-prices.mjs')) {
  const ECB_M = 'https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?startPeriod=2024-01&format=jsondata';
  const get = async (u, as) => { const r = await fetch(u, { headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : 'text/html' } }); if (!r.ok) throw new Error(u + ' ' + r.status); return as === 'json' ? r.json() : r.text(); };
  const [es, eia, ecb, ecbM] = await Promise.all([get(EUROSTAT, 'json'), get(EIA, 'html'), get(ECB, 'json'), get(ECB_M, 'json')]);
  const eu = eurostatPrices(es), us = eiaPrices(eia), fx = ecbRate(ecb), monthly = ecbMonthly(ecbM);
  const countries = {};
  /* each semester's euros at that semester's average dollar rate; the latest daily rate only when the semester has none yet */
  for (const [cc, p] of Object.entries(eu)) {
    const rate = semesterRate(monthly, p.period) || fx.usdPerEur;
    countries[isoOf(cc)] = { usd: Math.round(p.eur * rate * 10000) / 10000, period: p.period, src: 'eurostat' };
  }
  if (us.cents.US) countries.US = { usd: Math.round(us.cents.US * 100) / 10000, period: us.period, src: 'eia' };
  const states = Object.fromEntries(Object.entries(us.cents).filter(([k]) => k !== 'US').map(([k, v]) => [k, Math.round(v * 100) / 10000]));
  const data = { asOf: new Date().toISOString().slice(0, 10), euUpdated: es.updated, usPeriod: us.period, countries, states };
  const src = `/* Generated by scripts/power-prices.mjs on ${data.asOf} — do not edit by hand; re-run it.
   Industrial electricity, US dollars per kWh: Eurostat nrg_pc_205 (70–150 GWh/year,
   excl. VAT and recoverable taxes; euros at the ECB's average dollar rate for each
   semester) and U.S. EIA Electric Power Monthly table 5.6.B (industrial, ${us.period}). */
export const POWER = ${JSON.stringify(data)};
`;
  console.log(`${Object.keys(countries).length} countries, ${Object.keys(states).length} states; US ${us.period}`);
  console.log('cheapest:', Object.entries(countries).sort((a, b) => a[1].usd - b[1].usd).slice(0, 6).map(([k, v]) => k + ' $' + v.usd).join(', '));
  if (process.argv.includes('--write')) { writeFileSync(OUT, src); console.log('wrote', OUT.pathname); }
}
