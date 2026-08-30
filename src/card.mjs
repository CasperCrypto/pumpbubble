/* ==========================================================================
   pumpbubble.fun — share cards

   A number is the whole hook. "$POK +3000% in 24h" travels on its own; a link
   to a bubble map does not. So the card leads with the percentage at a size
   that survives being scaled down to a thumbnail in a timeline, and everything
   else — ticker, logo, market cap — supports it.

   Built as SVG and rasterised to PNG in src/png.mjs, because X, Telegram and
   Discord all refuse SVG in link previews. This file stays pure: it takes an
   already-fetched logo and returns a string, so the layout can be tested
   without a network or a WASM rasteriser.

   Two rules the design has to hold to:

   **Green means up and red means down, never brand colour.** A card is read in
   a quarter of a second while scrolling. Colouring a loss green because green
   is the brand would be a lie told faster than anyone can check it.

   **A window with no data does not get a card.** Absent is not zero here
   either; a card claiming +0.00% because the feed had no 30-day figure is a
   fabricated screenshot with our domain printed on it.
   ========================================================================== */

export const CARD_W = 1200;
export const CARD_H = 630;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* Archivo Black covers Latin and not much else, and the Worker has no fallback
   font to reach for. A ticker of CJK or emoji would rasterise to blank boxes,
   so it is replaced rather than shown broken. */
const RENDERABLE = /^[\x20-\x7E -ɏ]+$/;
export const renderable = s => RENDERABLE.test(String(s || ''));

/* Rough advance widths for Archivo Black, as a fraction of font size. Only
   needs to be good enough to pick a size that fits — the rasteriser does the
   real typesetting. */
const NARROW = new Set(['I', 'i', 'l', 'j', 't', 'f', 'r', '1', '.', ',', ':', "'", '!', '|']);
const WIDE = new Set(['W', 'M', '%', '@', 'm', 'w']);
function advance(text, size) {
  let n = 0;
  for (const ch of String(text)) n += NARROW.has(ch) ? 0.34 : WIDE.has(ch) ? 0.95 : 0.63;
  return n * size;
}

/* Largest size at or below `start` that keeps the string inside `maxW`. */
function fit(text, start, maxW, min = 24) {
  let s = start;
  while (s > min && advance(text, s) > maxW) s -= 2;
  return s;
}

export function pctLabel(pct) {
  /* null and undefined are checked before Number(), which turns both into 0 —
     the same coercion that made every long window read +0.00% on the map. Here
     it would mint a shareable image asserting a flat market we never measured. */
  if (pct == null || pct === '') return null;
  const v = Number(pct);
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  /* Three thousand percent does not need a decimal; three does. */
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return (v >= 0 ? '+' : '-') + abs.toFixed(digits) + '%';
}

export function mcapLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
}

/* Short forms for prose. "in 24 hour" is what the long labels produce, and the
   tweet text is the part a human actually reads. */
export const TF_SHORT = { h1: '1h', h24: '24h', d7: '7d', d30: '30d', y1: '1y' };

export const TF_LABEL = {
  h1: '1 HOUR', h24: '24 HOUR', d7: '7 DAY', d30: '30 DAY', y1: '1 YEAR',
};

/* logo is a data: URI or null. Everything else is plain data. */
export function buildCardSvg({ sym, name, pct, tf = 'h24', mcap, logo, tag = 'PUMPBUBBLE.FUN' }) {
  const label = pctLabel(pct);
  if (label == null) throw new Error('no change value');

  const up = Number(pct) >= 0;
  const hot = up ? '#2bd46e' : '#ff4d5e';
  const hot2 = up ? '#8ff7b4' : '#ffa8b0';
  const wash = up ? '#12351f' : '#341318';

  const ticker = '$' + (renderable(sym) ? String(sym).slice(0, 14) : '???');
  const sub = renderable(name) ? String(name).slice(0, 40) : '';

  /* The left column runs to the artwork; sizes shrink to fit rather than
     overrun it, which is what a long ticker used to do. */
  const colW = 580;
  const tickerSize = fit(ticker, 104, colW);
  const pctSize = fit(label, 132, colW);

  const cap = mcapLabel(mcap);
  const meta = [TF_LABEL[tf] || 'CHANGE', cap ? 'MCAP ' + cap : null]
    .filter(Boolean).join('   ·   ');

  const art = logo ? `
  <rect x="726" y="150" width="330" height="330" rx="52" fill="#0d1117"/>
  <image href="${esc(logo)}" x="726" y="150" width="330" height="330"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#rc)"/>
  <rect x="726" y="150" width="330" height="330" rx="52" fill="none"
        stroke="${hot}" stroke-width="4" opacity="0.85"/>`
    : `
  <circle cx="891" cy="315" r="150" fill="#0d1117" stroke="${hot}" stroke-width="4" opacity="0.85"/>
  <text x="891" y="356" text-anchor="middle" font-family="Archivo Black"
        font-size="120" fill="${hot}" opacity="0.5">?</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<defs>
  <radialGradient id="bg" cx="26%" cy="42%" r="66%">
    <stop offset="0" stop-color="${wash}"/><stop offset="1" stop-color="#080b0f"/>
  </radialGradient>
  <linearGradient id="num" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${hot2}"/><stop offset="1" stop-color="${hot}"/>
  </linearGradient>
  <clipPath id="rc"><rect x="726" y="150" width="330" height="330" rx="52"/></clipPath>
</defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
<circle cx="891" cy="315" r="252" fill="${hot}" opacity="0.15"/>
<circle cx="1128" cy="96" r="54" fill="${hot}" opacity="0.10"/>
<circle cx="642" cy="546" r="34" fill="${hot}" opacity="0.10"/>
${art}
<text x="90" y="192" font-family="Archivo Black" font-size="30" fill="#8b98a8"
      letter-spacing="4">${esc(tag)}</text>
<text x="90" y="${192 + 24 + tickerSize}" font-family="Archivo Black"
      font-size="${tickerSize}" fill="#ffffff">${esc(ticker)}</text>
<text x="90" y="${192 + 24 + tickerSize + 34 + pctSize}" font-family="Archivo Black"
      font-size="${pctSize}" fill="url(#num)">${esc(label)}</text>
<text x="90" y="${192 + 24 + tickerSize + 34 + pctSize + 52}" font-family="Archivo Black"
      font-size="27" fill="#8b98a8" letter-spacing="2">${esc(meta)}</text>
${sub ? `<text x="90" y="574" font-family="Archivo Black" font-size="25"
      fill="#5d6a7a">${esc(sub)}</text>` : ''}
</svg>`;
}

