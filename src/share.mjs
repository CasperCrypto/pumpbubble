import { altGateways } from './core.mjs';
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
import { buildBubbleSvg, seedFor } from './bubblecard.mjs';

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

/* What the rasteriser can actually decode. resvg-wasm 2.6.2 does not do WebP
   or AVIF, and it fails the way an image library fails inside an SVG: no
   error, no logo, just the space where one should be. */
const OK_TYPE = /^image\/(png|jpeg|jpg|gif)$/;

/* **The content type is not the truth; the first bytes are.** Every art host
   this project meets gets it wrong in one direction or the other: an IPFS
   gateway returns `text/plain` on a 429 with a sentence in the body, and
   returns plenty of real PNGs with no type at all. Sniffing the magic number
   both rescues the images that arrive mislabelled and refuses the error pages
   that arrive labelled as images. */
export function sniffType(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
   && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}

/* Some hosts will simply hand over a format we can read if asked properly.
   DexScreener's CMS takes `format=auto`, which means "whatever the caller
   accepts" and answers WebP to anything modern — `format=png` is the same
   image in a format resvg reads, for free and with no third party. */
export function preferReadable(url) {
  return String(url).replace(/([?&])format=auto\b/i, '$1format=png');
}

/* One list, in core.mjs, because the image proxy needs the same one. */
export { altGateways } from './core.mjs';

/* WebP is a third of the art on a live top ten and the rasteriser cannot read
   a byte of it. Decoding it in the Worker would mean a dependency, and this
   project has one already and wants no more, so the conversion is rented:
   wsrv.nl re-encodes a public image to PNG. What is sent is a URL that is
   already public, the request is for a share card only — never the map — and
   a failure is the same outcome as today, which is no logo. */
const WSRV = 'https://wsrv.nl/';
export function toReadableUrl(url, px = 256) {
  return WSRV + '?url=' + encodeURIComponent(String(url))
    + '&output=png&w=' + px + '&h=' + px + '&fit=cover&we';
}

/* pump.fun's own image optimizer re-encodes anything pump.fun hosts. Its
   profile pictures are WebP, and wsrv.nl answers 400 to that host — so for
   the Traders card eight avatars of ten came back blank. Asked through
   `/_next/image` with an Accept that does not list WebP, the same picture
   comes back as JPEG: first-party, no third party, and tried before wsrv.
   `q=75` exactly: current Next.js accepts only its configured qualities and
   answers 400 to anything else, which is what q=80 did on the first pass. */
const PUMP_HOST = /^https:\/\/([a-z0-9-]+\.)*pump\.fun\//i;
export function pumpOptimizerUrl(url, px = 256) {
  return PUMP_HOST.test(String(url))
    ? 'https://pump.fun/_next/image?url=' + encodeURIComponent(String(url)) + '&w=' + px + '&q=75'
    : '';
}

