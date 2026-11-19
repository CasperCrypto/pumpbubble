/* ==========================================================================
   pumpbubble.fun — power prices that refresh themselves

   Until 2026-11-19 every price on the Compute map was a file generated once
   (src/powerprices.mjs, 2026-10-19) and re-run by hand. Nobody re-ran it, so
   the map would have aged a month at a time while saying nothing.

   Two refreshes, both keyless, both run by the ComputeDO (a Durable Object has
   30 s of CPU where a Worker request has 10 ms; EIA's table is 106 KB of HTML):

   - **Industrial prices**, twice a day: Eurostat nrg_pc_205 (a new semester
     about four months after it ends), U.S. EIA Electric Power Monthly table
     5.6.B (monthly), and the ECB's dollar rate — the same reads and the same
     arithmetic as scripts/power-prices.mjs, which now imports this file. A
     fresh read replaces the baked file only when it is at least as complete
     (`usable`), so a half-answer never greys countries that had a price.
   - **Wholesale day-ahead, Europe**, from Energy-Charts (Fraunhofer ISE; data
     from Bundesnetzagentur | SMARD.de, CC BY 4.0 — credited in the map's
     sources line). One request per market zone, and the API answers 429 to a
     burst (measured: ~25 calls), so it is read a few zones at a time, the
     stalest first, each zone at most once every twenty hours. The figure is
     the zone's average over the last seven days — a single day's price swings
     tenfold (Spain €34/MWh beside Germany's €225 on 2026-11-19) and is weather,
     not a place's cost. A country with several zones (Norway, Sweden, Italy,
     Denmark) shows their mean and the range.

   Wholesale is never ranked with industrial prices — the map's rule. It fills
   a country with no industrial figure (Switzerland, Montenegro) and rides on
   the card of every other one as a second, daily number.
   ========================================================================== */

import { US_STATES as STATES } from './datacenters.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0 (power-prices)';
export const EUROSTAT = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_pc_205?format=JSON&lang=EN&nrg_cons=MWH70000-149999&tax=X_VAT&currency=EUR&unit=KWH&sinceTimePeriod=2024-S2';
export const EIA = 'https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_b';
export const ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata';
export const ecbMonthlyUrl = (from = '2024-01') => `https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?startPeriod=${from}&format=jsondata`;
const EC = 'https://api.energy-charts.info/price';

/* ---------------------------------------------------------------- parsers */

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

/* The four reads, shaped like src/powerprices.mjs's POWER */
export function buildPower({ es, eia, fx, monthly, today }) {
  const eu = eurostatPrices(es), us = eiaPrices(eia);
  const countries = {};
  /* each semester's euros at that semester's average dollar rate; the latest daily rate only when the semester has none yet */
  for (const [cc, p] of Object.entries(eu)) {
    const rate = semesterRate(monthly, p.period) || fx.usdPerEur;
    countries[isoOf(cc)] = { usd: Math.round(p.eur * rate * 10000) / 10000, period: p.period, src: 'eurostat' };
  }
  if (us.cents.US) countries.US = { usd: Math.round(us.cents.US * 100) / 10000, period: us.period, src: 'eia' };
  const states = Object.fromEntries(Object.entries(us.cents).filter(([k]) => k !== 'US').map(([k, v]) => [k, Math.round(v * 100) / 10000]));
  return { asOf: today, euUpdated: es.updated || '', usPeriod: us.period, usdPerEur: fx.usdPerEur, fxDate: fx.date, countries, states };
}

/* A fresh read replaces the baked file only if it is at least as complete. */
export function usable(fresh, baked) {
  if (!fresh || !fresh.countries || !fresh.states) return false;
  const n = o => Object.keys(o || {}).length;
  return !!fresh.countries.US && n(fresh.countries) >= n(baked && baked.countries) - 2 && n(fresh.states) >= n(baked && baked.states) - 2;
}

