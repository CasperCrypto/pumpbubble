/* ==========================================================================
   API abuse tests — run against a running server.

       node server/dev.mjs &
       node scripts/api-abuse.test.mjs [baseUrl]

   Everything here is an attack that would cost real money if it worked:
   editing a quote, forging an order, using the image proxy as a relay.
   ========================================================================== */

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
});
const get = p => fetch(BASE + p, { signal: AbortSignal.timeout(60000) });

const b64urlDecode = s => JSON.parse(
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
const b64urlEncode = o => Buffer.from(JSON.stringify(o)).toString('base64url');

console.log(`\nchecking ${BASE}\n`);

const snap = await (await get('/api/tokens')).json();
if (!snap.ok) { console.error('cannot read /api/tokens — is the server running?'); process.exit(1); }
const mint = snap.tokens[3].mint;

console.log('== editing a signed order ==');
const first = await (await post('/api/boost/order', { mint, tier: 'spark' })).json();
if (!first.ok) {
  no('create a legitimate order', first.error);
} else {
  ok('create a legitimate order', `${first.order.amountSol} SOL for $${first.order.usd}`);
  const [body, sig] = first.token.split('.');

  const tamper = async (label, mutate) => {
    const d = b64urlDecode(body);
    mutate(d);
    const forged = b64urlEncode(d) + '.' + sig;
    const r = await (await get('/api/boost/status?t=' + encodeURIComponent(forged))).json();
    r.ok === false ? ok(label, 'rejected') : no(label, 'ACCEPTED — forgery works');
  };

  await tamper('upgrade tier spark -> whale', d => {
    d.tier = 'whale'; d.mult = 4; d.hours = 72; d.usd = 149;
  });
  await tamper('cut the amount owed to dust', d => { d.lamports = 1; d.amountSol = 1e-9; });
  await tamper('redirect payment to another wallet', d => {
    d.treasury = 'So11111111111111111111111111111111111111112';
  });
  await tamper('extend the boost to a year', d => { d.hours = 8760; });
  await tamper('point the boost at a different token', d => {
    d.mint = 'So11111111111111111111111111111111111111112';
  });

  {
    const r = await (await get('/api/boost/status?t=' + encodeURIComponent('abc.def'))).json();
    r.ok === false ? ok('invent an order from nothing', 'rejected') : no('invent an order', 'ACCEPTED');
  }
  {
    const r = await (await get('/api/boost/status?t=' + encodeURIComponent(first.token))).json();
    r.ok === true ? ok('an untouched order still verifies', 'status: ' + r.status)
                  : no('an untouched order still verifies', r.error);
  }
}

console.log('\n== input validation ==');
for (const [label, badMint] of [
  ['path traversal in mint', '../../etc/passwd'],
  ['html in mint', '<script>alert(1)</script>'],
  ['empty mint', ''],
  ['valid shape but not on the map', '11111111111111111111111111111111'],
]) {
  const r = await post('/api/boost/order', { mint: badMint, tier: 'spark' });
  const j = await r.json();
  j.ok === false ? ok(label, `${r.status}: ${j.error}`) : no(label, 'ACCEPTED');
}
{
  const j = await (await post('/api/boost/order', { mint, tier: 'free_lol' })).json();
  j.ok === false ? ok('unknown tier', j.error)
                 : no('unknown tier', 'silently billed as ' + j.order.tier);
}
{
  /* the symbol must come from our own snapshot, never from the caller */
  const j = await (await post('/api/boost/order', { mint, tier: 'spark', sym: '<b>HACKED</b>' })).json();
  j.ok && j.order.sym !== '<b>HACKED</b>'
    ? ok('client-supplied symbol ignored', `used "${j.order.sym}"`)
    : no('client-supplied symbol ignored', 'caller controlled the label');
}

console.log('\n== image proxy ==');
for (const [label, target] of [
  ['unsigned external URL', 'https://evil.example.com/x.png'],
  ['SSRF to cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['SSRF to localhost', 'http://127.0.0.1:8787/api/health'],
]) {
  const r = await get('/api/img?u=' + encodeURIComponent(target) + '&s=AAAAAAAAAAAAAAAAAAAAAA');
  r.status === 403 ? ok(label, '403') : no(label, 'status ' + r.status);
}

console.log('\n== write paths ==');
{
  /* there must be no way to add an ad or a boost over HTTP */
  const before = await (await get('/api/ads')).json();
  await post('/api/ads', [{ id: 'x', title: 'FREE AD', url: 'https://evil.example.com' }]);
  const after = await (await get('/api/ads')).json();
  JSON.stringify(before.ads) === JSON.stringify(after.ads)
    ? ok('POST to /api/ads cannot add an ad', 'ads unchanged')
    : no('POST to /api/ads cannot add an ad', 'AD INSERTED');
}
{
  const h = await (await get('/api/boost/history')).json();
  h.ok ? ok('public boost ledger readable', `${h.count} boosts`) : no('public boost ledger');
}

console.log('\n== rate limiting ==');
{
  let codes = [];
  for (let i = 0; i < 45 && !codes.includes(429); i++) {
    codes.push((await post('/api/boost/order', { mint, tier: 'spark' })).status);
  }
  const local = /localhost|127\.0\.0\.1/.test(BASE);
  if (codes.includes(429)) {
    ok('order spam throttles', `429 after ${codes.indexOf(429)} in this window`);
  } else if (local) {
    no('order spam throttles', 'no 429 in 45 requests against a single process');
  } else {
    /* Expected at the edge, and worth stating plainly rather than passing
       quietly: the in-process limiter counts per isolate, and Cloudflare spreads
       a burst across many, so it never accumulates. It is a backstop against one
       runaway client hitting one isolate, not a global control. The global
       control is a Cloudflare Rate Limiting rule on /api/*, which has to be
       added in the dashboard — see docs/security.md. */
    no('order spam throttles at the edge',
       'no 429 in 45 requests — per-isolate counting cannot see a distributed burst. ' +
       'Add a Cloudflare Rate Limiting rule on /api/*; this cannot be fixed in code.');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
