/* ==========================================================================
   pumpbubble.fun — pages written to be found (the boards). /market and /board
   live in seo.mjs; these are the leaderboards and the KOL pages.

   The map is a canvas and its tables are drawn by JavaScript, so a crawler
   that reads HTML finds almost nothing (measured on /market's first version:
   196 indexable words on the homepage, not one coin name). These pages carry
   each board as server-rendered text: a one-paragraph answer with the
   numbers in it, the table, how it is measured, and the questions people
   type. Search engines index them; AI assistants that search the web (ChatGPT
   search reads Bing, Claude and Perplexity their own crawlers) quote them —
   which is what "showing up in ChatGPT" actually means.

   Rules: answer first, with a date; every number is measured and says how;
   every string a stranger controls (usernames, tickers) is escaped; no page
   claims more than its data (a missing record is a dash, never a zero).
   ========================================================================== */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const ORIGIN = 'https://pumpbubble.fun';

export function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return '$' + Math.round(v / 1e3) + 'K';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v).toLocaleString('en-US');
}
export const mult = x => (x == null || !Number.isFinite(+x) || +x <= 0) ? '—' : (+x >= 10 ? Math.round(+x) : (+x).toFixed(+x < 1 ? 2 : +x >= 2 ? 1 : 2)) + '×';
export const pct = x => (x == null || !Number.isFinite(+x)) ? '—' : Math.round(+x * 100) + '%';
const chg = x => (x == null || !Number.isFinite(+x)) ? '—' : (+x >= 0 ? '+' : '−') + Math.abs(+x).toFixed(Math.abs(+x) >= 100 ? 0 : 1) + '%';
const count = n => (n == null || !Number.isFinite(+n)) ? '—' : +n >= 1e6 ? (+n / 1e6).toFixed(1) + 'M' : +n >= 1e4 ? Math.round(+n / 1e3) + 'K' : Math.round(+n).toLocaleString('en-US');
export const day = now => new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const tone = x => x == null ? '' : x >= 1 ? 'up' : 'dn';

export function median(xs) {
  const a = xs.filter(x => x != null && Number.isFinite(+x)).map(Number).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* A URL-safe name for a KOL's own page. pump.fun usernames are letters,
   digits and underscores in practice; anything else is dropped, never encoded. */
export const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 40);

/* The pages, in the order the navigation lists them. `src` is the feed each reads. */
export const PAGES = [
  { path: '/kols', nav: 'KOL rewards', src: 'kols-all' },
  { path: '/callers', nav: 'Top callers', src: 'callers-weekly' },
  { path: '/traders', nav: 'Top traders', src: 'traders-weekly' },
  { path: '/trending', nav: 'Trending', src: 'trending' },
  { path: '/robinhood', nav: 'Robinhood Chain', src: 'robinhood' },
  { path: '/gpu-prices', nav: 'GPU prices', src: null },
  { path: '/compute-map', nav: 'Compute map', src: null },
  { path: '/bot', nav: 'Buy bot', src: null },
];
export const isSeoPath = p => PAGES.some(x => x.path === p) || /^\/kol\/[a-z0-9_-]{1,40}$/.test(p);

const STYLE = `:root{--bg:#070910;--ink:#eef2f8;--dim:#8a93a6;--line:rgba(255,255,255,.10);--mint:#28e08c;--mint2:#3df09b;--gold:#f5c542;--rose:#ff4d6d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--mint2)}.wrap{max-width:1080px;margin:0 auto;padding:0 16px 80px}
header{padding:26px 0 6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mark{width:26px;height:26px;border-radius:50%;display:block;background:#000;box-shadow:0 0 22px rgba(40,224,140,.45)}
.wordmark{font-weight:900;font-size:19px;letter-spacing:-.02em;text-decoration:none;color:var(--ink)}
nav{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap;font-size:13px;font-weight:700}nav a{color:var(--dim);text-decoration:none}nav a:hover,nav a.on{color:var(--ink)}
h1{font-size:clamp(26px,4.6vw,40px);line-height:1.12;letter-spacing:-.03em;margin:18px 0 10px;font-weight:900}
h2{font-size:21px;font-weight:900;letter-spacing:-.02em;margin:40px 0 10px}h3{font-size:16px;font-weight:800;margin:20px 0 4px}
p{max-width:72ch}.lede{font-size:17px;color:#c9d1de}.muted,.updated{color:var(--dim)}.updated{font-size:12px}
.cta{display:inline-block;margin:14px 0 4px;padding:11px 18px;border-radius:999px;background:var(--mint);color:#04140b;font-weight:900;text-decoration:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:22px 0}
.stat{border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.03)}
.stat b{display:block;font-size:22px;font-weight:900;letter-spacing:-.02em}.stat>span{font-size:12px;color:var(--dim)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:14px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:9px 10px;text-align:right;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
thead th{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line)}
th.n,td.n{text-align:left}td.r,th.r{color:var(--dim);width:40px}td.n small{display:block;color:var(--dim);font-size:12px}
.up{color:var(--mint2)}.dn{color:var(--rose)}.mid{color:var(--gold)}
.faq h3{margin-top:18px}.faq p{margin:4px 0 0;color:#c9d1de}
footer{margin-top:52px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}`;

