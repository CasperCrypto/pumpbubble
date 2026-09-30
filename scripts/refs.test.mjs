/* ==========================================================================
   Trade referrals and the pump.fun invite link.

       node scripts/refs.test.mjs

   The invite is shown to new traders on the site and in the bot, so the
   setting may only ever hold a pump.fun/join link — nothing else can be
   slotted in behind "Create an account".
   ========================================================================== */

import { pumpJoin, buyConfig, buyUrl, buyOrSwap, swapConfig, SWAP_CSP } from '../src/refs.mjs';

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
is('buyUrl alone still needs a trading provider', buyUrl({ PUMP_JOIN: JOIN }, MINT), '');
is('with one, Buy opens the token with the referral', buyUrl({ REF_PROVIDER: 'axiom', REF_CODE: 'abc' }, MINT), 'https://axiom.trade/t/' + MINT + '/abc');

/* The swap page: Buy's destination whenever no trading bot is configured. */
const SITE = 'https://pumpbubble.fun';
const ACCT = 'CdQTNULjDiTsvyR5UKjYBMqWvYpxXj6HY4m6atm2hErk';
is('the page gets the swap template with no provider', buyConfig({}).swap, '/swap?mint=__MINT__');
is('and with one', buyConfig({ REF_PROVIDER: 'axiom', REF_CODE: 'x' }).swap, '/swap?mint=__MINT__');
is('the bot Buy opens our swap page with no provider', buyOrSwap({}, SITE, MINT), SITE + '/swap?mint=' + MINT);
is('the referral still wins when set', buyOrSwap({ REF_PROVIDER: 'axiom', REF_CODE: 'abc' }, SITE, MINT), 'https://axiom.trade/t/' + MINT + '/abc');
is('no mint, no link', buyOrSwap({}, SITE, ''), '');
is('the mint is encoded', buyOrSwap({}, SITE, 'a&b'), SITE + '/swap?mint=a%26b');

is('no referral account, no fee', swapConfig({}).fee, false);
is('a non-address account is refused', swapConfig({ JUP_REFERRAL: 'javascript:alert(1)' }).fee, false);
is('an account with no bps charges the floor', swapConfig({ JUP_REFERRAL: ACCT }).feeBps, 50);
is('the account passes through', swapConfig({ JUP_REFERRAL: ACCT }).referralAccount, ACCT);
is('bps is clamped to Jupiter\'s ceiling', swapConfig({ JUP_REFERRAL: ACCT, JUP_FEE_BPS: '900' }).feeBps, 255);
is('and to its floor', swapConfig({ JUP_REFERRAL: ACCT, JUP_FEE_BPS: '10' }).feeBps, 50);
is('a set bps holds', swapConfig({ JUP_REFERRAL: ACCT, JUP_FEE_BPS: '100' }).feeBps, 100);
is('garbage bps is the floor', swapConfig({ JUP_REFERRAL: ACCT, JUP_FEE_BPS: 'lots' }).feeBps, 50);

/* The policy the swap page is served with: the map's, plus Jupiter's API in
   connect-src and nothing else. No third-party script, frame or image host. */
const csp = Object.fromEntries(SWAP_CSP.split(/;\s*/).map(d => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));
is('scripts: our own only', csp['script-src'], "'self' 'unsafe-inline'");
is('images: ours and data: (wallet icons)', csp['img-src'], "'self' data:");
is('network: us and Jupiter\'s API', csp['connect-src'], "'self' https://lite-api.jup.ag https://api.jup.ag");
is('never framed', csp['frame-ancestors'], "'none'");
is('no forms', csp['form-action'], "'none'");
is('no plugins', csp['object-src'], "'none'");
is('no eval', /'unsafe-eval'/.test(SWAP_CSP), false);
is('no bare scheme or wildcard source', /(^|\s)(https?:|wss?:|\*)(\s|;|$)/.test(SWAP_CSP), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
