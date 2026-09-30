/* ==========================================================================
   Trade referrals and the pump.fun invite link.

       node scripts/refs.test.mjs

   The invite is shown to new traders on the site and in the bot, so the
   setting may only ever hold a pump.fun/join link — nothing else can be
   slotted in behind "Create an account".
   ========================================================================== */

import { readFileSync } from 'node:fs';
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

/* The policy the swap page is served with: Jupiter's hosts in, still no
   framing, forms or plugins, and scripts from nowhere else. */
const csp = Object.fromEntries(SWAP_CSP.split(/;\s*/).map(d => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));
is('scripts: us and plugin.jup.ag only', csp['script-src'], "'self' 'unsafe-inline' 'wasm-unsafe-eval' https://plugin.jup.ag");
is('never framed', csp['frame-ancestors'], "'none'");
is('no forms', csp['form-action'], "'none'");
is('no plugins', csp['object-src'], "'none'");
is('no eval', /'unsafe-eval'/.test(SWAP_CSP), false);

/* The swap page's own script: it parses, and it only hands the widget a
   Solana address. */
{
  const html = readFileSync(new URL('../public/swap.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let bad = '';
  for (const s of scripts) { try { new Function(s); } catch (e) { bad = e.message; } }
  is('swap.html script parses', bad, '');
  is('swap.html loads the plugin from Jupiter', /<script src="https:\/\/plugin\.jup\.ag\/plugin-v1\.js"/.test(html), true);
  is('swap.html validates the mint before using it', html.includes('[1-9A-HJ-NP-Za-km-z]{32,44}'), true);
  is('swap.html escapes what it prints', /esc\(t\.sym/.test(html) && /esc\(t\.name/.test(html), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
