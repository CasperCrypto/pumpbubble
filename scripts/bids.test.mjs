/* ==========================================================================
   Bid board rules.

       node scripts/bids.test.mjs

   The board decides who is #1 on a public leaderboard people are paying real
   money to sit on. Every rule that decides rank is pinned here.
   ========================================================================== */

import {
  board, priceFor, standing, applyBid, countClick, bidsAsBoostSpend,
  FLOOR_SOL, INCREMENT_SOL,
} from '../src/bids.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const mkStore = () => { const m = new Map(); return {
  available: true,
  async get(k) { return m.has(k) ? m.get(k) : null; },
  async put(k, v) { m.set(k, v); },
}; };

const M = n => 'Mint' + String(n).padStart(40, '0');
let sigN = 0;
const bid = (store, mint, sol, sym) =>
  applyBid(store, { mint, sym: sym || 'T' + mint.slice(-2), sol, sig: 'sig' + (++sigN), payer: 'P' + mint.slice(-2) });

console.log('\n== rank is the bid ==');
{
  const s = mkStore();
  await bid(s, M(1), 1, 'AAA');
  await bid(s, M(2), 5, 'BBB');
  await bid(s, M(3), 3, 'CCC');
  const rows = await board(s);
  rows.map(r => r.sym).join(',') === 'BBB,CCC,AAA'
    ? ok('sorted by amount', rows.map(r => `${r.rank}:${r.sym} ${r.sol}`).join('  '))
    : no('sorted by amount', rows.map(r => r.sym).join(','));
  rows[0].rank === 1 && rows[2].rank === 3 ? ok('ranks derived from order') : no('ranks');
}

console.log('\n== bids accumulate, so defending is cheap ==');
{
  const s = mkStore();
  await bid(s, M(1), 2, 'AAA');
  await bid(s, M(1), 3, 'AAA');
  const rows = await board(s);
  near(rows[0].sol, 5) ? ok('topping up adds', '2 + 3 = 5 SOL') : no('topping up', String(rows[0].sol));
  rows.length === 1 ? ok('still one entry per token') : no('duplicate entries', String(rows.length));
}

console.log('\n== one payment counts once ==');
{
  const s = mkStore();
  await applyBid(s, { mint: M(1), sym: 'AAA', sol: 4, sig: 'same', payer: 'P' });
  await applyBid(s, { mint: M(1), sym: 'AAA', sol: 4, sig: 'same', payer: 'P' });
  const rows = await board(s);
  near(rows[0].sol, 4)
    ? ok('replaying a signature is ignored', 'still 4 SOL')
    : no('replay counted twice', String(rows[0].sol));
}

console.log('\n== what it costs to take a rank ==');
{
  const s = mkStore();
  const empty = await priceFor(s, 1);
  near(empty.takeSol, FLOOR_SOL)
    ? ok('empty board opens at the floor', FLOOR_SOL + ' SOL') : no('floor', String(empty.takeSol));

  await bid(s, M(1), 10, 'AAA');
  await bid(s, M(2), 4, 'BBB');
  const p1 = await priceFor(s, 1);
  near(p1.takeSol, 10 + INCREMENT_SOL)
    ? ok('taking #1 beats #1', `${p1.takeSol} SOL vs ${p1.currentSol}`) : no('take #1', String(p1.takeSol));
  p1.currentHolder?.sym === 'AAA' ? ok('names who holds it') : no('holder');

  const p2 = await priceFor(s, 2);
  near(p2.takeSol, 4 + INCREMENT_SOL) ? ok('taking #2 beats #2') : no('take #2', String(p2.takeSol));

  /* a small bid is still welcome — a board only whales can join is a board
     nobody else checks */
  await bid(s, M(3), FLOOR_SOL, 'CCC');
  const rows = await board(s);
  rows.length === 3 && rows[2].sym === 'CCC'
    ? ok('a floor bid still lands on the board', 'at #3') : no('small bid rejected');
}

console.log('\n== topping up only pays the difference ==');
{
  const s = mkStore();
  await bid(s, M(1), 10, 'AAA');
  await bid(s, M(2), 6, 'BBB');
  const st = await standing(s, M(2));
  st.current.rank === 2 ? ok('knows where you stand', '#2') : no('standing', JSON.stringify(st.current));
  near(st.toBeatAboveSol, 10 - 6 + INCREMENT_SOL)
    ? ok('quotes only the gap', `${st.toBeatAboveSol} SOL to pass #1, not ${10 + INCREMENT_SOL}`)
    : no('gap quote', String(st.toBeatAboveSol));

  const top = await standing(s, M(1));
  top.toBeatAboveSol === 0 ? ok('#1 has nothing above to beat') : no('#1 gap', String(top.toBeatAboveSol));

  const absent = await standing(s, M(9));
  absent.current === null ? ok('a token not on the board has no standing') : no('absent');
}

console.log('\n== ties ==');
{
  const s = mkStore();
  await applyBid(s, { mint: M(1), sym: 'FIRST', sol: 5, sig: 'a', payer: 'P' });
  await new Promise(r => setTimeout(r, 5));
  await applyBid(s, { mint: M(2), sym: 'LATER', sol: 5, sig: 'b', payer: 'P' });
  const rows = await board(s);
  rows[0].sym === 'FIRST'
    ? ok('equal bids: whoever got there first keeps the rank')
    : no('tie-break', rows.map(r => r.sym).join(','));
}

console.log('\n== clicks ==');
{
  const s = mkStore();
  await bid(s, M(1), 1, 'AAA');
  await countClick(s, M(1));
  await countClick(s, M(1));
  const rows = await board(s);
  rows[0].clicks === 2 ? ok('clicks counted', '2') : no('clicks', String(rows[0].clicks));
  (await countClick(s, M(9))) === null ? ok('clicks on an unlisted token are ignored') : no('phantom click');
}

console.log('\n== the map sees bids as paid size ==');
{
  const s = mkStore();
  await bid(s, M(1), 10, 'AAA');
  const rows = await board(s);
  const spend = bidsAsBoostSpend(rows, 200);      /* SOL at $200 */
  const one = spend.get(M(1));
  near(one.liveUsd, 2000) ? ok('converted to USD spend', '10 SOL @ $200 = $2000') : no('conversion', String(one.liveUsd));
  one.until > Date.now() + 1e11 ? ok('a bid does not expire') : no('bid expires', String(one.until));
  one.bid === true && one.rank === 1 ? ok('carries rank and a bid marker') : no('marker');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
