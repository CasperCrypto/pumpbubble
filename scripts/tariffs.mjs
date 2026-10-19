/* ==========================================================================
   Builds src/tariffs.mjs — published industrial tariffs and averages for
   places with no open statistical price, in US dollars per kWh.

       node scripts/tariffs.mjs          # prints
       node scripts/tariffs.mjs --write

   The table below is hand-kept: each row is a figure a utility, a regulator
   or a company filing published, in its own currency, with where it was
   read. The script only converts it, at the ECB's average rate for the
   figure's period. A row is a "tariff" on the map — what a big buyer pays
   by schedule — and says what it leaves out (China's rates are the energy
   charge alone, without the capacity charge). Asked for on 2026-10-19 ("also
   add energy prices — China etc.").

   Read 2026-10-19. Japan, Taiwan, Saudi Arabia, Malaysia, Kazakhstan and
   Iceland were looked for and left out: no current figure could be
   confirmed from a source that publishes it.
   ========================================================================== */

import { writeFileSync } from 'node:fs';

const OUT = new URL('../src/tariffs.mjs', import.meta.url);
const ECB = cur => `https://data-api.ecb.europa.eu/service/data/EXR/M.${cur}.EUR.SP00.A?startPeriod=2024-01&format=jsondata`;

/* China: two-part tariffs for large industry at ≥220 kV, the energy charge
   without TOU or the capacity charge, as of May 2025, from each province's
   published schedule as compiled by China Briefing. */
const CN_SRC = 'https://www.china-briefing.com/news/chinas-industrial-power-rates-category-electricity-usage-region-classification/';
export const CHINA = {
  Jiangsu: 0.556, Anhui: 0.584, 'Guangdong (Pearl River Delta)': 0.660, 'Guangdong (east and west)': 0.574, Shandong: 0.598, Shanxi: 0.441,
  Beijing: 0.590, Hebei: 0.590, Henan: 0.628, Zhejiang: 0.575, Shanghai: 0.579, Chongqing: 0.635, Sichuan: 0.514, Heilongjiang: 0.569,
  Liaoning: 0.571, Fujian: 0.555, 'Inner Mongolia (east)': 0.444, Jiangxi: 0.619, Hunan: 0.644, Shaanxi: 0.479, Xinjiang: 0.338,
  Guangxi: 0.462, Hainan: 0.680, Hubei: 0.572, Qinghai: 0.379, Ningxia: 0.371, Tianjin: 0.660, Guizhou: 0.552, Yunnan: 0.450, Shenzhen: 0.574,
};

/* [ISO, local price per kWh, currency, period (YYYY-MM the rate applies from or averages over), what it is, source] */
export const ROWS = [
  ['KR', 179.23, 'KRW', '2025-03', 'KEPCO’s average price for industrial power, Jan–Jun 2025 (its SEC filing)', 'https://www.sec.gov/Archives/edgar/data/0000887225/000119312525202690/d55270d6k.htm'],
  ['CA', 0.0682, 'CAD', '2026-04', 'Québec: what large industrial customers pay on average under Hydro-Québec’s Rate L (2026 filing)', 'https://www.ctvnews.ca/montreal/article/hydro-quebec-to-face-off-against-industry-actors-like-google-in-data-centre-hearing/'],
  ['ET', 0.040, 'USD', '2025-12', 'Ethiopian Electric Power’s tariff for crypto miners from 1 Dec 2025: 4¢ base, 6¢ from 18:00 to 22:00', 'https://shega.co/news/ethiopia-flirts-with-a-kazakhstan-moment-as-bitcoin-miners-weigh-exit'],
  ['PY', 0.03725 + 5.27 / 730, 'USD', '2026-01', 'ANDE’s 220 kV intensive-industry tariff at full load: $0.03725/kWh plus $5.27/kW a month', 'https://hashrateindex.com/blog/the-state-of-bitcoin-mining-in-paraguay-2026-2/'],
];

const median = xs => { const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const ecbMonthly = j => {
  const s = Object.values(j.dataSets[0].series)[0].observations;
  const dates = j.structure.dimensions.observation[0].values;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [dates[+k].id, v[0]]));
};
/* a month's rate, or the nearest earlier month the ECB has */
export function rateAt(monthly, ym) {
  const ks = Object.keys(monthly).filter(k => k <= ym).sort();
  return ks.length ? monthly[ks[ks.length - 1]] : null;
}
export const toUsd = (local, cur, ym, rates) => {
  if (cur === 'USD') return local;
  const perEur = rateAt(rates[cur], ym), usdPerEur = rateAt(rates.USD, ym);
  return perEur && usdPerEur ? local / perEur * usdPerEur : null;
};

if (process.argv[1] && process.argv[1].endsWith('tariffs.mjs')) {
  const rates = {};
  for (const cur of ['USD', 'CNY', 'KRW', 'CAD']) rates[cur] = ecbMonthly(await (await fetch(ECB(cur))).json());
  const r4 = v => Math.round(v * 10000) / 10000;
  const countries = {}, regions = {};
  for (const [cc, local, cur, ym, what, src] of ROWS) countries[cc] = { usd: r4(toUsd(local, cur, ym, rates)), local: +local.toFixed(5), cur, ym, what, src };
  regions.CN = Object.entries(CHINA).map(([name, cny]) => ({ name, usd: r4(toUsd(cny, 'CNY', '2025-05', rates)), local: cny })).sort((a, b) => a.usd - b.usd);
  const mid = median(Object.values(CHINA));
  countries.CN = { usd: r4(toUsd(mid, 'CNY', '2025-05', rates)), local: mid, cur: 'CNY', ym: '2025-05',
    what: `Median of ${regions.CN.length} provinces’ large-industry energy charge at ≥220 kV (May 2025), without the capacity charge`, src: CN_SRC };
  regions.CA = [{ name: 'Québec', usd: countries.CA.usd, local: countries.CA.local }];
  const src = `/* Generated by scripts/tariffs.mjs on ${new Date().toISOString().slice(0, 10)} — edit the table there, then re-run it.
   Published industrial tariffs and averages, US dollars per kWh (ECB rate for each figure's month). */
export const TARIFFS = ${JSON.stringify({ countries, regions })};
`;
  for (const [cc, c] of Object.entries(countries)) console.log(cc, '$' + c.usd, '(' + c.local + ' ' + c.cur + ')');
  console.log('China provinces', regions.CN.length, 'cheapest', regions.CN[0].name, '$' + regions.CN[0].usd);
  if (process.argv.includes('--write')) { writeFileSync(OUT, src); console.log('wrote', OUT.pathname); }
}
