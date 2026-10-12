/* ==========================================================================
   Pages to be found — src/pages.mjs.

       node scripts/pages.test.mjs

   What is pinned:
     - every page leads with a dated answer carrying its numbers, and has a
       title, description, canonical, FAQ and structured data;
     - a username or ticker is attacker-controlled: it is escaped in the HTML
       and cannot close the JSON-LD script;
     - a missing record prints a dash, never a zero;
     - the sitemap lists every board and one page per KOL; llms.txt carries
       the headline numbers;
     - only the pages that exist are routed.
   ========================================================================== */

import { kolsPage, kolPage, callersPage, tradersPage, trendingPage, robinhoodPage, gpuPage, sitemapXml, llmsTxt,
  slug, isSeoPath, money, mult, median, PAGES } from '../src/pages.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };
const NOW = Date.parse('2026-10-12T09:30:00Z');

const kol = (i, rec = true, extra = {}) => ({
  id: 'kol:w' + i, kind: 'kol', sym: 'kol' + i, xh: 'x' + i, rank: i + 1, verified: true,
  kol: { paid: 300000 - i * 1000, payouts: 60, followers: 100000 + i, lastPaidAt: NOW - 86400000,
    ...(rec ? { n: 100, avgMcap: 480000, under100k: 0.5, medPeak: 2.2, avgPeak: 3.3, hit2: 0.57, medNow: 0.06, inProfit: 0.05 } : { n: null }) },
  ...extra,
});
const evil = kol(1, true, { sym: '</script><img src=x onerror=alert(1)>', xh: 'a"b' });

console.log('\nKOLs');
{
  const html = kolsPage([kol(0), evil, kol(2, false)], NOW);
  ok('dated answer first', html.includes('As of 12 October 2026') && html.includes('<b>$897K</b>'), 'total paid in the lead');
  ok('the #1 named with what they were paid', html.includes('<b>kol0</b>') && html.includes('$300K'));
  ok('hold-now in the lead', html.includes('0.06×'));
  ok('a hostile username is escaped', !html.includes('<img src=x') && html.includes('&lt;/script&gt;&lt;img'));
  ok('it cannot close the JSON-LD script', html.split('<script type="application/ld+json">').slice(1).every(b => !b.split('</script>')[0].includes('<')));
  ok('a KOL with no record yet shows dashes, not zeros', /kol2<small>@x2<\/small><\/a><\/td><td class="up">\$298K<\/td><td>60<\/td><td>100K<\/td><td class="">—<\/td><td>—<\/td><td class="">—<\/td><td>—<\/td>/.test(html), 'row for kol2');
  ok('each KOL links to their own page', html.includes('href="/kol/kol0"'));
  ok('title, description, canonical', html.includes('<title>pump.fun KOL leaderboard') && html.includes('name="description"') && html.includes('rel="canonical" href="https://pumpbubble.fun/kols"'));
  ok('FAQ and Dataset structured data', html.includes('"@type":"FAQPage"') && html.includes('"@type":"Dataset"') && html.includes('"@type":"BreadcrumbList"'));
  ok('share card as the preview image', html.includes('/api/card?kind=table&amp;source=kols-all'));
  ok('an empty board says it is filling', kolsPage([], NOW).includes('The board is filling'));
}

console.log('\none KOL');
{
  const html = kolPage(kol(0), [kol(0), kol(1)], NOW);
  ok('page names the KOL and the record', html.includes('<h1>kol0: pump.fun KOL record</h1>') && html.includes('$480K') && html.includes('57%'));
  ok('canonical is their slug', html.includes('href="https://pumpbubble.fun/kol/kol0"'));
  ok('no record yet says so', kolPage(kol(3, false), [], NOW).includes('being read'));
}

console.log('\nthe other boards');
{
  const callers = callersPage([{ sym: 'cooker', xh: 'CookerFlips', rank: 1, caller: { hit2: 0.63, n: 16, med: 2.4, best: '20×+' } }], NOW);
  ok('callers: winner, hit rate, sample', callers.includes('<b>cooker</b>') && callers.includes('<b>63%</b>') && callers.includes('16 calls'));
  const traders = tradersPage([{ kind: 'trader', sym: 'whale', realized: 58700, unrealized: -95800, total: -37100, positions: 12 }], NOW);
  ok('traders: banked first, open in red', traders.includes('+$59K') && traders.includes('class="dn">−$96K'));
  const trending = trendingPage([{ sym: 'PONS', name: 'Pons', mcap: 6.7e6, pc: { h24: 12.3, h1: -1.2 }, vol: 1.2e6, chain: 'robinhood' }], NOW);
  ok('trending: top five named with caps and moves', trending.includes('<b>$PONS</b> ($6.70M, <span class="up">+12.3%</span>)'));
  ok('a token with no 24h move prints a dash', trendingPage([{ sym: 'NEW', mcap: 5e4, pc: { h24: null } }], NOW).includes('<td class="dn">—</td>'));
  ok('robinhood page names the chain', robinhoodPage([{ sym: 'ROBINCAT', mcap: 2e6, pc: {} }], NOW).includes('chain id 4663'));
  const gpu = gpuPage({ gpus: [{ id: 'h100', model: 'H100', usdPerHour: 2.72, fromUsdPerHour: 1.9, change24h: null, change7d: 1.5, gpusFree: 12, gpusListed: 40 }] }, NOW);
  ok('gpu: H100 price in the answer', gpu.includes('<b>$2.72 an hour</b>') && gpu.includes('12 / 40'));
  ok('gpu: no board, no invented price', gpuPage({ gpus: [] }, NOW).includes('being read'));
}

console.log('\nsitemap, llms.txt, routing');
{
  const sm = sitemapXml(['kol0', 'kol1'], NOW);
  ok('every board in the sitemap', PAGES.every(p => sm.includes('<loc>https://pumpbubble.fun' + p.path + '</loc>')));
  ok('one page per KOL', sm.includes('/kol/kol0</loc>') && sm.includes('/kol/kol1</loc>'));
  ok('lastmod is now', sm.includes('<lastmod>2026-10-12T09:30:00.000Z</lastmod>'));
  const llms = llmsTxt({ kols: [kol(0), kol(1)], now: NOW });
  ok('llms.txt: headline numbers', llms.includes('$599K') && llms.includes('kol0') && llms.includes('0.06×'));
  ok('llms.txt: every board linked', PAGES.every(p => llms.includes('https://pumpbubble.fun' + p.path)));
  ok('slug keeps letters, digits, _ and -', slug('POORGOAT___') === 'poorgoat___' && slug('Dior 100x!') === 'dior100x' && slug('') === '');
  ok('routed: the boards and /kol/<slug>', isSeoPath('/kols') && isSeoPath('/gpu-prices') && isSeoPath('/kol/chairman'));
  ok('not routed: anything else', !isSeoPath('/kol/') && !isSeoPath('/kol/a/b') && !isSeoPath('/kol/<x>') && !isSeoPath('/swap') && !isSeoPath('/'));
  ok('formatting', money(310013) === '$310K' && money(0) === '—' && mult(0.06) === '0.06×' && mult(2.23) === '2.2×' && mult(null) === '—' && median([3, 1, 2]) === 2);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
