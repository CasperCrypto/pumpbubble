/* ==========================================================================
   Generates the PNG assets: og.png (social card) and the app icons.

       node scripts/make-images.mjs

   Written against node:zlib rather than an image library because the project
   has no dependencies and this runs about twice a year. A PNG is a signature,
   an IHDR, a zlib-deflated block of filtered scanlines, and an IEND — that is
   the whole format, and all of it is below.

   The scene is drawn rather than photographed: same palette as the site, same
   idea (bubbles sized differently, green up, red down, one gold = paid).
   ========================================================================== */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/', import.meta.url));

/* ------------------------------------------------------------------- PNG */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* rgba: Uint8ClampedArray of w*h*4 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  /* every scanline carries a leading filter byte; 0 means "none", which
     compresses fine for smooth gradients and keeps this readable */
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- drawing */
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
  }
  /* source-over compositing of one pixel */
  blend(x, y, [r, g, b], a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.px;
    d[i]     = r * a + d[i]     * (1 - a);
    d[i + 1] = g * a + d[i + 1] * (1 - a);
    d[i + 2] = b * a + d[i + 2] * (1 - a);
    d[i + 3] = Math.max(d[i + 3], a * 255);
  }
  background(fn) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const [r, g, b] = fn(x / this.w, y / this.h);
      const i = (y * this.w + x) * 4;
      this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = 255;
    }
  }
  /* Anti-aliased disc. Coverage falls off across one pixel at the rim, which is
     what stops these looking like jagged 1990s clip-art. */
  disc(cx, cy, r, colour, alpha = 1, feather = 1.2) {
    /* The bounds must cover the feather, not just the radius. Clipping at r+2
       while feathering over a much wider band cuts the falloff off mid-gradient
       and leaves a square halo around every bubble. */
    const reach = r + feather + 2;
    const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(this.w - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(this.h - 1, Math.ceil(cy + reach));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let cov = (r - d) / feather + 0.5;
      cov = cov <= 0 ? 0 : cov >= 1 ? 1 : cov * cov * (3 - 2 * cov);  // smoothstep
      if (cov > 0) this.blend(x, y, colour, cov * alpha);
    }
  }
  /* the specular dot that makes a flat circle read as a wet bubble */
  highlight(cx, cy, r) {
    this.disc(cx - r * 0.34, cy - r * 0.38, r * 0.20, [255, 255, 255], 0.34, r * 0.14 + 1);
  }
}

const MINT = [40, 224, 140], ROSE = [255, 77, 106], GOLD = [255, 201, 60];
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

/* deterministic, so regenerating does not churn the committed files */
function rng(seed) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function bubbleField(w, h, count, seed, scale) {
  const c = new Canvas(w, h);
  const bg1 = hexToRgb('#070b12'), bg2 = hexToRgb('#030407');
  c.background((u, v) => {
    /* diagonal wash, darker toward the bottom-right, plus a soft vignette */
    const t = (u * 0.6 + v * 0.8) / 1.4;
    const vig = 1 - 0.35 * Math.hypot(u - 0.5, v - 0.5);
    return bg1.map((a, i) => (a + (bg2[i] - a) * t) * vig);
  });

  const R = rng(seed);
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 400) {
    const r = (0.035 + Math.pow(R(), 2.4) * 0.16) * scale;
    const x = R() * w, y = R() * h;
    /* allow a little overlap, the way the real map lets bubbles touch */
    if (placed.some(p => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 0.88)) continue;
    placed.push({ x, y, r });
  }

  placed.sort((a, b) => a.r - b.r);
  placed.forEach((p, i) => {
    const roll = rng(seed + i * 7)();
    const col = i === placed.length - 1 ? GOLD : roll > 0.42 ? MINT : ROSE;
    c.disc(p.x, p.y, p.r * 1.35, col, 0.10, p.r * 0.9);  // outer glow
    c.disc(p.x, p.y, p.r, col, 0.88);                    // body
    c.disc(p.x, p.y, p.r * 0.97, col, 0.30);             // rim density
    c.highlight(p.x, p.y, p.r);
  });
  return c;
}

/* --------------------------------------------------------------- outputs */
const write = (name, canvas) => {
  const png = encodePNG(canvas.w, canvas.h, canvas.px);
  writeFileSync(OUT + name, png);
  console.log(`  ${name.padEnd(16)} ${canvas.w}x${canvas.h}  ${(png.length / 1024).toFixed(1)} KB`);
};

console.log('\nwriting image assets to public/\n');

/* social card — a field of bubbles, same palette and behaviour as the map */
write('og.png', bubbleField(1200, 630, 34, 20260820, 630));

/* app icons — the three-bubble glyph, matching favicon.svg */
function icon(size) {
  const c = new Canvas(size, size);
  const bg = hexToRgb('#05070a');
  c.background(() => bg);
  const u = size / 64;
  c.disc(24 * u, 26 * u, 15 * u, MINT, 0.94); c.highlight(24 * u, 26 * u, 15 * u);
  c.disc(43 * u, 38 * u, 12 * u, ROSE, 0.94); c.highlight(43 * u, 38 * u, 12 * u);
  c.disc(40 * u, 19 * u, 8 * u, GOLD, 0.96);  c.highlight(40 * u, 19 * u, 8 * u);
  return c;
}
for (const s of [180, 192, 512]) write(`icon-${s}.png`, icon(s));

console.log('\ndone\n');
