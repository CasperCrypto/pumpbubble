#!/usr/bin/env node
/* ==========================================================================
   Builds src/minerals.mjs — who mines and who holds the minerals AI, robots,
   batteries and weapons are made of, by country.

       node scripts/minerals.mjs            # prints
       node scripts/minerals.mjs --write

   Source: USGS Mineral Commodity Summaries 2026 data release
   (doi:10.5066/P1WKQ63T, ScienceBase item 696a75d5d4be0228872d3bf8). US
   government work, public domain. Three of its files:

   - MCS2026_Commodities_Data.csv — world mine (or refinery, smelter) production
     for 2024 and 2025 and reserves, by country, per commodity;
   - MCS2026_Fig2_Net_Import_Reliance.csv — how much of each the United States
     imports, and from whom;
   - MCS2026_T4_Country_Export_Control.csv — export bans and controls in force.

   USGS's own markers keep their meaning: "—" is zero; "NA", "W" (withheld)
   and words like "Large" are unknown, never zero; ">21,000,000" is kept as a
   floor (`gt`). Germanium is absent because USGS withholds it by country.
   Re-run when the next edition lands (each February).
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';

const ITEM = '696a75d5d4be0228872d3bf8';
const OUT = new URL('../src/minerals.mjs', import.meta.url);
const UA = 'pumpbubble.fun/1.0 (minerals)';

/* What is on the map, grouped by what it goes into. `prod` and `res` name the
   USGS Statistics_detail rows; `use` is plain words for the card. */
export const PICK = [
  { id: 'ree', c: 'Rare Earths', name: 'Rare earths', group: 'Magnets & robots', prod: 'Mine production', res: 'Reserves', unit: 't REO',
    use: 'Permanent magnets (NdFeB) in EV and robot motors, wind turbines, drones and missiles' },
  { id: 'li', c: 'Lithium', name: 'Lithium', group: 'Batteries & EVs', prod: 'Mine production', res: 'Reserves', unit: 't Li',
    use: 'Lithium-ion batteries: EVs, phones, grid storage, data-center backup' },
  { id: 'co', c: 'Cobalt', name: 'Cobalt', group: 'Batteries & EVs', prod: 'Mine production', res: 'Reserves', unit: 't Co',
    use: 'Battery cathodes (NMC), superalloys for jet engines' },
  { id: 'ni', c: 'Nickel', name: 'Nickel', group: 'Batteries & EVs', prod: 'Mine production', res: 'Reserves', unit: 't Ni',
    use: 'High-energy battery cathodes, stainless steel' },
  { id: 'gr', c: 'Graphite (Natural)', name: 'Graphite', group: 'Batteries & EVs', prod: 'Mine production', res: 'Reserves', unit: 't',
    use: 'Battery anodes — every lithium-ion cell has one' },
  { id: 'mn', c: 'Manganese', name: 'Manganese', group: 'Batteries & EVs', prod: 'Mine production', res: 'Reserves', unit: 't Mn',
    use: 'Steel, and LMFP / NMC battery cathodes' },
  { id: 'cu', c: 'Copper', name: 'Copper', group: 'Chips & AI data centers', prod: 'Mine production', res: 'Reserves', ref: 'Refinery production', unit: 't Cu',
    use: 'Every wire: grids, data centers, motors, chips’ interconnects' },
  { id: 'ga', c: 'Gallium', name: 'Gallium', group: 'Chips & AI data centers', prod: 'Primary production', unit: 't',
    use: 'GaN and GaAs chips: AI power supplies, 5G, radar, LEDs' },
  { id: 'si', c: 'Silicon', name: 'Silicon metal', group: 'Chips & AI data centers', prod: 'Silicon metal', unit: 't',
    use: 'Chips and solar wafers start as silicon metal' },
  { id: 'sn', c: 'Tin', name: 'Tin', group: 'Chips & AI data centers', prod: 'Mine production', res: 'Reserves', unit: 't Sn',
    use: 'Solder — every circuit board' },
  { id: 'in', c: 'Indium', name: 'Indium', group: 'Chips & AI data centers', prod: 'Refinery production', unit: 't',
    use: 'Touchscreens (ITO), indium phosphide chips for AI optical links' },
  { id: 'w', c: 'Tungsten', name: 'Tungsten', group: 'Defense & aerospace', prod: 'Mine production', res: 'Reserves', unit: 't W',
    use: 'Armor-piercing rounds, cutting tools, chip-making' },
  { id: 'sb', c: 'Antimony', name: 'Antimony', group: 'Defense & aerospace', prod: 'Mine production', res: 'Reserves', unit: 't Sb',
    use: 'Ammunition primers, flame retardants, night-vision' },
  { id: 'ti', c: 'Titanium Sponge Metal', name: 'Titanium', group: 'Defense & aerospace', prod: 'Titanium sponge metal production', unit: 't',
    use: 'Airframes, jet engines, implants' },
  { id: 'mg', c: 'Magnesium Metal', name: 'Magnesium', group: 'Defense & aerospace', prod: 'Smelter production', unit: 't',
    use: 'Light alloys for cars and aircraft; aluminum alloys need it' },
  { id: 'au', c: 'Gold', name: 'Gold', group: 'Stores of value', prod: 'Mine production', res: 'Reserves', unit: 't',
    use: 'Central-bank reserves, jewelry, electronics' },
  { id: 'ag', c: 'Silver', name: 'Silver', group: 'Stores of value', prod: 'Mine production', res: 'Reserves', unit: 't',
    use: 'Solar cells (the largest industrial use), electronics, investment' },
  { id: 'pt', c: 'Platinum', name: 'Platinum', group: 'Stores of value', prod: 'Mine production: Platinum', resC: 'Platinum-Group Metals', res: 'PGM reserves', unit: 't',
    use: 'Catalysts, hydrogen electrolysers and fuel cells' },
];

