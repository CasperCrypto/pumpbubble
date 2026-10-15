/* ==========================================================================
   Outreach — who to invite to the buy bot, and the console page that lists them.

       node scripts/outreach.test.mjs

   What is pinned:
     - a lead is graduated, backed, alive, between the size and age bounds, links a
       community, and does not already run our bot;
     - a link the launcher typed is kept only as a plain https link to t.me /
       x.com / twitter.com (a "website" of javascript: is nothing);
     - Telegram leads first, then by volume;
     - the console page — every inline script on it — still parses.
   ========================================================================== */

import { leads, tgLink, xLink, webLink, LEAD } from '../src/outreach.mjs';
import { adminPage } from '../src/admin.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };
const NOW = Date.parse('2026-10-15T12:00:00Z');
const H = 3.6e6;
const coin = (i, x = {}) => ({ mint: 'Mint' + i + 'pump', sym: 'T' + i, name: 'Token ' + i, grad: true, solid: true, mcap: 400_000,
  created: NOW - 30 * H, lastTrade: NOW - 60_000, vol: 100_000 + i, pc: { h24: 12 }, telegram: '', twitter: 'https://x.com/t' + i, ...x });

console.log('\nlinks');
ok('t.me link kept', tgLink('https://t.me/ExampleCoin') === 'https://t.me/ExampleCoin');
ok('http and bare t.me are upgraded', tgLink('http://t.me/abc_def') === 'https://t.me/abc_def' && tgLink('t.me/abc_def') === 'https://t.me/abc_def');
ok('javascript: is no link', tgLink('javascript:alert(1)') === '' && xLink('javascript:alert(1)') === '' && webLink('javascript:alert(1)') === '');
ok('a t.me look-alike is not Telegram', tgLink('https://t.me.evil.example/x') === '');
ok('an attribute breakout is not a link', tgLink('https://t.me/a"onmouseover="x') === '' && webLink('https://site.example/"><img') === '');
ok('x.com and twitter.com accepted', xLink('https://x.com/i/communities/123') !== '' && xLink('https://twitter.com/coin') !== '');
ok('a website that is really X or Telegram is not doubled', webLink('https://x.com/coin') === '' && webLink('https://t.me/coin') === '');

console.log('\nwho is a lead');
{
  const list = [
    coin(1),
    coin(2, { telegram: 'https://t.me/two', vol: 10 }),
    coin(3, { grad: false }),
    coin(4, { solid: false }),
    coin(5, { mcap: 10_000 }),
    coin(6, { mcap: 90_000_000 }),
    coin(7, { created: NOW - 1 * H }),
    coin(8, { created: NOW - 40 * 24 * H }),
    coin(9, { lastTrade: NOW - 2 * H }),
    coin(10, { twitter: '', telegram: '' }),
    coin(11, { banned: true }),
    coin(12),                       // runs our bot already
    coin(13, { created: 0 }),
  ];
  const out = leads(list, new Set(['Mint12pump']), NOW);
  const syms = out.map(l => l.sym);
  ok('only the live, backed, sized, linked coins', JSON.stringify(syms) === JSON.stringify(['T2', 'T1']), syms.join(','));
  ok('Telegram first even with less volume', syms[0] === 'T2');
  ok('a coin already running the bot is left out', !syms.includes('T12'));
  ok('unknown age is not a lead', !syms.includes('T13'));
  ok('age is reported in hours', out[1].ageH === 30);
  ok('at most LEAD.max', leads(Array.from({ length: 100 }, (_, i) => coin(100 + i)), [], NOW).length === LEAD.max);
  ok('no tokens, no leads', leads(null, null, NOW).length === 0);
}

console.log('\nthe console page');
{
  const html = adminPage('/secret-admin');
  ok('the outreach card is there', html.includes('id="oTable"') && html.includes('id="oTpl"') && html.includes("api('outreach.leads')"));
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let bad = '';
  for (const s of scripts) { try { new Function(s); } catch (e) { bad = e.message; } }
  ok('every inline script parses', scripts.length > 0 && !bad, bad);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
