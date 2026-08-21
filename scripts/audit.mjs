/* ==========================================================================
   Full audit — every endpoint, every data guarantee, every failure mode.

       node scripts/audit.mjs [baseUrl]

   Reports problems, not reassurance. Anything printed as FAIL or WARN is a
   real defect with a real consequence stated next to it.
   ========================================================================== */

const BASE = (process.argv[2] || 'https://pumpbubble.fun').replace(/\/+$/, '');
let pass = 0, warn = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  ok    ${n}${d ? '  — ' + d : ''}`); };
const wr = (n, d = '') => { warn++; console.log(`  WARN  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

const get = (p, ms = 45000) => fetch(BASE + p, { signal: AbortSignal.timeout(ms) });
const timed = async (p, ms) => { const t = Date.now(); const r = await get(p, ms); return { r, ms: Date.now() - t }; };

console.log(`\n=== auditing ${BASE} ===\n`);

/* ---------------------------------------------------------------- reachability */
console.log('-- endpoints --');
const ROUTES = ['/', '/api/health', '/api/tokens', '/api/tokens?mode=bonding',
  '/api/boosts', '/api/ads', '/api/boost/history', '/api/boost/sweep'];
const timings = {};
for (const p of ROUTES) {
  try {
    const { r, ms } = await timed(p);
    timings[p] = ms;
    if (!r.ok) no(`${p}`, `HTTP ${r.status}`);
    else if (ms > 8000) wr(`${p}`, `${ms}ms — slow enough that a visitor notices`);
    else ok(`${p}`, `${ms}ms`);
  } catch (e) { no(`${p}`, e.name === 'TimeoutError' ? 'timed out' : e.message); }
}

/* ------------------------------------------------------------------- health */
console.log('\n-- configuration --');
const health = await (await get('/api/health')).json();
for (const [k, why] of [
  ['treasury', 'no wallet: boosts cannot be sold'],
  ['rpc', 'no RPC: payments cannot be verified'],
  ['kv', 'no storage: a paid boost cannot be recorded'],
  ['imgSecret', 'no signing secret: token art disappears'],
]) health[k] ? ok(k) : no(k, why);
health.boostsOpen ? ok('boostsOpen') : no('boostsOpen', 'nobody can buy a boost');
health.lastError ? wr('last snapshot error', health.lastError) : ok('no snapshot errors');

/* -------------------------------------------------------------------- data */
console.log('\n-- data quality (graduated) --');
const snap = await (await get('/api/tokens')).json();
const T = snap.tokens || [];
T.length >= 200 ? ok('token count', String(T.length)) : no('token count', String(T.length));
snap.source === 'pumpfun' ? ok('default source is pump.fun') : no('default source', String(snap.source));

/* every source must actually serve, not just the default */
for (const s of (snap.sources || [])) {
  try {
    const r = await get('/api/tokens?source=' + s.id, 60000);
    const j = await r.json();
    const n = (j.tokens || []).length;
    const img = (j.tokens || []).filter(t => t.img).length;
    n >= 40 && img / Math.max(n, 1) > 0.9
      ? ok('source ' + s.id, n + ' tokens, ' + img + ' with art' + (s.boostable ? '' : ', not boostable'))
      : no('source ' + s.id, n + ' tokens, ' + img + ' with art');
  } catch (e) { no('source ' + s.id, e.message); }
}

const pct = (n, d) => Math.round(n / d * 100);
const withMcap = T.filter(t => t.mcap > 0).length;
const withSym = T.filter(t => t.sym && t.sym !== '?').length;
const withImg = T.filter(t => t.img).length;
const withChg = T.filter(t => t.pc && (t.pc.h1 || t.pc.h24 || t.pc.m5)).length;
const withLiq = T.filter(t => t.liq > 0).length;

for (const [label, n, floor, why] of [
  ['market caps', withMcap, 99, 'a bubble with no cap cannot be sized'],
  ['tickers', withSym, 95, 'unlabelled bubbles'],
  ['images', withImg, 90, 'the art is one of the three things promised'],
  ['price change', withChg, 85, 'colour is meaningless without it'],
  ['liquidity', withLiq, 80, 'the scam filter depends on it'],
]) {
  const p = pct(n, T.length);
  p >= floor ? ok(label, `${n}/${T.length} (${p}%)`) : no(label, `${n}/${T.length} (${p}%) — ${why}`);
}

/* age of the data */
snap.age < 30000 ? ok('freshness', `${snap.age}ms old`)
  : wr('freshness', `${Math.round(snap.age / 1000)}s old`);

/* the anti-scam layer */
console.log('\n-- the copycat / paper-cap filter --');
const solid = T.filter(t => t.solid).length;
const copycats = T.filter(t => (t.flags || []).includes('copycat')).length;
const thin = T.filter(t => (t.flags || []).includes('thin')).length;
ok('solid tokens', `${solid}/${T.length}`);
ok('flagged copycat', String(copycats));
ok('flagged thin', String(thin));
solid >= 30 ? ok('enough solid tokens to fill a map', String(solid))
  : no('too few solid tokens', `${solid} — "Real only" would show almost nothing`);

