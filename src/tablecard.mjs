/* ==========================================================================
   pumpbubble.fun — the leaderboard share card

   The bubble card is a picture of the map. Smart money is not a map any more —
   its two views are tables, asked for directly — so its share card is a table
   too: ten rows, rank, picture, name, three right-aligned numbers. A list of
   people and amounts reads as a list, and a leaderboard is what gets reposted
   by the people on it.

   Same constraints as every card here: resvg, no CSS, no filters, one font
   (Archivo Black), gradients and clip-paths only, and text sized from the
   font's ~0.62em advance because nothing can be measured in the Worker.
   ========================================================================== */

import { CARD_W, CARD_H, renderable } from './card.mjs';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fit = (text, maxW, cap, min = 11) => Math.max(min, Math.min(cap, maxW / (Math.max(1, String(text).length) * 0.62)));

export const UP = '#2bd46e', DN = '#ff4d5e', DIM = '#6f7d8e', INK = '#ffffff';
const MEDAL = ['#ffc93c', '#d6dde6', '#e0915a'];

/* cols: [{ label, x }] — right edges of the three number columns.
   rows: [{ title, subtitle, logo, values: [{ text, color }] }] */
export function buildTableSvg({ title, sub, cols, rows, tag = 'PUMPBUBBLE.FUN', nameLabel = 'NAME' }) {
  const list = (rows || []).filter(r => r && r.title).slice(0, 10);
  if (list.length < 3) throw new Error('not enough rows');

  const TOP = 168, ROW = 44, X0 = 48, X1 = CARD_W - 48;
  let defs = '', body = '';

  body += `<text x="${X0 + 18}" y="${TOP - 14}" font-family="Archivo Black" font-size="13" fill="${DIM}" letter-spacing="2">#</text>`;
  body += `<text x="${X0 + 116}" y="${TOP - 14}" font-family="Archivo Black" font-size="13" fill="${DIM}" letter-spacing="2">${esc(nameLabel)}</text>`;
  for (const c of cols) {
    body += `<text x="${c.x}" y="${TOP - 14}" text-anchor="end" font-family="Archivo Black" font-size="13" fill="${DIM}" letter-spacing="2">${esc(c.label)}</text>`;
  }

  list.forEach((r, i) => {
    const y = TOP + i * ROW;
    const cy = y + ROW / 2 - 2;
    body += `<rect x="${X0}" y="${y}" width="${X1 - X0}" height="${ROW - 6}" rx="12" fill="#ffffff" opacity="${i % 2 ? 0.025 : 0.05}"/>`;
    if (i < 3) body += `<rect x="${X0}" y="${y}" width="5" height="${ROW - 6}" rx="2.5" fill="${MEDAL[i]}"/>`;
    body += `<text x="${X0 + 26}" y="${cy + 7}" text-anchor="middle" font-family="Archivo Black" font-size="18" fill="${i < 3 ? MEDAL[i] : DIM}">${i + 1}</text>`;

    /* picture, or the first letter in a tinted disc */
    const ax = X0 + 72, ar = 15;
    defs += `<clipPath id="a${i}"><circle cx="${ax}" cy="${cy}" r="${ar}"/></clipPath>`;
    if (r.logo) {
      body += `<image href="${esc(r.logo)}" x="${ax - ar}" y="${cy - ar}" width="${ar * 2}" height="${ar * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#a${i})"/>`;
    } else {
      body += `<circle cx="${ax}" cy="${cy}" r="${ar}" fill="#1c2735"/>`;
      body += `<text x="${ax}" y="${cy + 6}" text-anchor="middle" font-family="Archivo Black" font-size="15" fill="#9fb0c4">${esc(String(r.title).replace(/^[@$]/, '').slice(0, 1).toUpperCase())}</text>`;
    }
    body += `<circle cx="${ax}" cy="${cy}" r="${ar}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>`;

    /* name, and a quieter second word under it when there is room */
    const nameW = (cols[0] ? cols[0].x - 150 : 500) - (X0 + 104);
    const t = renderable(r.title) ? String(r.title).slice(0, 24) : '?';
    const fs = fit(t, nameW, 21);
    if (r.subtitle) {
      body += `<text x="${X0 + 102}" y="${cy + 1}" font-family="Archivo Black" font-size="${fs.toFixed(1)}" fill="${INK}">${esc(t)}</text>`;
      const st = renderable(r.subtitle) ? String(r.subtitle).slice(0, 34) : '';
      body += `<text x="${X0 + 102}" y="${cy + 16}" font-family="Archivo Black" font-size="${fit(st, nameW, 11, 9).toFixed(1)}" fill="${DIM}">${esc(st)}</text>`;
    } else {
      body += `<text x="${X0 + 102}" y="${cy + 7}" font-family="Archivo Black" font-size="${fs.toFixed(1)}" fill="${INK}">${esc(t)}</text>`;
    }

    (r.values || []).forEach((v, k) => {
      const c = cols[k]; if (!c || !v) return;
      body += `<text x="${c.x}" y="${cy + 7}" text-anchor="end" font-family="Archivo Black" font-size="${fit(v.text, 150, 19).toFixed(1)}" fill="${v.color || INK}">${esc(v.text)}</text>`;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<defs>
  <radialGradient id="bg" cx="16%" cy="10%" r="95%">
    <stop offset="0" stop-color="#0f2a1b"/><stop offset="0.5" stop-color="#07110c"/><stop offset="1" stop-color="#04060a"/>
  </radialGradient>
  <radialGradient id="gl"><stop offset="0" stop-color="${UP}" stop-opacity="0.16"/><stop offset="1" stop-color="${UP}" stop-opacity="0"/></radialGradient>
  ${defs}
</defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
<circle cx="1060" cy="30" r="300" fill="url(#gl)"/>
<text x="${X0}" y="58" font-family="Archivo Black" font-size="22" fill="#8b98a8" letter-spacing="4">${esc(tag)}</text>
<text x="${X1}" y="58" text-anchor="end" font-family="Archivo Black" font-size="18" fill="${UP}" letter-spacing="2">${esc(sub)}</text>
<text x="${X0}" y="114" font-family="Archivo Black" font-size="${Math.min(46, (X1 - X0) / (Math.max(1, String(title).length) * 0.7)).toFixed(1)}" fill="${INK}">${esc(title)}</text>
${body}
</svg>`;
}
