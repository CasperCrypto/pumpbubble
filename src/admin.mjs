/* ==========================================================================
   pumpbubble.fun — the operator's console

   There is no link to this anywhere on the site, and there is no default path:
   it lives at whatever `ADMIN_PATH` says, and if that or `ADMIN_PASS` is
   missing the whole thing 404s exactly like any other unknown URL. A panel that
   announces itself with a 401 has told an attacker it exists.

   The secret path is convenience, not security. The password is the control,
   and it is compared as a SHA-256 digest so the comparison cannot be timed, is
   rate limited, and is never echoed back in any response.

   The rule that matters most here is the one this project already learned about
   sweeps: **where money goes is never a request parameter.** Nothing below
   accepts a destination address. Collecting reads the treasury from the
   environment, so a request that names an attacker's wallet still pays the
   configured one.
   ========================================================================== */

const enc = new TextEncoder();

export function adminEnabled(env = {}) {
  return !!(env.ADMIN_PASS && env.ADMIN_PATH && String(env.ADMIN_PATH).length >= 8);
}

/* The panel's URL path, normalised to a single leading slash. */
export function adminPath(env = {}) {
  const p = String(env.ADMIN_PATH || '').replace(/^\/+|\/+$/g, '');
  return p ? '/' + p : '';
}