/* duplicate tickers should be flagged, not silently shown */
const bySym = {};
for (const t of T) (bySym[t.sym.toUpperCase()] ||= []).push(t);
const worstDupe = Object.entries(bySym).sort((a, b) => b[1].length - a[1].length)[0];
if (worstDupe && worstDupe[1].length > 2) {
  const allFlagged = worstDupe[1].every(t => (t.flags || []).includes('copycat'));
  allFlagged ? ok('duplicate tickers flagged', `${worstDupe[0]} x${worstDupe[1].length}, all flagged`)
             : no('duplicate tickers flagged', `${worstDupe[0]} x${worstDupe[1].length}, some unflagged`);
}

/* the top of the map is what people judge it by */
const top = T.filter(t => t.solid).sort((a, b) => b.mcap - a.mcap).slice(0, 5);
ok('top 5 shown', top.map(t => t.sym).join(', '));

/* ----------------------------------------------------------------- bonding */
console.log('\n-- bonding feed --');
try {
  const b = await (await get('/api/tokens?mode=bonding')).json();
  const B = b.tokens || [];
  B.length ? ok('bonding tokens', String(B.length)) : no('bonding tokens', 'empty');
  B.every(t => !t.grad) ? ok('all pre-graduation') : no('mixed', 'graduated tokens in the bonding feed');
  const bSolid = B.filter(t => t.solid).length;
  bSolid >= 10 ? ok('bonding solid', String(bSolid))
    : wr('bonding solid', `${bSolid} — "Real only" leaves the bonding map nearly empty`);
  const traded = B.filter(t => t.lastTrade && Date.now() - t.lastTrade < 36e5).length;
  traded >= B.length * 0.5 ? ok('actively trading', `${traded}/${B.length} in the last hour`)
    : wr('actively trading', `${traded}/${B.length} — the bonding feed is showing dead curves`);
} catch (e) { no('bonding feed', e.message); }

/* ------------------------------------------------------------------ boosts */
console.log('\n-- boosts --');
const boosts = await (await get('/api/boosts')).json();
boosts.tiers?.length === 3 ? ok('tiers', boosts.tiers.map(t => `${t.label} $${t.usd}`).join(', '))
  : no('tiers', 'missing');
boosts.treasury ? ok('treasury exposed for verification') : no('treasury not shown');
const hist = await (await get('/api/boost/history')).json();
hist.ok ? ok('public ledger', `${hist.count} boosts sold`) : no('public ledger');
typeof snap.goldShare === 'number' && snap.goldShare <= 0.25
  ? ok('gold share within cap', `${(snap.goldShare * 100).toFixed(1)}%`)
  : no('gold share', `${snap.goldShare} exceeds the 25% ceiling`);

/* --------------------------------------------------------------- security */
console.log('\n-- security --');
const imgOpen = await get('/api/img?u=' + encodeURIComponent('https://evil.example.com/x.png') + '&s=AAAA');
imgOpen.status === 403 ? ok('image proxy rejects unsigned') : no('image proxy is an open relay', String(imgOpen.status));
const ssrf = await get('/api/img?u=' + encodeURIComponent('http://169.254.169.254/') + '&s=AAAA');
ssrf.status === 403 ? ok('SSRF blocked') : no('SSRF', String(ssrf.status));
const badOrder = await (await get('/api/boost/status?t=abc.def')).json();
badOrder.ok === false ? ok('forged order rejected') : no('forged order accepted');

const headRes = await get('/');
const csp = headRes.headers.get('content-security-policy');
csp ? ok('CSP present', csp.includes("connect-src 'self'") ? "connect-src 'self'" : 'weak')
    : no('CSP missing', 'injected script could exfiltrate freely');
headRes.headers.get('x-content-type-options') ? ok('nosniff') : wr('nosniff missing');
/* token names are attacker-controlled and end up in the DOM */
const evil = T.find(t => /[<>]/.test(t.sym + t.name));
evil ? no('unsanitised token name reached the client', evil.sym) : ok('no angle brackets in token text');

/* --------------------------------------------------------------- delivery */
console.log('\n-- delivery --');
const html = await headRes.text();
const bytes = Buffer.byteLength(html);
bytes < 120000 ? ok('page weight', `${(bytes / 1024).toFixed(0)}KB, single file, no build step`)
  : wr('page weight', `${(bytes / 1024).toFixed(0)}KB`);
html.includes('<title>') ? ok('has title') : no('no <title>');
/^https:/.test(BASE) ? ok('served over https') : wr('not https');
for (const [tag, why] of [
  ['og:image', 'no preview when shared on X or Telegram'],
  ['og:title', 'no title when shared'],
  ['twitter:card', 'no card on X'],
  ['name="description"', 'no search snippet'],
  ['rel="canonical"', 'duplicate-content risk across workers.dev and the domain'],
  ['manifest', 'not installable on mobile'],
]) html.includes(tag) ? ok(tag.replace(/name=|rel=|"/g, '')) : wr(tag.replace(/name=|rel=|"/g, ''), why);
const robots = await get('/robots.txt');
robots.ok ? ok('robots.txt') : wr('robots.txt missing', 'crawlers get no guidance');
const sitemap = await get('/sitemap.xml');
sitemap.ok ? ok('sitemap.xml') : wr('sitemap.xml missing', 'slower indexing');

console.log(`\n${pass} ok · ${warn} warnings · ${fail} failures\n`);
process.exit(fail ? 1 : 0);
