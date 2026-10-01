/* Smoke test for a running pumpbubble instance — local or deployed.
 *
 *   node scripts/check.mjs                        # http://localhost:8787
 *   node scripts/check.mjs https://pumpbubble.fun
 *
 * Exits non-zero if anything essential is broken, so it can gate a deploy.   */

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;

const pass = (name, detail = '') => console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
const fail = (name, why) => { failed++; console.log(`  FAIL  ${name}  ${why}`); };

async function get(path, ms = 45000) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(ms) });
  return { status: r.status, headers: r.headers, json: async () => r.json(), r };
}

console.log('checking ' + BASE + '\n');

/* ------------------------------------------------------------- tokens */
let snap = null;
try {
  const t0 = Date.now();
  const res = await get('/api/tokens');
  const ms = Date.now() - t0;
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  snap = await res.json();

  if (!snap.ok || !Array.isArray(snap.tokens) || !snap.tokens.length) throw new Error('no tokens');
  pass('/api/tokens', `${snap.tokens.length} tokens in ${ms}ms`);

  /* the default feed must still be pump.fun — that is the product, and a
     silent switch to another source would change what the site is */
  if (snap.source !== 'pumpfun') fail('default source', 'expected pumpfun, got ' + snap.source);
  else pass('default source is pump.fun');

  const withMcap = snap.tokens.filter(t => t.mcap > 0).length;
  const withSym  = snap.tokens.filter(t => t.sym && t.sym !== '?').length;
  const withImg  = snap.tokens.filter(t => t.img).length;
  const withChg  = snap.tokens.filter(t => t.pc && (t.pc.h1 || t.pc.h24)).length;

  /* the three fields the product is defined by */
  withMcap / snap.tokens.length > 0.98 ? pass('market caps', `${withMcap}/${snap.tokens.length}`)
    : fail('market caps', `only ${withMcap}/${snap.tokens.length}`);
  withSym / snap.tokens.length > 0.98 ? pass('tickers', `${withSym}/${snap.tokens.length}`)
    : fail('tickers', `only ${withSym}/${snap.tokens.length}`);
  withImg / snap.tokens.length > 0.90 ? pass('images', `${withImg}/${snap.tokens.length}`)
    /* zero is a different failure from a few: it means nothing was signed at
       all, which points at the signing secret rather than at the token data */
    : fail('images', withImg === 0
      ? 'none at all — the image signing secret is missing, check /api/health'
      : `only ${withImg}/${snap.tokens.length}`);
  withChg / snap.tokens.length > 0.80 ? pass('price change', `${withChg}/${snap.tokens.length}`)
    : fail('price change', `only ${withChg}/${snap.tokens.length} — DexScreener enrichment may be failing`);

  snap.age < 60000 ? pass('data freshness', snap.age + 'ms old')
    : fail('data freshness', snap.age + 'ms old — snapshot is stale');

  /* CLAUDE.md guardrail: gold must not eat the map */
  snap.goldShare <= 0.25 ? pass('gold share', (snap.goldShare * 100).toFixed(1) + '% of bubble area')
    : fail('gold share', (snap.goldShare * 100).toFixed(1) + '% — over the 25% cap, boosts are oversold');
} catch (e) {
  fail('/api/tokens', e.message);
}

/* -------------------------------------------------------------- image */
try {
  const t = snap?.tokens.find(x => x.img);
  if (!t) throw new Error('no image to test');
  const res = await get(t.img, 20000);
  const type = res.headers.get('content-type') || '';
  res.status === 200 && type.startsWith('image/')
    ? pass('image proxy', type)
    : fail('image proxy', `HTTP ${res.status} ${type}`);
} catch (e) {
  fail('image proxy', e.message);
}

/* signed proxy must refuse an unsigned URL, or it is an open relay */
try {
  const res = await get('/api/img?u=' + encodeURIComponent('https://example.com/x.png'), 15000);
  res.status === 403 ? pass('image proxy rejects unsigned URLs')
    : fail('image proxy is an OPEN RELAY', 'expected 403, got ' + res.status);
} catch (e) {
  fail('image proxy signature check', e.message);
}

/* ------------------------------------------------------------- boosts */
try {
  const res = await get('/api/boosts');
  const j = await res.json();
  if (!j.ok) throw new Error('not ok');
  pass('/api/boosts', `${j.count} active, ${j.tiers.length} tiers`);
  j.treasury ? pass('treasury wallet configured', j.treasury.slice(0, 8) + '…')
    : fail('treasury wallet', 'not set — boosts cannot be sold (wrangler secret put TREASURY_WALLET)');
} catch (e) {
  fail('/api/boosts', e.message);
}

/* ------------------------------------------------------ one token by CA */
/* A token outside every warm feed has to resolve on its own. pump.fun
   retired GET /coins/<mint> and this was invisible for days: the boost box,
   /setup and Tap wars all said "no token found", while any token already on
   the map still resolved from the feed. Wrapped SOL is on no tab of ours and
   pump.fun's coin record names it, so it exercises the cold path. */
try {
  const res = await get('/api/token?mint=So11111111111111111111111111111111111111112', 20000);
  const j = await res.json();
  j.ok && j.token && j.token.sym
    ? pass('token lookup off the map', `$${j.token.sym} via ${j.from}`)
    : fail('token lookup off the map', `HTTP ${res.status} ${j.error || ''} — boost box, /setup and Tap wars adds are down`);
} catch (e) {
  fail('token lookup off the map', e.message);
}

/* ------------------------------------------------------------- swap */
/* /swap is the map's policy plus Jupiter's API in connect-src — no
   third-party script — and the map's own policy must not have moved. */
try {
  const res = await get('/swap?mint=So11111111111111111111111111111111111111112', 20000);
  const csp = res.headers.get('content-security-policy') || '';
  res.status === 200 && /script-src 'self' 'unsafe-inline';/.test(csp) && csp.includes('https://lite-api.jup.ag')
    && /frame-ancestors 'none'/.test(csp) && (csp.match(/default-src/g) || []).length === 1
    ? pass('/swap', 'own scripts only, Jupiter API, never framed')
    : fail('/swap', `HTTP ${res.status}, csp: ${csp.slice(0, 120)}`);
  const home = (await get('/', 20000)).headers.get('content-security-policy') || '';
  /connect-src 'self';/.test(home) && !home.includes('jup.ag')
    ? pass('map CSP still strict')
    : fail('map CSP', 'loosened: ' + home.slice(0, 120));
  const cfg = await (await get('/api/swap-config', 15000)).json();
  cfg.ok ? pass('/api/swap-config', (cfg.fee ? `Solana fee ${cfg.feeBps} bps` : 'no Solana fee account (JUP_REFERRAL)')
      + (cfg.evm && cfg.evm.fee ? `, EVM fee ${cfg.evm.feeBps} bps` : ', no EVM fee address (RELAY_FEE_RECIPIENT)'))
    : fail('/api/swap-config', 'not ok');
  csp.includes('https://api.relay.link') ? pass('/swap reaches Relay', 'Base, Ethereum, Robinhood Chain')
    : fail('/swap reaches Relay', 'connect-src is missing api.relay.link — EVM quotes would be blocked');
} catch (e) {
  fail('/swap', e.message);
}

/* ------------------------------------------------------------- health */
try {
  const j = await (await get('/api/health')).json();
  j.rpc ? pass('solana rpc configured') : fail('solana rpc', 'not set — payments cannot be verified');
  if (j.lastError) fail('last snapshot error', j.lastError);
} catch (e) {
  fail('/api/health', e.message);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
