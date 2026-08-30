/* ==========================================================================
   pumpbubble.fun — share pages and the plumbing behind the card

   The card is the marketing surface. Someone posting "$POK +3000% in 24h" with
   a picture of the number gets attention that a link to a bubble map does not,
   and every one of those posts carries our domain back into a timeline.

   A share URL is /s/<mint> or /s/<TICKER>, and it does two different jobs
   depending on who asks. A crawler gets Open Graph tags pointing at a PNG. A
   person gets a small page with the card, the number, and a way through to the
   map — never a bare image, which is a dead end for a visitor.
   ========================================================================== */

import { buildCardSvg, buildBoardSvg, pctLabel, mcapLabel, TF_LABEL } from './card.mjs';

/* base64 for a byte array. String.fromCharCode(...buf) on a megabyte of image
   overflows the argument stack, so it goes in chunks. */
export function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

/* Token art is stored as our own signed proxy path, with the upstream address
   inside it, because the page is served img-src 'self'. The rasteriser is not a
   browser and has no such restriction, so the original is unwrapped here. */
export function upstreamImg(t) {
  if (!t) return '';
  if (t.rawImg && /^https?:\/\//i.test(t.rawImg)) return t.rawImg;
  const img = typeof t.img === 'string' ? t.img : '';
  if (img.startsWith('/api/img?')) {
    try { return new URL('https://x' + img).searchParams.get('u') || ''; } catch { return ''; }
  }
  return /^https?:\/\//i.test(img) ? img : '';
}

const OK_TYPE = /^image\/(png|jpeg|jpg|gif|webp|avif)$/;

/* A card is not worth an unbounded decode. Some pump.fun art is many megabytes
   of animated GIF, which would spend the whole CPU budget on one thumbnail. */
const MAX_ART = 3_000_000;

export async function logoDataUri(t) {
  const raw = upstreamImg(t);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const r = await fetch(raw, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!OK_TYPE.test(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_ART) return null;
    return 'data:' + type + ';base64,' + b64(buf);
  } catch { return null; }
}

/* Build the SVG for a token in one window, or null when that window has no
   measured value. Absent is not zero: a card reading +0.00% because we never
   had a 30-day figure is a fabricated screenshot with our domain on it. */
export async function cardSvgFor(t, tf) {
  const pct = t && t.pc ? t.pc[tf] : null;
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return buildCardSvg({
    sym: t.sym, name: t.name, pct, tf, mcap: t.mcap,
    logo: await logoDataUri(t),
  });
}

/* The ranked card for a set of tokens. Art is fetched in parallel because it
   is five round trips to five different hosts and they are the whole latency. */
export async function boardCardSvgFor(tokens, tf, title, sub) {
  const list = (tokens || []).slice(0, 5);
  if (!list.length) return null;
  const rows = await Promise.all(list.map(async t => ({
    sym: t.sym, pct: t && t.pc ? t.pc[tf] : null, mcap: t.mcap,
    logo: await logoDataUri(t),
  })));
  if (!rows.some(r => r.pct != null && Number.isFinite(Number(r.pct)))) return null;
  return buildBoardSvg({ rows, title, sub });
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* The human-facing page. Deliberately tiny and self-contained: it is mostly
   opened from a phone, one tap after a link in a timeline. */
export function page({ title, desc, canonical, cardUrl, mapUrl, tweetUrl, alt, hot = '#2bd46e' }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="pumpbubble.fun">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(cardUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(cardUrl)}">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
 justify-content:center;gap:22px;padding:24px;background:#080b0f;color:#e8eef6;
 font:600 15px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
img{width:100%;max-width:640px;height:auto;border-radius:16px;
 box-shadow:0 20px 60px -20px ${hot}66}
.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
a.btn{display:inline-flex;align-items:center;gap:8px;height:46px;padding:0 22px;
 border-radius:999px;text-decoration:none;font-weight:800;letter-spacing:.04em}
.go{background:linear-gradient(180deg,#8ff7b4,#25c464);color:#05210f}
.x{background:#12171f;color:#e8eef6;border:1px solid #223}
.n{font-size:13px;color:#7d8a99}
</style></head><body>
<img src="${esc(cardUrl)}" alt="${esc(alt)}" width="1200" height="630">
<div class="row">
  <a class="btn go" href="${esc(mapUrl)}">Open the live map</a>
  <a class="btn x" href="${esc(tweetUrl)}" rel="noopener">Share on X</a>
</div>
<div class="n">${esc(desc)}</div>
</body></html>`;
}

export function sharePage({ origin, t, tf, pct, cardUrl, mapUrl, tweetUrl }) {
  const label = pctLabel(pct);
  const cap = mcapLabel(t.mcap);
  return page({
    title: '$' + t.sym + ' ' + label + ' · ' + (TF_LABEL[tf] || '') + ' — pumpbubble.fun',
    desc: [t.name, cap ? 'Market cap ' + cap : null,
           'Live bubble map of pump.fun and the whole market.'].filter(Boolean).join(' · '),
    canonical: origin + '/s/' + encodeURIComponent(t.mint || t.sym),
    cardUrl, mapUrl, tweetUrl,
    alt: '$' + t.sym + ' ' + label,
    hot: Number(pct) >= 0 ? '#2bd46e' : '#ff4d5e',
  });
}
