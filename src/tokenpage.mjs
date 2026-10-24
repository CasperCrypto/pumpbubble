/* ==========================================================================
   pumpbubble.fun — a token's own page, /t/<mint>.

   The Launch Kit's website: every token launched through it gets one, and
   any pump.fun token can have one (paste its address). It is the link a
   creator puts in their bio, their X post and their Telegram group, so it
   has to be good enough to be that — the token as a lit bubble, its money,
   Buy (our swap, 1%), Chart, its links, the buy bot for its group, Boost —
   and every one carries "Made with pumpbubble — launch yours", the badge
   that makes each launch an advert for the next.

   Every string on it came from a stranger (whoever minted the token typed
   the name, the description and the links): escaped on write, links kept
   only when they are https, and the page carries its own strict CSP.
   ========================================================================== */

import { groupLink } from './launch.mjs';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const https = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/i.test(u) ? u : '';
const money = v => { const n = +v; if (!Number.isFinite(n) || n <= 0) return '—'; return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n); };
const pctText = v => v == null || !Number.isFinite(+v) ? null : (+v >= 0 ? '+' : '−') + Math.abs(+v).toFixed(Math.abs(+v) >= 100 ? 0 : 1) + '%';
function ago(ms, now) {
  if (!(ms > 0)) return '';
  const s = Math.max(0, (now - ms) / 1000);
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
}
const short = s => String(s || '').slice(0, 4) + '…' + String(s || '').slice(-4);

export const TOKEN_CSP = "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/* `t` is the token as the map knows it (signed image, market cap, moves);
   `raw` is pump.fun's own record (description, creator, curve state);
   `launched` is our Launch Kit's record when it was launched with us. */
/* `site` is the token's own https://<slug>.pumpbubble.fun when it has one:
   the page's canonical address then, with every link pointing back at the
   main site, since on the subdomain a relative link would land on itself. */
export function tokenPage({ origin, t, raw = {}, launched = null, bot = 'pumpbubblebot', now = Date.now(), cardUrl = '', tgSoon = false, site = '' }) {
  const base = site ? origin : '';
  const mint = t.mint;
  const sym = t.sym || raw.symbol || '?', name = t.name || raw.name || sym;
  const desc = String(raw.description || '').slice(0, 600);
  const img = t.img || '';
  const pc = t.pc && t.pc.h24 != null ? pctText(t.pc.h24) : null;
  const up = t.pc && +t.pc.h24 >= 0;
  const grad = raw.complete === true || t.grad === true;
  const created = +raw.created_timestamp || +t.created || 0;
  const links = [
    ['X', https(raw.twitter || t.twitter)],
    ['Telegram', https(raw.telegram || t.telegram)],
    ['Website', https(raw.website || t.website)],
  ].filter(([, u]) => u && !u.startsWith(origin + '/t/') && !(site && u.replace(/\/+$/, '') === site));
  const url = site || origin + '/t/' + mint;
  const tweet = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent('$' + sym + ' — ' + name) + '&url=' + encodeURIComponent(url) + '&via=pumpbubblefun';
  const title = '$' + sym + ' — ' + name + ' | pumpbubble.fun';
  const descMeta = (desc || name + ' ($' + sym + ') on pump.fun') + ' · Market cap ' + money(t.mcap) + (pc ? ' · 24h ' + pc : '');
  const og = cardUrl || (img ? origin + img : origin + '/og.png');
  /* pictures stay relative: the subdomain serves /api/img and the icons
     itself, and its CSP allows images only from itself */
  const art = img;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(descMeta.slice(0, 300))}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/favicon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="pumpbubble.fun">
