/* ==========================================================================
   Trade referrals and the pump.fun invite link.

       node scripts/refs.test.mjs

   The invite is shown to new traders on the site and in the bot, so the
   setting may only ever hold a pump.fun/join link — nothing else can be
   slotted in behind "Create an account".
   ========================================================================== */

import { pumpJoin, buyConfig, buyUrl } from '../src/refs.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const JOIN = 'https://pump.fun/join/HermesCryptos';
const MINT = '7V4vYUApSWg1CWBHSxaEWZ8irJAU4q8pPmpZS3mJpump';

is('the invite link passes', pumpJoin({ PUMP_JOIN: JOIN }), JOIN);
is('another site is refused', pumpJoin({ PUMP_JOIN: 'https://evil.example/join/x' }), '');
is('markup in the code is refused', pumpJoin({ PUMP_JOIN: 'https://pump.fun/join/x"><b>' }), '');
is('a pump.fun page that is not an invite is refused', pumpJoin({ PUMP_JOIN: 'https://pump.fun/coin/' + MINT }), '');
is('it rides the buy config with no trading provider', buyConfig({ PUMP_JOIN: JOIN }).join, JOIN);
is('and with one', buyConfig({ PUMP_JOIN: JOIN, REF_PROVIDER: 'axiom', REF_CODE: 'x' }).join, JOIN);
is('absent when unset', 'join' in buyConfig({}), false);
is('the Buy button still needs a trading provider', buyUrl({ PUMP_JOIN: JOIN }, MINT), '');
is('with one, Buy opens the token with the referral', buyUrl({ REF_PROVIDER: 'axiom', REF_CODE: 'abc' }, MINT), 'https://axiom.trade/t/' + MINT + '/abc');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