/* USGS's import-reliance names, matched by prefix */
const IMPORT_NAME = {
  ree: 'RARE EARTHS', li: 'LITHIUM', co: 'COBALT', ni: 'NICKEL', gr: 'GRAPHITE (NATURAL)', mn: 'MANGANESE', cu: 'COPPER, refined',
  ga: 'GALLIUM', si: 'SILICON', sn: 'TIN', in: 'INDIUM', w: 'TUNGSTEN', sb: 'ANTIMONY', ti: 'TITANIUM, sponge', mg: 'MAGNESIUM METAL',
  au: 'GOLD', ag: 'SILVER', pt: 'PLATINUM',
};

/* USGS country names the map's Natural Earth names do not match */
const ALIAS = {
  'Burma': 'MM', 'Congo (Kinshasa)': 'CD', 'Congo (Brazzaville)': 'CG', 'Korea, Republic of': 'KR', 'Korea, North': 'KP',
  'Republic of Korea': 'KR', 'Russia': 'RU', 'Laos': 'LA', 'Vietnam': 'VN', 'Iran': 'IR', 'Syria': 'SY', 'Czechia': 'CZ',
  'Côte d’Ivoire': 'CI', "Côte d'Ivoire": 'CI', 'Turkey': 'TR', 'Türkiye': 'TR', 'United States': 'US', 'United Kingdom': 'GB',
  'Tanzania': 'TZ', 'Bolivia': 'BO', 'Venezuela': 'VE', 'New Caledonia': 'NC', 'Greenland': 'GL', 'Bahrain': 'BH',
  'Hong Kong': 'HK', 'Taiwan': 'TW', 'Eswatini': 'SZ', 'Democratic Republic of the Congo': 'CD',
};

/* RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes */
export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift().map(h => h.replace(/^﻿/, '').trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/* USGS's files differ: the commodities file is Windows-1252 (an em dash is a
   lone 0x97), the export-controls file UTF-8 with a byte-order mark. Strict
   UTF-8 first, Windows-1252 only when that fails — decoding the controls file
   as 1252 turned its header into "ï»¿Country" and matched no country at all. */
export function decodeUsgs(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); }
  catch { return decode1252(buf); }
}
const CP1252 = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—', 0x99: '™' };
export function decode1252(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : (CP1252[b] || String.fromCharCode(b));
  return s;
}

/* A USGS value: number, zero ("—"), floor (">N"), or unknown (null). */
export function usgsValue(v) {
  const s = String(v || '').trim();
  if (s === '—' || s === '-' || s === '0') return { v: 0 };
  const m = /^(>)?\s*([\d,]+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[2].replace(/,/g, ''));
  return Number.isFinite(n) ? (m[1] ? { v: n, gt: true } : { v: n }) : null;
}

const toTons = (n, unit) => /^thousand metric/.test(unit) ? n * 1000 : /^kilograms/.test(unit) ? n / 1000 : /^million metric/.test(unit) ? n * 1e6 : n;
const round = n => n >= 100 ? Math.round(n) : Math.round(n * 100) / 100;

export function isoFor(name, names) {
  return ALIAS[name] || names.get(name.toLowerCase()) || '';
}

/* One commodity's countries, world total and the countries USGS lumps in "Other". */
export function commodity(rows, pick, names, missing = new Set()) {
  const W = rows.filter(r => r.Commodity === pick.c && /^World/.test(r.Section));
  const read = (detail, year, from = W) => {
    const by = {}; let world = null, other = null, gt = {};
    for (const r of from) {
      if (r.Year !== String(year)) continue;
      const d = r.Statistics_detail;
      if (d !== detail && d !== detail + ': rounded' && d.toLowerCase() !== (detail + ', rounded').toLowerCase()) continue;
      const val = usgsValue(r.Value);
      if (!val) continue;
      const t = round(toTons(val.v, r.Unit));
      if (r.Country === 'World total') { world = t; continue; }
      if (r.Country === 'Other countries') { other = t; continue; }
      if (d !== detail) continue;
      const cc = isoFor(r.Country, names);
      if (!cc) { missing.add(r.Country); continue; }
      by[cc] = (by[cc] || 0) + t;
      if (val.gt) gt[cc] = true;
    }
    return { by, world, other, gt };
  };
  const now = read(pick.prod, 2025), prev = read(pick.prod, 2024);
  const resRows = pick.resC ? rows.filter(r => r.Commodity === pick.resC && /^World/.test(r.Section)) : W;
  const res = pick.res ? read(pick.res, 2025, resRows) : null;
  const ref = pick.ref ? read(pick.ref, 2025) : null;
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0) || null;
  const world = now.world || sum(now.by);
  /* Shares divide by the larger of USGS's rounded world total and what its
     own rows add up to: gallium's world is "900,000 kg, rounded" while China
     alone is 900,000 and Japan and Russia add 9,000 — dividing by the rounded
     total printed China at 100%. */
  const base = Math.max(world || 0, (sum(now.by) || 0) + (now.other || 0)) || null;
  return {
    year: 2025,
    prod: now.by, prodPrev: prev.by,
    world, base, worldPrev: prev.world || sum(prev.by), other: now.other,
    ...(res ? { res: res.by, resWorld: res.world || sum(res.by), resGt: Object.keys(res.gt) } : {}),
    ...(ref ? { ref: ref.by, refWorld: ref.world || sum(ref.by) } : {}),
  };
}

