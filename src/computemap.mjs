/* ==========================================================================
   pumpbubble.fun — the data behind the Compute tab's map view.

   Asked for on 2026-10-18 as "a dark global map with places of data centers
   and energy costs — something that lets you see more about compute power
   or pick cheaper", and on 2026-10-19 moved into the Compute tab ("not a new
   page"), made zoomable, and given every country's power price that open
   data has, in dollars. /api/compute/map serves it; public/compute-map.js
   draws it. What goes in:

   - Akash's GPU providers, live: every online provider with its position,
     GPUs and models. Akash's console publishes them keyless — 1,867
     providers in a 3.8 MB answer — so they are read in the ComputeDO (a
     Worker request has 10 ms of CPU; parsing that is more) at most every 30
     minutes. Positions are Akash's own IP geolocation: a city, not a building.
   - The big clouds' regions and the AI megaprojects (src/datacenters.mjs).
   - Power, per country (ISO alpha-2) and per US state, in US dollars per kWh:
     industrial prices where they are published openly (Eurostat for Europe,
     EIA for the US — src/powerprices.mjs), and the wholesale day-ahead price
     for seven markets with no open industrial figure (src/wholesale.mjs). The
     two are never mixed silently: every country says which it is, and the
     map draws wholesale-only countries striped. No country is guessed.
   - How clean each grid is: carbon intensity and low-carbon share, Ember via
     Our World in Data (src/gridmix.mjs), 213 countries.
   - The cheapest GPU-hour: Akash's posted price per model, where that model
     is offered, and an hour of its power there — board watts × 1.3 for
     cooling. Only models whose power draw is published are costed.

   Every string from Akash's provider list is written by whoever runs the
   provider: the host is the hostname of its own URL, region and country are
   cleaned, models must look like model names, and the page escapes them all.
   ========================================================================== */

import { GPUS } from './compute.mjs';
import { POWER } from './powerprices.mjs';
import { WHOLESALE } from './wholesale.mjs';
import { TARIFFS } from './tariffs.mjs';
import { GRID } from './gridmix.mjs';
import { METROS, PROJECTS, US_STATES } from './datacenters.mjs';

export const PROVIDERS_URL = 'https://console-api.akash.network/v1/providers';
export const SITES_TTL = 30 * 60_000;
export const PUE = 1.3;

/* Board power per GPU in watts, as NVIDIA publishes it (SXM boards; the
   RTX PRO 6000 at its 600 W). A model not listed here is not costed. */
export const WATTS = { h100: 700, h200: 700, a100: 400, b200: 1000, rtx4090: 450, rtx5090: 575, pro6000: 600 };
export const kwhPerHour = id => WATTS[id] ? (WATTS[id] * PUE) / 1000 : null;

/* For the earnings view. Akash's take on USDC leases since governance
   proposal 267 (Sept 2024); miners at Bitmain's published hashrate and
   efficiency — power = TH/s × J/TH. */
export const AKASH_FEE = 0.02;
export const MINERS = [
  { id: 's21', name: 'Antminer S21', th: 200, jth: 17.5 },
  { id: 's21pro', name: 'Antminer S21 Pro', th: 234, jth: 15 },
  { id: 's21xp', name: 'Antminer S21 XP', th: 270, jth: 13.5 },
];

/* free text from a provider: printable, no markup characters, short */
const clean = (s, n = 40) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };
export const ccOf = c => { const u = String(c || '').toUpperCase(); return /^[A-Z]{2}$/.test(u) ? u : ''; };

