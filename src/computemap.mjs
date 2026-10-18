/* ==========================================================================
   pumpbubble.fun — the compute map: where GPUs are, what power costs there.

   Asked for on 2026-10-18 as "a dark global map with places of data centers
   and energy costs — something that lets you see more about compute power
   or pick cheaper". /compute-map, server-rendered like the other boards (a
   crawler gets every number as text) with the map drawn over it by
   public/compute-map.js. Four layers:

   - Akash's GPU providers, live: every online provider with its position,
     GPUs and models. Akash's console publishes them keyless — 1,867
     providers in a 3.8 MB answer, 58 online on the day this was built — so
     the reading happens in the ComputeDO (a Worker request has 10 ms of CPU;
     parsing that is more) at most every 30 minutes, and the page gets a few
     KB. Positions are Akash's own IP geolocation: a city, not a building.
   - The big clouds' regions and the AI megaprojects (src/datacenters.mjs),
     hand-kept with their sources.
   - Industrial electricity by country and US state (src/powerprices.mjs,
     generated from Eurostat, EIA and the ECB) — what industry pays on
     average, not what any data center has contracted, and the page says so.
     A place no source covers is grey, never guessed.
   - Cheapest GPU-hour: Akash's posted price per model (the same board the
     Compute tab's strip reads), where that model is offered, and what an
     hour of its power costs there — watts × 1.3 for cooling, at the local
     industrial price. Only models whose power draw is published are costed.

   Every string from Akash's provider list is written by whoever runs the
   provider, so the host is the hostname of its own URL, region and country
   are cleaned, models must look like model names, and all of it is escaped
   on the page — and the page carries a strict CSP.
   ========================================================================== */

import { layout, table, day } from './pages.mjs';
import { GPUS } from './compute.mjs';
import { POWER } from './powerprices.mjs';
import { METROS, PROJECTS, US_STATES } from './datacenters.mjs';

export const PROVIDERS_URL = 'https://console-api.akash.network/v1/providers';
export const SITES_TTL = 30 * 60_000;
export const PUE = 1.3;

/* Board power per GPU in watts, as NVIDIA publishes it (SXM boards; the
   RTX PRO 6000 at its 600 W). A model not listed here is not costed. */
export const WATTS = { h100: 700, h200: 700, a100: 400, b200: 1000, rtx4090: 450, rtx5090: 575, pro6000: 600 };

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/* free text from a provider: printable, no markup characters, short */
const clean = (s, n = 40) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };

/* Eurostat writes Greece EL and the UK UK; geolocation writes GR and GB */
export const ccOf = c => { const u = String(c || '').toUpperCase(); return u === 'GB' ? 'UK' : u === 'GR' ? 'EL' : /^[A-Z]{2}$/.test(u) ? u : ''; };

const STATE_NAME = Object.fromEntries(Object.entries(US_STATES).map(([n, c]) => [c, n]));