export function layout({ path, title, desc, h1, lead, stats = [], body = '', method = '', faq = [], jsonld = [], live, ogImage, now, ctaText, dated = true }) {
  const url = ORIGIN + path;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'pumpbubble.fun', item: ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: h1, item: url }] },
    ...(faq.length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] : []),
    ...jsonld,
  ];
  /* `<` in JSON-LD would end the script element early: a username could carry it */
  const ldText = ld.map(o => JSON.stringify(o).replace(/</g, '\\u003c')).map(t => `<script type="application/ld+json">${t}</script>`).join('\n');
  const navHtml = PAGES.map(p => `<a href="${p.path}"${p.path === path ? ' class="on"' : ''}>${esc(p.nav)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="pumpbubble.fun">
<meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(ogImage || ORIGIN + '/og.png')}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@pumpbubblefun">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(ogImage || ORIGIN + '/og.png')}">
<style>${STYLE}</style>
${ldText}
</head>
<body><div class="wrap">
<header><a href="/" aria-label="pumpbubble.fun"><img class="mark" src="/mark.png" alt="" width="26" height="26"></a><a class="wordmark" href="/">pumpbubble.fun</a><nav>${navHtml}</nav></header>
<h1>${esc(h1)}</h1>
<p class="lede">${lead}</p>
<a class="cta" href="${esc(live)}">${esc(ctaText || 'Open the live board →')}</a>
${dated ? `<p class="updated">Updated <time datetime="${new Date(now).toISOString()}">${esc(day(now))}, ${new Date(now).toISOString().slice(11, 16)} UTC</time> · refreshed continuously on the live board</p>` : ''}
${stats.length ? `<div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`).join('')}</div>` : ''}
${body}
${method ? `<h2>How this is measured</h2>${method}` : ''}
${faq.length ? `<h2>Questions</h2><div class="faq">${faq.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}</div>` : ''}
<footer>pumpbubble.fun — live bubble maps and leaderboards for crypto: pump.fun, Base, Robinhood Chain, the wider market and compute. Free to use; not financial advice.<br>
${navHtml.replace(/ class="on"/g, '')} · <a href="/market">Crypto market</a> · <a href="/partners">Partners &amp; API</a> · <a href="https://x.com/pumpbubblefun" rel="noopener">X</a> · <a href="https://t.me/pumpbubble" rel="noopener">Telegram</a> · <a href="/llms.txt">llms.txt</a></footer>
</div></body></html>`;
}

export const table = (head, rows) => `<div class="tw"><table><thead><tr>${head.map(([h, c]) => `<th class="${c || ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const who = t => t.xh ? `${esc(t.sym)}<small>@${esc(t.xh)}</small>` : esc(t.sym);
const kolMc = v => v == null ? '' : v >= 1e6 ? 'up' : v >= 1e5 ? 'mid' : 'dn';

/* ---------------------------------------------------------------- KOLs */
export function kolsPage(tokens, now = Date.now()) {
  const rows = (tokens || []).filter(t => t && t.kol);
  const withRec = rows.filter(t => t.kol.n);
  const paid = rows.reduce((s, t) => s + (t.kol.paid || 0), 0);
  const top = rows[0];
  const medPeak = median(withRec.map(t => t.kol.medPeak));
  const medNow = median(withRec.map(t => t.kol.medNow));
  const underHalf = withRec.length ? withRec.filter(t => t.kol.medNow != null && t.kol.medNow < 0.5).length / withRec.length : null;
  const smallCalls = median(withRec.map(t => t.kol.under100k));
  const lead = top
    ? `As of ${esc(day(now))}, pump.fun has paid the ${rows.length} biggest earners on its callout-rewards board <b>${money(paid)}</b> in USDC. The #1, <b>${esc(top.sym)}</b>, has received <b>${money(top.kol.paid)}</b> over ${esc(String(top.kol.payouts || 0))} payouts.`
      + (medNow != null ? ` Across each KOL's last 100 calls the median call peaked at <b>${mult(medPeak)}</b> — but a follower who bought every call and held is at <b class="${tone(medNow)}">${mult(medNow)}</b> today, at the median.` : '')
    : 'The board is filling — open the live board for the current numbers.';
  const body = `<h2>pump.fun KOLs by callout rewards</h2>
<p class="muted">Ranked by what pump.fun has paid, all time. Hold now is the median multiple today for someone who bought at each of the KOL's last 100 calls and never sold.</p>
${table([['#', 'r'], ['KOL', 'n'], ['Rewards'], ['Payouts'], ['Followers'], ['Avg mcap at call'], ['Median peak'], ['Hold now'], ['Hit 2×']],
    rows.slice(0, 100).map(t => { const k = t.kol; const s = slug(t.sym);
      return `<tr><td class="r">${esc(String(t.rank || ''))}</td><td class="n">${s ? `<a href="/kol/${s}">${who(t)}</a>` : who(t)}</td><td class="up">${money(k.paid)}</td><td>${esc(String(k.payouts || 0))}</td><td>${count(k.followers)}</td><td class="${kolMc(k.avgMcap)}">${money(k.avgMcap)}</td><td>${mult(k.medPeak)}</td><td class="${tone(k.medNow)}">${mult(k.medNow)}</td><td>${pct(k.hit2)}</td></tr>`; }))}`;
  return layout({
    path: '/kols', now, live: '/?source=kols', ogImage: ORIGIN + '/api/card?kind=table&source=kols-all&tf=h24',
    title: 'pump.fun KOL leaderboard: callout rewards, followers and how their calls did',
    desc: top ? `pump.fun has paid its top ${rows.length} KOLs ${money(paid)} in callout rewards. #1 ${top.sym}: ${money(top.kol.paid)}. Median hold-now on their last 100 calls: ${mult(medNow)}. Live, updated continuously.` : 'pump.fun callout rewards leaderboard, live.',
    h1: 'pump.fun KOL leaderboard: who gets paid to call coins',
    lead,
    stats: [[money(paid), `paid to the top ${rows.length} KOLs (USDC)`], [mult(medPeak), 'median peak of their calls'],
      [`<span class="${tone(medNow)}">${mult(medNow)}</span>`, 'median hold-now'], [pct(underHalf), 'of KOLs whose holders are down more than half'],
      [pct(smallCalls), 'of a typical KOL\'s calls are on coins under $100K']],
    body,
    method: `<p>Rewards, payouts and wallets come from pump.fun's own public payout board (callout rewards, paid in USDC). Followers are each KOL's pump.fun followers. For every KOL we read their last 100 callouts from pump.fun: the market cap at the call, the highest multiple the coin reached after it (peak) and its multiple now. Median peak is what a perfect seller got at the middle call; hold now is what a follower who bought at the call and held has today. Perp calls carry no market cap and are left out. Records refresh every six hours; a KOL whose calls have not been read yet shows a dash, never a zero.</p>`,
    faq: [
      ['What are pump.fun callout rewards?', 'pump.fun pays users who post "callouts" — public calls on coins they hold — a share of the trading those calls bring, in USDC. The program launched in August 2026; its payout board is public and this page is built from it.'],
      ['Who earns the most from pump.fun callouts?', top ? `As of ${day(now)}, ${top.sym} leads the all-time board with ${money(top.kol.paid)} over ${top.kol.payouts || 0} payouts. The full ranking is above and live on pumpbubble.fun.` : 'See the live board on pumpbubble.fun.'],
      ['Do pump.fun KOL calls make money for followers?', medNow != null ? `Mostly only for followers who sell near the top. Across the top KOLs' last 100 calls the median call peaked at ${mult(medPeak)}, but someone who bought at each call and held is at ${mult(medNow)} at the median today.` : 'The live board shows each KOL\'s median peak and what holding their calls got.'],
      ['How often is this updated?', 'The payout board is read every 30 minutes and each KOL\'s last 100 calls every six hours. The live board on pumpbubble.fun shows the current numbers.'],
    ],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Dataset', name: 'pump.fun KOL callout rewards and call record',
      description: 'Callout rewards paid by pump.fun to its top KOLs, with followers and the record of each KOL\'s last 100 calls (average market cap at the call, median and average peak, hold-now, 2× hit rate).',
      url: ORIGIN + '/kols', creator: { '@type': 'Organization', name: 'pumpbubble.fun', url: ORIGIN }, isAccessibleForFree: true,
      dateModified: new Date(now).toISOString(), variableMeasured: ['callout rewards (USDC)', 'followers', 'average market cap at call', 'median peak multiple', 'hold-now multiple', '2× hit rate'] }],
  });
}