export function importReliance(rows, id) {
  const want = IMPORT_NAME[id];
  if (!want) return null;
  const r = rows.find(x => String(x.Commodity || '').toUpperCase().startsWith(want.toUpperCase()));
  if (!r) return null;
  const s = String(r.Net_Import_Reliance_pct_2025 || '').trim();
  const m = /^([<>])?\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (/^E$/i.test(s)) return { pct: 0, exporter: true, from: r.Major_Import_Sources_2021_24 || '' };
  return m ? { pct: +m[2], ...(m[1] ? { bound: m[1] } : {}), from: String(r.Major_Import_Sources_2021_24 || '').slice(0, 80) } : null;
}

export function controls(rows, names, missing = new Set()) {
  const out = {};
  for (const r of rows) {
    const cc = isoFor(String(r.Country || '').trim(), names);
    if (!cc) { if (r.Country) missing.add(r.Country); continue; }
    (out[cc] = out[cc] || []).push({
      type: String(r.Control_Type || '').trim().slice(0, 90),
      what: String(r.Commodity_Year || '').trim().slice(0, 400),
      src: /^https:\/\//.test(r.Data_source || '') ? String(r.Data_source).slice(0, 300) : '',
    });
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('minerals.mjs')) {
  const item = await (await fetch(`https://www.sciencebase.gov/catalog/item/${ITEM}?format=json`, { headers: { 'user-agent': UA } })).json();
  const file = name => {
    const f = (item.files || []).find(x => x.name === name);
    if (!f) throw new Error('ScienceBase item has no ' + name);
    return f.url;
  };
  const get = async name => decodeUsgs(Buffer.from(await (await fetch(file(name), { headers: { 'user-agent': UA } })).arrayBuffer()));
  const [data, fig2, t4] = await Promise.all([get('MCS2026_Commodities_Data.csv'), get('MCS2026_Fig2_Net_Import_Reliance.csv'), get('MCS2026_T4_Country_Export_Control.csv')]);
  const world = JSON.parse(readFileSync(new URL('../public/world-110m.json', import.meta.url), 'utf8'));
  const names = new Map(world.countries.filter(c => c.a2 && c.n).map(c => [c.n.toLowerCase(), c.a2]));
  const rows = parseCsv(data), imp = parseCsv(fig2), ctl = parseCsv(t4);
  const missing = new Set();
  const list = PICK.map(p => ({
    id: p.id, name: p.name, group: p.group, unit: p.unit, use: p.use,
    /* mined from the ground, or produced from a refinery or smelter */
    stage: /^Mine/.test(p.prod) ? 'mined' : 'produced',
    ...commodity(rows, p, names, missing),
    us: importReliance(imp, p.id),
  }));
  const out = { asOf: new Date().toISOString().slice(0, 10), edition: 'USGS Mineral Commodity Summaries 2026', doi: '10.5066/P1WKQ63T', list, controls: controls(ctl, names, missing) };
  for (const m of list) {
    const top = Object.entries(m.prod).sort((a, b) => b[1] - a[1])[0];
    console.log(m.name.padEnd(14), String(Object.keys(m.prod).length).padStart(2), 'countries · world', m.world, '· top', top && top[0], top && m.base ? Math.round(top[1] / m.base * 100) + '%' : '', '· US import', m.us ? (m.us.bound || '') + m.us.pct + '%' : '—');
  }
  if (missing.size) console.log('unmatched:', [...missing].join(', '));
  const body = `/* Generated by scripts/minerals.mjs on ${out.asOf} — do not edit by hand; re-run it.
   ${out.edition} data release (doi:${out.doi}), U.S. Geological Survey, public domain.
   Tonnes; production for 2024 and 2025 (2025 estimated), reserves 2025. */
export const MINERALS = ${JSON.stringify(out)};
`;
  console.log((body.length / 1024).toFixed(1) + ' KB');
  if (process.argv.includes('--write')) { writeFileSync(OUT, body); console.log('wrote', OUT.pathname); }
}