/* What power costs at a place: the state's price in the US, else the country's. */
export function powerAt(cc, st) {
  if (cc === 'US' && st && POWER.states[st] != null) return { cents: POWER.states[st], where: STATE_NAME[st] || st, src: 'eia' };
  const c = POWER.countries[cc];
  return c ? { cents: c.cents, where: cc, src: c.src, period: c.period } : null;
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

export async function readAkashSites(fetcher = fetch, now = Date.now()) {
  const r = await fetcher(PROVIDERS_URL, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 pumpbubble.fun/1.0' }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error('akash providers ' + r.status);
  const sites = akashSites(await r.json());
  if (!sites.length) throw new Error('akash providers: none online');
  return { at: now, sites };
}

/* ---------------------------------------------------------- the payload */
const kwh = id => WATTS[id] ? (WATTS[id] * PUE) / 1000 : null;

/* Every GPU model the board prices: the posted price, where on the map it is
   offered, and an hour of its power at the cheapest of those places. */
export function cheapGpus(feed, sites) {
  const rows = [];
  for (const g of (feed && feed.gpus) || []) {
    if (g.usdPerHour == null) continue;
    const at = (sites || []).filter(s => s.models.some(m => MODEL_ID[m] === g.id));
    const places = [];
    for (const s of at) {
      const p = powerAt(s.cc, s.st);
      places.push({ label: s.cc === 'US' && s.st ? (STATE_NAME[s.st] || s.st) + ', US' : (s.country || s.cc), cents: p ? p.cents : null, free: s.free });
    }
    const priced = places.filter(p => p.cents != null).sort((a, b) => a.cents - b.cents);
    const k = kwh(g.id);
    rows.push({
      id: g.id, model: g.model, usd: g.usdPerHour, from: g.fromUsdPerHour, free: g.gpusFree, listed: g.gpusListed,
      where: [...new Set(places.map(p => p.label))].slice(0, 6),
      power: k && priced.length ? { usd: Math.round(k * priced[0].cents) / 100, at: priced[0].label, cents: priced[0].cents } : null,
    });
  }
  return rows.sort((a, b) => (a.from ?? a.usd) - (b.from ?? b.usd));
}

/* The cheapest places to run a GPU by power, among those with a price: the
   US states that hold a data center on this map, and every priced country. */
export function cheapPower(sites, limit = 12) {
  const seen = new Map();
  for (const [cc, c] of Object.entries(POWER.countries)) if (cc !== 'US') seen.set(cc, { label: cc, cents: c.cents, src: c.src });
  const states = new Set([...METROS, ...PROJECTS, ...(sites || [])].filter(x => x.cc === 'US' && x.st).map(x => x.st));
  for (const st of states) if (POWER.states[st] != null) seen.set('US-' + st, { label: (STATE_NAME[st] || st) + ', US', cents: POWER.states[st], src: 'eia' });
  return [...seen.values()].sort((a, b) => a.cents - b.cents).slice(0, limit);
}

export function mapPayload({ sites = null, feed = null, error = '', now = Date.now() } = {}) {
  const S = (sites && sites.sites) || [];
  const at = (x) => ({ ...x, power: powerAt(x.cc, x.st) });
  return {
    at: now, sitesAt: sites && sites.at || null, error: error || '',
    sites: S.map(at), metros: METROS.map(at), projects: PROJECTS.map(at),
    gpus: cheapGpus(feed, S),
    power: { countries: Object.fromEntries(Object.entries(POWER.countries).map(([k, v]) => [k, v.cents])), asOf: POWER.asOf, usPeriod: POWER.usPeriod, usdPerEur: POWER.usdPerEur, fxDate: POWER.fxDate },
  };
}

/* -------------------------------------------------------------- the page */
const usd = v => v == null ? '—' : '$' + (+v).toFixed(2);
const cents = v => v == null ? '—' : (+v).toFixed(1) + '¢';
const COUNTRY = { UK: 'United Kingdom', EL: 'Greece', TR: 'Türkiye', NO: 'Norway', FR: 'France', PT: 'Portugal', FI: 'Finland', ES: 'Spain', SE: 'Sweden',
  BA: 'Bosnia and Herzegovina', MT: 'Malta', MK: 'North Macedonia', LV: 'Latvia', BE: 'Belgium', LT: 'Lithuania', BG: 'Bulgaria', SI: 'Slovenia', NL: 'Netherlands',
  DK: 'Denmark', RS: 'Serbia', AL: 'Albania', AT: 'Austria', DE: 'Germany', IT: 'Italy', RO: 'Romania', SK: 'Slovakia', PL: 'Poland', EE: 'Estonia', HU: 'Hungary',
  IE: 'Ireland', CZ: 'Czechia', CY: 'Cyprus', US: 'United States' };
const place = label => COUNTRY[label] || label;

/* the data for the map script; `<` escaped so a provider's text cannot end the script element */
const dataTag = payload => `<script type="application/json" id="cm-data">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;

export const MAP_CSP = "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function computeMapPage(payload, now = Date.now()) {
  const P = payload || mapPayload({ now });
  const gpusOn = P.sites.reduce((n, s) => n + s.gpus, 0), gpusFree = P.sites.reduce((n, s) => n + s.free, 0);
  const countries = new Set(P.sites.filter(s => s.gpus > 0).map(s => s.cc).filter(Boolean)).size;
  const regions = P.metros.reduce((n, m) => n + m.regions.length, 0);
  const gw = P.projects.reduce((n, p) => n + (p.gw || 0), 0);
  const power = cheapPower(P.sites);
  const top = P.gpus[0], h100 = P.gpus.find(g => g.id === 'h100');
  const lead = P.sites.length
    ? `As of ${esc(day(now))}, Akash's open market has <b>${gpusOn} GPUs online at ${P.sites.filter(s => s.gpus > 0).length} providers in ${countries} countries</b>, ${gpusFree} of them free${h100 ? `; an <b>H100</b> rents from <b>${usd(h100.from ?? h100.usd)} an hour</b>` : ''}. Industrial power is cheapest in <b>${esc(place(power[0] && power[0].label))}</b> at ${cents(power[0] && power[0].cents)} per kWh among the places with published prices.`
    : `The map of ${regions} cloud regions and ${P.projects.length} AI megaprojects, with what industrial power costs in each place. Akash's providers are being read.`;

  const map = `<style>
.cm{position:relative;margin:18px 0 6px;border:1px solid var(--line);border-radius:16px;background:radial-gradient(120% 90% at 50% 0%,#0d1422 0%,#070910 70%);overflow:hidden}
.cm canvas{display:block;width:100%;height:auto;touch-action:manipulation}
.cm-bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 10px 0}
.cm-bar button{font:700 12px/1 inherit;color:var(--dim);background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:999px;padding:7px 11px;cursor:pointer}
.cm-bar button.on{color:var(--ink);border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.09)}
.cm-bar .sep{flex:1}
.cm-k{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 12px 10px;font-size:12px;color:var(--dim)}
.cm-k i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.cm-k .grad{display:inline-block;width:90px;height:8px;border-radius:4px;background:linear-gradient(90deg,#1f9d6a,#c9b23a,#d9573f);margin:0 5px;vertical-align:0}
.cm-tip{position:absolute;pointer-events:none;max-width:260px;padding:9px 11px;border-radius:12px;background:rgba(9,12,20,.94);border:1px solid rgba(255,255,255,.16);font-size:12.5px;line-height:1.45;color:var(--ink);box-shadow:0 8px 30px rgba(0,0,0,.5)}
.cm-tip b{font-size:13.5px}.cm-tip .d{color:var(--dim)}
.cm-card{display:none;margin:8px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.03);font-size:14px}
@media (max-width:700px){.cm-tip{display:none!important}.cm-card.on{display:block}.cm-bar{gap:5px;padding:8px 8px 0}.cm-bar button{padding:6px 9px;font-size:11.5px}.cm-bar .sep{flex-basis:100%;height:0}}
.src{margin-top:34px;font-size:11px;line-height:1.5;color:#5d6678}.src a{color:#7d879a}
</style>
<div class="cm" id="cm">
<div class="cm-bar" role="toolbar" aria-label="Map layers and views">
<button data-l="sites" class="on">GPU providers</button><button data-l="metros" class="on">Cloud regions</button><button data-l="projects" class="on">AI megaprojects</button><button data-l="power" class="on">Power price</button>
<span class="sep"></span><button data-v="world" class="on">World</button><button data-v="na">N. America</button><button data-v="eu">Europe</button><button data-v="asia">Asia</button>
</div>
<canvas id="cm-c" width="1080" height="520" aria-label="World map of GPU providers, cloud regions and AI data centers, shaded by industrial power price"></canvas>
<div class="cm-tip" id="cm-tip" hidden></div>
<div class="cm-k"><span><i style="background:#3df09b"></i>Akash GPU provider (size: GPUs)</span><span><i style="background:#9fb7ff"></i>Cloud region</span><span><i style="background:#f5c542"></i>AI megaproject (size: GW)</span><span>Power <span class="grad"></span> 6¢ → 20¢+ per kWh · grey: no published price</span></div>
</div>
<div class="cm-card" id="cm-card"></div>
${dataTag(P)}
<script src="/compute-map.js" defer></script>
<noscript><p class="muted">The map needs JavaScript; every number on it is in the tables below.</p></noscript>`;

  const gpuTable = P.gpus.length ? `<h2>Cheapest GPU hour</h2>
<p class="muted">Posted on-demand prices on Akash, cheapest first. Power is one GPU at full draw, ×${PUE} for cooling, at the cheapest place on the map that offers it.</p>
${table([['GPU', 'n'], ['From $/h'], ['Typical $/h'], ['Free / listed'], ['Where', 'n'], ['Power $/h', '']],
    P.gpus.map(g => `<tr><td class="n"><b>${esc(g.model)}</b></td><td><b>${usd(g.from ?? g.usd)}</b></td><td>${usd(g.usd)}</td><td>${g.listed ? esc(String(g.free ?? '—')) + ' / ' + esc(String(g.listed)) : '—'}</td><td class="n">${g.where.length ? esc(g.where.join(' · ')) : '<span class="muted">—</span>'}</td><td>${g.power ? `${usd(g.power.usd)}<small class="muted"> in ${esc(place(g.power.at))}</small>` : '—'}</td></tr>`))}` : '';

  const powerTable = `<h2>Cheapest industrial power</h2>
<p class="muted">Average price paid by large industrial users (70–150 GWh a year in Europe), excluding VAT, in US cents per kWh. Places without a published price are left out.</p>
${table([['', 'r'], ['Place', 'n'], ['¢ per kWh'], ['An H100-hour of power']],
    power.map((p, i) => `<tr><td class="r">${i + 1}</td><td class="n">${esc(place(p.label))}</td><td><b>${cents(p.cents)}</b></td><td>${usd((kwh('h100') * p.cents) / 100)}</td></tr>`))}`;

  const projTable = `<h2>AI megaprojects</h2>
${table([['Campus', 'n'], ['Where', 'n'], ['Stated target'], ['Power there'], ['Status', 'n']],
    P.projects.map(p => `<tr><td class="n"><b>${esc(p.name)}</b><small>${esc(p.who)}</small></td><td class="n">${esc(p.city)}</td><td>${p.gw ? (p.gw >= 1 ? p.gw + ' GW' : Math.round(p.gw * 1000) + ' MW') : '—'}</td><td>${p.power ? cents(p.power.cents) : '—'}</td><td class="n" style="white-space:normal;min-width:220px">${esc(p.now)} <a href="${esc(p.src)}" rel="noopener nofollow">source</a></td></tr>`))}`;

  const siteTable = P.sites.length ? `<h2>Akash GPU providers</h2>
${table([['Provider', 'n'], ['Where', 'n'], ['GPUs'], ['Free'], ['Models', 'n'], ['Uptime 7d'], ['Power']],
    P.sites.filter(s => s.gpus > 0).slice(0, 30).map(s => `<tr><td class="n">${esc(s.host || '—')}${s.audited ? '<small>audited</small>' : ''}</td><td class="n">${esc([s.region, s.country].filter(Boolean).join(', ') || '—')}</td><td>${s.gpus}</td><td>${s.free}</td><td class="n">${esc(s.models.join(', ') || '—')}</td><td>${s.up7d != null ? esc(s.up7d) + '%' : '—'}</td><td>${s.power ? cents(s.power.cents) : '—'}</td></tr>`))}` : '';

  const sources = `<p class="src">Sources: GPU providers and prices — Akash Network console API (live; positions are its IP geolocation). Power — Eurostat, nrg_pc_205 (${esc(P.power.asOf)}); U.S. EIA, Electric Power Monthly table 5.6.B (${esc(P.power.usPeriod)}); euros converted at the ECB reference rate of ${esc(P.power.fxDate)}. Cloud regions — AWS, Google Cloud and Microsoft Azure region lists. Megaprojects — company announcements and trackers, linked in the table. Map — Natural Earth.</p>`;

  return layout({
    path: '/compute-map', now, live: '/?source=compute', ctaText: 'Compute bubbles →',
    title: 'Compute map: GPU providers, AI data centers and power prices worldwide',
    desc: `Live world map of GPU providers, ${regions} cloud regions and ${P.projects.length} AI megaprojects, shaded by industrial electricity price. Cheapest GPU hour and cheapest power, updated live.`,
    h1: 'Compute map',
    lead,
    stats: [[String(gpusOn || '—'), 'GPUs online on Akash'], [String(gpusFree || '—'), 'free right now'], [String(regions), 'cloud regions mapped'], [gw ? gw.toFixed(1) + ' GW' : '—', 'stated by AI megaprojects'],
      ...(top ? [[usd(top.from ?? top.usd), 'cheapest GPU-hour (' + top.model + ')']] : [])],
    body: map + gpuTable + powerTable + projTable + siteTable + sources,
    method: `<p>Akash's providers and their GPUs are read live from Akash Network's public console, at most every 30 minutes; a provider's position is Akash's IP geolocation of it, so a dot marks a city, not a building. GPU prices are what providers post on Akash's open market, not trades. Cloud regions are where AWS, Google Cloud and Azure say their regions are — a region is not a promise of GPUs. Megaproject capacities are what their owners have stated; a campus with no stated capacity shows a dash. Electricity is the average industrial price for the country (US: the state), not what any data center has contracted, and an hour of a GPU's power is its published board power × ${PUE} for cooling.</p>`,
    faq: [
      ['Where is the cheapest place to run a GPU?', power.length ? `By industrial power price among places with published data, ${place(power[0].label)} at ${cents(power[0].cents)} per kWh — one H100 at full draw costs about ${usd((kwh('h100') * power[0].cents) / 100)} an hour in power there. Rent is a much larger share: ${h100 ? `an H100 rents from ${usd(h100.from ?? h100.usd)} an hour on Akash` : 'see the GPU table'}.` : 'See the power table.'],
      ['How much electricity does an H100 use?', `About ${WATTS.h100} W at full load, so roughly ${(kwh('h100')).toFixed(2)} kWh an hour once cooling (×${PUE}) is counted.`],
      ['Where are the biggest AI data centers?', P.projects.filter(p => p.gw).sort((a, b) => b.gw - a.gw).slice(0, 4).map(p => `${p.name} (${p.city}, ${p.gw} GW stated)`).join('; ') + '.'],
    ],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Dataset', name: 'Compute map: GPU providers, cloud regions, AI data centers and power prices',
      description: 'Akash GPU providers (live), public cloud regions, AI megaprojects and industrial electricity prices by country and US state.',
      url: 'https://pumpbubble.fun/compute-map', isAccessibleForFree: true, dateModified: new Date(now).toISOString(),
      creator: { '@type': 'Organization', name: 'pumpbubble.fun', url: 'https://pumpbubble.fun' } }],
  });
}