const STATE_NAME = Object.fromEntries(Object.entries(US_STATES).map(([n, c]) => [c, n]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = ym => { const [y, m] = String(ym).split('-'); return MONTHS[+m - 1] + ' ' + y; };
const semLabel = p => { const m = /^(\d{4})-S([12])$/.exec(p || ''); return m ? (m[2] === '1' ? 'H1 ' : 'H2 ') + m[1] : String(p || ''); };

/* What power costs at a place, best source first: the state's industrial
   price in the US, the country's statistical industrial price, a published
   tariff (src/tariffs.mjs), the wholesale price, or nothing. */
export function powerAt(cc, st) {
  if (cc === 'US' && st && POWER.states[st] != null) return { usd: POWER.states[st], kind: 'industrial', where: STATE_NAME[st] || st };
  const c = POWER.countries[cc];
  if (c) return { usd: c.usd, kind: 'industrial', where: cc };
  const t = TARIFFS.countries[cc];
  if (t) return { usd: t.usd, kind: 'tariff', where: cc };
  const w = WHOLESALE[cc];
  return w ? { usd: w.usd, kind: 'wholesale', where: cc } : null;
}

/* Every country something is known about, one object each — what the map
   colours and what a country's card says. */
export function countryData() {
  const out = {};
  const at = cc => (out[cc] = out[cc] || {});
  for (const [cc, c] of Object.entries(POWER.countries)) Object.assign(at(cc), { ind: c.usd, indP: c.src === 'eia' ? c.period : semLabel(c.period) });
  for (const [cc, t] of Object.entries(TARIFFS.countries)) Object.assign(at(cc), { tar: t.usd, tarP: monthLabel(t.ym), tarWhat: t.what, tarSrc: t.src });
  for (const [cc, w] of Object.entries(WHOLESALE)) Object.assign(at(cc), { whl: w.usd, whlP: monthLabel(w.from) + ' – ' + monthLabel(w.to), whlM: w.market });
  for (const [cc, g] of Object.entries(GRID)) Object.assign(at(cc), { ...(g.co2 != null ? { co2: g.co2 } : {}), ...(g.lowc != null ? { lowc: g.lowc } : {}), gy: g.year });
  return out;
}

/* Akash model names → our GPU ids (h100, rtx4090, …), from the board's own map */
const MODEL_ID = {};
for (const g of GPUS) for (const [model] of g.akash || []) MODEL_ID[model] = g.id;

/* ------------------------------------------------------------- Akash */
export function akashSites(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !p.isOnline) continue;
    const lat = num(p.ipLat), lon = num(p.ipLon);
    if (lat == null || lon == null || Math.abs(lat) > 85 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    let host = '';
    try { host = new URL(String(p.hostUri || '')).hostname.toLowerCase(); } catch { /* none */ }
    if (!/^[a-z0-9.-]{3,80}$/.test(host)) host = '';
    const g = (p.stats && p.stats.gpu) || {};
    const models = [...new Set((Array.isArray(p.gpuModels) ? p.gpuModels : [])
      .map(m => String((m && m.model) || '').toLowerCase()).filter(m => /^[a-z0-9]{2,16}$/.test(m)))];
    const cc = ccOf(p.ipCountryCode);
    const region = clean(p.ipRegion, 40);
    out.push({
      host, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100,
      cc, country: clean(p.ipCountry, 40), region,
      st: cc === 'US' ? (US_STATES[region] || '') : '',
      gpus: Math.max(0, Math.round(num(g.total) || 0)), free: Math.max(0, Math.round(num(g.available) || 0)),
      models, up7d: num(p.uptime7d) != null ? Math.round(num(p.uptime7d) * 1000) / 10 : null,
      audited: !!p.isAudited,
    });
  }
  return out.sort((a, b) => b.gpus - a.gpus || b.free - a.free);
}

/* Akash's GPU utilization by model on the newest day each model has: a
   model can be several rows a day (an A100 with 40 or 80 GB), so the day's
   rows are summed — leased over total. */
export function akashUtil(rows) {
  const days = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const m = String((r && r.model) || '').toLowerCase(), d = String((r && r.date) || '');
    if (!/^[a-z0-9]{2,16}$/.test(m) || !(+r.totalGpus > 0)) continue;
    const k = (days[m] = days[m] || {});
    (k[d] = k[d] || { total: 0, leased: 0 });
    k[d].total += +r.totalGpus; k[d].leased += Math.max(0, +r.leasedGpus || 0);
  }
  const out = {};
  for (const [m, byDay] of Object.entries(days)) {
    const d = Object.keys(byDay).sort().pop(), x = byDay[d];
    out[m] = { util: Math.round(Math.min(1, x.leased / x.total) * 1000) / 1000, total: x.total, leased: x.leased, date: d.slice(0, 10) };
  }
  return out;
}