<meta property="og:url" content="${esc(url)}"><meta property="og:title" content="${esc('$' + sym + ' — ' + name)}">
<meta property="og:description" content="${esc(descMeta.slice(0, 300))}"><meta property="og:image" content="${esc(og)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@pumpbubblefun">
<meta name="twitter:image" content="${esc(og)}">
<style>
:root{--bg:#06080d;--ink:#eef2f8;--dim:#8a93a6;--line:rgba(255,255,255,.1);--mint:#28e08c;--mint2:#3df09b;--gold:#f5c542;--rose:#ff5a6e}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(120% 70% at 50% -10%,#10241a 0%,#06080d 60%);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh}
a{color:inherit}.wrap{max-width:720px;margin:0 auto;padding:18px 16px 60px}
.top{display:flex;align-items:center;gap:10px}.top .mk{width:24px;height:24px;border-radius:50%;box-shadow:0 0 18px rgba(40,224,140,.45)}.top b{font-weight:900;letter-spacing:-.02em}.top nav{margin-left:auto;display:flex;gap:14px;font-size:13px;font-weight:700}.top nav a{color:var(--dim);text-decoration:none}.top nav a:hover{color:var(--ink)}
.hero{text-align:center;margin:34px 0 10px}
.bub{width:150px;height:150px;margin:0 auto;border-radius:50%;overflow:hidden;border:4px solid ${up ? 'var(--mint)' : 'var(--rose)'};box-shadow:0 0 60px ${up ? 'rgba(40,224,140,.35)' : 'rgba(255,90,110,.3)'};background:#111a14;display:flex;align-items:center;justify-content:center;font:900 56px/1 inherit;color:var(--mint)}
.bub img{width:100%;height:100%;object-fit:cover}
h1{margin:16px 0 2px;font-size:clamp(28px,6vw,40px);line-height:1.1;letter-spacing:-.03em;font-weight:900}h1 small{display:block;font-size:15px;color:var(--dim);font-weight:700;letter-spacing:0;margin-top:4px}
.nums{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin:14px 0 4px}.nums div{padding:8px 14px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.03)}.nums b{display:block;font-size:18px;font-weight:900}.nums span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.up{color:var(--mint2)}.dn{color:var(--rose)}
.cta{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:18px 0 6px}
.cta a,.cta button{font:800 14px/1 inherit;padding:12px 18px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink);text-decoration:none;cursor:pointer}
.cta .buy{background:var(--mint);border-color:var(--mint);color:#04140b;padding:12px 26px}
.desc{max-width:560px;margin:16px auto 0;color:#c9d1de;white-space:pre-line}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:28px 0 0}
.card{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.03);text-decoration:none}.card b{display:block;margin-bottom:3px}.card span{font-size:13px;color:var(--dim)}.card:hover{border-color:rgba(255,255,255,.25)}
.card.gold{border-color:rgba(245,197,66,.35)}.card.gold b{color:var(--gold)}
.facts{margin:22px 0 0;border:1px solid var(--line);border-radius:14px;padding:4px 14px}.facts div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:13.5px}.facts div:last-child{border-bottom:0}.facts span{color:var(--dim)}.facts code{font-size:12.5px}
.facts button{font:700 12px/1 inherit;color:var(--mint2);background:none;border:0;cursor:pointer;padding:0 0 0 8px}
.made{display:block;text-align:center;margin:30px auto 0;padding:12px 16px;border-radius:999px;border:1px dashed rgba(61,240,155,.4);color:var(--mint2);font-weight:800;text-decoration:none;max-width:360px}
.badge{display:inline-block;margin-top:8px;font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--mint2);border:1px solid rgba(61,240,155,.35);border-radius:999px;padding:3px 9px}
.note{margin-top:22px;font-size:12px;color:#5d6678;text-align:center}
</style>
</head>
<body><div class="wrap">
<div class="top"><a href="${base}/"><img class="mk" src="/mark.png" alt="" width="24" height="24"></a><b><a href="${base}/" style="text-decoration:none">pumpbubble.fun</a></b><nav><a href="${base}/">Map</a><a href="${base}/launch">Launch</a><a href="${base}/swap">Swap</a></nav></div>
<div class="hero">
  <div class="bub" data-l="${esc(sym.slice(0, 1))}">${img ? `<img src="${esc(art)}" alt="">` : esc(sym.slice(0, 1))}</div>
  <h1>$${esc(sym)}<small>${esc(name)}</small></h1>
  ${launched ? '<span class="badge">Launched with pumpbubble</span>' : ''}
  ${tgSoon ? `<p class="desc" style="color:var(--gold)">$${esc(sym)}’s Telegram group is not made yet — its link opens it as soon as the creator adds our bot.</p>` : ''}
  <div class="nums"><div><b>${esc(money(t.mcap))}</b><span>Market cap</span></div>${pc ? `<div><b class="${up ? 'up' : 'dn'}">${esc(pc)}</b><span>24h</span></div>` : ''}<div><b>${grad ? 'Graduated' : 'Bonding curve'}</b><span>pump.fun</span></div></div>
  <div class="cta"><a class="buy" href="${base}/swap?mint=${esc(mint)}">Buy $${esc(sym)}</a><a href="https://pump.fun/coin/${esc(mint)}" target="_blank" rel="noopener">Chart</a>${links.map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(l)}</a>`).join('')}</div>
  ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
</div>
<div class="grid">
  <a class="card" href="${esc(groupLink(bot, mint))}" target="_blank" rel="noopener"><b>Buy alerts in your Telegram</b><span>Add our free bot to a group — set up for $${esc(sym)} the moment it joins.</span></a>
  <a class="card gold" href="${base}/?boost=${esc(mint)}"><b>Make it gold on the map</b><span>A golden bubble on pumpbubble.fun, sized by what is paid.</span></a>
  <a class="card" href="${esc(tweet)}" target="_blank" rel="noopener"><b>Share on X</b><span>This page unfurls with $${esc(sym)}'s picture.</span></a>
</div>
<div class="facts">
  <div><span>Contract</span><code>${esc(short(mint))}<button type="button" data-copy="${esc(mint)}">copy</button></code></div>
  ${raw.creator ? `<div><span>Creator</span><code>${esc(short(raw.creator))}</code></div>` : ''}
  ${created ? `<div><span>Created</span><b>${esc(ago(created, now))}</b></div>` : ''}
  <div><span>On the map</span><a href="${base}/?pin=${esc(mint)}" style="color:var(--mint2)">See $${esc(sym)} as a bubble →</a></div>
</div>
<a class="made" href="${base}/launch">Made with pumpbubble — launch your own token →</a>
<p class="note">Data from pump.fun and the map. Not financial advice: anyone can launch a token, and most go to zero.</p>
</div>
<script>
/* art that does not load becomes the ticker's letter, never a hole */
document.querySelectorAll('.bub img').forEach(function(i){var f=function(){var p=i.parentNode;p.textContent=p.getAttribute('data-l')||''};if(i.complete&&!i.naturalWidth)f();else i.addEventListener('error',f)});
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;try{navigator.clipboard.writeText(b.getAttribute('data-copy'));b.textContent='copied';setTimeout(function(){b.textContent='copy'},1500)}catch(x){}});
</script>
</body></html>`;
}
