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

  if (snap.source !== 'pump.fun') fail('data source', 'expected pump.fun, got ' + snap.source);
  else pass('source is pump.fun');

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