/* One KOL's page. Facts only, in neutral words — the record speaks. */
export function kolPage(t, all, now = Date.now()) {
  const k = t.kol, s = slug(t.sym), name = t.sym;
  const peers = (all || []).filter(x => x && x.kol && x.kol.n);
  const peerNow = median(peers.map(x => x.kol.medNow));
  const lead = `${esc(name)}${t.xh ? ` (@${esc(t.xh)} on X)` : ''} is #${esc(String(t.rank || '?'))} on pump.fun's all-time callout-rewards board, with <b>${money(k.paid)}</b> paid over ${esc(String(k.payouts || 0))} payouts and ${count(k.followers)} followers on pump.fun.`
    + (k.n ? ` Across their last ${k.n} calls the coins were worth <b>${money(k.avgMcap)}</b> on average at the call; the median call peaked at <b>${mult(k.medPeak)}</b>, and a follower who bought each call and held is at <b class="${tone(k.medNow)}">${mult(k.medNow)}</b> today (median).` : ' Their call record is being read — the live board shows it within hours.');
  return layout({
    path: '/kol/' + s, now, live: '/?source=kols',
    title: `${name} — pump.fun KOL record: callout rewards and call performance`,
    desc: `${name}: ${money(k.paid)} in pump.fun callout rewards, ${count(k.followers)} followers.` + (k.n ? ` Last ${k.n} calls: median peak ${mult(k.medPeak)}, hold now ${mult(k.medNow)}, ${pct(k.hit2)} hit 2×.` : ''),
    h1: `${name}: pump.fun KOL record`,
    lead,
    stats: [[money(k.paid), 'callout rewards (USDC)'], [count(k.followers), 'followers on pump.fun'], [money(k.avgMcap), 'average market cap at the call'],
      [mult(k.medPeak), 'median peak'], [mult(k.avgPeak), 'average peak'], [`<span class="${tone(k.medNow)}">${mult(k.medNow)}</span>`, 'hold now (median)'],
      [pct(k.hit2), 'of calls reached 2×'], [pct(k.inProfit), 'of calls above the call price now']],
    body: `<p class="muted">For comparison, the median hold-now across the top KOLs is ${mult(peerNow)}. <a href="/kols">See the whole leaderboard</a>.</p>`,
    method: `<p>From pump.fun's public data: its callout-rewards payout board, the KOL's profile, and their last 100 callouts (market cap at the call, the peak after it, the multiple now). Not financial advice; past calls do not predict future ones.</p>`,
    faq: [
      [`How much has ${name} earned from pump.fun callout rewards?`, `${money(k.paid)} in USDC over ${k.payouts || 0} payouts, as of ${day(now)}.`],
      [`Do ${name}'s calls make money for followers?`, k.n ? `Their median call peaked at ${mult(k.medPeak)} and ${pct(k.hit2)} reached 2×, but a follower who bought each call and held is at ${mult(k.medNow)} at the median today.` : 'Their record is still being read; see the live board.'],
    ],
  });
}

