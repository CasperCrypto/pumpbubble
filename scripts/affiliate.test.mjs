/* ==========================================================================
   Affiliate accounting — the rules that decide who gets paid.

       node scripts/affiliate.test.mjs

   Runs against a Map, no network. Commission is money owed to real people, so
   the arithmetic and the fraud checks get pinned down here rather than
   discovered on a payout day.
   ========================================================================== */

import {
  upsertAffiliate, getAffiliate, resolveReferral, commissionUsd,
  statement, recordPayout, isCode, DEFAULT_PCT,
} from '../src/affiliates.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const near = (a, b) => Math.abs(a - b) < 1e-9;

const mkStore = () => { const m = new Map(); return {
  available: true,
  async get(k) { return m.has(k) ? m.get(k) : null; },
  async put(k, v) { m.set(k, v); },
}; };

const ALICE = 'AL1ceWa11etAddressAAAAAAAAAAAAAAAAAAAAAAAAA';
const DEV   = 'DeVWa11etAddressBBBBBBBBBBBBBBBBBBBBBBBBBBB';

console.log('\n== codes ==');
for (const [c, want] of [['alice', true], ['a1', false], ['Alice', false],
  ['has space', false], ['ok_code-1', true], ['x'.repeat(24), true], ['x'.repeat(25), false]]) {
  isCode(c) === want ? ok(`"${c}" ${want ? 'accepted' : 'rejected'}`)
                     : no(`"${c}"`, `expected ${want}`);
}

console.log('\n== commission arithmetic ==');
near(commissionUsd(9, 20), 1.8) ? ok('20% of $9', '$1.80') : no('20% of $9', String(commissionUsd(9, 20)));
near(commissionUsd(149, 20), 29.8) ? ok('20% of $149', '$29.80') : no('20% of $149');
near(commissionUsd(9, 0), 0) ? ok('0% pays nothing') : no('0%');
commissionUsd(9, 500) === 9 ? ok('commission cannot exceed the sale', 'capped at $9')
                            : no('commission cap', String(commissionUsd(9, 500)));
near(commissionUsd(0.07, 20), 0.01) ? ok('rounds to cents') : no('rounds to cents', String(commissionUsd(0.07, 20)));

console.log('\n== who earns ==');
{
  const store = mkStore();
  await upsertAffiliate(store, { code: 'alice', wallet: ALICE, name: 'Alice', pct: DEFAULT_PCT });

  const r = await resolveReferral(store, { code: 'alice', usd: 49, payer: DEV });
  r && near(r.usd, 9.8) ? ok('a referred sale earns', `$49 → $${r.usd}`) : no('referred sale', JSON.stringify(r));

  const none = await resolveReferral(store, { code: '', usd: 49, payer: DEV });
  none === null ? ok('no code, no commission') : no('no code', JSON.stringify(none));

  const unknown = await resolveReferral(store, { code: 'nobody', usd: 49, payer: DEV });
  unknown === null ? ok('unknown code earns nothing') : no('unknown code', JSON.stringify(unknown));

  /* The one that actually costs money if it is missed. */
  const self = await resolveReferral(store, { code: 'alice', usd: 149, payer: ALICE });
  self && self.usd === 0 && self.voided
    ? ok('self-referral is voided', `payer is the affiliate wallet — ${self.voided}`)
    : no('self-referral voided', JSON.stringify(self));

  await upsertAffiliate(store, { code: 'alice', wallet: ALICE, pct: 35 });
  const bump = await resolveReferral(store, { code: 'alice', usd: 100, payer: DEV });
  near(bump.usd, 35) ? ok('per-affiliate rate is honoured', '35% of $100') : no('rate override');
}

console.log('\n== validation ==');
{
  const store = mkStore();
  for (const [label, input] of [
    ['bad code', { code: 'A', wallet: ALICE }],
    ['bad wallet', { code: 'bob', wallet: 'nope' }],
    ['rate above the cap', { code: 'bob', wallet: ALICE, pct: 90 }],
    ['negative rate', { code: 'bob', wallet: ALICE, pct: -5 }],
  ]) {
    try { await upsertAffiliate(store, input); no(label, 'ACCEPTED'); }
    catch (e) { ok(label, 'rejected: ' + e.message); }
  }
}

console.log('\n== statements reconcile with the ledger ==');
{
  const store = mkStore();
  await upsertAffiliate(store, { code: 'alice', wallet: ALICE, pct: 20 });
  await store.put('boosts', [
    { sym: 'AAA', tier: 'spark', usd: 9,   sig: 's1', startedAt: 1, ref: { code: 'alice', usd: 1.8 } },
    { sym: 'BBB', tier: 'whale', usd: 149, sig: 's2', startedAt: 2, ref: { code: 'alice', usd: 29.8 } },
    { sym: 'CCC', tier: 'pump',  usd: 49,  sig: 's3', startedAt: 3, ref: { code: 'bob', usd: 9.8 } },
    { sym: 'DDD', tier: 'spark', usd: 9,   sig: 's4', startedAt: 4, ref: null },
    { sym: 'EEE', tier: 'spark', usd: 9,   sig: 's5', startedAt: 5, ref: { code: 'alice', usd: 0, voided: 'self-referral' } },
  ]);

  let st = await statement(store, 'alice');
  st.referrals === 3 ? ok('counts only their own referrals', '3 of 5 boosts') : no('referral count', String(st.referrals));
  near(st.earnedUsd, 31.6) ? ok('earned totals correctly', '$31.60') : no('earned', String(st.earnedUsd));
  near(st.owedUsd, 31.6) ? ok('owed equals earned before payout') : no('owed', String(st.owedUsd));
  st.boosts.some(b => b.voided) ? ok('voided referrals stay visible', 'shown, worth $0')
                                : no('voided visible');
  st.boosts.every(b => b.explorer.startsWith('https://solscan.io/tx/'))
    ? ok('every line links to its transaction') : no('explorer links');

  await recordPayout(store, { code: 'alice', usd: 20, sig: 'payout1' });
  st = await statement(store, 'alice');
  near(st.paidUsd, 20) ? ok('payout recorded', '$20.00') : no('payout', String(st.paidUsd));
  near(st.owedUsd, 11.6) ? ok('owed drops by what was paid', '$11.60') : no('owed after payout', String(st.owedUsd));

  const bob = await statement(store, 'bob');
  bob === null ? ok('a statement for an unknown code is refused') : no('unknown statement');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
