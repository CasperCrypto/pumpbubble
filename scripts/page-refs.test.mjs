/* ==========================================================================
   The page may not reference elements that do not exist.

       node scripts/page-refs.test.mjs

   This exists because of a real outage. Removing the caption strip under the
   map took the "N bubbles · size = mcap" element with it, but left the line
   that writes to it. getElementById returned null, setting .textContent threw
   inside rebuild(), and rebuild() is what draws the map — so every tab on
   every source hung on "loading…" forever.

   The failure was invisible from the server: all three feeds returned 200 with
   full token counts in under three seconds. Nothing but the browser console
   said otherwise, which is exactly the kind of break that survives a deploy.

   Markup and the script that drives it live in one file here, so a plain text
   check is enough to tie them together.
   ========================================================================== */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const referenced = [...html.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)]
  .map(m => m[1]);

const missing = [...new Set(referenced.filter(id => !declared.has(id)))];

if (missing.length) no('every getElementById target exists', 'missing: ' + missing.join(', '));
else ok('every getElementById target exists', referenced.length + ' references, all resolved');

/* The two controls that are the product's revenue line. If either loses its
   handler target the page still renders, so nothing else would catch it. */
for (const id of ['boostTop', 'cBoost']) {
  if (declared.has(id)) ok('boost control present', '#' + id);
  else no('boost control present', '#' + id + ' is gone');
}

/* Markup belongs in the body. A share dialog once landed above </head>
   because it was inserted before the first <script>, which is the JSON-LD in
   the head - the parser dropped it, the button silently did nothing, and no
   console error appeared to say why. */
const headEnd = html.indexOf('</head>');
const strays = [...html.slice(0, headEnd).matchAll(/<div\s+id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
if (strays.length) no('no markup above </head>', 'found: ' + strays.join(', '));
else ok('no markup above </head>');

/* ...and below the script that uses it. This page has no defer and no
   DOMContentLoaded: the app script runs inline and wires handlers as it goes,
   so markup placed after it does not exist yet. Moving the share dialog out of
   the head put it at the end of the body instead, and sveil.querySelector
   threw on null - which killed the render loop and left every tab on
   'loading...' again, from the opposite mistake. */
const bodyScript = html.indexOf('<script>', html.indexOf('</head>'));
const late = [...html.slice(bodyScript).matchAll(/<div\s+id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
if (late.length) no('no markup below the app script', 'found: ' + late.join(', '));
else ok('no markup below the app script');

/* The page's own formatters, lifted out of the file and run.

   `fmtPct(null)` threw for as long as any source published a window it does not
   have, because `null >= 0` is true in JavaScript: the sign guard passed and
   `null.toFixed` did not exist. It threw inside openCard, between the
   market-cap box and the line that reveals the card — so the failure looked
   like a bubble that simply would not open. No visual glitch, no failing
   route, one uncaught error in a console nobody had open, and every check this
   project runs stayed green. Stocks (no 5m, no 1h) and the two flow tabs (a
   day and a week, nothing shorter) were both dead that way.

   So these two are executed here rather than read. They are the only functions
   on the page that turn an absent number into something a reader sees, and
   "absent is not zero" is the bug this codebase keeps rediscovering. */
const lift = name => {
  const m = html.match(new RegExp('(?:const ' + name + '\\s*=|function ' + name + '\\b)'));
  if (!m) return null;
  const from = m.index;
  let src;
  if (html.slice(from).startsWith('const')) {
    src = html.slice(from, html.indexOf(';', from) + 1);
  } else {
    const open = html.indexOf('{', from);
    let d = 0, i = open;
    for (; i < html.length; i++) {
      if (html[i] === '{') d++;
      else if (html[i] === '}' && --d === 0) { i++; break; }
    }
    src = html.slice(from, i);
  }
  try { return new Function(src + ';return ' + name)(); } catch { return null; }
};

const DASH = '—';
const fmtPct = lift('fmtPct'), fmtUsd = lift('fmtUsd');
const cases = [
  ['fmtPct', fmtPct, null, DASH],
  ['fmtPct', fmtPct, undefined, DASH],
  ['fmtPct', fmtPct, NaN, DASH],
  ['fmtPct', fmtPct, 0, '+0.00%'],
  ['fmtPct', fmtPct, -5.78, '-5.78%'],
  ['fmtPct', fmtPct, 706399, '+706399%'],
  ['fmtUsd', fmtUsd, null, DASH],
  ['fmtUsd', fmtUsd, 0, DASH],
  ['fmtUsd', fmtUsd, 5.39e12, '$5.39T'],
  ['fmtUsd', fmtUsd, 2.08e9, '$2.08B'],
];
for (const [name, fn, input, want] of cases) {
  if (!fn) { no(name + ' is liftable', 'could not find it in the page'); continue; }
  let got;
  try { got = fn(input); }
  catch (e) { no(name + '(' + String(input) + ')', 'threw: ' + e.message); continue; }
  if (got === want) ok(name + '(' + String(input) + ')', got);
  else no(name + '(' + String(input) + ')', 'got ' + got + ', want ' + want);
}

/* Every inline script must parse. A redeclared `const` inside one function is
   a SyntaxError that stops the whole page — the map, the tabs, everything —
   and nothing above notices, because it reads the page as text. That exact
   bug (a second `const cb` in openCard) was caught in the browser before it
   shipped; this catches the next one before anyone has to look. */
{
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let bad = '';
  for (const s of scripts) { try { new Function(s); } catch (e) { bad = e.message; break; } }
  if (scripts.length && !bad) ok('every inline script parses', scripts.length + ' script' + (scripts.length > 1 ? 's' : ''));
  else no('every inline script parses', bad || 'no inline script found');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