/* ------------------------------------------------------------- callers */
export function callersPage(tokens, now = Date.now()) {
  const rows = (tokens || []).filter(t => t && t.caller);
  const top = rows[0];
  const lead = top
    ? `As of ${esc(day(now))}, this week's best caller on pump.fun is <b>${esc(top.sym)}</b>: <b>${pct(top.caller.hit2)}</b> of their ${esc(String(top.caller.n || 0))} calls reached 2×, with a median peak of ${mult(top.caller.med)}. Callers are ranked by how often their calls reach 2×, adjusted for how many they made — so three lucky calls do not beat thirty good ones.`
    : 'The board is filling — open the live board for the current ranking.';
  return layout({
    path: '/callers', now, live: '/?source=callers', ogImage: ORIGIN + '/api/card?kind=table&source=callers-weekly&tf=h24',
    title: 'Best pump.fun callers this week: ranked by 2× hit rate',
    desc: top ? `This week's top pump.fun caller: ${top.sym}, ${pct(top.caller.hit2)} of ${top.caller.n} calls hit 2×. Ranked by hit rate, not one lucky call. Live.` : 'Best pump.fun callers, ranked by 2× hit rate. Live.',
    h1: 'Best pump.fun callers this week',
    lead,
    body: table([['#', 'r'], ['Caller', 'n'], ['Hit 2×'], ['Median peak'], ['Calls'], ['Best call']],
      rows.slice(0, 50).map(t => `<tr><td class="r">${esc(String(t.rank || ''))}</td><td class="n">${who(t)}</td><td class="up">${pct(t.caller.hit2)}</td><td>${mult(t.caller.med)}</td><td>${esc(String(t.caller.n || 0))}</td><td>${esc(t.caller.best || '—')}</td></tr>`)),
    method: `<p>From pump.fun's public callout feeds and each caller's callout statistics for the last 7 days. The ranking is the lower bound of the 95% Wilson interval of the share of calls that reached 2× at their peak, with at least 5 calls in the week — a caller who went 3 for 3 has shown less than one who went 20 for 30.</p>`,
    faq: [
      ['Who is the best caller on pump.fun?', top ? `This week, ${top.sym}: ${pct(top.caller.hit2)} of ${top.caller.n} calls reached 2×. The ranking changes daily; see the live board.` : 'See the live board on pumpbubble.fun.'],
      ['What is a pump.fun callout?', 'A public call on a coin the caller holds, pushed to their followers on pump.fun. Each call records the market cap at the moment it was made, so its result can be measured.'],
      ['Why rank by hit rate instead of average gain?', 'An average is one moonshot. The share of calls that reach 2×, adjusted for sample size, says whether a caller is consistently right.'],
    ],
  });
}