/* ==========================================================================
   The ranked card.

   A single token's card flatters one community. A leaderboard flatters five,
   and every project on it has a reason to repost something that shows them
   ranked — which is the whole point of publishing it. It is also the honest
   shape for "what moved today", because it shows the field rather than one
   cherry-picked number.

   rows: [{ sym, pct, mcap, logo }]. Logos are data URIs or null.
   ========================================================================== */
export function buildBoardSvg({ rows, title = 'TOP MOVERS', sub = '24 HOUR', tag = 'PUMPBUBBLE.FUN' }) {
  const list = (rows || []).filter(r => r && pctLabel(r.pct) != null).slice(0, 5);
  if (!list.length) throw new Error('no rows');

  const TOP = 214;        /* first row baseline block */
  const H = 78;           /* row pitch */

  const body = list.map((r, i) => {
    const y = TOP + i * H;
    const up = Number(r.pct) >= 0;
    const hot = up ? '#2bd46e' : '#ff4d5e';
    const label = pctLabel(r.pct);
    const cap = mcapLabel(r.mcap);
    const ticker = '$' + (renderable(r.sym) ? String(r.sym).slice(0, 12) : '???');

    /* Rank, art, ticker on the left; the number hard-right so the column of
       percentages lines up and can be read down in one movement. */
    const art = r.logo
      ? `<image href="${esc(r.logo)}" x="150" y="${y - 34}" width="46" height="46"
                preserveAspectRatio="xMidYMid slice" clip-path="url(#rr${i})"/>
         <rect x="150" y="${y - 34}" width="46" height="46" rx="14" fill="none"
               stroke="${hot}" stroke-width="2" opacity="0.7"/>`
      : `<rect x="150" y="${y - 34}" width="46" height="46" rx="14" fill="#151b24"
               stroke="${hot}" stroke-width="2" opacity="0.6"/>`;

    return `
  <clipPath id="rr${i}"><rect x="150" y="${y - 34}" width="46" height="46" rx="14"/></clipPath>
  <text x="92" y="${y}" font-family="Archivo Black" font-size="30" fill="#48545f">${i + 1}</text>
  ${art}
  <text x="214" y="${y}" font-family="Archivo Black" font-size="30" fill="#ffffff">${esc(ticker)}</text>
  ${cap ? `<text x="214" y="${y + 25}" font-family="Archivo Black" font-size="16"
        fill="#5d6a7a">${esc(cap)}</text>` : ''}
  <text x="1110" y="${y + 4}" text-anchor="end" font-family="Archivo Black"
        font-size="38" fill="${hot}">${esc(label)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<defs>
  <radialGradient id="bg" cx="20%" cy="18%" r="88%">
    <stop offset="0" stop-color="#12351f"/><stop offset="1" stop-color="#080b0f"/>
  </radialGradient>
</defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
<circle cx="1090" cy="70" r="150" fill="#2bd46e" opacity="0.10"/>
<circle cx="120" cy="600" r="70" fill="#2bd46e" opacity="0.08"/>
<text x="90" y="98" font-family="Archivo Black" font-size="28" fill="#8b98a8"
      letter-spacing="4">${esc(tag)}</text>
<text x="90" y="164" font-family="Archivo Black" font-size="52" fill="#ffffff">${esc(title)}</text>
<text x="1110" y="164" text-anchor="end" font-family="Archivo Black" font-size="30"
      fill="#2bd46e" letter-spacing="3">${esc(sub)}</text>
<rect x="90" y="186" width="1020" height="2" fill="#1e2733"/>
${body}
</svg>`;
}
