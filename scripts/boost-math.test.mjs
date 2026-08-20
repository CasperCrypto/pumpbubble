/* ==========================================================================
   Boost economics — the properties the map depends on.

       node scripts/boost-math.test.mjs

   These are the rules that keep paid size proportional: advertised tiers have
   to hold, a crowd has to beat a whale, and no amount of money may let one
   bubble swallow the screen.
   ========================================================================== */

import { TIERS, bonusFromSpend, liveSpend, bonusOf } from '../src/boosts.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* the map turns bonus into radius, and the eye reads area */
const radius = b => 1 + b * 0.6;
const area = b => radius(b) ** 2;

console.log('\n== advertised tiers still hold for a single buyer ==');
for (const [k, t] of Object.entries(TIERS)) {
  const got = 1 + bonusFromSpend(t.usd);
  near(got, t.mult, 0.15)
    ? ok(`${k} $${t.usd} advertised x${t.mult}`, `actual x${got.toFixed(2)}`)
    : no(`${k} advertised x${t.mult}`, `actual x${got.toFixed(2)}`);
}

console.log('\n== stacking is bounded ==');
const table = [1, 2, 5, 10, 20, 50, 200].map(n => {
  const spend = n * 9;
  const b = bonusFromSpend(spend);
  return { n, spend, b, r: radius(b), a: area(b) };
});
for (const r of table) {
  console.log(`   ${String(r.n).padStart(3)} x $9 = $${String(r.spend).padStart(4)}   bonus ${r.b.toFixed(2).padStart(5)}   radius x${r.r.toFixed(2)}   area x${r.a.toFixed(1)}`);
}
const worst = table[table.length - 1];
worst.r <= 4.01
  ? ok('200 micro-boosts cannot swallow the screen', `radius x${worst.r.toFixed(2)} (was x61 unbounded)`)
  : no('runaway stacking', `radius x${worst.r.toFixed(2)}`);

console.log('\n== a crowd still beats a whale ==');
const whale = bonusFromSpend(TIERS.whale.usd);          // $149
const crowd = bonusFromSpend(9 * 20);                   // $180 from twenty holders
crowd > whale
  ? ok('20 x $9 ($180) outranks 1 x $149', `x${(1 + crowd).toFixed(2)} vs x${(1 + whale).toFixed(2)}`)
  : no('crowd beats whale', `x${(1 + crowd).toFixed(2)} vs x${(1 + whale).toFixed(2)}`);

console.log('\n== each extra dollar buys less than the last ==');
let prevMarginal = Infinity, monotonic = true;
for (const s of [9, 49, 149, 300, 600]) {
  const marginal = bonusFromSpend(s + 9) - bonusFromSpend(s);
  if (marginal > prevMarginal + 1e-9) monotonic = false;
  prevMarginal = marginal;
}
monotonic ? ok('diminishing returns hold across the range')
          : no('diminishing returns', 'a later dollar bought more than an earlier one');

console.log('\n== decay ==');
const order = { usd: 49, startedAt: 0, until: 100, mult: 2.4 };
const halfway = liveSpend(order, 50);
near(halfway, 24.5, 0.01)
  ? ok('spend decays linearly', `$49 -> $${halfway.toFixed(2)} at the halfway point`)
  : no('spend decays linearly', String(halfway));
bonusOf(order, 100) === 0 ? ok('expired boost contributes nothing') : no('expired boost');

/* Two half-spent boosts must not beat one whole one of the same total, or
   buying twice and letting both rot would be a strategy. */
const oneWhole = bonusFromSpend(49);
const twoHalves = bonusFromSpend(24.5 + 24.5);
near(oneWhole, twoHalves, 1e-9)
  ? ok('decayed spend pools correctly', 'two half-spent = one whole of equal value')
  : no('decayed spend pools correctly');

console.log('\n== the cap is reachable but real ==');
const capped = bonusFromSpend(1e9);
capped <= 5.0001 ? ok('bonus is hard-capped', `x${(1 + capped).toFixed(2)} radius x${radius(capped).toFixed(1)}`)
                 : no('bonus is hard-capped', String(capped));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
