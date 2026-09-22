/* ==========================================================================
   The generative share card.

       node scripts/bubblecard.test.mjs

   What matters about a generated picture is that it is *the same* picture for
   the same fact in the same hour (or the edge cannot cache it and a timeline
   shows two versions of one claim), that it recomposes when the fact changes,
   and that nothing lands outside the frame or on top of the title.
   ========================================================================== */

import { buildBubbleSvg, pack, radii, rng, seedOf, seedFor, fitSize } from '../src/bubblecard.mjs';
import { CARD_W, CARD_H } from '../src/card.mjs';
import { sniffType, preferReadable, altGateways, toReadableUrl } from '../src/share.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const T0 = 1_800_000_000_000;
const row = (sym, pct, o = {}) => ({ sym, pct, mcap: 1e6, logo: '', ...o });
const ten = ['JEANPHIL', 'PAID', 'STONK', 'QUEEF', 'HARAMBE', 'BP', 'TIPPED', 'SOL', 'GROK', 'DEED']
  .map((s, i) => row(s, i % 3 === 0 ? -12.5 - i : 40 + i * 9));

console.log('\nseed');
{
  is('the same rows in the same hour seed the same', seedFor(ten, T0), seedFor(ten, T0 + 59 * 60_000));
  is('the next hour is a different seed', seedFor(ten, T0) === seedFor(ten, T0 + 3600_001), false);
  const swapped = [row('NEWONE', 12), ...ten.slice(1)];
  is('one change in the ten is a different seed', seedFor(ten, T0) === seedFor(swapped, T0), false);
  const r1 = rng(seedOf('x')), r2 = rng(seedOf('x'));
  is('the generator is reproducible', [r1(), r1(), r1()].join(), [r2(), r2(), r2()].join());
  is('…and stays in range', [...Array(200)].every(() => { const v = rng(seedOf('y'))(); return v >= 0 && v < 1; }), true);
}

console.log('\npacking');
{
  const rs = [90, 80, 74, 68, 62, 58, 54, 50, 46, 42];
  const P = pack(rs, rng(12345));
  is('every bubble is placed', P.length, 10);
  const inside = P.every(p => p.x - p.r >= 0 && p.x + p.r <= CARD_W && p.y + p.r <= CARD_H);
  is('nothing hangs outside the frame', inside, true);
  is('nothing climbs into the title band', P.every(p => p.y - p.r >= 130), true);
  /* the map allows a little overlap on purpose; runaway overlap is a bug */
  let worst = 0;
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
    const d = Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y);
    const sum = P[a].r + P[b].r;
    worst = Math.max(worst, (sum - d) / sum);
  }
  is('overlap stays under a tenth of the radii', worst < 0.10, true, );
  const again = pack(rs, rng(12345));
  is('the same seed packs identically', JSON.stringify(P), JSON.stringify(again));
  is('a different seed packs differently', JSON.stringify(P) === JSON.stringify(pack(rs, rng(999))), false);
}

console.log('\nfitting text');
{
  is('a short ticker takes the cap', fitSize('$SOL', 160, 30), 30);
  const long = fitSize('$SCHRODINGER', 160, 30);
  is('a long one is shrunk to fit', long < 30, true);
  is('…and actually fits the width', long * 12 * 0.62 <= 160 + 0.01, true);
  is('never smaller than legible', fitSize('$AVERYVERYLONGTICKER', 60, 30), 9);
}

console.log('\nthe field fills the frame');
{
  /* the radii the card actually builds, not a hand-written set: a cluster is
     only as spreadable as its own area, and the card sizes for 60% of the box */
  const r0 = rng(2024);
  const P = pack(radii(10, r0), r0);
  const w = Math.max(...P.map(p => p.x + p.r)) - Math.min(...P.map(p => p.x - p.r));
  const h = Math.max(...P.map(p => p.y + p.r)) - Math.min(...P.map(p => p.y - p.r));
  is('spans most of the width', w > (1200 - 68) * 0.8, true, 'spans ' + Math.round(w));
  is('spans most of the height', h > (630 - 150 - 28) * 0.8, true, 'spans ' + Math.round(h));
  is('still inside the frame', P.every(p => p.x - p.r >= 0 && p.x + p.r <= 1200 && p.y - p.r >= 130 && p.y + p.r <= 630), true);
}

