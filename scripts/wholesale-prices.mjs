/* ==========================================================================
   Builds src/wholesale.mjs — the wholesale (day-ahead) price of power, in US
   dollars per kWh, for markets where no open industrial price exists.

       node scripts/wholesale-prices.mjs <folder>          # prints
       node scripts/wholesale-prices.mjs <folder> --write

   <folder> is the unzipped "Global Day-Ahead Electricity Price Dataset"
   (Zenodo record 16284828, CC BY 4.0, published 2025-07-21). Download it into
   a folder of its own; this script only reads its CSVs.

   A wholesale price is what power trades for before networks, taxes and
   retail margins — lower than what a data center pays, which is why the map
   draws these countries striped and says "wholesale" on every one of them.
   Europe and the US are not taken from here: Eurostat and EIA publish what
   industry actually pays there.

   Markets taken, and why these columns:
     Japan        JEPX system price, JPY/kWh
     South Korea  KPX SMP, mainland, KRW/kWh
     India        IEX day-ahead, INR/MWh
     Australia    AEMO, the mean of its five regions, AUD/MWh
     Brazil       CCEE PLD, Sudeste (São Paulo), BRL/MWh
     Singapore    NEMS USEP, SGD/MWh
     Switzerland  day-ahead, EUR/MWh
   Left out: Chile (the unit could not be confirmed), Ontario (its HOEP leaves
   out the Global Adjustment, several times the price itself), Great Britain
   (the dataset stops in 2020).

   Each market's last twelve months in the file, averaged month by month, each
   month converted at the ECB's average rate for that month.
   ========================================================================== */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../src/wholesale.mjs', import.meta.url);
const ECB = cur => `https://data-api.ecb.europa.eu/service/data/EXR/M.${cur}.EUR.SP00.A?startPeriod=2023-01&format=jsondata`;

export const MARKETS = [
  { cc: 'JP', dir: 'Japan', col: 'System Price', cur: 'JPY', perKwh: true, market: 'JEPX' },
  { cc: 'KR', dir: 'South Korea', col: 'Mainlad', cur: 'KRW', perKwh: true, market: 'KPX' },
  { cc: 'IN', dir: 'India', col: 'India', cur: 'INR', perKwh: false, market: 'IEX' },
  { cc: 'AU', dir: 'Australia', col: '*', cur: 'AUD', perKwh: false, market: 'AEMO' },
  { cc: 'BR', dir: 'Brazil', col: 'SUDESTE', cur: 'BRL', perKwh: false, market: 'CCEE' },
  { cc: 'SG', dir: 'Singapore', col: 'Singapore', cur: 'SGD', perKwh: false, market: 'NEMS' },
  { cc: 'CH', dir: 'Switzerland', col: 'Switzerland', cur: 'EUR', perKwh: false, market: 'day-ahead' },
];

/* monthly mean of one market's prices: { '2025-01': price, … } in its own unit */
export function monthlyMeans(csvTexts, col) {
  const sum = {}, n = {};
  for (const text of csvTexts) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(',');
    const idx = col === '*' ? head.map((_, i) => i).slice(1) : [head.indexOf(col)];
    if (idx.some(i => i < 1)) throw new Error('no column ' + col);
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(',');
      const m = (c[0] || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const v = idx.map(i => parseFloat(c[i])).filter(x => Number.isFinite(x) && x > 0);
      if (!v.length) continue;
      sum[m] = (sum[m] || 0) + v.reduce((a, b) => a + b, 0) / v.length;
      n[m] = (n[m] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.keys(sum).sort().map(m => [m, sum[m] / n[m]]));
}

/* the last twelve full months present, in dollars per kWh */
export function lastYearUsd(means, perKwh, localPerEur, usdPerEur) {
  const months = Object.keys(means).filter(m => Object.keys(means).length && localPerEur[m] && usdPerEur[m]);
  /* a month with too few hours (the file's last, cut mid-month) is dropped */
  const full = months.slice(0, -1);
  const last = full.slice(-12);
  if (last.length < 6) return null;
  const usd = last.map(m => (means[m] / (perKwh ? 1 : 1000)) / localPerEur[m] * usdPerEur[m]);
  return { usd: Math.round(usd.reduce((a, b) => a + b, 0) / usd.length * 10000) / 10000, from: last[0], to: last[last.length - 1] };
}

const ecbMonthly = j => {
  const s = Object.values(j.dataSets[0].series)[0].observations;
  const dates = j.structure.dimensions.observation[0].values;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [dates[+k].id, v[0]]));
};

if (process.argv[1] && process.argv[1].endsWith('wholesale-prices.mjs')) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) { console.error('usage: node scripts/wholesale-prices.mjs <unzipped dataset folder> [--write]'); process.exit(1); }
  const rates = {};
  for (const cur of ['USD', ...new Set(MARKETS.map(m => m.cur).filter(c => c !== 'EUR'))]) rates[cur] = ecbMonthly(await (await fetch(ECB(cur))).json());
  const ones = Object.fromEntries(Object.keys(rates.USD).map(m => [m, 1]));
  const out = {};
  for (const mk of MARKETS) {
    const files = readdirSync(join(dir, mk.dir)).filter(f => f.endsWith('.csv')).sort().slice(-2);
    const means = monthlyMeans(files.map(f => readFileSync(join(dir, mk.dir, f), 'utf8')), mk.col);
    const r = lastYearUsd(means, mk.perKwh, mk.cur === 'EUR' ? ones : rates[mk.cur], rates.USD);
    if (r) out[mk.cc] = { ...r, market: mk.market };
    console.log(mk.cc.padEnd(3), mk.market.padEnd(9), r ? `$${r.usd}/kWh  ${r.from} → ${r.to}` : 'not enough months');
  }
  const src = `/* Generated by scripts/wholesale-prices.mjs on ${new Date().toISOString().slice(0, 10)} — do not edit by hand.
   Wholesale (day-ahead) power, US dollars per kWh, the last twelve months in the
   Global Day-Ahead Electricity Price Dataset (Zenodo 16284828, CC BY 4.0),
   each month at the ECB's average rate. Wholesale, not what industry pays. */
export const WHOLESALE = ${JSON.stringify(out)};
`;
  if (process.argv.includes('--write')) { writeFileSync(OUT, src); console.log('wrote', OUT.pathname); }
}