/* ------------------------------------------------------------- traders */
export function tradersPage(tokens, now = Date.now()) {
  const rows = (tokens || []).filter(t => t && t.kind === 'trader');
  const top = rows[0];
  const lead = top
    ? `As of ${esc(day(now))}, this week's top trader on pump.fun by realized profit is <b>${esc(top.sym)}</b>, with <b class="up">+${money(top.realized)}</b> banked. Realized profit is what was actually sold for more than it cost — pump.fun's own board ranks by paper gains, which can be large and unbanked.`
    : 'The board is filling — open the live board for the current ranking.';
  return layout({
    path: '/traders', now, live: '/?source=traders-weekly', ogImage: ORIGIN + '/api/card?kind=table&source=traders-weekly&tf=d7',
    title: 'Top pump.fun traders this week by realized profit (not paper gains)',
    desc: top ? `This week's top pump.fun trader by realized PnL: ${top.sym}, +${money(top.realized)} banked. Ranked by profit actually taken. Live.` : 'Top pump.fun traders by realized profit. Live.',
    h1: 'Top pump.fun traders this week, by realized profit',
    lead,
    body: table([['#', 'r'], ['Trader', 'n'], ['Banked'], ['Open'], ['Total'], ['Positions']],
      rows.slice(0, 50).map((t, i) => `<tr><td class="r">${i + 1}</td><td class="n">${who(t)}</td><td class="up">+${money(t.realized)}</td><td class="${t.unrealized >= 0 ? 'up' : 'dn'}">${t.unrealized ? (t.unrealized >= 0 ? '+' : '−') + money(Math.abs(t.unrealized)) : '—'}</td><td class="${t.total >= 0 ? 'up' : 'dn'}">${t.total ? (t.total >= 0 ? '+' : '−') + money(Math.abs(t.total)) : '—'}</td><td>${esc(String(t.positions ?? '—'))}</td></tr>`)),
    method: `<p>From pump.fun's public weekly PnL leaderboard, re-ranked by realized profit. Everyone on it is a pump.fun profile that opted in; nothing is shown that pump.fun does not publish. Open is the unrealized PnL of positions still held.</p>`,
    faq: [
      ['Who is the most profitable trader on pump.fun?', top ? `By profit actually banked this week, ${top.sym} with +${money(top.realized)}.` : 'See the live board.'],
      ['Why realized profit and not total PnL?', 'Total PnL counts open positions at today\'s price, which can vanish before they are sold. Realized profit is money already taken.'],
    ],
  });
}

/* -------------------------------------------------------------- tokens */
function tokenPage({ path, tokens, now, live, title, h1, intro, desc, faq, chainName }) {
  const rows = (tokens || []).filter(t => t && t.sym).slice(0, 50);
  const lead = rows.length
    ? `${intro} As of ${esc(day(now))} ${new Date(now).toISOString().slice(11, 16)} UTC the top ${Math.min(5, rows.length)} are ${rows.slice(0, 5).map(t => `<b>$${esc(t.sym)}</b> (${money(t.mcap)}${t.pc && t.pc.h24 != null ? ', <span class="' + (t.pc.h24 >= 0 ? 'up' : 'dn') + '">' + chg(t.pc.h24) + '</span>' : ''})`).join(', ')}.`
    : `${intro} The board is filling — open the live map.`;
  return layout({
    path, now, live, title, h1, lead, desc: desc(rows),
    body: table([['#', 'r'], ['Token', 'n'], ['Market cap'], ['24h'], ['1h'], ['24h volume'], ['Chain']],
      rows.map((t, i) => `<tr><td class="r">${i + 1}</td><td class="n">$${esc(t.sym)}<small>${esc(t.name || '')}</small></td><td>${money(t.mcap)}</td><td class="${t.pc && t.pc.h24 >= 0 ? 'up' : 'dn'}">${chg(t.pc && t.pc.h24)}</td><td class="${t.pc && t.pc.h1 >= 0 ? 'up' : 'dn'}">${chg(t.pc && t.pc.h1)}</td><td>${money(t.vol)}</td><td>${esc(chainName || t.chain || '')}</td></tr>`)),
    method: `<p>Market caps from each token's own data (pump.fun, Blockscout and DexScreener depending on the chain), price changes from DexScreener and our own market-cap history. Tokens whose market cap is not backed by liquidity or trading — thin pools, copycat tickers — are filtered out, as they are on the live map.</p>`,
    faq,
  });
}
export const trendingPage = (tokens, now = Date.now()) => tokenPage({
  path: '/trending', tokens, now, live: '/?source=trending',
  title: 'Trending crypto tokens right now: pump.fun, Base, Robinhood Chain',
  h1: 'Trending tokens right now, across chains',
  intro: 'pump.fun\'s own trending list leads, then the tokens turning over the most of their size while moving, on Base, Robinhood Chain and the wider market.',
  desc: rows => 'Trending now: ' + rows.slice(0, 6).map(t => '$' + t.sym).join(', ') + '. pump.fun, Base, Robinhood Chain, live.',
  faq: [['How is trending decided?', 'pump.fun\'s own trending list first; after it, tokens ranked by turnover (24h volume against market cap) multiplied by movement, with scam-shaped moves (+7,000% on a token hours old) and thin pools left out.']],
});
export const robinhoodPage = (tokens, now = Date.now()) => tokenPage({
  path: '/robinhood', tokens, now, live: '/?source=robinhood', chainName: 'Robinhood',
  title: 'Robinhood Chain tokens: live market caps and price changes',
  h1: 'Robinhood Chain tokens, live',
  intro: 'Every token trading on Robinhood Chain, ranked by market cap, one survivor per ticker (the chain is full of clones), with bridged assets that have no real pool filtered out.',
  desc: rows => 'Top Robinhood Chain tokens: ' + rows.slice(0, 6).map(t => '$' + t.sym + ' ' + money(t.mcap)).join(', ') + '. Live map and swap.',
  faq: [
    ['What is Robinhood Chain?', 'Robinhood\'s own blockchain (chain id 4663), where tokens launch through the Pons launchpad and trade on Uniswap-style pools.'],
    ['How do I buy a Robinhood Chain token?', 'Open the token on the live map and press Buy: pumpbubble.fun\'s swap routes the trade through Relay from your own wallet.'],
  ],
});