async function get(fetcher, url, as, ms = 15000) {
  const r = await fetcher(url, { headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(new URL(url).host + ' ' + r.status);
  return as === 'json' ? r.json() : r.text();
}

export async function readIndustrial(fetcher = fetch, now = Date.now()) {
  const y = new Date(now).getUTCFullYear() - 2;
  const [es, eia, ecb, ecbM] = await Promise.all([
    get(fetcher, EUROSTAT, 'json'), get(fetcher, EIA, 'html'), get(fetcher, ECB, 'json'), get(fetcher, ecbMonthlyUrl(y + '-01'), 'json'),
  ]);
  return buildPower({ es, eia, fx: ecbRate(ecb), monthly: ecbMonthly(ecbM), today: new Date(now).toISOString().slice(0, 10) });
}

/* ----------------------------------------------------- day-ahead, Europe */

/* Energy-Charts' bidding zones, by the country they price. Luxembourg shares
   Germany's zone. */
export const DA_ZONES = {
  AT: ['AT'], BE: ['BE'], BG: ['BG'], CH: ['CH'], CZ: ['CZ'], DE: ['DE-LU'], LU: ['DE-LU'],
  DK: ['DK1', 'DK2'], EE: ['EE'], ES: ['ES'], FI: ['FI'], FR: ['FR'], GR: ['GR'], HR: ['HR'], HU: ['HU'],
  IT: ['IT-North', 'IT-South'], LT: ['LT'], LV: ['LV'], ME: ['ME'], NL: ['NL'],
  NO: ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'], PL: ['PL'], PT: ['PT'], RO: ['RO'], RS: ['RS'],
  SE: ['SE1', 'SE2', 'SE3', 'SE4'], SI: ['SI'], SK: ['SK'],
};
export const ALL_ZONES = [...new Set(Object.values(DA_ZONES).flat())];
export const DA_EVERY_MS = 20 * 3600_000;
export const DA_PER_STEP = 5;

const ymd = t => new Date(t).toISOString().slice(0, 10);

/* One zone's answer: the mean of every quarter-hour with a price, in €/MWh. */
export function zoneAverage(j) {
  const p = (j && Array.isArray(j.price) ? j.price : []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (p.length < 96) return null;                  // under a day of prices is not a week's average
  if (!/EUR\s*\/\s*MWh/i.test(String(j.unit || ''))) return null;
  const t = Array.isArray(j.unix_seconds) ? j.unix_seconds : [];
  return { eurMwh: Math.round(p.reduce((a, b) => a + b, 0) / p.length * 100) / 100, n: p.length, to: t.length ? ymd(t[t.length - 1] * 1000) : '' };
}

/* The stalest zones first, those never read before anything else. */
export function zonesDue(state, now = Date.now(), per = DA_PER_STEP) {
  const z = (state && state.zones) || {};
  return ALL_ZONES.filter(k => !z[k] || now - (z[k].at || 0) > DA_EVERY_MS)
    .sort((a, b) => ((z[a] && z[a].at) || 0) - ((z[b] && z[b].at) || 0)).slice(0, per);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Reads up to `per` due zones, one after another. A 429 stops the step: the
   rest wait for the next one. Returns the new state; never throws. */
export async function dayAheadStep(state, fetcher = fetch, now = Date.now(), { per = DA_PER_STEP, gap = 1500 } = {}) {
  const next = { zones: { ...((state && state.zones) || {}) }, at: now, error: '' };
  const start = ymd(now - 7 * 86400_000), end = ymd(now);
  let first = true;
  for (const zone of zonesDue(state, now, per)) {
    if (!first) await sleep(gap);
    first = false;
    try {
      const r = await fetcher(`${EC}?bzn=${encodeURIComponent(zone)}&start=${start}&end=${end}`, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.status === 429) { next.error = 'energy-charts 429'; break; }
      if (!r.ok) { next.error = 'energy-charts ' + r.status + ' ' + zone; next.zones[zone] = { ...(next.zones[zone] || {}), at: now, error: r.status }; continue; }
      const a = zoneAverage(await r.json());
      /* a zone with no usable week keeps its last good figure, marked read so it is not asked again at once */
      next.zones[zone] = a ? { ...a, at: now } : { ...(next.zones[zone] || {}), at: now };
    } catch (e) { next.error = String((e && e.message) || e).slice(0, 100); break; }
  }
  return next;
}

/* Per country, dollars per kWh at the given rate: the mean of its zones and
   their range. A zone figure older than ten days is not used. */
export function dayAheadByCountry(state, usdPerEur, now = Date.now()) {
  const z = (state && state.zones) || {}, out = {};
  if (!(usdPerEur > 0)) return out;
  for (const [cc, zones] of Object.entries(DA_ZONES)) {
    const got = zones.map(k => z[k]).filter(v => v && v.eurMwh != null && now - (v.at || 0) < 10 * 86400_000);
    if (!got.length) continue;
    const usd = got.map(v => v.eurMwh * usdPerEur / 1000);
    const r4 = v => Math.round(v * 10000) / 10000;
    out[cc] = {
      usd: r4(usd.reduce((a, b) => a + b, 0) / usd.length),
      lo: r4(Math.min(...usd)), hi: r4(Math.max(...usd)),
      zones: got.length, of: zones.length,
      to: got.map(v => v.to).filter(Boolean).sort().pop() || '',
    };
  }
  return out;
}

/* --------------------------------------------------------------- keeper */

/* The whole refresh as one portable piece: the ComputeDO holds one with its
   storage, server/dev.mjs one in memory. `current()` answers at once with what
   is stored and starts whatever is due in the background (`pending`). */
export const IND_EVERY_MS = 12 * 3600_000;
export const IND_RETRY_MS = 3600_000;
export const DA_STEP_MS = 20 * 60_000;

export class PowerKeeper {
  constructor(storage, fetcher = fetch) {
    this.storage = storage; this.fetcher = fetcher;
    this.mem = null; this.pending = null;
  }
  async load() {
    if (!this.mem) { try { this.mem = (await this.storage.get('power')) || {}; } catch { this.mem = {}; } }
    return this.mem;
  }
  async save() { try { await this.storage.put('power', this.mem); } catch { /* next refresh writes again */ } }
  due(now = Date.now()) {
    const m = this.mem || {};
    /* the retry gate applies before the first good read too, or a refusing
       source would be asked again on every map request */
    const ind = (!m.ind || now - (m.ind.readAt || 0) > IND_EVERY_MS) && now - (m.indTriedAt || 0) > IND_RETRY_MS;
    const da = now - ((m.da && m.da.at) || 0) > DA_STEP_MS && zonesDue(m.da, now).length > 0;
    return { ind, da };
  }
  async refresh(now = Date.now()) {
    const d = this.due(now);
    if (d.ind) {
      this.mem.indTriedAt = now;
      try { this.mem.ind = { ...(await readIndustrial(this.fetcher, now)), readAt: now }; this.mem.indError = ''; }
      catch (e) { this.mem.indError = String((e && e.message) || e).slice(0, 120); }
    }
    if (d.da) this.mem.da = await dayAheadStep(this.mem.da, this.fetcher, now);
    if (d.ind || d.da) await this.save();
  }
  async current(now = Date.now()) {
    await this.load();
    const d = this.due(now);
    if ((d.ind || d.da) && !this.pending) {
      this.pending = this.refresh(now).catch(() => {}).finally(() => { this.pending = null; });
    }
    return this.mem;
  }
}
