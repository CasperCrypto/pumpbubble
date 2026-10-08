/* ==========================================================================
   Base map art — the token list's logo where DexScreener has none.

       node scripts/basechain.test.mjs

   On 2026-10-08 a quarter of the Base map (53 of 220) drew letters while the
   CoinGecko list the map is built from had a logo for every token.
   ========================================================================== */

import { logoPath, logoUrl, baseTokens } from '../src/basechain.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

console.log('\nlogo paths');
is('the list\'s thumb kept as a short path', logoPath('https://assets.coingecko.com/coins/images/53669/thumb/IMG_3254.jpeg?1740321990'), '53669/IMG_3254.jpeg?1740321990');
is('served at the large size, on the current host', logoUrl('53669/IMG_3254.jpeg?1740321990'), 'https://coin-images.coingecko.com/coins/images/53669/large/IMG_3254.jpeg?1740321990');
is('a host that is not CoinGecko is not kept', logoPath('https://evil.example/coins/images/1/thumb/x.png'), '');
is('no path, no URL', logoUrl(''), '');

console.log('\nthe map');
{
  const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
  const store = { m: new Map([
    ['basechain', { live: {
      [a]: { sym: 'AAA', name: 'A', img: 'https://dex.example/a.png', mcap: 2e6, pc: { h24: 1 } },
      [b]: { sym: 'BBB', name: 'B', img: '', mcap: 1e6, pc: { h24: 2 } },
    }, dead: {}, seeds: [], cursor: 0, at: 1 }],
    ['baseuni', { at: 1, addrs: [a, b], logos: { [a]: '1/a.png', [b]: '2/b.png' } }],
  ]), async get(k) { return this.m.get(k) ?? null; }, async put(k, v) { this.m.set(k, v); } };
  const rows = await baseTokens(store, 10);
  const by = Object.fromEntries(rows.map(r => [r.sym, r.rawImg]));
  is('DexScreener\'s picture is kept where it exists', by.AAA, 'https://dex.example/a.png');
  is('the list\'s logo fills where it does not', by.BBB, 'https://coin-images.coingecko.com/coins/images/2/large/b.png');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
