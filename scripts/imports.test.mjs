/* ==========================================================================
   Every module has to actually load.

       node scripts/imports.test.mjs

   This exists because moving one helper broke `export const clean` in
   core.mjs, so `sources.mjs` could no longer import it — and the whole suite
   still passed, because nothing in it imported sources.mjs. `node --check` did
   not catch it either: a missing export is valid syntax and only fails when
   the module graph is linked.

   In production that failure is total. `sources.mjs` is what every feed goes
   through, so the map would have served nothing at all on the first request
   after the deploy.
   ========================================================================== */

import { readdirSync } from 'node:fs';

/* These reach the display font and the WASM rasteriser through wrangler's
   [[rules]], which Node knows nothing about — a .ttf is not a module to it.
   They are unloadable here by design. What covers them is
   `npx wrangler deploy --dry-run`, which bundles the real graph and fails on
   an unresolved import the same way this does. */
const WORKER_ONLY = new Set(['png.mjs', 'api.mjs']);

let pass = 0, fail = 0, skip = 0;
const dir = new URL('../src/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();

for (const f of files) {
  if (WORKER_ONLY.has(f)) {
    skip++;
    console.log(`  SKIP  ${f}  — Worker-only assets, covered by wrangler --dry-run`);
    continue;
  }
  try {
    await import(new URL(f, dir).href);
    pass++;
    console.log(`  PASS  ${f}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${f}  — ${(e && e.message) || e}`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