async function digest(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* Digests are equal-length hex, so this is a fixed-cost comparison whatever the
   input was. Comparing the passwords directly would leak their common prefix
   through timing. */
export async function passOk(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Bearer token, or the `p` field of a JSON body. Never a query parameter:
   those end up in logs, in referrers and in browser history. */
export async function authed(req, env) {
  if (!adminEnabled(env)) return false;
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  return passOk(m[1].trim(), env.ADMIN_PASS);
}

/* ----------------------------------------------------------------- lockout */
/* Failed logins are counted in KV rather than in memory.

   The in-memory limiter this started with counted per isolate, and Cloudflare
   spreads requests across many: eleven wrong passwords in a row all returned
   401 and not one of them was ever throttled. It had exactly the wrong shape —
   invisible to an attacker spread across isolates, while reliably locking out
   the one person using the console from a single browser.

   KV is the one thing every isolate can see. Only failures are written, and a
   locked-out caller is rejected on the read alone, so ordinary use costs one
   read and an attacker cannot make this expensive either.

   KV is eventually consistent, so a fast burst may land a couple of extra
   guesses. Against a bounded budget that is noise. */
const FAIL_MAX = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const ipOf = req =>
  req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';

const failKey = req => 'adminfail:' + ipOf(req);

/* True when this caller has spent its budget. */
export async function lockedOut(store, req) {
  try {
    const r = await store.get(failKey(req));
    return !!(r && r.n >= FAIL_MAX && Date.now() < r.reset);
  } catch { return false; }
}

export async function noteFailure(store, req) {
  try {
    const k = failKey(req);
    const r = await store.get(k);
    const live = r && Date.now() < r.reset;
    const next = { n: (live ? r.n : 0) + 1, reset: live ? r.reset : Date.now() + FAIL_WINDOW_MS };
    await store.put(k, next, { ttlSec: Math.ceil(FAIL_WINDOW_MS / 1000) + 60 });
  } catch { /* a lockout that cannot be recorded must not block the request */ }
}

/* A good password clears the slate, so a typo or two never strands anyone. */
export async function clearFailures(store, req) {
  try {
    const r = await store.get(failKey(req));
    if (r) await store.put(failKey(req), { n: 0, reset: 0 }, { ttlSec: 120 });
  } catch { /* nothing to do */ }
}

/* -------------------------------------------------------------------- page */
/* Served from the Worker rather than from public/, so there is no file for
   anyone to find by guessing asset names. */
export function adminPage(path) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>console</title>
<style>
:root{color-scheme:dark;--bg:#080b0f;--card:#11161e;--line:#1e2733;--ink:#e8eef6;--dim:#8b98a8;--up:#2bd46e;--dn:#ff4d5e;--gold:#ffc93c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:500 14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 18px}
h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
.wrap{max-width:1000px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;padding:12px}
.stat u{display:block;text-decoration:none;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:5px}
.stat b{font-size:19px;font-variant-numeric:tabular-nums}
input,button,select{font:inherit;border-radius:9px;border:1px solid var(--line);background:#0d1117;color:var(--ink);padding:9px 11px}
button{cursor:pointer;font-weight:700;background:#1b2431}
button.go{background:linear-gradient(180deg,#8ff7b4,#25c464);color:#05210f;border:0}
button.bad{border-color:#5a2029;color:#ff9aa4}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.04);font-variant-numeric:tabular-nums}
.up{color:var(--up)}.dn{color:var(--dn)}.dim{color:var(--dim)}
#msg{min-height:18px;font-size:12px;color:var(--dim);margin-top:8px}
#login{max-width:340px;margin:12vh auto}
.hide{display:none}
code{background:#0d1117;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:12px}
</style></head><body>

<div id="login" class="card">
  <h2>console</h2>
  <input id="pw" type="password" placeholder="password" style="width:100%" autocomplete="current-password">
  <div class="row"><button class="go" id="in" style="flex:1">Open</button></div>
  <div id="lmsg" class="dim" style="font-size:12px;margin-top:8px"></div>
</div>

<div id="app" class="wrap hide">
  <h1>pumpbubble console</h1>

  <div class="card">
    <h2>Ready posts</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      On the map, pick a tab and press <b>Share top 10</b>: this browser gets the full post for the
      official account — @handles, amounts, link — with Copy post and Post on X. Visitors never see it.</p>
    <div class="row"><span id="opState" class="dim"></span>
      <a href="/?source=traders" target="_blank" rel="noopener" style="text-decoration:none;padding:7px 12px;border-radius:9px;font-weight:700;background:linear-gradient(180deg,#8ff7b4,#25c464);color:#05210f">Open Traders</a>
      <button id="opOff">Turn off in this browser</button></div>
  </div>

  <div class="card"><h2>Money</h2><div class="grid" id="money"></div></div>
  <div class="card"><h2>Traffic</h2><div class="grid" id="traffic"></div></div>
  <div class="card"><h2>Feeds</h2><div id="feeds"></div></div>

  <div class="card">
    <h2>Ad rail</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      Four slots. Yours come first, then slots won in Tap wars, then trending fills what is left.
      A slot whose time is up disappears by itself.</p>
    <div id="ads"></div>
    <div class="row">
      <input id="aTitle" placeholder="title" style="width:120px">
      <input id="aSub" placeholder="subtitle" style="width:150px">
      <input id="aUrl" placeholder="https://…" style="flex:1;min-width:200px">
      <input id="aImg" placeholder="image url (optional)" style="flex:1;min-width:180px">
      <select id="aHours" class="dur"></select>
      <button class="go" id="aAdd">Save slot</button>
      <button id="aCancel" class="hide">Cancel edit</button>
    </div>
  </div>

  <div class="card">
    <h2>Bubbles on the map</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      Gold bubbles you place, on every tab. Size is what the bubble's face will say. Any chain —
      paste the contract. Paid boosts from buyers are listed here too.</p>
    <div id="boosts"></div>
    <div class="row">
      <input id="bMint" placeholder="contract address — any chain" style="flex:1;min-width:240px">
      <select id="bSize">
        <option value="1.5">size ×1.5</option><option value="2">size ×2</option>
        <option value="3" selected>size ×3</option><option value="4">size ×4</option><option value="6">size ×6 (max)</option>
      </select>
      <select id="bHours" class="dur"></select>
      <button class="go" id="bAdd">Save bubble</button>
    </div>
  </div>

  <div class="card">
    <h2>Hidden from the map</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      Off every tab, the rail and the share cards — for scams, spam, or anything you do not want shown.</p>
    <div id="hidden"></div>
    <div class="row">
      <input id="hCa" placeholder="contract address" style="flex:1;min-width:240px">
      <input id="hNote" placeholder="note (optional)" style="width:180px">
      <button class="bad" id="hAdd">Hide</button>
    </div>
  </div>

  <div class="card">
    <h2>Tap wars</h2>
    <div id="arena"></div>
    <div class="row">
      <span class="dim">Remove tokens nobody tapped for</span>
      <input id="tIdle" style="width:70px" inputmode="numeric">
      <span class="dim">hours</span>
      <button class="go" id="tIdleSave">Save</button>
    </div>
  </div>

  <div class="card">
    <h2>Our token</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      The one contract address the header strip names as official. Ticker and name are read from pump.fun.</p>
    <div id="ourtoken"></div>
    <div class="row">
      <input id="tMint" placeholder="mint" style="flex:1;min-width:240px">
      <button class="go" id="tSet">Set</button>
      <button id="tClear">Clear</button>
    </div>
  </div>

  <div class="card">
    <h2>Pinned tokens</h2>
    <p class="dim" style="font-size:12px;margin:0 0 8px">
      Forces a token onto a chain map even when discovery has not reached it.</p>
    <div id="seeds"></div>
    <div class="row">
      <select id="sChain"><option value="base">base</option><option value="robinhood">robinhood</option></select>
      <input id="sAddr" placeholder="0x…" style="flex:1;min-width:280px">
      <button class="go" id="sAdd">Pin</button>
    </div>
  </div>

  <div class="card">
    <h2>X poster</h2>
    <div id="xbot"></div>
  </div>

  <div class="card">
    <h2>Telegram bot</h2>
    <div id="tg"></div>
    <div class="row" style="margin-top:10px">
      <select id="bAud"><option value="index">Bubble Index subscribers</option><option value="trend">Trending subscribers</option></select>
      <button class="go" id="bCount">Count recipients</button>
      <button class="go" id="bSend" disabled>Send</button>
    </div>
    <textarea id="bText" rows="4" placeholder="HTML allowed: &lt;b&gt;, &lt;i&gt;, &lt;a href&gt;. Goes only to people who opted in." style="width:100%;margin-top:8px;background:#0d1117;color:inherit;border:1px solid var(--line);border-radius:9px;padding:10px;font:inherit;font-size:13px"></textarea>
    <div class="dim" id="bOut" style="margin-top:6px"></div>
  </div>

  <div id="msg"></div>
</div>

<script>
const BASE=${JSON.stringify(path)};
let PW='';
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=n=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+(+n||0).toFixed(2);
let D=null, EDIT_AD='';
const DUR=[[1,'1 hour'],[6,'6 hours'],[24,'24 hours'],[72,'3 days'],[168,'7 days'],[720,'30 days'],[0,'until removed']];
/* how long something still shows; a century out is how "forever" was written */
const left=u=>{if(!u||u-Date.now()>50*365*864e5)return 'always';const ms=u-Date.now();if(ms<=0)return 'expired';
  const h=ms/36e5;return h>=48?Math.round(h/24)+' days left':h>=1?Math.floor(h)+'h '+Math.round((h%1)*60)+'m left':Math.max(1,Math.round(ms/6e4))+'m left'};
/* the size the bubble's face prints — the same curve the map uses */
const face=b=>b.size>1?String(b.size):(1+Math.min(5,0.1233*Math.pow(+b.usd||0,0.637))).toFixed(1);
document.querySelectorAll('select.dur').forEach(s=>{s.innerHTML=DUR.map(([h,l])=>'<option value="'+h+'"'+(h===24?' selected':'')+'>show '+l+'</option>').join('')});

async function api(action,body){
  const r=await fetch(BASE+'/api',{method:'POST',
    headers:{'authorization':'Bearer '+PW,'content-type':'application/json'},
    body:JSON.stringify({action,...(body||{})})});
  if(r.status===401){throw new Error('unauthorised')}
  const j=await r.json();
  if(!j.ok)throw new Error(j.error||'failed');
  return j;
}
let bReady=null;
$('bCount').onclick=async()=>{
  try{
    const r=await api('tg.broadcast',{audience:$('bAud').value,text:$('bText').value||'x',dry:true});
    let eligible=r.eligible,after=r.after;
    while(!r.done&&after<r.total){const n=await api('tg.broadcast',{audience:$('bAud').value,text:'x',dry:true,after});eligible+=n.eligible;after=n.after;if(n.done)break}
    bReady={audience:$('bAud').value,eligible};
    $('bOut').textContent=eligible+' would receive this';
    $('bSend').disabled=!(eligible>0&&$('bText').value.trim());
  }catch(e){say(e.message,true)}
};
$('bText').oninput=()=>{$('bSend').disabled=true;bReady=null;$('bOut').textContent=''};
$('bAud').onchange=()=>{$('bSend').disabled=true;bReady=null;$('bOut').textContent=''};
$('bSend').onclick=async()=>{
  if(!bReady||!confirm('Send to '+bReady.eligible+' subscribers?'))return;
  $('bSend').disabled=true;
  try{
    let after=0,sent=0,gone=0;
    for(;;){const r=await api('tg.broadcast',{audience:bReady.audience,text:$('bText').value,dry:false,after});sent+=r.sent;gone+=r.gone;after=r.after;if(r.done)break}
    $('bOut').textContent='sent '+sent+(gone?' · '+gone+' had blocked the bot and were removed':'');
    bReady=null;
  }catch(e){say(e.message,true)}
};

function say(t,bad){const m=$('msg');m.textContent=t;m.style.color=bad?'#ff9aa4':'#8b98a8';
  if(t)setTimeout(()=>{if(m.textContent===t)m.textContent=''},4000)}

const stat=(u,b,cls)=>'<div class="stat"><u>'+esc(u)+'</u><b class="'+(cls||'')+'">'+esc(b)+'</b></div>';

async function load(){
  const d=await api('overview');
  $('money').innerHTML=
    stat('Boost revenue',money(d.money.revenueUsd))+
    stat('Paid boosts',d.money.paidCount)+
    stat('Live boosts',d.money.liveCount)+
    stat('Treasury',d.money.treasury? d.money.treasury.slice(0,6)+'…'+d.money.treasury.slice(-4):'—');
  $('traffic').innerHTML=
    stat('Views today',d.traffic.viewsToday)+
    stat('Visitors today',d.traffic.visitorsToday)+
    stat('Views 7d',d.traffic.views7d)+
    stat('Visitors 7d',d.traffic.visitors7d);

  $('feeds').innerHTML='<table><tr><th>source</th><th>tokens</th><th>backed</th><th>age</th></tr>'+
    d.feeds.map(f=>'<tr><td>'+esc(f.id)+'</td><td>'+f.tokens+'</td><td>'+f.solid+'</td><td class="dim">'+
      (f.age==null?'—':Math.round(f.age/1000)+'s')+'</td></tr>').join('')+'</table>';

  D=d;
  $('ads').innerHTML=d.ads.length
    ? '<table><tr><th>title</th><th>subtitle</th><th>link</th><th>shows</th><th></th></tr>'+d.ads.map(a=>
        '<tr><td>'+esc(a.title)+'</td><td class="dim">'+esc(a.sub||'')+'</td><td class="dim">'+esc((a.url||'').slice(0,40))+'</td>'+
        '<td class="dim">'+esc(left(a.until))+'</td>'+
        '<td style="white-space:nowrap"><button data-edit-ad="'+esc(a.title)+'">edit</button> <button class="bad" data-del-ad="'+esc(a.title)+'">remove</button></td></tr>').join('')+'</table>'
    : '<div class="dim">no slots filled — the rail shows trending and the "your ad here" pitch</div>';

  $('hidden').innerHTML=(d.hidden||[]).length
    ? '<table><tr><th>token</th><th>address</th><th>note</th><th></th></tr>'+d.hidden.slice().reverse().map(h=>
        '<tr><td>'+esc(h.sym||'?')+'</td><td class="dim"><code>'+esc(h.key.slice(0,6)+'…'+h.key.slice(-4))+'</code></td><td class="dim">'+esc(h.note||'')+'</td>'+
        '<td><button data-del-hide="'+esc(h.key)+'">unhide</button></td></tr>').join('')+'</table>'
    : '<div class="dim">nothing hidden</div>';

  if(d.arena){
    $('tIdle').value=d.arena.idleHours;
    const ago=t=>{if(!t)return 'never';const m=Math.round((Date.now()-t)/60000);return m<60?m+'m ago':m<2880?Math.round(m/60)+'h ago':Math.round(m/1440)+'d ago'};
    $('arena').innerHTML=d.arena.tokens.length
      ? '<table><tr><th>#</th><th>token</th><th>taps</th><th>holds</th><th>last tap</th><th></th></tr>'+d.arena.tokens.map((t,i)=>
          '<tr><td class="dim">'+(i+1)+'</td><td>'+esc(t.sym)+'</td><td>'+esc(String(t.taps))+'</td><td>'+(t.award==='gold'?'<b style="color:#ffc93c">gold</b>':t.award==='ad'?'rail slot':'<span class="dim">—</span>')+'</td>'+
          '<td class="dim">'+ago(t.lastTap)+'</td><td style="white-space:nowrap"><button data-tap-reset="'+esc(t.key)+'">reset taps</button> <button class="bad" data-tap-remove="'+esc(t.key)+'">remove</button></td></tr>').join('')+'</table>'
      : '<div class="dim">the arena is empty</div>';
  }else $('arena').innerHTML='<div class="dim">the arena is not running</div>';

  $('ourtoken').innerHTML=d.token&&d.token.mint
    ? '<div><b>$'+esc(d.token.sym||'')+'</b> <span class="dim">'+esc(d.token.name||'')+'</span><br><code>'+esc(d.token.mint)+'</code></div>'
    : '<div class="dim">none - the header strip is hidden</div>';
  const live=d.boosts.filter(b=>!(b.until&&b.until<Date.now()));
  $('boosts').innerHTML=live.length
    ? '<table><tr><th>token</th><th>kind</th><th>size</th><th>shows</th><th></th></tr>'+live.map(b=>
        '<tr><td>'+esc(b.sym||b.mint.slice(0,6))+'</td><td>'+(b.house?'<span class="dim">yours</span>':'paid '+money(b.spentUsd||0))+
        '</td><td>×'+face(b)+'</td><td class="dim">'+esc(left(b.until))+
        '</td><td style="white-space:nowrap">'+(b.house?'<button data-edit-boost="'+esc(b.mint)+'">edit</button> ':'')+
        '<button class="bad" data-del-boost="'+esc(b.mint)+'">remove</button></td></tr>').join('')+'</table>'
    : '<div class="dim">no gold bubbles on the map</div>';

  $('seeds').innerHTML=Object.entries(d.seeds).map(([chain,list])=>
    '<div style="margin-bottom:6px"><b>'+esc(chain)+'</b> '+
    (list.length?list.map(a=>'<code>'+esc(a.slice(0,10))+'…</code> <button class="bad" data-del-seed="'+esc(chain)+'|'+esc(a)+'">x</button>').join(' '):'<span class="dim">none</span>')+
    '</div>').join('');

  const t=d.tg||{};
  $('tg').innerHTML=!t.enabled
    ?'<div class="dim">not configured — set <code>TG_BOT_TOKEN</code> and the next cron tick registers the webhook</div>'
    :stat('Groups',t.groups||0)+stat('Subscribers',t.subscribers||0)+stat('Tokens watched',t.mints||0)+
     '<div class="dim" style="margin-top:8px">telegram webhook: '+(t.telegram&&t.telegram.url?'set'+(t.telegram.lastError?' · last error: '+esc(t.telegram.lastError):''):'not set')+
     ' · helius: '+(t.helius&&t.helius.exists?(t.helius.addresses+' addresses'):(t.helius&&t.helius.configured?'no webhook yet (created on first /setup)':'no key'))+'</div>';
  $('xbot').innerHTML='<div class="dim">'+(d.xbot.configured?'configured':'not configured — no credentials set')+
    ' · posted today '+d.xbot.postedToday+'</div>'+
    (d.xbot.would?'<pre style="white-space:pre-wrap;background:#0d1117;border:1px solid var(--line);border-radius:9px;padding:10px;margin-top:8px;font-size:12px">'+esc(d.xbot.would.text)+'</pre>':'');
}

document.addEventListener('click',async e=>{
  const b=e.target.closest('button'); if(!b)return;
  try{
    if(b.dataset.delAd){await api('ad.remove',{title:b.dataset.delAd});say('removed');return load()}
    if(b.dataset.delBoost){await api('boost.remove',{mint:b.dataset.delBoost});say('removed');return load()}
    if(b.dataset.delHide){await api('hide.remove',{key:b.dataset.delHide});say('back on the map');return load()}
    if(b.dataset.tapReset){await api('tap.reset',{key:b.dataset.tapReset});say('taps reset');return load()}
    if(b.dataset.tapRemove){await api('tap.remove',{key:b.dataset.tapRemove});say('removed from the arena');return load()}
    if(b.dataset.editAd){
      const a=(D&&D.ads||[]).find(x=>x.title===b.dataset.editAd);if(!a)return;
      $('aTitle').value=a.title;$('aSub').value=a.sub||'';$('aUrl').value=a.url||'';$('aImg').value=a.img||'';
      EDIT_AD=a.title;$('aAdd').textContent='Save changes';$('aCancel').classList.remove('hide');$('aTitle').focus();return}
    if(b.dataset.editBoost){
      const x=(D&&D.boosts||[]).find(y=>y.mint===b.dataset.editBoost);if(!x)return;
      $('bMint').value=x.mint;
      const f=+face(x);let best='3';for(const o of $('bSize').options)if(Math.abs(+o.value-f)<Math.abs(+best-f))best=o.value;
      $('bSize').value=best;$('bMint').focus();say('change size or time, then Save bubble');return}
    if(b.dataset.delSeed){const [c,a]=b.dataset.delSeed.split('|');await api('seed.remove',{chain:c,addr:a});say('unpinned');return load()}
  }catch(err){say(err.message,true)}
});

$('in').onclick=async()=>{
  PW=$('pw').value;
  try{ await load(); $('login').classList.add('hide'); $('app').classList.remove('hide');
    /* unlock ready posts on the map, in this browser */
    try{localStorage.setItem('pb_op','1')}catch(_){}
    opState(); }
  catch(e){ $('lmsg').textContent=e.message; PW=''; }
};
$('pw').addEventListener('keydown',e=>{if(e.key==='Enter')$('in').click()});
function opState(){let on=false;try{on=localStorage.getItem('pb_op')==='1'}catch(_){}
  $('opState').textContent=on?'on in this browser':'off in this browser'}
$('opOff').onclick=()=>{try{localStorage.removeItem('pb_op')}catch(_){}opState()};

const adReset=()=>{$('aTitle').value=$('aSub').value=$('aUrl').value=$('aImg').value='';EDIT_AD='';
  $('aAdd').textContent='Save slot';$('aCancel').classList.add('hide')};
$('aAdd').onclick=async()=>{
  try{ await api('ad.add',{title:$('aTitle').value,sub:$('aSub').value,url:$('aUrl').value,img:$('aImg').value,
      hours:+$('aHours').value,prevTitle:EDIT_AD});
    say(EDIT_AD?'slot updated':'slot added'); adReset(); load(); }
  catch(e){say(e.message,true)}
};
$('aCancel').onclick=adReset;
$('bAdd').onclick=async()=>{
  const ca=$('bMint').value.trim();if(!ca){say('paste a contract address',true);return}
  try{ const r=await api('boost.house',{ca,size:+$('bSize').value,hours:+$('bHours').value});
    $('bMint').value=''; say('$'+(r.sym||'')+' is on the map at ×'+$('bSize').value); load(); }
  catch(e){say(e.message,true)}
};
$('hAdd').onclick=async()=>{
  const ca=$('hCa').value.trim();if(!ca){say('paste a contract address',true);return}
  try{ const r=await api('hide.add',{ca,note:$('hNote').value});
    $('hCa').value=$('hNote').value=''; say((r.sym?'$'+r.sym:'token')+' hidden from the map'); load(); }
  catch(e){say(e.message,true)}
};
$('tIdleSave').onclick=async()=>{
  try{ await api('tap.config',{idleHours:+$('tIdle').value}); say('saved'); load(); }
  catch(e){say(e.message,true)}
};
$('tSet').onclick=async()=>{
  try{ const r=await api('token.set',{mint:$('tMint').value});
    $('tMint').value=''; say('official token: $'+(r.sym||'')); load(); }
  catch(e){say(e.message,true)}
};
$('tClear').onclick=async()=>{
  try{ await api('token.clear',{}); say('cleared'); load(); }
  catch(e){say(e.message,true)}
};
$('sAdd').onclick=async()=>{
  try{ await api('seed.add',{chain:$('sChain').value,addr:$('sAddr').value});
    $('sAddr').value=''; say('pinned — live on the next sweep'); load(); }
  catch(e){say(e.message,true)}
};
</script></body></html>`;
}