/* ------------------------------------------------------------ compute */
export function gpuPage(feed, now = Date.now()) {
  const gpus = ((feed && feed.gpus) || []).filter(g => g && g.usdPerHour != null);
  const h100 = gpus.find(g => g.id === 'h100');
  const lead = gpus.length
    ? `As of ${esc(day(now))}, ${h100 ? `one <b>NVIDIA H100</b> rents for <b>$${h100.usdPerHour.toFixed(2)} an hour</b>` : `GPUs rent from <b>$${Math.min(...gpus.map(g => g.usdPerHour)).toFixed(2)} an hour</b>`} on Akash's open compute market — the typical posted rate, weighted by GPUs on offer. These are what providers ask, not trades.`
    : 'GPU prices are being read — open the live board.';
  return layout({
    path: '/gpu-prices', now, live: '/?source=compute',
    title: 'GPU rental prices per hour, live: H100, A100, RTX 5090, RTX 4090',
    desc: gpus.length ? 'GPU price per hour on Akash now: ' + gpus.slice(0, 5).map(g => g.model + ' $' + g.usdPerHour.toFixed(2)).join(', ') + '. Free JSON API.' : 'Live GPU rental prices per hour.',
    h1: 'GPU rental prices per hour, live',
    lead,
    body: table([['GPU', 'n'], ['Typical $/hour'], ['From $/hour'], ['24h'], ['7d'], ['Free / listed']],
      gpus.map(g => `<tr><td class="n">${esc(g.model)}</td><td><b>$${g.usdPerHour.toFixed(2)}</b></td><td>${g.fromUsdPerHour != null ? '$' + g.fromUsdPerHour.toFixed(2) : '—'}</td><td>${chg(g.change24h)}</td><td>${chg(g.change7d)}</td><td>${g.gpusListed ? esc(String(g.gpusFree ?? '—')) + ' / ' + esc(String(g.gpusListed)) : '—'}</td></tr>`))
      + `<p>Free JSON: <a href="/api/compute/gpus">/api/compute/gpus</a> (add <code>?history=1</code> for hourly points) — please link back where you show it.</p>`,
    method: `<p>Read from Akash Network's public console API: each provider's own bid for one GPU for one hour, weighted by the GPUs on offer. "From" is the cheapest bid with a GPU actually free. Day and week changes come from our own hourly history and stay empty until a point that old exists.</p>`,
    faq: [
      ['How much does it cost to rent an H100?', h100 ? `About $${h100.usdPerHour.toFixed(2)} an hour on Akash as of ${day(now)} (posted rate). Prices on centralized clouds vary by contract.` : 'See the live board for the current posted rate.'],
      ['Is there a free GPU price API?', 'Yes: pumpbubble.fun/api/compute/gpus returns these prices as JSON, free with a link back.'],
    ],
  });
}

/* ------------------------------------------------------------ the bot */
/* What a project admin needs to decide in thirty seconds: what it does, that
   it is free (and the one sponsored line that pays for it), how to set it
   up, and what an alert looks like. The example alert is labelled as one. */
