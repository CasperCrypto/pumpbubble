/* Pin a Robinhood Chain token onto the map.

     node scripts/rh-seed.mjs --list
     node scripts/rh-seed.mjs --sym ROBINCAT --go
     node scripts/rh-seed.mjs --addr 0xded852De9fe9bA9b6f27f39e8e81CF851A5C79cc --go

   Discovery on this chain has to page: any single query comes back as a swarm
   of one ticker's clones — forty-four tokens call themselves ROBINCAT — so a
   token can take a long time to be reached. A seed jumps that queue and is
   never pruned.

   With --sym the address is resolved through DexScreener and the deepest pool
   wins, because a ticker on this chain does not identify a token. The address
   it picked is printed before anything is written, since pinning the wrong
   ROBINCAT would put a clone on the map under a real name.
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
const KEY = 'rhchain';

const kv = (...a) => execFileSync('npx', ['wrangler', 'kv', ...a], {
  encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});

function read() {
  try {
    const out = kv('key', 'get', KEY, '--binding', 'BUBBLE_KV', '--remote');
    const i = out.indexOf('{');
    return i >= 0 ? JSON.parse(out.slice(i)) : {};
  } catch { return {}; }
}

function write(value) {
  const tmp = join(tmpdir(), 'rhchain-' + Date.now() + '.json');
  writeFileSync(tmp, JSON.stringify(value));
  try { kv('key', 'put', KEY, '--binding', 'BUBBLE_KV', '--remote', '--path', tmp); }
  finally { try { unlinkSync(tmp); } catch {} }
}

const reg = read();
reg.addrs = Array.isArray(reg.addrs) ? reg.addrs : [];
reg.seeds = Array.isArray(reg.seeds) ? reg.seeds : [];

console.log('');
console.log('  registry: ' + reg.addrs.length + ' addresses, ' + reg.seeds.length + ' pinned');

if (has('list')) {
  for (const a of reg.seeds) console.log('    ' + a);
  console.log('');
  process.exit(0);
}

let addr = (arg('addr', '') || '').toLowerCase();
const sym = arg('sym', '');

if (!addr && sym) {
  const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(sym));
  if (!r.ok) { console.error('  dexscreener returned ' + r.status); process.exit(1); }
  const j = await r.json();
  const hits = (j.pairs || [])
    .filter(p => p.chainId === 'robinhood'
      && (p.baseToken.symbol || '').toUpperCase() === sym.toUpperCase())
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));

  if (!hits.length) { console.error('\n  no Robinhood Chain pair with that ticker\n'); process.exit(1); }
  console.log('');
  console.log('  ' + hits.length + ' token(s) trade under that ticker. Deepest pool wins:');
  for (const p of hits.slice(0, 4)) {
    console.log('    ' + p.baseToken.address
      + '   liq $' + Math.round((p.liquidity && p.liquidity.usd) || 0).toLocaleString()
      + '   mcap $' + Math.round((p.marketCap || p.fdv || 0) / 1e6) + 'M');
  }
  addr = hits[0].baseToken.address.toLowerCase();
}

if (!/^0x[0-9a-f]{40}$/.test(addr)) {
  console.error('\n  need --addr <0x…> or --sym <TICKER>\n');
  process.exit(1);
}

if (reg.seeds.includes(addr)) { console.log('\n  already pinned: ' + addr + '\n'); process.exit(0); }

console.log('');
console.log('  pinning ' + addr);
if (!GO) { console.log('\n  Dry run. Add --go to apply.\n'); process.exit(0); }

reg.seeds = [...new Set([...reg.seeds, addr])];
reg.addrs = [...new Set([...reg.addrs, addr])];
write(reg);
console.log('  done — live on the next snapshot\n');
