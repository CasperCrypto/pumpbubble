/* Install or remove a permanent house boost.

   A house boost is the operator's own feature slot: a gold bubble that never
   expires and never decays. It is stored in the same list as a paid boost and
   flagged `house`, so every path downstream treats it identically — pooling,
   the bonus curve, the gold-share guardrail, and the re-add that keeps a paid
   bubble on the map after its token drops out of the pump.fun feed.

   It is deliberately not disguised as a purchase. The flag is what stops the
   revenue ledger counting money that was never paid.

     node scripts/house-boost.mjs --mint <mint> [--usd 400] [--go]
     node scripts/house-boost.mjs --remove <mint> --go

   Without --go it prints what it would do and changes nothing.
*/

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const GO = args.includes('--go');
const REMOVE = arg('remove', null);
const MINT = REMOVE || arg('mint', null);
/* $400 is where the bonus curve reaches its cap, so this is the largest a
   bubble is ever allowed to be. Lower it to take up less of the map. */
const USD = Number(arg('usd', 400));

if (!MINT) {
  console.error('need --mint <mint>  (or --remove <mint>)');
  process.exit(1);
}

const kv = (...a) => execFileSync('npx', ['wrangler', 'kv', ...a], {
  encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});

function read(key) {
  try {
    const out = kv('key', 'get', key, '--binding', 'BUBBLE_KV', '--remote');
    return JSON.parse(out.slice(out.indexOf('[') >= 0 ? out.indexOf('[') : out.indexOf('{')));
  } catch { return null; }
}

const list = read('boosts') || [];
console.log('');
console.log('  ' + list.length + ' boost record(s) currently stored');

if (REMOVE) {
  const next = list.filter(b => !(b.house && b.mint === MINT));
  console.log('  removing ' + (list.length - next.length) + ' house boost(s) for this mint');
  if (!GO) { console.log('\n  Dry run. Add --go to apply.\n'); process.exit(0); }
  writeBack(next);
  console.log('  done\n');
  process.exit(0);
}

/* Real metadata, so the bubble carries the token's own art and ticker. The
   re-add path reads these when the token is not in the current feed, which is
   exactly when a permanent boost most needs them. */
const r = await fetch('https://frontend-api-v3.pump.fun/coins-v2/' + MINT)  // /coins/<mint> is retired (core.mjs pumpCoin);
if (!r.ok) { console.error('  pump.fun returned ' + r.status); process.exit(1); }
const c = await r.json();

const boost = {
  house: true,
  mint: MINT,
  sym: c.symbol || '',
  name: c.name || c.symbol || '',
  img: c.image_uri || '',
  mcap: c.usd_market_cap || 0,
  grad: !!c.complete,
  usd: USD,
  startedAt: Date.now(),
  /* Far future rather than Infinity: JSON has no Infinity, and every existing
     comparison against `until` keeps working unchanged. The house flag is what
     actually makes it permanent. */
  until: Date.now() + 100 * 365 * 24 * 3600 * 1000,
  sig: 'house:' + MINT,
  payer: null,
};

console.log('  installing house boost');
console.log('    token   ' + boost.name + '  $' + boost.sym);
console.log('    mint    ' + MINT);
console.log('    art     ' + (boost.img || 'none'));
console.log('    weight  $' + USD + ' of equivalent spend (never decays)');

const next = [...list.filter(b => !(b.house && b.mint === MINT)), boost];

if (!GO) { console.log('\n  Dry run. Add --go to apply.\n'); process.exit(0); }
writeBack(next);
console.log('  done — it appears on the next snapshot refresh\n');

function writeBack(value) {
  /* Written via --path rather than as an argument: the boost list is far past
     any safe command-line length, and a shell would mangle the JSON anyway. */
  const tmp = join(tmpdir(), 'boosts-' + Date.now() + '.json');
  writeFileSync(tmp, JSON.stringify(value));
  try {
    kv('key', 'put', 'boosts', '--binding', 'BUBBLE_KV', '--remote', '--path', tmp);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}