/* What one TH/s earns in a day: the last 144 blocks' reward (subsidy and
   fees) at today's price, spread over the network's hashrate. */
export function hashprice({ rewardSats, blocks = 144, priceUsd, hashrateHs }) {
  if (!(rewardSats > 0) || !(priceUsd > 0) || !(hashrateHs > 0)) return null;
  const btcPerDay = (rewardSats / 1e8) * (144 / blocks);
  return { usdPerThDay: btcPerDay * priceUsd / (hashrateHs / 1e12), btcPerDay, priceUsd, hashrateEh: hashrateHs / 1e18 };
}

const getJson = async (fetcher, url, ms = 15_000) => {
  const r = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 pumpbubble.fun/1.0' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(new URL(url).host + ' ' + r.status);
  return r.json();
};

/* Utilization and the hashprice, each allowed to fail without the other */
export async function readMarket(fetcher = fetch, now = Date.now()) {
  const out = { at: now, util: null, btc: null, errors: {} };
  await Promise.all([
    getJson(fetcher, 'https://console-api.akash.network/v1/gpu-breakdown').then(j => { out.util = akashUtil(j); }).catch(e => { out.errors.util = String(e.message).slice(0, 120); }),
    Promise.all([
      getJson(fetcher, 'https://mempool.space/api/v1/mining/reward-stats/144'),
      getJson(fetcher, 'https://mempool.space/api/v1/prices'),
      getJson(fetcher, 'https://mempool.space/api/v1/mining/hashrate/3d'),
    ]).then(([rw, px, hr]) => {
      const blocks = (+rw.endBlock - +rw.startBlock + 1) || 144;
      out.btc = hashprice({ rewardSats: +rw.totalReward, blocks, priceUsd: +px.USD, hashrateHs: +hr.currentHashrate });
    }).catch(e => { out.errors.btc = String(e.message).slice(0, 120); }),
  ]);
  return out;
}

export async function readAkashSites(fetcher = fetch, now = Date.now()) {
  const r = await fetcher(PROVIDERS_URL, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 pumpbubble.fun/1.0' }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error('akash providers ' + r.status);
  const sites = akashSites(await r.json());
  if (!sites.length) throw new Error('akash providers: none online');
  return { at: now, sites, market: await readMarket(fetcher, now).catch(() => null) };
}

/* ---------------------------------------------------------- the payload */
/* Every GPU model the board prices: the posted price, where on the map it is
   offered, and an hour of its power at the cheapest of those places. */
export function cheapGpus(feed, sites) {
  const rows = [];
  for (const g of (feed && feed.gpus) || []) {
    if (g.usdPerHour == null) continue;
    const at = (sites || []).filter(s => s.models.some(m => MODEL_ID[m] === g.id));
    const priced = at.map(s => ({ s, p: powerAt(s.cc, s.st) })).filter(x => x.p).sort((a, b) => a.p.usd - b.p.usd);
    const k = kwhPerHour(g.id);
    rows.push({
      id: g.id, model: g.model, usd: g.usdPerHour, from: g.fromUsdPerHour, free: g.gpusFree, listed: g.gpusListed,
      ccs: [...new Set(at.map(s => s.cc).filter(Boolean))],
      power: k && priced.length ? { usd: Math.round(k * priced[0].p.usd * 1000) / 1000, cc: priced[0].s.cc, st: priced[0].s.st, kind: priced[0].p.kind } : null,
    });
  }
  return rows.sort((a, b) => (a.from ?? a.usd) - (b.from ?? b.usd));
}

export function mapPayload({ sites = null, feed = null, error = '', now = Date.now() } = {}) {
  const S = (sites && sites.sites) || [];
  return {
    at: now, sitesAt: (sites && sites.at) || null, error: error || '',
    sites: S, metros: METROS, projects: PROJECTS,
    countries: countryData(), states: POWER.states, stateNames: STATE_NAME, regions: TARIFFS.regions,
    market: (sites && sites.market) || null, miners: MINERS, akashFee: AKASH_FEE, watts: WATTS,
    gpus: cheapGpus(feed, S),
    h100: kwhPerHour('h100'), pue: PUE,
    asOf: { industrial: POWER.asOf, us: POWER.usPeriod },
  };
}
