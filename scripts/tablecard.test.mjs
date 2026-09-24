/* ==========================================================================
   The leaderboard share card — Smart money's two views as ten rows.

       node scripts/tablecard.test.mjs

   It prints attacker-chosen strings (pump.fun usernames, tickers, X handles)
   onto an image with our domain on it, so escaping is tested first; then
   that it never draws more than ten rows, refuses to draw fewer than three,
   and that every row and number lands inside the frame.
   ========================================================================== */

import { buildTableSvg, UP, DN } from '../src/tablecard.mjs';
import { CARD_W, CARD_H } from '../src/card.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const cols = [{ label: 'BANKED', x: 760 }, { label: 'OPEN', x: 960 }, { label: 'TOTAL', x: 1152 }];
const row = (title, o = {}) => ({
  title, subtitle: '', logo: null,
  values: [{ text: '+$58.7K', color: UP }, { text: '−$95.8K', color: DN }, { text: '−$37.1K', color: DN }],
  ...o,
});
const names = ['@cooker', 'Weeshark', '@hexiecs', 'MadToast', 'goon', 'ZCAT', 'dev', 'sol', 'grok', 'deed', 'eleventh', 'twelfth'];
const spec = (rows, o = {}) => ({ title: 'TOP TRADERS BY REALIZED PNL', sub: '24H', cols, rows, ...o });

console.log('\nrows');
{
  const svg = buildTableSvg(spec(names.map(n => row(n))));
  is('at most ten rows are drawn', (svg.match(/<clipPath id="a\d+"/g) || []).length, 10);
  is('the eleventh is not on the card', svg.includes('eleventh'), false);
  let threw = false;
  try { buildTableSvg(spec(names.slice(0, 2).map(n => row(n)))); } catch { threw = true; }
  is('under three rows refuses rather than draws', threw, true);
  const gaps = buildTableSvg(spec([row('a'), null, row(''), row('b'), row('c')]));
  is('empty and missing rows are skipped, not numbered', (gaps.match(/<clipPath id="a\d+"/g) || []).length, 3);
  is('the top three wear medals', (svg.match(/width="5" height="38"/g) || []).length, 3);
}

console.log('\nescaping');
{
  const svg = buildTableSvg(spec([
    row('<img src=x onerror=alert(1)>'), row('a&b', { subtitle: '"quoted"' }), row('c'),
  ], { title: 'T<script>' }));
  is('no raw tag from a name reaches the SVG', svg.includes('<img') || svg.includes('<script'), false);
  is('ampersands are escaped', svg.includes('a&amp;b'), true);
  is('quotes in a subtitle are escaped', svg.includes('&quot;quoted&quot;'), true);
  const bad = buildTableSvg(spec([row('a', { logo: 'data:image/png;base64,AA"/><script>' }), row('b'), row('c')]));
  is('a logo cannot close its attribute', bad.includes('<script'), false);
}

console.log('\nframe');
{
  const svg = buildTableSvg(spec(names.map(n => row(n, { subtitle: 'a pump.fun username' }))));
  const ys = [...svg.matchAll(/<rect x="48" y="(\d+)" width="\d{3,}" height="(\d+)"/g)].map(m => +m[1] + +m[2]);
  is('ten row backgrounds', ys.length, 10);
  const last = Math.max(...ys);
  last <= CARD_H - 10 ? ok('the last row ends inside the card', `${last} of ${CARD_H}`) : no('the last row ends inside the card', `${last} of ${CARD_H}`);
  const xs = [...svg.matchAll(/text-anchor="end"[^>]*?>|x="(\d+(?:\.\d+)?)"/g)].map(m => +m[1]).filter(Number.isFinite);
  Math.max(...xs) <= CARD_W ? ok('nothing is placed past the right edge') : no('nothing is placed past the right edge', String(Math.max(...xs)));
  const long = buildTableSvg(spec([row('@' + 'x'.repeat(40)), row('b'), row('c')]));
  const fs = +(long.match(/font-size="([\d.]+)" fill="#ffffff">@x+/) || [])[1];
  fs > 0 && fs * 0.62 * 24 <= 760 - 150 - 152 + 1
    ? ok('a long name shrinks to its column', `${fs}px, clipped to 24 chars`)
    : no('a long name shrinks to its column', String(fs));
  const noLogo = buildTableSvg(spec([row('$zcat'), row('b'), row('c')]));
  is('no art draws the first letter, not the sigil', /font-size="15" fill="#9fb0c4">Z</.test(noLogo), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