console.log('\nthe card');
{
  const svg = buildBubbleSvg({ rows: ten, seed: 42 });
  is('is an svg of the card size', /^<svg[^>]*width="1200"[^>]*height="630"/.test(svg), true);
  is('draws ten bubbles', (svg.match(/url\(#gb\d+\)/g) || []).length, 10);
  is('every ticker is on it', ten.every(r => svg.includes('$' + r.sym)), true);
  is('a gain is green', svg.includes('#22c46a'), true);
  is('a loss is red', svg.includes('#e8364d'), true);
  is('the same seed is the same picture', svg, buildBubbleSvg({ rows: ten, seed: 42 }));
  is('another seed is another picture', svg === buildBubbleSvg({ rows: ten, seed: 43 }), false);
  is('only the font the worker has', [...svg.matchAll(/font-family="([^"]+)"/g)].every(m => m[1] === 'Archivo Black'), true);
  is('no filters or css the rasteriser would drop', /<filter|<style|class=/.test(svg), false);

  /* the project's rule: a window nobody measured is not a number */
  const holes = [...ten.slice(0, 4), row('NOPC', null), row('NAN', NaN), ...ten.slice(4)];
  const svg2 = buildBubbleSvg({ rows: holes, seed: 7 });
  is('a token with no measured change is not drawn', svg2.includes('$NOPC') || svg2.includes('$NAN'), false);
  is('…and the rest still are', (svg2.match(/url\(#gb\d+\)/g) || []).length, 10);

  /* the empty-ring bug: no art, no ring */
  const noArt = buildBubbleSvg({ rows: ten.map(r => ({ ...r, logo: '' })), seed: 5 });
  is('a token with no art draws no ring', /<circle[^>]*stroke="#03200f"/.test(noArt), false);
  const withArt = buildBubbleSvg({ rows: ten.map(r => ({ ...r, logo: 'data:image/png;base64,AA' })), seed: 5 });
  is('…and one with art does', /<circle[^>]*stroke="#03200f"/.test(withArt), true);

  is('a hostile ticker cannot escape the markup', buildBubbleSvg({ rows: [row('<script>', 5), ...ten], seed: 1 }).includes('<script>'), false);

  let threw = '';
  try { buildBubbleSvg({ rows: ten.slice(0, 2), seed: 1 }); } catch (e) { threw = e.message; }
  is('two movers is not a top ten', threw, 'not enough rows');
}

console.log('\nart the rasteriser can read');
{
  const png = new Uint8Array([0x89,0x50,0x4E,0x47,13,10,26,10,0,0,0,13]);
  const jpg = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,16,0x4A,0x46,0x49,0x46,0,1]);
  const gif = new Uint8Array([0x47,0x49,0x46,0x38,0x39,0x61,1,0,1,0,0x80,0]);
  const webp = new Uint8Array([0x52,0x49,0x46,0x46,36,0,0,0,0x57,0x45,0x42,0x50]);
  const err = new Uint8Array([...'This IPFS gate'].map(c => c.charCodeAt(0)));
  is('png by its bytes', sniffType(png), 'image/png');
  is('jpeg by its bytes', sniffType(jpg), 'image/jpeg');
  is('gif by its bytes', sniffType(gif), 'image/gif');
  is('webp by its bytes', sniffType(webp), 'image/webp');
  /* the 429 body an IPFS gateway sends, which arrives as text/plain and would
     otherwise be base64'd into the card as if it were a picture */
  is('a rate-limit page is not an image', sniffType(err), '');
  is('too short to name', sniffType(new Uint8Array([0x89,0x50])), '');
  is('nothing is not an image', sniffType(null), '');

  is('format=auto is asked for png instead',
    preferReadable('https://cdn.dexscreener.com/cms/images/X?width=800&format=auto'),
    'https://cdn.dexscreener.com/cms/images/X?width=800&format=png');
  is('a url with no format is untouched',
    preferReadable('https://ipfs.io/ipfs/bafy'), 'https://ipfs.io/ipfs/bafy');

  is('an ipfs url has fallbacks, fastest first',
    altGateways('https://ipfs.io/ipfs/bafkreiabc').join(' '),
    'https://ipfs.filebase.io/ipfs/bafkreiabc https://gateway.pinata.cloud/ipfs/bafkreiabc');
  is('...whatever gateway it came from',
    altGateways('https://dweb.link/ipfs/QmXyz')[0], 'https://ipfs.filebase.io/ipfs/QmXyz');
  is('a non-ipfs url has none', altGateways('https://example.com/a.webp').length, 0);

  const conv = toReadableUrl('https://x.io/a.webp?q=1&b=2');
  is('conversion asks for png', conv.includes('output=png'), true);
  is('...and carries the whole url encoded', conv.includes(encodeURIComponent('https://x.io/a.webp?q=1&b=2')), true);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