/* One fetch, with the type decided by the bytes. */
async function grab(url, ms = 7000) {
  try {
    const r = await fetch(url, {
      headers: { accept: 'image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_ART) return null;
    const type = sniffType(buf) || (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return type ? { type, buf } : null;
  } catch { return null; }
}

/* The same, through a fetcher that returns a Response (the image proxy). */
async function grabVia(via, url) {
  try {
    const r = await via(url);
    if (!r || !r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_ART) return null;
    const type = sniffType(buf) || (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return type ? { type, buf } : null;
  } catch { return null; }
}

/* A card is not worth an unbounded decode. Some pump.fun art is many megabytes
   of animated GIF, which would spend the whole CPU budget on one thumbnail. */
const MAX_ART = 3_000_000;

/* Art for a card, in a format the rasteriser reads — going to some lengths,
   because a card of ten bubbles with four blanks in it is not the product.
   Three things go wrong and each has one answer:

     1. the host serves WebP           → re-encode it (see toReadableUrl)
     2. the IPFS gateway is rate limited → ask a different one
     3. the type header is wrong        → believe the bytes (see sniffType)

   Any step may fail and the result is simply no logo, exactly as before. */
export async function logoDataUri(t, via = null) {
  const raw = upstreamImg(t);
  if (!/^https?:\/\//i.test(raw)) return null;

  /* **The map's own image proxy first.** It has usually served this exact
     art already, so it is an edge-cache hit with no upstream call at all —
     and on a miss it walks the same gateways. Measured on the first Smart
     money table card: six of ten logos were ipfs.io art that ipfs.io
     answered 429 to the card's direct fetch, while /api/img served every one
     of them in ~0.1s from the cache. */
  let got = via ? await grabVia(via, raw) : null;
  if (!got) got = await grab(preferReadable(raw));
  for (const alt of (got ? [] : altGateways(raw))) {
    got = await grab(alt, 9000);
    if (got) break;
  }
  if (!got) return null;

  if (!OK_TYPE.test(got.type)) {
    /* WebP, AVIF, or something we cannot name: pump.fun's own optimizer for
       art it hosts, then rent the conversion. */
    let conv = null;
    const own = pumpOptimizerUrl(raw);
    if (own) conv = await grab(own, 8000);
    if (!conv || !OK_TYPE.test(conv.type)) conv = await grab(toReadableUrl(raw), 9000);
    if (!conv || !OK_TYPE.test(conv.type)) return null;
    got = conv;
  }
  return 'data:' + got.type + ';base64,' + b64(got.buf);
}

/* Build the SVG for a token in one window, or null when that window has no
   measured value. Absent is not zero: a card reading +0.00% because we never
   had a 30-day figure is a fabricated screenshot with our domain on it. */
export async function cardSvgFor(t, tf, via = null) {
  const pct = t && t.pc ? t.pc[tf] : null;
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return buildCardSvg({
    sym: t.sym, name: t.name, pct, tf, mcap: t.mcap,
    logo: await logoDataUri(t, via),
  });
}

/* The ranked card for a set of tokens. Art is fetched in parallel because it
   is five round trips to five different hosts and they are the whole latency. */
export async function boardCardSvgFor(tokens, tf, title, sub, via = null) {
  const list = (tokens || []).slice(0, 5);
  if (!list.length) return null;
  const rows = await Promise.all(list.map(async t => ({
    sym: t.sym, pct: t && t.pc ? t.pc[tf] : null, mcap: t.mcap,
    logo: await logoDataUri(t, via),
  })));
  if (!rows.some(r => r.pct != null && Number.isFinite(Number(r.pct)))) return null;
  return buildBoardSvg({ rows, title, sub });
}

/* The generative card: the top ten as a bubble field. Ten logos from ten
   different hosts, so they are fetched together — they are the whole latency,
   exactly as on the five-row card. A logo that does not answer is not an
   error; that bubble simply wears its ticker. */
export async function bubbleCardSvgFor(tokens, tf, { title, sub, seed, via = null } = {}) {
  const list = (tokens || []).slice(0, 10);
  if (list.length < 3) return null;
  const rows = await Promise.all(list.map(async t => ({
    sym: t.sym, pct: t && t.pc ? t.pc[tf] : null, mcap: t.mcap,
    label: t.cardLabel, title: t.cardTitle, up: t.cardUp,
    logo: await logoDataUri(t, via),
  })));
  if (rows.filter(r => r.label || (r.pct != null && Number.isFinite(Number(r.pct)))).length < 3) return null;
  try { return buildBubbleSvg({ rows, title, sub, seed }); }
  catch { return null; }
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
<meta name="twitter:site" content="@pumpbubblefun">
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
.f{font-size:12.5px;color:#7d8a99}.f a{color:#c9d3de;text-decoration:none;font-weight:700}
</style></head><body>
<img src="${esc(cardUrl)}" alt="${esc(alt)}" width="1200" height="630">
<div class="row">
  <a class="btn go" href="${esc(mapUrl)}">Open the live map</a>
  <a class="btn x" href="${esc(tweetUrl)}" rel="noopener">Share on X</a>
</div>
<div class="n">${esc(desc)}</div>
<div class="f">Follow <a href="https://x.com/pumpbubblefun" rel="noopener">@pumpbubblefun on X</a> · <a href="https://t.me/pumpbubble" rel="noopener">Telegram</a> · <a href="https://t.me/pumpbubblebot" rel="noopener">free buy bot</a></div>
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
