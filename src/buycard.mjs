/* ==========================================================================
   pumpbubble.fun — the picture on a buy alert.

   A buy alert with a picture is an advert for whoever drew the picture: every
   member of every group sees it on every buy. Peak's bot does this with a
   robot; ours draws the token as the map draws it — its own art as a lit
   bubble — and puts on the image what no other buy bot knows: that the buyer
   is one of pump.fun's top traders by realized profit, or a top KOL.

   Used only when a group has not set its own media (a group's GIF always
   wins), and only when the render works: any failure is the text alert, as
   before. Rendered in the CardDO, never in a Worker request — a card costs
   hundreds of milliseconds of CPU and a free-plan Worker has ten.

   Same constraints as every card here: resvg, one font (Archivo Black, so no
   emoji — the badges are drawn), sizes estimated from the font's ~0.62em
   advance because nothing can be measured in the Worker.
   ========================================================================== */

import { renderable } from './card.mjs';

export const BUY_W = 1200, BUY_H = 675;
const GREEN = '#2bd46e', GOLD = '#ffc93c', INK = '#ffffff', DIM = '#8b98a8', SOFT = '#c9d3de';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fit = (text, maxW, cap, min = 12, adv = 0.62) => Math.max(min, Math.min(cap, maxW / (Math.max(1, String(text).length) * adv)));
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };

export function usdText(v) {
  const n = num(v);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}
export function shortAmt(v) {
  const n = num(v);
  const trim = x => x.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  if (n >= 1e9) return trim((n / 1e9).toFixed(2)) + 'B';
  if (n >= 1e6) return trim((n / 1e6).toFixed(2)) + 'M';
  if (n >= 1e3) return trim((n / 1e3).toFixed(1)) + 'K';
  return n >= 1 ? n.toFixed(0) : n.toPrecision(2);
}
/* what was paid: 0.507 SOL, 3.1 SOL, 41.2 SOL, 1,250 SOL */
export function paidText(v) {
  const n = num(v);
  if (n >= 100) return Math.round(n).toLocaleString('en-US');
  return n.toFixed(n < 1 ? 3 : 2).replace(/\.?0+$/, '');
}
const capText = v => { const n = num(v); return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : n > 0 ? '$' + Math.round(n) : '—'; };

/* What the card needs to know about one buy, from what the alert already has.
   `pre` is the buyer's balance before the buy: none means a new holder, some
   means the position grew by gained / pre. */
export function buyCardSpec({ buy, token, usd, payWith = 'SOL', smart = null, caller = null, rank = null, whale = false }) {
  const pre = num(buy && buy.pre);
  const pos = buy && buy.newHolder ? 'NEW HOLDER' : pre > 0 && num(buy.tokens) > 0 ? '+' + Math.min(999, (num(buy.tokens) / pre) * 100).toFixed(1) + '%' : '';
  let tag = whale ? 'WHALE BUY' : 'NEW BUY', line = '';
  if (smart) { tag = 'TOP TRADER BUY'; line = '#' + num(smart.rank) + ' ON PUMP.FUN ' + ({ daily: 'TODAY', weekly: 'THIS WEEK', monthly: 'THIS MONTH' }[smart.period] || 'THIS WEEK') + ' BY PROFIT BANKED'; }
  else if (caller) { tag = 'TOP KOL BUY'; line = '#' + num(caller.rank) + ' CALLER ON PUMP.FUN THIS WEEK' + (caller.hit2 != null ? ' · ' + Math.round(num(caller.hit2) * 100) + '% OF CALLS HIT 2×' : ''); }
  return {
    sym: String((token && token.sym) || '').slice(0, 16), img: (token && (token.img || token.rawImg)) || '',
    usd: num(usd), paid: num(buy && buy.sol), payWith, tokens: num(buy && buy.tokens),
    mcap: num(token && token.mcap), pos, tag, line, rank: num(rank) || 0, whale: !!whale,
  };
}

/* A seeded scatter of small bubbles around the big one, so the same token
   always gets the same sky and different tokens different ones. */
