/* ==========================================================================
   pumpbubble.fun — the generative share card

   The ranked card (`buildBoardSvg`) is a list: five rows, a number hard-right.
   It is the right shape for "who moved", and the wrong shape for what this
   site actually looks like. This one draws the top ten as the map draws them —
   bubbles, packed, sized by rank, coloured by direction — so a post carries a
   picture of the product rather than a table.

   **Generative, not random.** The layout comes from a seeded PRNG, and the
   seed is the hour plus the tickers in it. So:

     - the same top ten in the same hour always renders the same image, which
       is what lets the edge cache it and what stops a timeline showing two
       different pictures of one fact;
     - the next hour, or one change in the ten, recomposes the whole field.

   Nothing here is measured or claimed — position and wobble are decoration.
   Every number on the card (rank, ticker, percentage, market cap) is the
   token's own, and a token whose window was never measured is not drawn at
   all, the same rule the rest of the project follows.

   It rasterises through resvg like every other card, so: no CSS, no filters,
   one font (Archivo Black, compiled into the Worker), and gradients and
   clip-paths only.
   ========================================================================== */

import { CARD_W, CARD_H, pctLabel, mcapLabel, renderable } from './card.mjs';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* mulberry32 — small, fast, and identical in every runtime, which matters
   because the card is cached by a key that assumes it. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* The card's own seed: what is on it, and which hour it is. Not the minute —
   a picture that changes while people are opening the same link is churn, and
   the edge cache would never be hit. */
export function seedFor(rows, at = Date.now()) {
  return seedOf(rows.map(r => r.sym).join(',') + '|' + Math.floor(at / 36e5));
}

const PAD = 34;
const TOP = 150;          /* the title band is the bubbles' ceiling */
const BOT = CARD_H - 28;

/* Radii by rank, on the same idea as the map: compress the range so #10 is
   still a bubble rather than a dot. Scaled afterwards to fill the box. */
export function radii(n, rand) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    /* 1.00 down to 0.46, with a little seeded variation so two cards with the
       same count are not the same picture */
    out.push((1 - 0.54 * Math.pow(t, 0.85)) * (0.94 + rand() * 0.12));
  }
  const boxW = CARD_W - PAD * 2, boxH = BOT - TOP;
  const area = out.reduce((s, r) => s + Math.PI * r * r, 0);
  /* fill a share of the box with bubble area — high enough that they touch,
     which is what makes it read as the map */
  const k = Math.sqrt((boxW * boxH * 0.60) / area);
  return out.map(r => r * k);
}

/* Deterministic packing: seeded start, then relaxation — push apart, pull
   gently to the middle, clamp inside the box. Twelve lines instead of a
   library, and it is the same algorithm the map's physics uses in spirit. */
