/* ==========================================================================
   Our own market-cap history, and what it may fill.

       node scripts/history.test.mjs

   Three things went wrong here at once, all quietly:

     - history was written under `t.mint` and read under `t.id`. They agree
       only where the id is the mint (pump.fun), so every other feed's tokens
       — all carrying `mint: ''` — were pushed into one shared array under
       the empty key, saved to KV with it, and never read back;
     - `!t.pc[k]` took a *measured* 0 for a gap and replaced it with our own
       estimate;
     - pump.fun's normaliser seeded every window at 0, so a coin no upstream
       priced kept a "+0.00%" nobody had measured.
   ========================================================================== */

import { pushHistory, changeFromHistory, buildSnapshot, normalizeCoin } from '../src/core.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const MINT_A = 'A'.repeat(39) + 'pump';
const MINT_B = 'B'.repeat(39) + 'pump';

console.log('\nkeying');
{
  const hist = new Map();
  const now = Date.now();
  pushHistory(hist, [
    { id: MINT_A, mint: MINT_A, mcap: 100 },
    { id: 'cg:btc-bitcoin', mint: '', mcap: 2e12 },
    { id: 'base:0xabc', mint: '', mcap: 5e6 },
    { id: 'stock:AAPL', mcap: 3e12 },
  ], now - 2 * 36e5);
  is('a token with no mint leaves no empty key', hist.has(''), false);
  is('nor an undefined one', hist.has(undefined), false);
  is('only the mint is recorded', hist.size, 1);
  pushHistory(hist, [{ id: MINT_A, mint: MINT_A, mcap: 150 }], now);
  const ch = changeFromHistory(hist, MINT_A, 150, now);
  is('read back under the same key: +50% over the hour', Math.round(ch.h1), 50);
}

console.log('\npump.fun seed');
{
  const t = normalizeCoin({ mint: MINT_A, symbol: 'AAA', name: 'aaa', usd_market_cap: 1000 });
  is('5m starts unmeasured', t.pc.m5, null);
  is('24h starts unmeasured', t.pc.h24, null);
}

console.log('\nwhat history may fill (buildSnapshot)');
{
  const now = Date.now();
  const hist = new Map([[MINT_A, [now - 2 * 36e5, 100]], [MINT_B, [now - 2 * 36e5, 100]]]);
  const rows = () => [
    /* measured flat on the hour: a zero is an answer */
    { id: MINT_A, mint: MINT_A, sym: 'A', name: 'a', mcap: 200, pc: { m5: 0, h1: 0, h6: null, h24: null } },
    /* nothing measured at all */
    { id: MINT_B, mint: MINT_B, sym: 'B', name: 'b', mcap: 300, pc: { m5: null, h1: null, h6: null, h24: null } },
    { id: 'chain:Solana', mint: '', sym: 'Solana', name: 'Solana', mcap: 4e9, pc: { m5: null, h1: null, h6: null, h24: 3 } },
  ];
  const src = { id: 'test', label: 'test', chain: 'mixed', enrich: false, quality: 'major', fetch: async () => rows() };
  const snap = await buildSnapshot({ source: src, hist });
  const by = Object.fromEntries(snap.tokens.map(t => [t.id, t]));
  is('a measured 0 is kept, not replaced by our estimate', by[MINT_A].pc.h1, 0);
  is('an unmeasured hour is filled from our own snapshots', Math.round(by[MINT_B].pc.h1), 200);
  is('a token with no mint gets no history fill', by['chain:Solana'].pc.h1, null);
  is('and its measured 24h is untouched', by['chain:Solana'].pc.h24, 3);
  is('no empty key was written', hist.has(''), false);

  const off = { ...src, id: 'off', history: false };
  const hist2 = new Map([[MINT_B, [now - 2 * 36e5, 100]]]);
  const snap2 = await buildSnapshot({ source: off, hist: hist2 });
  is('a source that opts out is not filled', snap2.tokens.find(t => t.id === MINT_B).pc.h1, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