function seeded(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

export function buildBuyCardSvg(spec, logo = null) {
  const s = spec || {};
  const sym = renderable(s.sym) && s.sym ? s.sym : 'TOKEN';
  const accent = s.tag === 'WHALE BUY' ? GOLD : GREEN;
  const X0 = 64, CX = 905, CY = 318, R = 205;
  const rnd = seeded(sym);
  let defs = '', body = '';

  /* the sky: small bubbles, dimmer the further from the big one */
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2, d = R + 40 + rnd() * 170, r = 10 + rnd() * 34;
    const x = Math.round(CX + Math.cos(a) * d), y = Math.round(CY + Math.sin(a) * d * 0.8);
    if (x - r < 690 || y - r < 0 || y + r > BUY_H - 70) continue;   // never under the text or the footer
    body += `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="url(#sb)" opacity="${(0.25 + rnd() * 0.45).toFixed(2)}"/>`;
  }
  /* the token as a lit bubble */
  defs += `<clipPath id="lg"><circle cx="${CX}" cy="${CY}" r="${R - 10}"/></clipPath>`;
  body += `<circle cx="${CX}" cy="${CY}" r="${R + 46}" fill="url(#halo)"/>`;
  if (logo) {
    body += `<image href="${esc(logo)}" x="${CX - R + 10}" y="${CY - R + 10}" width="${(R - 10) * 2}" height="${(R - 10) * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#lg)"/>`;
  } else {
    body += `<circle cx="${CX}" cy="${CY}" r="${R - 10}" fill="#13241b"/>`;
    const letter = sym.slice(0, 1).toUpperCase();
    body += `<text x="${CX}" y="${CY + 62}" text-anchor="middle" font-family="Archivo Black" font-size="180" fill="${accent}" opacity="0.85">${esc(letter)}</text>`;
  }
  body += `<circle cx="${CX}" cy="${CY}" r="${R - 10}" fill="url(#gloss)"/>`;
  body += `<circle cx="${CX}" cy="${CY}" r="${R - 6}" fill="none" stroke="${accent}" stroke-width="8" stroke-opacity="0.9"/>`;

  /* the badge */
  const tag = s.tag || 'NEW BUY';
  const tagW = Math.round(tag.length * 15.5 + 40);
  body += `<rect x="${X0}" y="56" width="${tagW}" height="46" rx="23" fill="${accent}"/>`;
  body += `<text x="${X0 + tagW / 2}" y="87" text-anchor="middle" font-family="Archivo Black" font-size="22" fill="#04140b" letter-spacing="1">${esc(tag)}</text>`;

  /* ticker, the money, what was swapped */
  const tk = '$' + sym;
  body += `<text x="${X0}" y="184" font-family="Archivo Black" font-size="${fit(tk, 560, 78).toFixed(1)}" fill="${INK}">${esc(tk)}</text>`;
  const money = usdText(s.usd);
  body += `<text x="${X0}" y="318" font-family="Archivo Black" font-size="${fit(money, 600, 128, 40, 0.66).toFixed(1)}" fill="${accent}">${esc(money)}</text>`;
  const swap = (s.paid ? paidText(s.paid) + ' ' + (s.payWith || 'SOL') : '') + (s.tokens ? '  FOR  ' + shortAmt(s.tokens) + ' $' + sym : '');
  if (swap.trim()) body += `<text x="${X0}" y="372" font-family="Archivo Black" font-size="${fit(swap, 600, 30).toFixed(1)}" fill="${SOFT}">${esc(swap)}</text>`;

  /* the chips: market cap, the buyer's position, where it sits on the map */
  const chips = [['MARKET CAP', capText(s.mcap)]];
  if (s.pos) chips.push([s.pos === 'NEW HOLDER' ? 'HOLDER' : 'POSITION', s.pos === 'NEW HOLDER' ? 'NEW' : s.pos]);
  if (s.rank > 0) chips.push(['ON THE MAP', '#' + s.rank]);
  let cx = X0;
  for (const [label, value] of chips) {
    const w = Math.max(label.length * 11, value.length * 17) + 44;
    body += `<rect x="${cx}" y="410" width="${w.toFixed(0)}" height="78" rx="18" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.10"/>`;
    body += `<text x="${cx + 22}" y="440" font-family="Archivo Black" font-size="13" fill="${DIM}" letter-spacing="2">${esc(label)}</text>`;
    body += `<text x="${cx + 22}" y="473" font-family="Archivo Black" font-size="26" fill="${INK}">${esc(value)}</text>`;
    cx += w + 14;
  }

  /* who bought, when it is somebody */
  if (s.line) {
    body += `<rect x="${X0}" y="512" width="600" height="44" rx="12" fill="${accent}" fill-opacity="0.12"/>`;
    body += `<rect x="${X0}" y="512" width="6" height="44" rx="3" fill="${accent}"/>`;
    body += `<text x="${X0 + 22}" y="541" font-family="Archivo Black" font-size="${fit(s.line, 560, 19, 11, 0.66).toFixed(1)}" fill="${accent}">${esc(s.line)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BUY_W}" height="${BUY_H}" viewBox="0 0 ${BUY_W} ${BUY_H}">
<defs>
  <radialGradient id="bg" cx="18%" cy="12%" r="100%"><stop offset="0" stop-color="#0f2a1b"/><stop offset="0.55" stop-color="#07110c"/><stop offset="1" stop-color="#04060a"/></radialGradient>
  <radialGradient id="halo"><stop offset="0.6" stop-color="${accent}" stop-opacity="0.30"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
  <radialGradient id="gloss" cx="35%" cy="25%" r="80%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.04"/><stop offset="1" stop-color="#000000" stop-opacity="0.25"/></radialGradient>
  <radialGradient id="sb" cx="35%" cy="30%"><stop offset="0" stop-color="#9dffc9"/><stop offset="0.5" stop-color="${GREEN}"/><stop offset="1" stop-color="#0a5f33"/></radialGradient>
  ${defs}
</defs>
<rect width="${BUY_W}" height="${BUY_H}" fill="url(#bg)"/>
${body}
<text x="${X0}" y="${BUY_H - 40}" font-family="Archivo Black" font-size="22" fill="${DIM}" letter-spacing="4">PUMPBUBBLE.FUN</text>
<text x="${X0 + 318}" y="${BUY_H - 40}" font-family="Archivo Black" font-size="18" fill="${GREEN}" letter-spacing="1">FREE BUY BOT · @PUMPBUBBLEBOT</text>
</svg>`;
}