export function pack(rs, rand) {
  const boxW = CARD_W - PAD * 2, boxH = BOT - TOP;
  const cx = CARD_W / 2, cy = TOP + boxH / 2;
  const P = rs.map((r, i) => ({
    r,
    x: cx + (rand() - 0.5) * boxW * 0.7,
    y: cy + (rand() - 0.5) * boxH * 0.7,
    i,
  }));
  for (let pass = 0; pass < 240; pass++) {
    for (let a = 0; a < P.length; a++) {
      for (let b = a + 1; b < P.length; b++) {
        const A = P[a], B = P[b];
        let dx = B.x - A.x, dy = B.y - A.y;
        let d = Math.hypot(dx, dy);
        if (d === 0) { dx = 0.01; dy = 0.01; d = 0.014; }
        /* a touch of overlap, like the map's soft bodies */
        const want = (A.r + B.r) * 0.94;
        if (d < want) {
          const push = (want - d) / d * 0.5;
          A.x -= dx * push; A.y -= dy * push;
          B.x += dx * push; B.y += dy * push;
        }
      }
    }
    for (const p of P) {
      p.x += (cx - p.x) * 0.010;
      p.y += (cy - p.y) * 0.010;
      p.x = Math.min(CARD_W - PAD - p.r, Math.max(PAD + p.r, p.x));
      p.y = Math.min(BOT - p.r, Math.max(TOP + p.r, p.y));
    }
  }

  /* Relaxation pulls to the middle, so the cluster ends up compact and a third
     of the card is empty. Spread it back out over the frame afterwards:
     positions only, never radii, and never inward — scaling a packed cluster
     down would push bubbles through each other. */
  const minX = Math.min(...P.map(p => p.x - p.r)), maxX = Math.max(...P.map(p => p.x + p.r));
  const minY = Math.min(...P.map(p => p.y - p.r)), maxY = Math.max(...P.map(p => p.y + p.r));
  /* Each axis on its own. One factor for both fills whichever axis is tighter
     and leaves the other short, and the card is a 1.9:1 letterbox — the axis
     left short is always the wide one, which is the whole picture. Scaling the
     two independently is safe *because both factors are at least 1*: every
     pair of centres moves further apart, so a spread can separate bubbles but
     can never push one through another. Radii are untouched, so the bubbles
     themselves stay round. */
  const kx = Math.max(1, Math.min(boxW / Math.max(1, maxX - minX), 1.5));
  const ky = Math.max(1, Math.min(boxH / Math.max(1, maxY - minY), 1.5));
  if (kx > 1.001 || ky > 1.001) {
    const slackX = (boxW - (maxX - minX) * kx) / 2;
    const slackY = (boxH - (maxY - minY) * ky) / 2;
    for (const p of P) {
      p.x = PAD + slackX + (p.x - minX) * kx;
      p.y = TOP + slackY + (p.y - minY) * ky;
      p.x = Math.min(CARD_W - PAD - p.r, Math.max(PAD + p.r, p.x));
      p.y = Math.min(BOT - p.r, Math.max(TOP + p.r, p.y));
    }
  }
  return P;
}

/* Archivo Black is a wide display face — about 0.62em an character across a
   ticker's mix of caps and digits. There is no way to measure a string inside
   the Worker, so the size is solved from that constant rather than guessed
   from the radius alone: `$SCHRÖDINGER` at the radius that suits `$SOL` runs
   a hundred pixels past the rim and across its neighbours. */
export function fitSize(text, maxW, cap) {
  const n = Math.max(1, String(text).length);
  return Math.max(9, Math.min(cap, maxW / (n * 0.62)));
}

const UP = { hi: '#7dffc0', mid: '#22c46a', lo: '#0b4d2c', ink: '#03200f' };
const DN = { hi: '#ff97a6', mid: '#e8364d', lo: '#5a0f1c', ink: '#24050c' };

