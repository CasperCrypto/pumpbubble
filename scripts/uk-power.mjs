#!/usr/bin/env node
/* ==========================================================================
   Builds src/ukpower.mjs — what electricity costs a big industrial buyer in
   the United Kingdom, the one large market Eurostat stopped covering.

       node scripts/uk-power.mjs <table_341.xlsx>           # prints
       node scripts/uk-power.mjs <table_341.xlsx> --write

   The workbook is DESNZ's "Gas and electricity prices in the non-domestic
   sector", table 3.4.1, from
   https://www.gov.uk/government/statistical-data-sets/gas-and-electricity-prices-in-the-non-domestic-sector
   (Open Government Licence v3.0 — reuse with the source acknowledged). Its
   address changes with every quarterly release, so it is downloaded by hand
   and passed in; re-run each quarter.

   Which number, and why:
   - **Very Large** (70,000–150,000 MWh a year) — the same band as the
     Eurostat figure every European country on the map uses (70–150 GWh).
   - **Including the Climate Change Levy** (sheet 3.4.2): Eurostat's figure
     excludes VAT and *recoverable* taxes only, so a levy a business cannot
     reclaim belongs in it.
   - Pence to dollars at the ECB's average rates for the quarter's months
     (dollars per euro over pounds per euro).

   No dependencies: an .xlsx is a zip of XML, read here with node:zlib.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const OUT = new URL('../src/ukpower.mjs', import.meta.url);
const SHEET = '3.4.2 (incl CCL)';
const COLUMN = 'Electricity: Very Large';

/* Every file in a zip, by its central directory. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + ln + le, off + 30 + ln + le + size);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 46 + nl + el + cl;
  }
  return out;
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/* One sheet as rows of cell values, shared strings resolved. */
export function sheetRows(files, name) {
  const wb = files['xl/workbook.xml'].toString();
  const rels = files['xl/_rels/workbook.xml.rels'].toString();
  const sh = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => m[0]).find(t => unxml((/name="([^"]*)"/.exec(t) || [])[1] || '') === name);
  if (!sh) throw new Error('no sheet ' + name);
  const rid = /r:id="([^"]+)"/.exec(sh)[1];
  const target = new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"').exec(rels)
    || new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + rid + '"').exec(rels);
  const path = 'xl/' + target[1].replace(/^\/?xl\//, '');
  const ss = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml'].toString().matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''))) : [];
  const col = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const rows = [];
  for (const r of files[path].toString().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (/r="([A-Z]+\d+)"/.exec(c[1]) || [])[1];
      if (!ref) continue;
      const t = (/t="([^"]+)"/.exec(c[1]) || [])[1];
      const v = c[2] ? ((/<v>([\s\S]*?)<\/v>/.exec(c[2]) || [])[1] ?? (/<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2]) || [])[1]) : undefined;
      if (v == null) continue;
      row[col(ref)] = t === 's' ? ss[+v] : t === 'str' || t === 'inlineStr' ? unxml(v) : +v;
    }
    rows.push(row);
  }
  return rows;
}

/* The newest quarter with a value in the column, in pence per kWh. */
export function latestQuarter(rows, column = COLUMN) {
  const head = rows.find(r => r && r[0] === 'Year');
  if (!head) throw new Error('no header row');
  const ci = head.findIndex(h => typeof h === 'string' && h.startsWith(column));
  if (ci < 0) throw new Error('no column ' + column);
  const qn = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
  let best = null;
  for (const r of rows) {
    const y = typeof r[0] === 'number' ? r[0] : parseInt(r[0], 10);
    const q = qn[String(r[1] || '').replace(/[^0-9a-z]/gi, '').slice(0, 3)] || qn[String(r[1] || '').trim().slice(0, 3)];
    if (!(y > 2000) || !q || !(typeof r[ci] === 'number' && r[ci] > 0)) continue;
    if (!best || y * 10 + q > best.y * 10 + best.q) best = { y, q, pence: r[ci], provisional: /p/i.test(String(r[1])) };
  }
  if (!best) throw new Error('no quarter with a value');
  return best;
}

const months = (y, q) => [1, 2, 3].map(i => `${y}-${String((q - 1) * 3 + i).padStart(2, '0')}`);

if (process.argv[1] && process.argv[1].endsWith('uk-power.mjs')) {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: node scripts/uk-power.mjs <table_341.xlsx> [--write]'); process.exit(1); }
  const q = latestQuarter(sheetRows(unzip(readFileSync(file)), SHEET));
  const ecb = cur => `https://data-api.ecb.europa.eu/service/data/EXR/M.${cur}.EUR.SP00.A?startPeriod=${q.y - 1}-01&format=jsondata`;
  const monthly = async cur => {
    const j = await (await fetch(ecb(cur), { headers: { accept: 'application/json' } })).json();
    const s = Object.values(j.dataSets[0].series)[0].observations, d = j.structure.dimensions.observation[0].values;
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [d[+k].id, v[0]]));
  };
  const [usd, gbp] = await Promise.all([monthly('USD'), monthly('GBP')]);
  const r = months(q.y, q.q).map(m => usd[m] && gbp[m] ? usd[m] / gbp[m] : null).filter(Boolean);
  if (!r.length) throw new Error('no ECB rate for ' + q.y + ' Q' + q.q);
  const usdPerGbp = r.reduce((a, b) => a + b, 0) / r.length;
  const data = {
    asOf: new Date().toISOString().slice(0, 10),
    usd: Math.round(q.pence / 100 * usdPerGbp * 10000) / 10000,
    pence: Math.round(q.pence * 100) / 100, usdPerGbp: Math.round(usdPerGbp * 10000) / 10000,
    period: `${q.y}-Q${q.q}`, provisional: q.provisional,
    what: 'DESNZ table 3.4.2, Very Large band (70–150 GWh/yr), incl. Climate Change Levy, excl. VAT',
    src: 'https://www.gov.uk/government/statistical-data-sets/gas-and-electricity-prices-in-the-non-domestic-sector',
  };
  const body = `/* Generated by scripts/uk-power.mjs on ${data.asOf} — do not edit by hand; re-run it each quarter.
   UK industrial electricity: ${data.what}, ${data.period}.
   Contains public sector information licensed under the Open Government Licence v3.0. */
export const UK_POWER = ${JSON.stringify(data)};
`;
  console.log(`${data.period}: ${data.pence}p/kWh = $${data.usd}/kWh at $${data.usdPerGbp}/£`);
  if (process.argv.includes('--write')) { writeFileSync(OUT, body); console.log('wrote', OUT.pathname); }
}
