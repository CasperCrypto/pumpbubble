/* ==========================================================================
   One-time Cloudflare setup.

       npx wrangler login          # once, opens a browser
       node scripts/setup-cloudflare.mjs

   Creates the KV namespace, writes its id into wrangler.toml, deploys the
   worker, then uploads the secrets read from .env. Safe to re-run: each step
   checks whether it has already been done.

   Nothing here prints a secret value.
   ========================================================================== */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOML = ROOT + 'wrangler.toml';

const say = (...a) => console.log(...a);
const die = m => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

/* wrangler writes progress to stderr, so capture both and keep it out of the
   way unless something fails */
function wrangler(args, { input, quiet = true } = {}) {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    cwd: ROOT, shell: true, input, encoding: 'utf8',
    stdio: input === undefined ? ['inherit', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!quiet) say(out);
  return { code: r.status, out };
}

/* ------------------------------------------------------------ 0. env file */
const envPath = ROOT + '.env';
if (!existsSync(envPath)) die('.env not found. Copy .env.example to .env and put your Helius URL in it.');

const envText = readFileSync(envPath, 'utf8');
const readEnv = k => {
  const m = envText.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+)\\s*$', 'm'));
  const v = m ? m[1].trim() : '';
  return v && !/REPLACE_ME|change-me/i.test(v) ? v : '';
};

const rpc = readEnv('SOLANA_RPC');
if (!rpc) die('SOLANA_RPC is missing or still a placeholder in .env. Paste your Helius URL there first.');
if (!/^https:\/\//.test(rpc)) die('SOLANA_RPC in .env does not look like an https URL.');
say('\n  ✓ .env has a Solana RPC endpoint');

/* an image-signing secret is generated here if you have not chosen one */
const imgSecret = readEnv('IMG_SECRET') || (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');

/* ------------------------------------------------------------- 1. logged in */
say('\n  … checking Cloudflare login');
const who = wrangler(['whoami']);
if (/not authenticated/i.test(who.out)) die('Not logged in. Run:  npx wrangler login');
const account = (who.out.match(/([\w.@+-]+@[\w.-]+)/) || [])[1];
say('  ✓ logged in' + (account ? ' as ' + account : ''));

/* ----------------------------------------------------------------- 2. KV */
let toml = readFileSync(TOML, 'utf8');
if (toml.includes('REPLACE_WITH_YOUR_KV_NAMESPACE_ID')) {
  say('\n  … creating the KV namespace (stores boosts and ad slots)');
  const kv = wrangler(['kv', 'namespace', 'create', 'BUBBLE_KV']);
  const id = (kv.out.match(/id\s*=\s*"([0-9a-f]{32})"/i)
    || kv.out.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)
    || kv.out.match(/([0-9a-f]{32})/))?.[1];
  if (!id) { say(kv.out); die('Could not read the namespace id from that output. Paste it into wrangler.toml by hand.'); }
  toml = toml.replace('REPLACE_WITH_YOUR_KV_NAMESPACE_ID', id);
  writeFileSync(TOML, toml);
  say('  ✓ namespace created and written into wrangler.toml');
} else {
  say('\n  ✓ KV namespace already configured in wrangler.toml');
}

/* ------------------------------------------------------------- 3. deploy */
/* The worker has to exist before secrets can be attached to it. */
say('\n  … deploying (this creates the worker)');
const dep = wrangler(['deploy']);
if (dep.code !== 0) { say(dep.out); die('Deploy failed — the output above says why.'); }
const url = (dep.out.match(/https:\/\/[a-z0-9.-]*workers\.dev[^\s]*/i) || [])[0];
say('  ✓ deployed' + (url ? '  →  ' + url : ''));

/* ------------------------------------------------------------ 4. secrets */
for (const [name, value] of [['IMG_SECRET', imgSecret], ['SOLANA_RPC', rpc]]) {
  say(`\n  … setting ${name}`);
  const r = wrangler(['secret', 'put', name], { input: value + '\n' });
  if (r.code !== 0) { say(r.out); die(`Could not set ${name}.`); }
  say(`  ✓ ${name} stored in Cloudflare (not in the repo)`);
}

/* ------------------------------------------------------------- 5. verify */
say('\n  … verifying');
if (url) {
  try {
    const h = await (await fetch(url + '/api/health', { signal: AbortSignal.timeout(20000) })).json();
    say(`  ✓ /api/health  rpc=${h.rpc}  treasury=${h.treasury}  tokens=${h.cachedTokens}`);
  } catch { say('  ! could not reach /api/health yet — give it a few seconds and retry'); }
}

say(`
  Done. What is left, in the dashboard:

    1. Custom domain — uncomment the [[routes]] block at the end of
       wrangler.toml, then run:  npm run deploy
       That points pumpbubble.fun at the worker and creates the DNS record.

    2. Rate limiting — Security → WAF → Rate limiting rules, on /api/*,
       around 300 requests/minute per IP. The in-process limiter only sees
       one isolate; only the edge rule is global.

  Then check the live site:  node scripts/check.mjs https://pumpbubble.fun
`);