export function buildBubbleSvg({ rows, title = 'TOP 10 TRENDING', sub = '24 HOUR',
                                 tag = 'PUMPBUBBLE.FUN', seed }) {
  const list = (rows || []).filter(r => r && r.sym && pctLabel(r.pct) != null).slice(0, 10);
  if (list.length < 3) throw new Error('not enough rows');

  const rand = rng(seed == null ? seedFor(list) : seed);
  const P = pack(radii(list.length, rand), rand);

  /* The light comes off the bubbles, not from behind them. Free-floating glow
     blobs read as a wallpaper the bubbles happen to sit on; a halo around each
     one reads as the bubble glowing, which is what the map does. Three
     translucent rings approximate a blur at a fraction of a filter's cost, and
     they are emitted before any body so a neighbour's halo never washes over a
     bubble that is already drawn. */
  let halo = '', defs = '', body = '';
  list.forEach((r, i) => {
    const p = P[i];
    const up = Number(r.pct) >= 0;
    const C = up ? UP : DN;
    const R = p.r, x = p.x, y = p.y;
    const id = 'b' + i;

    defs += `<radialGradient id="g${id}" cx="34%" cy="26%" r="78%">
      <stop offset="0" stop-color="${C.hi}"/><stop offset="0.45" stop-color="${C.mid}"/>
      <stop offset="1" stop-color="${C.lo}"/></radialGradient>`;

    /* logo sits above the middle, the way it does on the map */
    const lr = R * 0.40, ly = y - R * 0.30;
    defs += `<clipPath id="c${id}"><circle cx="${x.toFixed(1)}" cy="${ly.toFixed(1)}" r="${lr.toFixed(1)}"/></clipPath>`;

    const ticker = '$' + (renderable(r.sym) ? String(r.sym).slice(0, 12) : '???');
    const label = pctLabel(r.pct);
    /* the chord at the height each line sits on, less a margin, is the width
       it has to fit in */
    const symSize = fitSize(ticker, R * 1.52, Math.min(R * 0.36, 44));
    const pctSize = fitSize(label, R * 1.50, Math.min(R * 0.30, 34));

    halo += `
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(R * 1.42).toFixed(1)}" fill="${C.mid}" opacity="0.045"/>
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(R * 1.24).toFixed(1)}" fill="${C.mid}" opacity="0.07"/>
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(R * 1.09).toFixed(1)}" fill="${C.mid}" opacity="0.11"/>`;

    body += `
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R.toFixed(1)}" fill="url(#g${id})"/>
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(R - 1).toFixed(1)}" fill="none" stroke="${C.hi}" stroke-width="1.5" opacity="0.45"/>
  <ellipse cx="${(x - R * 0.34).toFixed(1)}" cy="${(y - R * 0.46).toFixed(1)}" rx="${(R * 0.30).toFixed(1)}" ry="${(R * 0.20).toFixed(1)}" fill="#ffffff" opacity="0.30"/>`;

    if (R > 40) {
      /* The art, and the ring that frames it, are one thing: drawing the ring
         for a token whose art did not come back leaves an empty circle, which
         reads as a broken image rather than as a bubble. No art, no ring, and
         the two lines of text move up into the space instead. */
      const hasArt = !!r.logo;
      if (hasArt) {
        body += `
  <image href="${esc(r.logo)}" x="${(x - lr).toFixed(1)}" y="${(ly - lr).toFixed(1)}"
         width="${(lr * 2).toFixed(1)}" height="${(lr * 2).toFixed(1)}"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#c${id})"/>
  <circle cx="${x.toFixed(1)}" cy="${ly.toFixed(1)}" r="${lr.toFixed(1)}" fill="none" stroke="${C.ink}" stroke-width="2" opacity="0.5"/>`;
      }
      const symY = hasArt ? y + R * 0.30 : y + R * 0.02;
      const pctY = hasArt ? y + R * 0.62 : y + R * 0.02 + pctSize * 1.35;
      body += `
  <text x="${x.toFixed(1)}" y="${symY.toFixed(1)}" text-anchor="middle"
        font-family="Archivo Black" font-size="${symSize.toFixed(1)}" fill="#ffffff">${esc(ticker)}</text>
  <text x="${x.toFixed(1)}" y="${pctY.toFixed(1)}" text-anchor="middle"
        font-family="Archivo Black" font-size="${pctSize.toFixed(1)}" fill="${C.ink}">${esc(label)}</text>`;
    } else {
      /* too small for three lines: the ticker alone, centred */
      body += `
  <text x="${x.toFixed(1)}" y="${(y + symSize * 0.34).toFixed(1)}" text-anchor="middle"
        font-family="Archivo Black" font-size="${symSize.toFixed(1)}" fill="#ffffff">${esc(ticker)}</text>`;
    }

    /* the rank, in the corner of the bubble, so the order is readable */
    if (R > 52) {
      body += `<text x="${(x - R * 0.60).toFixed(1)}" y="${(y - R * 0.55).toFixed(1)}" text-anchor="middle"
        font-family="Archivo Black" font-size="${Math.min(R * 0.22, 26).toFixed(1)}" fill="${C.ink}" opacity="0.85">${i + 1}</text>`;
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<defs>
  <radialGradient id="bg" cx="50%" cy="58%" r="78%">
    <stop offset="0" stop-color="#0c2617"/><stop offset="0.55" stop-color="#07130d"/>
    <stop offset="1" stop-color="#04060a"/>
  </radialGradient>
  ${defs}
</defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
${halo}
<text x="${PAD + 20}" y="64" font-family="Archivo Black" font-size="26" fill="#8b98a8" letter-spacing="4">${esc(tag)}</text>
<text x="${PAD + 20}" y="124" font-family="Archivo Black" font-size="50" fill="#ffffff">${esc(title)}</text>
<text x="${CARD_W - PAD - 20}" y="124" text-anchor="end" font-family="Archivo Black" font-size="28"
      fill="#2bd46e" letter-spacing="3">${esc(sub)}</text>
${body}
</svg>`;
}
