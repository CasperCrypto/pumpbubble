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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
