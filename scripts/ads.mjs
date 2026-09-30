/* Manage the ad rail above the map.

   Slots come from KV so one can be filled or cleared without a deploy. The rail
   always shows four; whatever is not sold renders as "SLOT OPEN", which is
   deliberate — an empty slot is the advert for the inventory.

     node scripts/ads.mjs --list
     node scripts/ads.mjs --add --title POK --sub "text" --url <url> [--mint <mint>] --go
     node scripts/ads.mjs --remove POK --go

   With --mint the art and ticker are read from pump.fun, so an ad for a token
   carries the token's own logo without anyone hunting for an image URL.

   Art is stored as the upstream URL. /api/ads signs it into a proxy URL on the
   way out, because the page is served img-src 'self' and would otherwise show a
   broken image in a slot somebody paid for.
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
const has = n => args.includes('--' + n);
const GO = has('go');

const kv = (...a) => execFileSync('npx', ['wrangler', 'kv', ...a], {
  encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});

function read() {
  try {
    const out = kv('key', 'get', 'ads', '--binding', 'BUBBLE_KV', '--remote');
    const i = out.indexOf('[');
    return i >= 0 ? JSON.parse(out.slice(i)) : [];
  } catch { return []; }
}

function write(value) {
  const tmp = join(tmpdir(), 'ads-' + Date.now() + '.json');
  writeFileSync(tmp, JSON.stringify(value));
  try { kv('key', 'put', 'ads', '--binding', 'BUBBLE_KV', '--remote', '--path', tmp); }
  finally { try { unlinkSync(tmp); } catch {} }
}

const ads = read();
console.log('');
console.log('  ' + ads.length + ' of 4 slots filled');
for (const a of ads) console.log('    ' + (a.title || '?') + '  ' + (a.url || ''));

if (has('list')) { console.log(''); process.exit(0); }

const REMOVE = arg('remove', null);
if (REMOVE) {
  const next = ads.filter(a => (a.title || '').toUpperCase() !== REMOVE.toUpperCase());
  console.log('');
  console.log('  removing ' + (ads.length - next.length) + ' slot(s) titled ' + REMOVE);
  if (!GO) { console.log('\n  Dry run. Add --go to apply.\n'); process.exit(0); }
  write(next);
  console.log('  done\n');
  process.exit(0);
}

if (!has('add')) {
  console.error('\n  nothing to do — pass --list, --add or --remove\n');
  process.exit(1);
}

let title = arg('title', '');
let img = arg('img', '');
let url = arg('url', '');
const sub = arg('sub', 'sponsored');
const mint = arg('mint', null);

if (mint) {
  const r = await fetch('https://frontend-api-v3.pump.fun/coins-v2/' + mint)  // /coins/<mint> is retired (core.mjs pumpCoin);
  if (!r.ok) { console.error('  pump.fun returned ' + r.status); process.exit(1); }
  const c = await r.json();
  title = title || c.symbol || c.name || '';
  img = img || c.image_uri || '';
  url = url || ('https://pump.fun/coin/' + mint);
}

if (!title) { console.error('  need --title (or --mint to read one)'); process.exit(1); }
if (url && !/^https?:\/\//i.test(url)) {
  console.error('  --url must be http(s): the rail refuses anything else');
  process.exit(1);
}

/* Four slots, and no more. The cap is what keeps the rail worth buying. */
const next = [...ads.filter(a => (a.title || '').toUpperCase() !== title.toUpperCase()),
              { title, sub, img, url }].slice(0, 4);

console.log('');
console.log('  adding slot');
console.log('    title  ' + title);
console.log('    sub    ' + sub);
console.log('    url    ' + (url || 'none'));
console.log('    art    ' + (img || 'none'));

if (!GO) { console.log('\n  Dry run. Add --go to apply.\n'); process.exit(0); }
write(next);
console.log('  done — live on the next page load\n');
