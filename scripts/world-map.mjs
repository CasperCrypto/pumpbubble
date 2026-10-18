/* ==========================================================================
   Builds public/world-110m.json — the country outlines the compute map draws.

       node scripts/world-map.mjs          # prints what it would write
       node scripts/world-map.mjs --write

   Natural Earth's 1:110m countries (public domain), as TopoJSON from the
   world-atlas package (2.0.2, ISC — notice below), decoded here into plain
   rings so the page needs no TopoJSON code: every country is
   {id, a2, n, r: [[lon*10, lat*10, …], …]} in tenths of a degree, whole
   numbers, Antarctica left out (nothing there rents GPUs). About 60 KB.

   world-atlas: Copyright 2013-2019 Michael Bostock. Permission to use, copy,
   modify, and/or distribute this software for any purpose with or without fee
   is hereby granted, provided that the above copyright notice and this
   permission notice appear in all copies.
   ========================================================================== */

import { writeFileSync } from 'node:fs';

const SRC = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
const OUT = new URL('../public/world-110m.json', import.meta.url);

/* ISO 3166-1 numeric → alpha-2, for the countries the map can say something
   about (a power price, a data center, a GPU provider). Eurostat calls Greece
   EL and the UK UK; those are its codes, kept as it writes them. */
export const A2 = {
  '008': 'AL', '036': 'AU', '040': 'AT', '056': 'BE', '070': 'BA', '076': 'BR', '100': 'BG', '124': 'CA', '152': 'CL',
  '156': 'CN', '158': 'TW', '191': 'HR', '196': 'CY', '203': 'CZ', '208': 'DK', '233': 'EE', '246': 'FI', '250': 'FR',
  '268': 'GE', '276': 'DE', '300': 'EL', '344': 'HK', '348': 'HU', '352': 'IS', '356': 'IN', '360': 'ID', '372': 'IE',
  '376': 'IL', '380': 'IT', '392': 'JP', '398': 'KZ', '410': 'KR', '428': 'LV', '440': 'LT', '442': 'LU', '458': 'MY',
  '470': 'MT', '484': 'MX', '498': 'MD', '499': 'ME', '528': 'NL', '554': 'NZ', '578': 'NO', '608': 'PH', '616': 'PL',
  '620': 'PT', '634': 'QA', '642': 'RO', '643': 'RU', '682': 'SA', '688': 'RS', '702': 'SG', '703': 'SK', '704': 'VN',
  '705': 'SI', '710': 'ZA', '724': 'ES', '752': 'SE', '756': 'CH', '764': 'TH', '784': 'AE', '792': 'TR', '804': 'UA',
  '807': 'MK', '818': 'EG', '826': 'UK', '840': 'US', '048': 'BH', '032': 'AR', '170': 'CO', '604': 'PE',
};

export function decode(topo, objectName = 'countries') {
  const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
  /* arcs are delta-encoded, quantized positions */
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
  const arc = i => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
  const ring = idx => {
    const pts = [];
    for (const i of idx) { const a = arc(i); pts.push(...(pts.length ? a.slice(1) : a)); }
    return pts;
  };
  const out = [];
  for (const g of topo.objects[objectName].geometries) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    const rings = [];
    for (const p of polys) for (const r of p) rings.push(ring(r));
    out.push({ id: String(g.id ?? ''), name: (g.properties && g.properties.name) || '', rings });
  }
  return out;
}

/* A ring that crosses the antimeridian (Russia's Chukotka, Fiji) jumps from
   +180 to -180 and, drawn as it is, runs a line across the whole map. It is
   unwrapped into one continuous ring and cut into its two halves, each held
   at ±180 — at 1:110m, clamping is as good as clipping. */
export function splitDateline(r) {
  if (!r.some((p, i) => i && Math.abs(p[0] - r[i - 1][0]) > 180)) return [r];
  const u = r.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]);
  /* a run of points held at the edge keeps only its ends — the two places it
     crosses — or the held run draws a line down the edge of the map */
  const runs = h => h.filter((p, i) => Math.abs(p[0]) < 180 || i === 0 || i === h.length - 1
    || Math.abs(h[i - 1][0]) < 180 || Math.abs(h[i + 1][0]) < 180);
  const east = runs(u.map(([lon, lat]) => [Math.min(lon, 180), lat]));
  const west = runs(u.map(([lon, lat]) => [Math.max(lon - 360, -180), lat]));
  return [east, west].filter(h => h.some(([lon]) => Math.abs(lon) < 180));
}

/* tenths of a degree, consecutive duplicates dropped, rings under 3 points dropped */
export function compact(countries) {
  return countries.filter(c => c.id !== '010').map(c => ({
    id: c.id, a2: A2[c.id] || '', n: c.name,
    r: c.rings.flatMap(splitDateline).map(r => {
      const flat = [];
      let px = null, py = null;
      for (const [lon, lat] of r) {
        const x = Math.round(lon * 10), y = Math.round(lat * 10);
        if (x === px && y === py) continue;
        flat.push(x, y); px = x; py = y;
      }
      return flat;
    }).filter(f => f.length >= 6),
  })).filter(c => c.r.length);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('world-map.mjs')) {
  const topo = await (await fetch(SRC)).json();
  const countries = compact(decode(topo));
  const json = JSON.stringify({ v: 1, src: 'Natural Earth 1:110m (public domain), via world-atlas 2.0.2', countries });
  const named = countries.filter(c => c.a2).length;
  console.log(`${countries.length} countries (${named} with a code), ${countries.reduce((n, c) => n + c.r.reduce((m, r) => m + r.length / 2, 0), 0)} points, ${(json.length / 1024).toFixed(1)} KB`);
  if (process.argv.includes('--write')) { writeFileSync(OUT, json); console.log('wrote', OUT.pathname); }
}
