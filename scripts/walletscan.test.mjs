/* ==========================================================================
   Wallet X-ray — what a wallet's own swaps add up to.

       node scripts/walletscan.test.mjs

   Pinned: average-cost realized profit; a sell of tokens bought before the
   window is never counted as profit; a position is closed at 99% sold and
   dust is not an open position; win rate is over closed positions only; the
   hold time is first buy to last sell; quick flips; an address check.
   ========================================================================== */
import { positions, summarize, isWallet, holdLabel } from '../public/js/walletscan.mjs';

let pass = 0, fail = 0;
const is = (n, got, want) => { const ok = typeof want === 'number' ? Math.abs(got - want) < 1e-9 : JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))); };

const T = 1_800_000_000;
const sw = (mint, side, sol, tokens, t) => ({ mint, side, sol, tokens, blockTime: T + t, slot: t });

const s = summarize([
  /* A: bought 2 SOL for 1000, sold half for 2 SOL, the rest for 3 SOL: +3 SOL, closed, won, held 600s */
  sw('A', 'buy', 2, 1000, 0), sw('A', 'sell', 2, 500, 300), sw('A', 'sell', 3, 500, 600),
  /* B: bought 1 SOL, sold all for 0.4: −0.6, closed, lost, a quick flip (60s) */
  sw('B', 'buy', 1, 100, 10), sw('B', 'sell', 0.4, 100, 70),
  /* C: sold 5 SOL of tokens it bought before the window: not profit */
  sw('C', 'sell', 5, 1000, 20),
  /* D: bought 1 SOL, still holding */
  sw('D', 'buy', 1, 10, 30),
  /* E: bought 1 SOL, sold 99.5% for 2 SOL: closed, dust left is not open */
  sw('E', 'buy', 1, 1000, 40), sw('E', 'sell', 2, 995, 100),
], { txRead: 50 });

const by = Object.fromEntries(s.positions.map(p => [p.mint, p]));
is('A: realized is what it got back over what it paid', by.A.realized, 3);
is('A: closed', by.A.closed, true);
is('A: held from first buy to last sell', by.A.holdS, 600);
is('B: a loss', by.B.realized, -0.6);
is('C: a sell of earlier buys is not profit', by.C.realized, 0);
is('C: …it is counted as sold from earlier', by.C.earlierSol, 5);
is('D: still open', by.D.held, 10);
is('E: 99.5% sold is closed', by.E.closed, true);
is('E: the dust left is not an open position', by.E.held, 0);
is('E: profit at average cost', by.E.realized, 2 - 0.995);
is('realized adds up', s.realizedSol, 3 - 0.6 + 1.005);
is('win rate is over closed positions only (A, E won; B lost)', s.winRate, 2 / 3);
is('two quick flips (B and E, 60 s each)', s.quickFlips, 2);
is('one open position', s.open, 1);
is('best is A', s.best.mint, 'A');
is('worst is B', s.worst.mint, 'B');
is('nothing closed: no win rate, not 0%', summarize([sw('X', 'buy', 1, 1, 0)]).winRate, null);
is('a wallet address is one', isWallet('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'), true);
is('an EVM address is not', isWallet('0x' + 'a'.repeat(40)), false);
is('hold labels', [holdLabel(30), holdLabel(300), holdLabel(7200), holdLabel(200000), holdLabel(null)].join(' '), '30s 5m 2.0h 2.3d —');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