export const BOT_ADD = 'https://t.me/pumpbubblebot?startgroup=setup&admin=delete_messages+restrict_members+pin_messages+invite_users';
export function botPage(now = Date.now()) {
  const feat = [
    ['Buy alerts your community already knows', 'The classic format — your emoji per $ bought, your GIF or video, a minimum buy, Chart · Buy · Bubble buttons. A cleaner style is one tap away.'],
    ['🧠 when a top trader buys', 'If the buyer is one of pump.fun\'s top traders by profit actually banked, the alert says so — "#3 on pump.fun this week". Nobody else\'s bot knows who they are.'],
    ['📣 when a top KOL buys', 'The same for the week\'s best callers, ranked by how often their calls reach 2×.'],
    ['Whale buys that land', 'Big buys get a whale headline, your second GIF, and Telegram\'s full-screen animated reaction for everyone in the chat.'],
    ['Captcha, welcome, clean joins', 'New members are muted until they tap the right emoji; raids bounce. Welcome message and join-line cleanup included — no second bot needed.'],
    ['Solana, Base, Ethereum, Robinhood Chain', 'pump.fun coins on the curve and after graduation, and tokens on Base, Ethereum and Robinhood Chain.'],
  ];
  const mock = `<div class="tg"><div class="tgh">Example alert</div><div class="tgm"><b>🟢 $EXAMPLE Buy!</b><br>🟢🟢🟢🟢🟢🟢🟢🟢<br><br>💵 2.50 SOL ($412)<br>🪙 1,234,567 EXAMPLE<br>👤 7xKX…a91f | Txn<br>🧠 <b>SMART BUY</b> — #3 on pump.fun this week by profit banked<br>📊 MCap $1.24M<br><br><span class="tgb">Chart</span><span class="tgb">Bubble</span><span class="tgb">Buy</span><span class="tgb">Boost</span></div></div>`;
  const body = `<p class="muted">Or open <a href="https://t.me/pumpbubblebot" rel="noopener">@pumpbubblebot</a> in Telegram to see it first.</p>
<style>.feat{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:18px 0}.feat div{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:rgba(255,255,255,.03)}.feat b{display:block;margin-bottom:4px}.feat span{color:#c9d1de;font-size:14px}
.tg{max-width:420px;margin:18px 0;border-radius:16px;background:#17212b;border:1px solid var(--line);overflow:hidden}.tgh{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding:10px 14px 0}.tgm{padding:8px 14px 14px;font-size:14px;line-height:1.5}.tgb{display:inline-block;margin:4px 6px 0 0;padding:5px 12px;border-radius:8px;background:#2b5278;font-size:13px}
ol.steps{padding-left:20px}ol.steps li{margin:8px 0}</style>
<h2>What it does</h2>
<div class="feat">${feat.map(([h, p]) => `<div><b>${esc(h)}</b><span>${esc(p)}</span></div>`).join('')}</div>
${mock}
<h2>Set up in 30 seconds</h2>
<ol class="steps"><li><a href="${BOT_ADD}" rel="noopener">Add @pumpbubblebot to your group</a> — Telegram asks for the admin rights the captcha needs.</li>
<li>In the group, send <code>/setup</code> followed by your token's contract address.</li>
<li>Tap <b>Test alert</b>, then set your GIF, emoji and minimum buy with the buttons. Done — and on its first setup your token turns gold on pumpbubble.fun's live map for an hour.</li></ol>`;
  return layout({
    path: '/bot', now, live: BOT_ADD, ctaText: 'Add it to your group — free →', dated: false,
    title: 'Free Telegram buy bot for pump.fun, Base and Robinhood Chain tokens — pumpbubble',
    desc: 'Free buy alerts for your token\'s Telegram group: top-trader and KOL tags, whale reactions, captcha. Solana (pump.fun), Base, Ethereum, Robinhood Chain. 30-second setup.',
    h1: 'A free buy bot that knows who is buying',
    lead: 'Buy alerts for your token\'s Telegram group in the format your holders know — plus what no other buy bot can tell them: when one of pump.fun\'s <b>top traders</b> or <b>top KOLs</b> just bought. Free, with a captcha guard built in, for pump.fun, Base, Ethereum and Robinhood Chain tokens.',
    stats: [['Free', 'one sponsored line under alerts pays for it'], ['30 s', 'to set up'], ['4 chains', 'Solana, Base, Ethereum, Robinhood'], ['1 hour', 'gold on the live map on first setup']],
    body,
    faq: [
      ['Is the buy bot free?', 'Yes. Alerts, the smart-money and KOL tags, whale reactions and the captcha are free. One sponsored line sits under each alert; that is what pays for it.'],
      ['How do I add a buy bot to my Telegram group?', 'Add @pumpbubblebot to the group, then send /setup followed by your token\'s contract address. A test alert confirms it works.'],
      ['Which chains does it support?', 'Solana (pump.fun tokens on the bonding curve and after graduation), Base, Ethereum and Robinhood Chain.'],
      ['What admin rights does it need?', 'Deleting messages, restricting members, pinning and inviting — what the captcha and the join cleanup use. Alerts alone need only the right to post.'],
      ['Does it message my members?', 'No. It posts in the group. Only people who open the bot\'s own chat and press Start get messages from it, and they can stop them at any time.'],
    ],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'pumpbubble buy bot', applicationCategory: 'CommunicationApplication',
      operatingSystem: 'Telegram', url: ORIGIN + '/bot', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      description: 'Free Telegram buy bot with top-trader and KOL tags, whale reactions and a captcha, for Solana, Base, Ethereum and Robinhood Chain tokens.' }],
  });
}

/* -------------------------------------------------------- sitemap, llms */
export function sitemapXml(kols = [], now = Date.now()) {
  const lm = new Date(now).toISOString();
  const urls = [
    ['/', 'hourly', '1.0'], ...PAGES.map(p => [p.path, 'hourly', '0.9']), ['/market', 'hourly', '0.8'], ['/board', 'hourly', '0.6'],
    ['/partners', 'weekly', '0.5'], ['/swap', 'weekly', '0.4'],
    ...kols.map(s => ['/kol/' + s, 'daily', '0.5']),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(([u, f, p]) => `  <url><loc>${ORIGIN}${u}</loc><lastmod>${lm}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join('\n')
    + '\n</urlset>\n';
}

/* llms.txt (llmstxt.org): what the site is, in a form a language model can
   quote, with today's headline numbers so an answer can carry them. */
export function llmsTxt({ kols = [], now = Date.now() } = {}) {
  const k = kols.filter(t => t && t.kol);
  const paid = k.reduce((s, t) => s + (t.kol.paid || 0), 0);
  const medNow = median(k.filter(t => t.kol.n).map(t => t.kol.medNow));
  return `# pumpbubble.fun

> Free live crypto bubble maps and leaderboards: pump.fun tokens, pump.fun KOLs and callers, top traders by realized profit, Base, Robinhood Chain, the wider crypto market, US stocks, and GPU rental prices. Every bubble is a token: size is market cap, colour is price change. Unbacked market caps are filtered out. Not financial advice.

pumpbubble.fun is independent of pump.fun. Data is read from public sources (pump.fun's public endpoints, DexScreener, Blockscout, CoinPaprika, Nasdaq, Akash) and measured, never estimated: a value that could not be measured is shown as missing, not zero.
${k.length ? `\nAs of ${day(now)}: pump.fun has paid its top ${k.length} KOLs ${money(paid)} in callout rewards (USDC); the #1 is ${k[0].sym} with ${money(k[0].kol.paid)}. Across their last 100 calls, a follower who bought each call and held is at ${mult(medNow)} at the median.\n` : ''}
## Leaderboards (server-rendered, updated continuously)

- [pump.fun KOL leaderboard](${ORIGIN}/kols): callout rewards paid by pump.fun, followers, and each KOL's last 100 calls — average market cap at the call, median and average peak, hold-now (what a follower who held has), 2× hit rate. One page per KOL at ${ORIGIN}/kol/<name>.
- [Best pump.fun callers](${ORIGIN}/callers): ranked by the share of calls that reach 2×, adjusted for sample size (Wilson lower bound).
- [Top pump.fun traders](${ORIGIN}/traders): ranked by realized profit, not paper gains.
- [Trending tokens](${ORIGIN}/trending): pump.fun's trending list plus Base, Robinhood Chain and majors by turnover × movement.
- [Robinhood Chain tokens](${ORIGIN}/robinhood): every token on Robinhood Chain (chain id 4663), one per ticker, unbacked caps filtered.
- [GPU rental prices](${ORIGIN}/gpu-prices): H100, A100, RTX PRO 6000, RTX 5090, RTX 4090 per hour on Akash's open market.
- [Compute map](${ORIGIN}/compute-map): a world map of Akash's GPU providers (live), AWS / Google Cloud / Azure regions and AI megaprojects, shaded by industrial electricity price by country and US state; the cheapest GPU hour and the cheapest power.
- [Crypto market overview](${ORIGIN}/market): the top 250 coins with 1h to 1y changes.

## Live maps

- [The map](${ORIGIN}/): tabs for Trending, Tap wars, Smart money, Calls (Live calls, Top callers, KOLs), Insiders, Compute, pump.fun, Crypto, Stocks, Robinhood, Base, Chains, Launchpads, Prediction, Casinos. Deep links: ?source=kols, ?source=callers, ?source=trending, ?source=robinhood, ?source=compute.

## Tools

- [Swap](${ORIGIN}/swap): swap Solana tokens (Jupiter) and Base, Ethereum and Robinhood Chain tokens (Relay) from your own wallet.
- [Telegram buy bot](${ORIGIN}/bot): free buy alerts for token communities on Solana, Base, Ethereum and Robinhood Chain, with a captcha guard and smart-money tags.
- [Free GPU price API](${ORIGIN}/api/compute/gpus): JSON, free with a link back.

## Contact

- X: https://x.com/pumpbubblefun
- Telegram: https://t.me/pumpbubble
- Partners: ${ORIGIN}/partners
`;
}
